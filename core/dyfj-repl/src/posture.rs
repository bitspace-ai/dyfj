//! The startup posture line.
//!
//! Without it the operator cannot tell which model they are talking to, or
//! whether they are talking to one at all. That was the first thing missing
//! when this front-end was first driven by hand.

use crate::approval::visible;
use crate::session::{ModelOrigin, Session};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// A fingerprint field that could not be read. Never compared.
pub const FINGERPRINT_UNKNOWN: &str = "unknown";

/// Print the posture line for a `runtime/status` answer, with any warnings
/// it carries, or say the posture is unavailable. Shown at startup and again
/// when the REPL re-attaches to a restarted runtime.
pub fn show(status: &anyhow::Result<Value>, session: &Session, socket: &str) {
    match status {
        Ok(status) => {
            println!("{}", line(status, session, socket));
            for warning in unresolved_pointer_warnings(status) {
                eprintln!("{warning}");
            }
        }
        Err(err) => println!("{}", runtime_line("posture: unavailable", &err.to_string(), socket)),
    }
}

/// A line about the runtime that also carries local context, such as the
/// socket path. The runtime's message is sanitised; the local context is ours
/// and is not.
pub fn runtime_line(context: &str, message: &str, local: &str) -> String {
    format!("{context} ({}) · {local}", visible(message))
}

/// Render the posture from a `runtime/status` result and the choices the
/// command line made for this session, which override the runtime's defaults
/// on the first turn. Every status field is optional: a runtime that stops
/// reporting one should cost a narrower line, not a failed startup. When the
/// runtime is behind this checkout's code, a warning line follows.
pub fn line(status: &Value, session: &Session, socket: &str) -> String {
    let local = match std::env::var_os("DYFJ_PROTOTYPE_ROOT") {
        Some(root) => source_tree_hash(&PathBuf::from(root).join("src")),
        None => FINGERPRINT_UNKNOWN.to_string(),
    };
    line_with_local_hash(status, session, socket, &local)
}

/// `line`, with this checkout's source hash supplied rather than read from
/// the checkout `DYFJ_PROTOTYPE_ROOT` names (the launcher exports it).
pub fn line_with_local_hash(status: &Value, session: &Session, socket: &str, local_hash: &str) -> String {
    let posture = posture_line(status, session, socket);
    match freshness_warning(status, local_hash) {
        Some(warning) => format!("{posture}\n{warning}"),
        None => posture,
    }
}

/// The line after the posture line when the runtime's code differs from this
/// checkout's, saying how it will catch up. `None` when they match, when
/// either hash is unknown, or when the runtime reports no fingerprint (an
/// older runtime). The TypeScript REPL prints the same text
/// (`formatFreshnessWarning` in `prototype/src/cli.ts`).
pub fn freshness_warning(status: &Value, local_hash: &str) -> Option<String> {
    let runtime = status.get("runtime").unwrap_or(status);
    let runtime_hash = runtime.get("fingerprint")?.get("contentHash")?.as_str()?;
    if !runtime_hash.starts_with("sha256:") || !local_hash.starts_with("sha256:") || runtime_hash == local_hash {
        return None;
    }
    Some(if runtime.get("autostarted").and_then(Value::as_bool) == Some(true) {
        "warning: runtime is behind the working tree; dyfj started it, so it \
         stops 10 s after its last client disconnects and the next dyfj loads \
         the current code"
            .into()
    } else {
        "warning: runtime is behind the working tree; it was started with \
         `dyfj start`, so restart it to load the current code: `dyfj stop`, \
         then `dyfj start`"
            .into()
    })
}

