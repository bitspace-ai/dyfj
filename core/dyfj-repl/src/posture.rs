//! The startup posture line.
//!
//! Without it the operator cannot tell which model they are talking to, or
//! whether they are talking to one at all. That was the first thing missing
//! when this front-end was first driven by hand.

use crate::approval::visible;
use serde_json::Value;

/// Render the posture from a `runtime/status` result. Every field is optional:
/// a runtime that stops reporting one should cost a narrower line, not a
/// failed startup.
pub fn line(status: &Value, socket: &str) -> String {
    let runtime = status.get("runtime").unwrap_or(status);
    let mut parts: Vec<String> = Vec::new();

    if let Some(model) = runtime.get("defaultTurnModel") {
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
    }
    // Both states are shown, as the TypeScript posture line shows them: the
    // default of paid off is the one an operator most needs to see, because
    // it is why a hosted turn is refused. An absent field narrows the line.
    match runtime.get("approvePaidDefault").and_then(Value::as_bool) {
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
         unlock the vault, then restart it (`dyfj stop`, then start it again)"
            .into(),
    );
    lines
}

#[cfg(test)]
mod tests {
    use super::{line, unresolved_pointer_warnings};

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
    use serde_json::json;

    #[test]
    fn renders_the_fields_the_runtime_reports() {
        let status = json!({"runtime": {
            "defaultTurnModel": {"slug": "claude-haiku-4-5", "tier": 1, "local": false},
            "approvePaidDefault": true,
            "permissionLevel": "operator",
            "maxToolSteps": 32
        }});
        let rendered = line(&status, "/tmp/s.sock");
        assert!(rendered.contains("claude-haiku-4-5"), "{rendered}");
        assert!(rendered.contains("tier 1"), "{rendered}");
        assert!(rendered.contains("hosted"), "{rendered}");
        assert!(rendered.contains("paid approved"), "{rendered}");
        assert!(rendered.contains("32 tool steps"), "{rendered}");
        assert!(rendered.contains("/tmp/s.sock"), "{rendered}");
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
        let rendered = line(&status, "/tmp/s.sock");
        assert!(!rendered.contains('\u{1b}'), "escape survived: {rendered:?}");
        assert!(!rendered.contains('\u{7}'), "bell survived: {rendered:?}");
        assert!(rendered.contains("model"), "text must not be dropped: {rendered:?}");
    }

    #[test]
    fn degrades_to_whatever_is_present() {
        let rendered = line(&json!({"runtime": {}}), "/tmp/s.sock");
        assert_eq!(rendered, "posture: /tmp/s.sock");
    }

    #[test]
    fn a_local_model_says_local_not_paid() {
        let status = json!({"runtime": {
            "defaultTurnModel": {"slug": "qwen", "tier": 0, "local": true},
            "approvePaidDefault": false
        }});
        let rendered = line(&status, "/tmp/s.sock");
        assert!(rendered.contains("local"), "{rendered}");
        assert!(!rendered.contains("paid approved"), "{rendered}");
        assert!(rendered.contains("paid off (hosted turns fail closed)"), "{rendered}");
    }

    #[test]
    fn an_unreported_paid_default_is_left_out() {
        let status = json!({"runtime": {"permissionLevel": "operator"}});
        let rendered = line(&status, "/tmp/s.sock");
        assert!(!rendered.contains("paid"), "{rendered}");
    }
}
