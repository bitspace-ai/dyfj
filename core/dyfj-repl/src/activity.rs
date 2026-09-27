//! Turn activity, rendered from event frames.
//!
//! An agentic turn on a provider whose tool-offering calls are buffered
//! streams no text at all: the operator sees nothing between submitting and
//! the answer, which for a multi-step turn is minutes of silence. The event
//! frames are the only evidence a turn is progressing, so they are what the
//! operator gets to watch.

use serde_json::Value;

/// The event that abandons everything streamed so far.
///
/// Emitted between the deltas of an attempt the runtime gave up on and the
/// deltas of the retry replacing it. Whatever was shown before it is stale:
/// the retry's answer replaces that text rather than continuing it.
pub const SUPERSEDING_RETRY: &str = "supersedingRetryStarted";

/// What the operator sees when output is superseded. A marker rather than a
/// screen clear: the abandoned text stays in scrollback, where it can be
/// compared, but it is fenced off from what follows.
pub const SUPERSEDED_MARKER: &str =
    "· the answer above was abandoned; the runtime is starting again";

/// One line of progress, or None for events not worth showing.
///
/// The discriminator is `type`. Every field below was observed on a live
/// runtime rather than inferred: an earlier version of this keyed on `kind`,
/// which does not exist, so it silently rendered nothing for a whole turn.
pub fn describe(event: &Value) -> Option<String> {
    let event_type = event.get("type").and_then(Value::as_str)?;
    match event_type {
        "toolStepStarted" => {
            let step = event.get("step").and_then(Value::as_i64)?;
            match event.get("toolCallCount").and_then(Value::as_i64) {
                Some(1) => Some(format!("· step {step}: 1 call")),
                Some(count) => Some(format!("· step {step}: {count} calls")),
                None => Some(format!("· step {step}")),
            }
        }
        "toolCallStarted" => {
            let name = event.get("commandId").and_then(Value::as_str).unwrap_or("tool");
            Some(format!("  → {}", crate::approval::visible(name)))
        }
        "toolCallCompleted" => {
            let name = event.get("commandId").and_then(Value::as_str).unwrap_or("tool");
            // isError is reported per call; a failed tool is the thing an
            // operator most needs to see in a long turn.
            let mark = if event.get("isError").and_then(Value::as_bool) == Some(true) {
                "✗"
            } else {
                "✓"
            };
            let name = crate::approval::visible(name);
            match event.get("durationMs").and_then(Value::as_i64) {
                Some(ms) => Some(format!("  {mark} {name} ({ms}ms)")),
                None => Some(format!("  {mark} {name}")),
            }
        }
        "toolStepLimitReached" => {
            Some("· tool step limit reached; the turn stopped early".into())
        }
        // The runtime emitted text shaped like a tool call that executed
        // nothing. Without this the operator reads prose describing tool
        // activity that never happened.
        "unparsedToolCallMarkupDetected" => {
            Some("· the model wrote tool-call markup that ran no tools".into())
        }
        // Bookkeeping the operator does not need narrated. Observed on a live
        // runtime: sessionStart, inputReceived, contextBuilt, modelSelected,
        // beforeProviderRequest, afterProviderResponse, turnCompleted.
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::describe;
    use serde_json::json;

    /// Shapes captured from a live runtime turn, not invented.
    #[test]
    fn narrates_a_tool_step_as_the_runtime_reports_it() {
        assert_eq!(
            describe(&json!({"type": "toolStepStarted", "step": 1, "toolCallCount": 1}))
                .as_deref(),
            Some("· step 1: 1 call")
        );
        assert_eq!(
            describe(&json!({"type": "toolStepStarted", "step": 2, "toolCallCount": 3}))
                .as_deref(),
            Some("· step 2: 3 calls")
        );
        assert_eq!(
            describe(&json!({"type": "toolCallStarted", "commandId": "list_files"}))
                .as_deref(),
            Some("  → list_files")
        );
        assert_eq!(
            describe(&json!({
                "type": "toolCallCompleted", "commandId": "list_files",
                "isError": false, "durationMs": 11
            }))
            .as_deref(),
            Some("  ✓ list_files (11ms)")
        );
    }

    #[test]
    fn a_failed_tool_call_is_marked_differently() {
        let rendered = describe(&json!({
            "type": "toolCallCompleted", "commandId": "bash",
            "isError": true, "durationMs": 4
        }));
        assert_eq!(rendered.as_deref(), Some("  ✗ bash (4ms)"));
    }

    /// Guards the defect this module was rewritten for: keying on a field the
    /// runtime does not send renders nothing at all.
    #[test]
    fn keys_on_type_not_kind() {
        assert_eq!(describe(&json!({"kind": "toolCallStarted", "commandId": "x"})), None);
        assert!(describe(&json!({"type": "toolCallStarted", "commandId": "x"})).is_some());
    }

    /// Observed on a live runtime; none deserves a line of attention.
    #[test]
    fn stays_quiet_for_lifecycle_bookkeeping() {
        for event_type in [
            "sessionStart",
            "inputReceived",
            "contextBuilt",
            "modelSelected",
            "beforeProviderRequest",
            "afterProviderResponse",
            "turnCompleted",
        ] {
            assert_eq!(describe(&json!({"type": event_type})), None, "{event_type}");
        }
    }

    #[test]
    fn warns_that_tool_markup_ran_nothing() {
        let rendered = describe(&json!({"type": "unparsedToolCallMarkupDetected"}));
        assert!(rendered.is_some(), "the operator must be told nothing ran");
    }

    #[test]
    fn ignores_an_event_with_no_type() {
        assert_eq!(describe(&json!({"step": 1})), None);
    }

    #[test]
    fn reports_the_step_limit_because_it_explains_a_short_turn() {
        assert!(describe(&json!({"type": "toolStepLimitReached"})).is_some());
    }
}
