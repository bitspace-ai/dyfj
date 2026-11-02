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
        "toolCallStarted" => Some(format!("  → {}", call_label(event))),
        "toolCallCompleted" => Some(format!("  {}", completed_call(event))),
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
        // The external-agent (ACP) route reports its tool calls only as
        // titled progress patches, with no call id. A call's end is a line;
        // the status line names the one in progress.
        "agentProgress" => {
            if event.get("kind").and_then(Value::as_str) != Some("tool_call") {
                return None;
            }
            let mark = match event.get("status").and_then(Value::as_str) {
                Some("completed") => "✓",
                Some("failed") => "✗",
                _ => return None,
            };
            Some(format!("  {mark} {} (external agent)", agent_progress_title(event)?))
        }
        // Bookkeeping the operator does not need narrated. Observed on a live
        // runtime: sessionStart, inputReceived, contextBuilt, modelSelected,
        // beforeProviderRequest, afterProviderResponse, turnCompleted.
        _ => None,
    }
}

/// How a completed call turned out, as its line marks it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Ran, and reported nothing wrong.
    Ok,
    /// Ran without a tool error, but its result says something went wrong: a
    /// command's non-zero exit, a timeout, or a tool's `error:` reply. The
    /// model reads these as output, so the runtime does not count them as
    /// failures, and a model can go on to report success over one.
    Reported,
    /// The tool itself failed.
    Failed,
    /// Not approved, so it did not run.
    NotApproved,
}

impl Outcome {
    pub fn mark(self) -> &'static str {
        match self {
            Outcome::Ok => "✓",
            Outcome::Reported => "!",
            Outcome::Failed => "✗",
            Outcome::NotApproved => "⊘",
        }
    }
}

/// The outcome a `toolCallCompleted` frame reports.
pub fn outcome(event: &Value) -> Outcome {
    if event.get("verdict").and_then(Value::as_str) == Some("approval_denied") {
        return Outcome::NotApproved;
    }
    if event.get("isError").and_then(Value::as_bool) == Some(true) {
        return Outcome::Failed;
    }
    match result_status(event) {
        Some(status) if status != "exit 0" => Outcome::Reported,
        _ => Outcome::Ok,
    }
}

/// The `resultStatus` a frame carries, when it carries a non-empty one.
fn result_status(event: &Value) -> Option<&str> {
    event
        .get("resultStatus")
        .and_then(Value::as_str)
        .filter(|status| !status.is_empty())
}

/// A status as a summary shows it: a timeout's header without the kill
/// details the call's own line already gave.
pub fn short_status(status: &str) -> String {
    let status = match status.split_once(" (killed") {
        Some((head, _)) if status.starts_with("timed out after ") => head,
        _ => status,
    };
    bounded(status, 40)
}

/// The title of an ACP tool-call progress frame, or its name.
pub fn agent_progress_title(event: &Value) -> Option<String> {
    event
        .get("title")
        .or_else(|| event.get("name"))
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .map(|title| bounded(title, MAX_SUBJECT_CHARS))
}

/// The longest subject a line shows, in characters. The runtime caps it at
/// 120 bytes; this holds for any runtime, and keeps a line on one row.
const MAX_SUBJECT_CHARS: usize = 80;

/// The tool's name and, when the runtime sends one, what it acted on: the
/// path, pattern or command. Ten `read_file` lines that do not say which file
/// tell the operator almost nothing.
pub fn call_label(event: &Value) -> String {
    let name = event.get("commandId").and_then(Value::as_str).unwrap_or("tool");
    let name = crate::approval::visible(name);
    match event.get("subject").and_then(Value::as_str) {
        Some(subject) if !subject.trim().is_empty() => {
            format!("{name} {}", bounded(subject, MAX_SUBJECT_CHARS))
        }
        _ => name,
    }
}

/// A completed call's line, without indentation: mark, label, duration, and
/// the status or failure reason that explains the mark.
pub fn completed_call(event: &Value) -> String {
    let outcome = outcome(event);
    let label = call_label(event);
    // The call was not approved, so it did not run. The frame does not say
    // whether the operator declined or the prompt produced no decision, so
    // this line claims neither. No duration: the time on it is the wait, not
    // execution.
    if outcome == Outcome::NotApproved {
        return format!("⊘ {label} not approved");
    }
    let mut line = format!("{} {label}", outcome.mark());
    if let Some(ms) = event.get("durationMs").and_then(Value::as_i64) {
        line.push_str(&format!(" ({})", duration(ms)));
    }
    match outcome {
        // Why it failed, when the runtime says: a ✗ with only a duration left
        // the operator guessing.
        Outcome::Failed => {
            if let Some(reason) = event
                .get("failureReason")
                .and_then(Value::as_str)
                .filter(|reason| !reason.is_empty())
            {
                line.push_str(&format!(": {}", bounded_reason(reason)));
            }
        }
        // A command's exit status, shown as reported; anything but `exit 0`
        // is why the mark is not a ✓.
        Outcome::Ok | Outcome::Reported => {
            if let Some(status) = result_status(event) {
                line.push_str(&format!(" · {}", bounded_reason(status)));
            }
        }
        Outcome::NotApproved => {}
    }
    line
}

/// A duration as an operator reads it: milliseconds under a second, then
/// tenths of a second, then minutes and seconds.
pub fn duration(ms: i64) -> String {
    let ms = ms.max(0);
    if ms < 1_000 {
        format!("{ms}ms")
    } else if ms < 60_000 {
        format!("{:.1}s", ms as f64 / 1_000.0)
    } else {
        format!("{}m{:02}s", ms / 60_000, (ms % 60_000) / 1_000)
    }
}