/// The content hash of the source tree at `root`, as the runtime records it
/// (`prototype/src/config/code-fingerprint.ts`), so the two can be compared.
/// Every regular file under `root`, skipping any entry whose name starts with
/// `.`; sorted by relative path (`/`-separated, compared as bytes); SHA-256
/// over, for each file, its path, a NUL, its length in decimal, a NUL, and its
/// content; `sha256:<hex>`. Symlinks are skipped, neither followed nor
/// hashed. Any read error gives `unknown`, never a partial hash.
/// `prototype/testing/fixtures/code-fingerprint` pins both implementations
/// to one test vector.
pub fn source_tree_hash(root: &Path) -> String {
    fn collect(root: &Path, prefix: &str, files: &mut Vec<String>) -> std::io::Result<()> {
        let dir = if prefix.is_empty() { root.to_path_buf() } else { root.join(prefix) };
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                // A name that is not UTF-8 cannot be hashed the way the
                // runtime hashes it.
                return Err(std::io::Error::other("non-UTF-8 file name"));
            };
            if name.starts_with('.') {
                continue;
            }
            let relative = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            // `file_type` does not follow symlinks, so a symlink is neither.
            let kind = entry.file_type()?;
            if kind.is_dir() {
                collect(root, &relative, files)?;
            } else if kind.is_file() {
                files.push(relative);
            }
        }
        Ok(())
    }
    let hash = || -> std::io::Result<String> {
        let mut files = Vec::new();
        collect(root, "", &mut files)?;
        files.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
        let mut hasher = Sha256::new();
        for relative in &files {
            let content = std::fs::read(root.join(relative))?;
            hasher.update(format!("{relative}\0{}\0", content.len()).as_bytes());
            hasher.update(&content);
        }
        let hex: String = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(format!("sha256:{hex}"))
    };
    hash().unwrap_or_else(|_| FINGERPRINT_UNKNOWN.to_string())
}

fn posture_line(status: &Value, session: &Session, socket: &str) -> String {
    let runtime = status.get("runtime").unwrap_or(status);
    let mut parts: Vec<String> = Vec::new();

    let default = runtime.get("defaultTurnModel");
    let default_slug = default.and_then(|m| m.get("slug")).and_then(Value::as_str);
    let restored = session.model_origin == ModelOrigin::Restored;
    if let Some(chosen) = session.model.as_deref().filter(|m| Some(*m) != default_slug) {
        // The status describes only the default model, so a different choice
        // is named without a tier or locality this line could not vouch for.
        let origin = if restored { "restored from session" } else { "chosen" };
        parts.push(format!("{} ({origin})", visible(chosen)));
    } else if let Some(model) = default {
        let slug = model.get("slug").and_then(Value::as_str).unwrap_or("unknown model");
        parts.push(visible(slug));
        if let Some(tier) = model.get("tier").and_then(Value::as_i64) {
            parts.push(format!("tier {tier}"));
        }
        match model.get("local").and_then(Value::as_bool) {
            Some(true) => parts.push("local".into()),
            Some(false) => parts.push("hosted".into()),
            None => {}
        }
        if restored {
            parts.push("restored from session".into());
        }
    }
    // A resumed session with no recorded model runs on the default, as every
    // resume did before the runtime recorded one; say so rather than imply
    // the default is the model its history was built on.
    if session.model_origin == ModelOrigin::Unrecorded {
        parts.push("no recorded model for this session".into());
    }
    // Both states are shown, as the TypeScript posture line shows them: the
    // default of paid off is the one an operator most needs to see, because
    // it is why a hosted turn is refused. An absent field narrows the line.
    if session.fast == Some(true) {
        parts.push("fast".into());
    }
    match runtime.get("approvePaidDefault").and_then(Value::as_bool) {
        _ if session.approve_paid => parts.push("paid approved for this session".into()),
        Some(true) => parts.push("paid approved".into()),
        Some(false) => parts.push("paid off (hosted turns fail closed)".into()),
        None => {}
    }
    if let Some(level) = runtime.get("permissionLevel").and_then(Value::as_str) {
        parts.push(format!("permission {}", visible(level)));
    }
    if let Some(steps) = runtime.get("maxToolSteps").and_then(Value::as_i64) {
        parts.push(format!("{steps} tool steps"));
    }
    parts.push(socket.to_string());
    format!("posture: {}", parts.join(" · "))
}

/// Lines naming the secret pointers that failed when the runtime started.
/// A provider reading one has no credential until the runtime restarts, so
/// this says so at startup instead of leaving it to the first turn's error.
pub fn unresolved_pointer_warnings(status: &Value) -> Vec<String> {
    let runtime = status.get("runtime").unwrap_or(status);
    let Some(pointers) = runtime.get("unavailableSecrets").and_then(Value::as_array) else {
        return Vec::new();
    };
    if pointers.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<String> = pointers
        .iter()
        .map(|pointer| {
            let field = |key: &str, fallback: &str| {
                visible(pointer.get(key).and_then(Value::as_str).unwrap_or(fallback))
            };
            let label = match (pointer.get("envVar"), pointer.get("name")) {
                (Some(_), _) => field("envVar", "(unnamed)"),
                (None, Some(_)) => format!("[secrets.named] {}", field("name", "(unnamed)")),
                (None, None) => "(unnamed)".into(),
            };
            format!("secret unavailable since start: {label} ({})", field("reason", "unavailable"))
        })
        .collect();
    lines.push(
        "  anything reading these has no credential until the runtime restarts; \
         fix what the reason names (unlock the vault, or correct the resolver \
         command or pointer), then restart it (`dyfj stop`, then start it again)"
            .into(),
    );
    lines
}

