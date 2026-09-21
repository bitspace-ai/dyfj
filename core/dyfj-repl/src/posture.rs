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
    if runtime.get("approvePaidDefault").and_then(Value::as_bool) == Some(true) {
        parts.push("paid approved".into());
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
    }
}