/// The longest failure reason a ✗ line shows, in characters. The runtime
/// already caps it at 160 bytes; this holds for any runtime.
const MAX_REASON_CHARS: usize = 160;

/// A runtime-supplied reason, made terminal-safe and cut to one short line.
fn bounded_reason(reason: &str) -> String {
    bounded(reason, MAX_REASON_CHARS)
}

/// Runtime-supplied text made terminal-safe and cut to `max` characters.
pub fn bounded(text: &str, max: usize) -> String {
    let visible = crate::approval::visible(text);
    if visible.chars().count() <= max {
        return visible;
    }
    let mut cut: String = visible.chars().take(max).collect();
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
            Some("  ✗ mcp.linear.save_comment (1.7s): upstream error: Error: Could not find issue \"BIT-99999\"")
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
        assert!(rendered.starts_with("  ✗ web_fetch (30.0s): timed out "), "{rendered:?}");
        assert!(rendered.chars().count() <= "  ✗ web_fetch (30.0s): ".chars().count() + 161, "{rendered:?}");
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

    /// A call names what it acted on, so ten reads are ten different files.
    #[test]
    fn a_call_line_names_its_subject() {
        assert_eq!(
            describe(&json!({"type": "toolCallStarted", "commandId": "read_file", "subject": "src/a.ts"}))
                .as_deref(),
            Some("  → read_file src/a.ts")
        );
        assert_eq!(
            describe(&json!({
                "type": "toolCallCompleted", "commandId": "read_file", "subject": "src/a.ts",
                "isError": false, "durationMs": 4
            }))
            .as_deref(),
            Some("  ✓ read_file src/a.ts (4ms)")
        );
    }

    /// A command that exits non-zero ran without a tool error, so the runtime
    /// does not call it a failure. It is still not a ✓: a model that ran the
    /// tests and saw them fail can say they pass, and this line is what
    /// contradicts it.
    #[test]
    fn a_non_zero_exit_is_marked_as_a_reported_problem() {
        assert_eq!(
            describe(&json!({
                "type": "toolCallCompleted", "commandId": "bash", "subject": "npm test",
                "isError": false, "durationMs": 3200, "resultStatus": "exit 1"
            }))
            .as_deref(),
            Some("  ! bash npm test (3.2s) · exit 1")
        );
        assert_eq!(
            describe(&json!({
                "type": "toolCallCompleted", "commandId": "bash", "subject": "npm test",
                "isError": false, "durationMs": 3200, "resultStatus": "exit 0"
            }))
            .as_deref(),
            Some("  ✓ bash npm test (3.2s) · exit 0")
        );
        assert_eq!(
            describe(&json!({
                "type": "toolCallCompleted", "commandId": "read_file", "subject": "missing.txt",
                "isError": false, "durationMs": 5,
                "resultStatus": "error: cannot read missing.txt: not found"
            }))
            .as_deref(),
            Some("  ! read_file missing.txt (5ms) · error: cannot read missing.txt: not found")
        );
    }

    #[test]
    fn a_subject_is_made_safe_and_bounded() {
        let line = describe(&json!({
            "type": "toolCallStarted", "commandId": "bash",
            "subject": format!("echo \u{1b}[2J{}", "y".repeat(300))
        }))
        .expect("a line");
        assert!(!line.contains('\u{1b}'), "{line:?}");
        assert!(line.ends_with('…'), "{line:?}");
        assert!(line.chars().count() <= "  → bash ".chars().count() + 81, "{line:?}");
    }

    #[test]
    fn durations_read_as_an_operator_reads_them() {
        use super::duration;
        assert_eq!(duration(999), "999ms");
        assert_eq!(duration(1_000), "1.0s");
        assert_eq!(duration(59_949), "59.9s");
        assert_eq!(duration(61_000), "1m01s");
        assert_eq!(duration(-5), "0ms");
    }

    #[test]
    fn ignores_an_event_with_no_type() {
        assert_eq!(describe(&json!({"step": 1})), None);
    }

    #[test]
    fn reports_the_step_limit_because_it_explains_a_short_turn() {
        assert!(describe(&json!({"type": "toolStepLimitReached"})).is_some());
    }

    /// The header `describeTimeout` writes, as the probe turn produced it.
    #[test]
    fn a_timeout_status_is_shortened_for_the_summary() {
        use super::short_status;
        assert_eq!(
            short_status("timed out after 3000ms (killed; output shown up to the deadline)"),
            "timed out after 3000ms"
        );
        assert_eq!(short_status("timed out after 3000ms (killed)"), "timed out after 3000ms");
        assert_eq!(short_status("exit 7"), "exit 7");
    }

    /// ACP progress names a call by title only; its end is one line.
    #[test]
    fn external_agent_tool_calls_end_with_a_line() {
        let progress = |status: &str| {
            describe(&json!({
                "type": "agentProgress", "kind": "tool_call", "title": "Run npm test", "status": status
            }))
        };
        assert_eq!(progress("in_progress"), None);
        assert_eq!(progress("completed").as_deref(), Some("  ✓ Run npm test (external agent)"));
        assert_eq!(progress("failed").as_deref(), Some("  ✗ Run npm test (external agent)"));
        assert_eq!(describe(&json!({"type": "agentProgress", "kind": "thought"})), None);
    }
}