#[cfg(test)]
mod tests {
    use super::{line, unresolved_pointer_warnings};
    use crate::session::Session;
    use serde_json::json;

    #[test]
    fn names_each_secret_that_failed_at_start_and_how_to_recover() {
        let status = json!({"runtime": {"unavailableSecrets": [
            {"envVar": "OPENROUTER_API_KEY", "reason": "session probe failed: timed out after 10000ms (locked or unavailable)"},
            {"envVar": "OPENAI_API_KEY", "reason": "skipped: session probe OPENROUTER_API_KEY did not resolve"},
            {"name": "linear", "reason": "skipped"}
        ]}});
        let lines = unresolved_pointer_warnings(&status);
        assert_eq!(lines.len(), 4, "{lines:?}");
        assert!(lines[2].contains("[secrets.named] linear (skipped)"), "{lines:?}");
        assert!(lines[0].contains("OPENROUTER_API_KEY (session probe failed"), "{lines:?}");
        assert!(lines[1].contains("OPENAI_API_KEY"), "{lines:?}");
        assert!(lines[3].contains("restart it"), "{lines:?}");
        assert!(unresolved_pointer_warnings(&json!({"runtime": {}})).is_empty());
        assert!(unresolved_pointer_warnings(&json!({"runtime": {"unavailableSecrets": []}})).is_empty());
        let hostile = json!({"runtime": {"unavailableSecrets": [{"envVar": "X\u{1b}[2J", "reason": "r"}]}});
        assert!(!unresolved_pointer_warnings(&hostile)[0].contains('\u{1b}'));
    }

    #[test]
    fn renders_the_fields_the_runtime_reports() {
        let status = json!({"runtime": {
            "defaultTurnModel": {"slug": "claude-haiku-4-5", "tier": 1, "local": false},
            "approvePaidDefault": true,
            "permissionLevel": "operator",
            "maxToolSteps": 32
        }});
        let rendered = line(&status, &Session::default(), "/tmp/s.sock");
        assert!(rendered.contains("claude-haiku-4-5"), "{rendered}");
        assert!(rendered.contains("tier 1"), "{rendered}");
        assert!(rendered.contains("hosted"), "{rendered}");
        assert!(rendered.contains("paid approved"), "{rendered}");
        assert!(rendered.contains("32 tool steps"), "{rendered}");
        assert!(rendered.contains("/tmp/s.sock"), "{rendered}");
    }

    /// The command line's choices override the runtime's defaults on the
    /// first turn, so the line announces them rather than the defaults.
    #[test]
    fn the_sessions_own_choices_replace_the_runtime_defaults() {
        let status = json!({"runtime": {
            "defaultTurnModel": {"slug": "local/qwen", "tier": 0, "local": true},
            "approvePaidDefault": false
        }});
        let chosen = Session {
            model: Some("z-ai/glm-5.2".into()),
            fast: Some(true),
            approve_paid: true,
            ..Session::default()
        };
        let rendered = line(&status, &chosen, "/tmp/s.sock");
        assert!(rendered.contains("z-ai/glm-5.2 (chosen)"), "{rendered}");
        assert!(!rendered.contains("local/qwen") && !rendered.contains("tier 0"), "{rendered}");
        assert!(rendered.contains("fast"), "{rendered}");
        assert!(rendered.contains("paid approved for this session"), "{rendered}");
        assert!(!rendered.contains("fail closed"), "{rendered}");

        let same = Session { model: Some("local/qwen".into()), ..Session::default() };
        let rendered = line(&status, &same, "/tmp/s.sock");
        assert!(rendered.contains("local/qwen · tier 0 · local"), "{rendered}");
    }

