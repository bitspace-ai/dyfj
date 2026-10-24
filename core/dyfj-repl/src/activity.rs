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
            // The call was not approved, so it did not run. The frame does
            // not say whether the operator declined or the prompt produced no
            // decision, so this line claims neither. No duration: the time on
            // it is the wait, not execution.
            if event.get("verdict").and_then(Value::as_str) == Some("approval_denied") {
                return Some(format!(
                    "  ⊘ {} not approved",
                    crate::approval::visible(name)
                ));
            }
            // isError is reported per call; a failed tool is the thing an
            // operator most needs to see in a long turn.
            let mark = if event.get("isError").and_then(Value::as_bool) == Some(true) {
                "✗"
            } else {
                "✓"
            };
            let name = crate::approval::visible(name);
            let line = match event.get("durationMs").and_then(Value::as_i64) {
                Some(ms) => format!("  {mark} {name} ({ms}ms)"),
                None => format!("  {mark} {name}"),
            };
            // Why it failed, when the runtime says: a ✗ with only a duration
            // left the operator guessing.
            match event.get("failureReason").and_then(Value::as_str) {
                Some(reason) if mark == "✗" && !reason.is_empty() => {
                    Some(format!("{line}: {}", bounded_reason(reason)))
                }
                _ => Some(line),
            }
        }
        "toolStepLimitReached" => match event.get("maxSteps").and_then(Value::as_i64) {
            Some(max) => Some(format!(
                "· tool step limit reached ({max} steps); asking the model for a handoff"
            )),
            None => Some("· tool step limit reached; asking the model for a handoff".into()),
        },
        // A handoff the model wrote is the reply itself; only the fallback
        // needs saying, because the reply is then the runtime's notice.
        "toolStepLimitHandoff" => (event.get("source").and_then(Value::as_str) == Some("notice"))
            .then(|| {
                "· the handoff call failed; the reply is the runtime's notice of the last tool calls"
                    .into()
            }),
        // A tool result was cut to fit the model's context window; the
        // model got a marker in its place, the session log kept the result.
        "toolResultTrimmed" => {
            let name = event.get("commandId").and_then(Value::as_str).unwrap_or("tool");
            let name = crate::approval::visible(name);
            match (
                event.get("keptChars").and_then(Value::as_i64),
                event.get("totalChars").and_then(Value::as_i64),
            ) {
                (Some(kept), Some(total)) => Some(format!(
                    "  · {name} result trimmed to fit the context window ({kept} of {total} chars kept)"
                )),
                _ => Some(format!("  · {name} result trimmed to fit the context window")),
            }
        }
        // The request would not have fit the window and was made to fit
        // before it went out: without this the operator cannot tell why the
        // model stopped seeing an earlier tool result.
        "contextFitted" => {
            let window = event
                .get("contextWindow")
                .and_then(Value::as_i64)
                .map(|window| format!("{window}-token "))
                .unwrap_or_default();
            let mut what: Vec<String> = Vec::new();
            if let Some(trimmed) = event.get("trimmedToolResults").and_then(Value::as_i64) {
                if trimmed > 0 {
                    what.push(format!("{trimmed} tool result(s) trimmed"));
                }
            }
            if event.get("compressed").and_then(Value::as_bool) == Some(true) {
                what.push("elder turns compressed".into());
            }
            let cause = match event.get("trigger").and_then(Value::as_str) {
                Some("provider_rejected") => " after the provider rejected the request",
                _ => "",
            };
            if what.is_empty() {
                Some(format!("· context fitted to the {window}window{cause}"))
            } else {
                Some(format!(
                    "· context fitted to the {window}window{cause}: {}",
                    what.join(", ")
                ))
            }
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

/// The longest failure reason a ✗ line shows, in characters. The runtime
/// already caps it at 160 bytes; this holds for any runtime.
const MAX_REASON_CHARS: usize = 160;

/// A runtime-supplied reason, made terminal-safe and cut to one short line.
fn bounded_reason(reason: &str) -> String {
    let visible = crate::approval::visible(reason);
    if visible.chars().count() <= MAX_REASON_CHARS {
        return visible;
    }
    let mut cut: String = visible.chars().take(MAX_REASON_CHARS).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use super::describe;
    use serde_json::json;

    #[test]
    fn narrates_the_step_limit_and_a_failed_handoff() {
        assert_eq!(
            describe(&json!({"type": "toolStepLimitReached", "maxSteps": 2})).as_deref(),
            Some("· tool step limit reached (2 steps); asking the model for a handoff")
        );
        assert_eq!(
            describe(&json!({"type": "toolStepLimitHandoff", "maxSteps": 2, "source": "notice"}))
                .as_deref(),
            Some("· the handoff call failed; the reply is the runtime's notice of the last tool calls")
        );
        // The model's handoff is the reply; there is nothing more to say.
        assert_eq!(
            describe(&json!({"type": "toolStepLimitHandoff", "maxSteps": 2, "source": "model"})),
            None
        );
    }

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

    /// A call that was not approved did not run. The line does not say the
    /// operator declined: a failed prompt carries the same verdict. No
    /// duration, because the time on it is the wait.
    #[test]
    fn renders_an_unapproved_call_as_not_approved() {
        assert_eq!(
            describe(&json!({
                "type": "toolCallCompleted", "commandId": "bash",
                "isError": true, "durationMs": 163376, "verdict": "approval_denied"
            }))
            .as_deref(),
            Some("  ⊘ bash not approved")
        );
    }

    /// A real failure keeps its mark and duration, with or without any other
    /// verdict value a later runtime might send.
    #[test]
    fn a_real_failure_still_renders_as_a_failure() {
        assert_eq!(
            describe(&json!({
                "type": "toolCallCompleted", "commandId": "bash",
                "isError": true, "durationMs": 40
            }))
            .as_deref(),
            Some("  ✗ bash (40ms)")
        );
        assert_eq!(
            describe(&json!({
                "type": "toolCallCompleted", "commandId": "bash",
                "isError": true, "durationMs": 40, "verdict": "something_else"
            }))
            .as_deref(),
            Some("  ✗ bash (40ms)")
        );
    }

    #[test]
    fn narrates_window_fitting_as_the_runtime_reports_it() {
        assert_eq!(
            describe(&json!({
                "type": "toolResultTrimmed", "commandId": "read_file", "callId": "c1",
                "contextWindow": 32768, "keptChars": 8192, "totalChars": 65536
            }))
            .as_deref(),
            Some("  · read_file result trimmed to fit the context window (8192 of 65536 chars kept)")
        );
        assert_eq!(
            describe(&json!({
                "type": "contextFitted", "modelSlug": "m", "contextWindow": 32768,
                "budgetTokens": 23347, "estimatedTokensBefore": 47716,
                "estimatedTokensAfter": 18200, "trimmedToolResults": 2,
                "compressed": false, "trigger": "before_send"
            }))
            .as_deref(),
            Some("· context fitted to the 32768-token window: 2 tool result(s) trimmed")
        );
        assert_eq!(
            describe(&json!({
                "type": "contextFitted", "contextWindow": 32768, "trimmedToolResults": 0,
                "compressed": true, "trigger": "provider_rejected"
            }))
            .as_deref(),
            Some("· context fitted to the 32768-token window after the provider rejected the request: elder turns compressed")
        );
    }

    /// The runtime sends why a call failed; the ✗ line carries it, on one
    /// line, so the operator is not left with a mark and a duration.
    #[test]
    fn a_failed_tool_call_shows_its_reason() {
        assert_eq!(
            describe(&json!({
                "type": "toolCallCompleted", "commandId": "mcp.linear.save_comment",
                "isError": true, "durationMs": 1700,
                "failureReason": "upstream error: Error: Could not find issue \"BIT-99999\""
            }))
            .as_deref(),
            Some("  ✗ mcp.linear.save_comment (1700ms): upstream error: Error: Could not find issue \"BIT-99999\"")
        );
    }

    /// The reason is runtime-supplied text: control characters cannot reach
    /// the terminal, and an oversized one is cut rather than flooding it.
    #[test]
    fn a_failure_reason_is_made_safe_and_bounded() {
        let long = format!("timed out\n\u{1b}[2J{}", "x".repeat(500));
        let rendered = describe(&json!({
            "type": "toolCallCompleted", "commandId": "web_fetch",
            "isError": true, "durationMs": 30000, "failureReason": long
        }))
        .expect("a line");
        assert!(!rendered.contains('\u{1b}'), "{rendered:?}");
        assert!(!rendered.contains('\n'), "{rendered:?}");
        assert!(rendered.starts_with("  ✗ web_fetch (30000ms): timed out "), "{rendered:?}");
        assert!(rendered.chars().count() <= "  ✗ web_fetch (30000ms): ".chars().count() + 161, "{rendered:?}");
        assert!(rendered.ends_with('…'), "{rendered:?}");
    }

    /// A successful call never shows a reason, even if one were sent.
    #[test]
    fn a_successful_call_shows_no_reason() {
        assert_eq!(
            describe(&json!({
                "type": "toolCallCompleted", "commandId": "bash",
                "isError": false, "durationMs": 4, "failureReason": "stale"
            }))
            .as_deref(),
            Some("  ✓ bash (4ms)")
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
