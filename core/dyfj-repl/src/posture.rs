//! The startup posture line.
//!
//! Without it the operator cannot tell which model they are talking to, or
//! whether they are talking to one at all. That was the first thing missing
//! when this front-end was first driven by hand.

use crate::approval::visible;
use crate::session::Session;
use serde_json::Value;

/// Render the posture from a `runtime/status` result and the choices the
/// command line made for this session, which override the runtime's defaults
/// on the first turn. Every status field is optional: a runtime that stops
/// reporting one should cost a narrower line, not a failed startup.
pub fn line(status: &Value, session: &Session, socket: &str) -> String {
    let runtime = status.get("runtime").unwrap_or(status);
    let mut parts: Vec<String> = Vec::new();

    let default = runtime.get("defaultTurnModel");
    let default_slug = default.and_then(|m| m.get("slug")).and_then(Value::as_str);
    if let Some(chosen) = session.model.as_deref().filter(|m| Some(*m) != default_slug) {
        // The status describes only the default model, so a different choice
        // is named without a tier or locality this line could not vouch for.
        parts.push(format!("{} (chosen)", visible(chosen)));
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

#[cfg(test)]
mod tests {
    use super::line;
    use crate::session::Session;
    use serde_json::json;

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
}