    /// A resumed session names the model it was restored to, whether or not
    /// that is the runtime's default; one with nothing recorded says so.
    #[test]
    fn a_resumed_session_names_its_restored_model_or_its_absence() {
        let status = json!({"runtime": {
            "defaultTurnModel": {"slug": "local/qwen", "tier": 0, "local": true}
        }});
        let mut hosted = Session::default();
        hosted.restore_model(Some("claude-sonnet-5".into()));
        let rendered = line(&status, &hosted, "/tmp/s.sock");
        assert!(rendered.contains("claude-sonnet-5 (restored from session)"), "{rendered}");
        assert!(!rendered.contains("local/qwen"), "{rendered}");

        let mut local = Session::default();
        local.restore_model(Some("local/qwen".into()));
        let rendered = line(&status, &local, "/tmp/s.sock");
        assert!(rendered.contains("local/qwen · tier 0 · local · restored from session"), "{rendered}");

        let mut unrecorded = Session::default();
        unrecorded.restore_model(None);
        let rendered = line(&status, &unrecorded, "/tmp/s.sock");
        assert!(rendered.contains("local/qwen · tier 0 · local"), "{rendered}");
        assert!(rendered.contains("no recorded model for this session"), "{rendered}");
        assert!(!rendered.contains("restored"), "{rendered}");
    }

    /// A runtime that stops reporting a field must not cost a failed startup.
    /// Runtime-supplied strings reach the terminal through this line. Testing
    /// the sanitiser directly would not catch a field that forgot to call it,
    /// which is how the error paths were missed, so this drives `line`.
    #[test]
    fn hostile_runtime_strings_cannot_escape_through_the_posture_line() {
        let status = json!({"runtime": {
            "defaultTurnModel": {"slug": "evil\u{1b}[2Jmodel", "tier": 1, "local": false},
            "permissionLevel": "operator\u{7}"
        }});
        let rendered = line(&status, &Session::default(), "/tmp/s.sock");
        assert!(!rendered.contains('\u{1b}'), "escape survived: {rendered:?}");
        assert!(!rendered.contains('\u{7}'), "bell survived: {rendered:?}");
        assert!(rendered.contains("model"), "text must not be dropped: {rendered:?}");
    }

    #[test]
    fn degrades_to_whatever_is_present() {
        let rendered = line(&json!({"runtime": {}}), &Session::default(), "/tmp/s.sock");
        assert_eq!(rendered, "posture: /tmp/s.sock");
    }

    #[test]
    fn a_local_model_says_local_not_paid() {
        let status = json!({"runtime": {
            "defaultTurnModel": {"slug": "qwen", "tier": 0, "local": true},
            "approvePaidDefault": false
        }});
        let rendered = line(&status, &Session::default(), "/tmp/s.sock");
        assert!(rendered.contains("local"), "{rendered}");
        assert!(!rendered.contains("paid approved"), "{rendered}");
        assert!(rendered.contains("paid off (hosted turns fail closed)"), "{rendered}");
    }

    #[test]
    fn an_unreported_paid_default_is_left_out() {
        let status = json!({"runtime": {"permissionLevel": "operator"}});
        let rendered = line(&status, &Session::default(), "/tmp/s.sock");
        assert!(!rendered.contains("paid"), "{rendered}");
    }

    mod freshness {
        use super::super::{FINGERPRINT_UNKNOWN, freshness_warning, line, line_with_local_hash, source_tree_hash};
        use crate::session::Session;
        use serde_json::json;
        use std::fs;
        use std::path::{Path, PathBuf};

        const LOCAL: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const OLD: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

        fn fixture() -> PathBuf {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../prototype/testing/fixtures/code-fingerprint")
        }

        fn expected_hash() -> String {
            fs::read_to_string(fixture().join("expected-hash.txt")).unwrap().trim().to_string()
        }

        /// A writable copy of the fixture tree, removed when dropped.
        struct TreeCopy(PathBuf);
        impl Drop for TreeCopy {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        fn copy_dir(from: &Path, to: &Path) {
            fs::create_dir_all(to).unwrap();
            for entry in fs::read_dir(from).unwrap() {
                let entry = entry.unwrap();
                let target = to.join(entry.file_name());
                if entry.file_type().unwrap().is_dir() {
                    copy_dir(&entry.path(), &target);
                } else {
                    fs::copy(entry.path(), target).unwrap();
                }
            }
        }
        fn tree_copy() -> TreeCopy {
            let dir = std::env::temp_dir().join(format!("dyfj-fingerprint-{}", uuid::Uuid::new_v4()));
            copy_dir(&fixture().join("tree"), &dir);
            TreeCopy(dir)
        }

        #[test]
        fn hashes_the_shared_fixture_tree_to_the_shared_expected_value() {
            assert_eq!(source_tree_hash(&fixture().join("tree")), expected_hash());
        }

        #[test]
        fn skips_symlinks_without_following_them() {
            let tree = tree_copy();
            std::os::unix::fs::symlink(tree.0.join("a.txt"), tree.0.join("link-to-file.txt")).unwrap();
            std::os::unix::fs::symlink(tree.0.join("nested"), tree.0.join("link-to-dir")).unwrap();
            assert_eq!(source_tree_hash(&tree.0), expected_hash());
        }

        #[test]
        fn a_changed_file_changes_the_hash() {
            let tree = tree_copy();
            fs::write(tree.0.join("a.txt"), "export const a = 2;\n").unwrap();
            assert_ne!(source_tree_hash(&tree.0), expected_hash());
        }

        #[test]
        fn an_unreadable_tree_is_unknown_never_partial() {
            use std::os::unix::fs::PermissionsExt;
            if unsafe { libc::geteuid() } == 0 {
                return;
            }
            let tree = tree_copy();
            let file = tree.0.join("nested/c.txt");
            fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
            assert_eq!(source_tree_hash(&tree.0), FINGERPRINT_UNKNOWN);
            assert_eq!(source_tree_hash(&tree.0.join("missing")), FINGERPRINT_UNKNOWN);
        }

        #[test]
        fn warns_when_the_runtime_is_behind_and_says_how_it_recovers() {
            let manual = json!({"runtime": {"autostarted": false, "fingerprint": {"head": "x", "contentHash": OLD}}});
            let warning = freshness_warning(&manual, LOCAL).expect("behind");
            assert!(warning.starts_with("warning: runtime is behind the working tree; "), "{warning}");
            assert!(warning.contains("`dyfj stop`, then `dyfj start`"), "{warning}");

            let auto = json!({"runtime": {"autostarted": true, "fingerprint": {"head": "x", "contentHash": OLD}}});
            let warning = freshness_warning(&auto, LOCAL).expect("behind");
            assert!(warning.contains("10 s after its last client"), "{warning}");

            let rendered = line_with_local_hash(&manual, &Session::default(), "/tmp/s.sock", LOCAL);
            let mut lines = rendered.lines();
            assert_eq!(lines.next(), Some("posture: /tmp/s.sock"));
            assert!(lines.next().unwrap().starts_with("warning: runtime is behind the working tree"));
        }

        #[test]
        fn says_nothing_when_current_or_either_side_is_unknown() {
            let current = json!({"runtime": {"fingerprint": {"head": "x", "contentHash": LOCAL}}});
            assert_eq!(freshness_warning(&current, LOCAL), None);
            let stale = json!({"runtime": {"fingerprint": {"head": "x", "contentHash": OLD}}});
            assert_eq!(freshness_warning(&stale, FINGERPRINT_UNKNOWN), None);
            let unknown = json!({"runtime": {"fingerprint": {"head": "unknown", "contentHash": "unknown"}}});
            assert_eq!(freshness_warning(&unknown, LOCAL), None);
            assert_eq!(freshness_warning(&json!({"runtime": {}}), LOCAL), None);
            assert_eq!(freshness_warning(&json!({"runtime": {"fingerprint": {"contentHash": 7}}}), LOCAL), None);
        }

        /// An older client ignores the new fields: the posture line it
        /// renders is the same with or without them.
        #[test]
        fn the_new_status_fields_leave_the_posture_line_unchanged() {
            let before = json!({"runtime": {
                "defaultTurnModel": {"slug": "qwen", "tier": 0, "local": true},
                "permissionLevel": "strict"
            }});
            let mut after = before.clone();
            after["runtime"]["fingerprint"] = json!({"head": "x", "contentHash": LOCAL});
            after["runtime"]["clients"] = json!(2);
            after["runtime"]["inFlightTurns"] = json!(1);
            assert_eq!(
                line_with_local_hash(&after, &Session::default(), "/tmp/s.sock", LOCAL),
                line(&before, &Session::default(), "/tmp/s.sock"),
            );
        }
    }
}
