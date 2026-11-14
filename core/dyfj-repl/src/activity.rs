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
/// The discriminator is `type`: an earlier version keyed on `kind`, which
/// is not the event discriminator, so it silently rendered nothing for a
/// whole turn.
/// The maintainer verified the file-change display in an acceptance test
/// with real agent turns on the `codex-chatgpt` route with adapter 2.5.0.
/// Plan display is covered by fixture tests only; no plan update from a
/// real agent has been observed.
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
        "agentProgress" => agent_progress_line(event),
        "childApprovalParked" => child_approval_parked(event),
        "continuityReconstructing" => continuity_reconstructing(event),
        // Bookkeeping the operator does not need narrated. Observed on a live
        // runtime: sessionStart, inputReceived, contextBuilt, modelSelected,
        // beforeProviderRequest, afterProviderResponse, turnCompleted.
        _ => None,
    }
}

/// One-line operator notice before agent output on a reconstructed ACP turn.
/// Built from fixed reason codes and message counts only; an unrecognized
/// reason renders `reason not reported` rather than dropping the line.
fn continuity_reconstructing(event: &Value) -> Option<String> {
    let projected = event.get("priorMessagesProjected").and_then(Value::as_u64)?;
    let left_out = event.get("priorMessagesLeftOut").and_then(Value::as_u64)?;
    let phrase = match event.get("reason").and_then(Value::as_str) {
        Some("idle_limit") => "it was closed after the idle limit",
        Some("capacity") => "it was closed to make room for another session",
        Some("agent_settings_changed") => {
            "the model, effort, workspace or another agent setting changed"
        }
        Some("agent_session_failed") => "it ended with an error",
        Some("released") => "the runtime released it after a one-shot or dispatched turn",
        Some("not_held") => "this runtime holds no agent session for it (for example after a restart)",
        _ => "reason not reported",
    };
    let noun = if projected == 1 {
        "earlier message"
    } else {
        "earlier messages"
    };
    if left_out > 0 {
        Some(format!(
            "· agent session replaced: {phrase}. Sending {projected} {noun}, {left_out} left out."
        ))
    } else {
        Some(format!(
            "· agent session replaced: {phrase}. Sending {projected} {noun}."
        ))
    }
}

/// One-line operator notice built strictly from validated label + session id
/// fields when a dispatched child session parks on an approval. Never carries
/// prompt text or option ids.
pub fn child_approval_parked(event: &Value) -> Option<String> {
    if event.get("type").and_then(Value::as_str) != Some("childApprovalParked") {
        return None;
    }
    let label = event.get("label").and_then(Value::as_str)?;
    if !is_child_label(label) {
        return None;
    }
    let child_id = event.get("childSessionId").and_then(Value::as_str)?;
    if !is_session_id(child_id) {
        return None;
    }
    Some(format!(
        "{label} (child) is waiting for approval: dyfj --session {child_id}"
    ))
}

fn is_child_label(label: &str) -> bool {
    let mut chars = label.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if label.len() > 32 || !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn is_session_id(id: &str) -> bool {
    id.len() == 26
        && id
            .chars()
            .all(|c| c.is_ascii_digit() || (c.is_ascii_alphabetic() && !"IiLlOoUu".contains(c)))
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
    /// A command that completed without reporting its exit status, as a
    /// runtime from before `resultStatus` does. A non-zero exit or a timeout
    /// looks the same, so this is not counted as a success.
    Unknown,
}

/// The tools whose result opens with a process exit status. A non-zero exit
/// or a timeout is output the model reads, not a tool error.
pub const COMMANDS: [&str; 2] = ["bash", "git"];

impl Outcome {
    pub fn mark(self) -> &'static str {
        match self {
            Outcome::Ok => "✓",
            Outcome::Reported => "!",
            Outcome::Failed => "✗",
            Outcome::NotApproved => "⊘",
            Outcome::Unknown => "?",
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
    let name = event.get("commandId").and_then(Value::as_str).unwrap_or_default();
    match result_status(event) {
        Some(status) if status != "exit 0" => Outcome::Reported,
        Some(_) => Outcome::Ok,
        None if COMMANDS.contains(&name) => Outcome::Unknown,
        None => Outcome::Ok,
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

/// The title of an ACP tool-call progress frame, or its name, or
/// `external tool` when it carries neither: both are optional, and a call
/// without them still needs a line.
pub fn agent_progress_title(event: &Value) -> String {
    event
        .get("title")
        .or_else(|| event.get("name"))
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .map_or_else(|| "external tool".into(), |title| bounded(title, MAX_SUBJECT_CHARS))
}

/// Identity is used for pairing, never printed. Oversized or empty IDs use the
/// legacy title fallback, matching the runtime's display identity bound.
pub fn agent_progress_id(event: &Value) -> Option<&str> {
    event.get("toolCallId").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 128)
}

pub fn agent_progress_ended(event: &Value) -> bool {
    matches!(event.get("status").and_then(Value::as_str), Some("completed" | "failed"))
}

fn plan_lines(event: &Value) -> Option<String> {
    let plan = event.get("plan")?;
    let steps = plan.get("steps").and_then(Value::as_array)?;
    let header = "  · plan (external agent)";
    let mut line = header.to_string();
    for step in steps.iter().take(20) {
        let mark = match step.get("status").and_then(Value::as_str) {
            Some("completed") => "x",
            Some("in_progress") => ">",
            Some("pending") => " ",
            _ => continue,
        };
        if let Some(content) = step.get("content").and_then(Value::as_str) {
            line.push_str(&format!("\n      [{mark}] {}", bounded(content, MAX_SUBJECT_CHARS)));
        }
    }
    if let Some(count) = plan.get("stepsOmitted").and_then(Value::as_u64) {
        line.push_str(&format!("\n      … {count} more steps"));
    }
    (line.len() > header.len()).then_some(line)
}

fn append_file_changes(line: &mut String, changes: &Value) {
    let mut remaining = 40;
    if let Some(files) = changes.get("files").and_then(Value::as_array) {
        for file in files.iter().take(5) {
            let Some(path) = file.get("path").and_then(Value::as_str) else { continue };
            let kind = match file.get("change").and_then(Value::as_str) {
                Some("add") => "added, ",
                Some("delete") => "deleted, ",
                _ => "",
            };
            let mut counts = Vec::new();
            for (field, sign) in [("added", "+"), ("removed", "-")] {
                if let Some(count) = file.get(field).and_then(Value::as_u64).filter(|n| *n > 0) {
                    counts.push(format!("{sign}{count}"));
                }
            }
            line.push_str(&format!("\n      {}", bounded(path, MAX_SUBJECT_CHARS)));
            if !kind.is_empty() || !counts.is_empty() {
                line.push_str(&format!("  {kind}{}", counts.join(" ")));
            }
            if file.get("withheld").and_then(Value::as_bool) == Some(true) {
                line.push_str("\n        (content withheld: it matched a credential pattern)");
            } else if let Some(lines) = file.get("lines").and_then(Value::as_array) {
                for text in lines.iter().filter_map(Value::as_str).take(remaining) {
                    let text = bounded(text, MAX_SUBJECT_CHARS);
                    if let Some(content) = text.strip_prefix('+') {
                        line.push_str(&format!("\n        + {content}"));
                    } else if let Some(content) = text.strip_prefix('-') {
                        line.push_str(&format!("\n        - {content}"));
                    }
                    remaining -= 1;
                }
            }
            if let Some(count) = file.get("linesOmitted").and_then(Value::as_u64) {
                line.push_str(&format!("\n        … {count} more lines"));
            }
        }
    }
    if let Some(count) = changes.get("filesOmitted").and_then(Value::as_u64) {
        line.push_str(&format!("\n      … {count} more files"));
    }
}

fn agent_progress_line(event: &Value) -> Option<String> {
    if event.get("kind").and_then(Value::as_str) == Some("plan") {
        return plan_lines(event);
    }
    if event.get("kind").and_then(Value::as_str) != Some("tool_call") {
        return None;
    }
    let mark = match event.get("status").and_then(Value::as_str) {
        Some("completed") => "✓",
        Some("failed") => "✗",
        // An older runtime retains its completion-only scrollback behavior.
        _ if agent_progress_id(event).is_some() => "▸",
        _ => return None,
    };
    let mut line = format!("  {mark} {} (external agent)", agent_progress_title(event));
    if agent_progress_ended(event) {
        return Some(line);
    }
    if event.get("toolKind").and_then(Value::as_str) == Some("edit") {
        if let Some(changes) = event.get("fileChanges") {
            append_file_changes(&mut line, changes);
            return Some(line);
        }
    }
    let input = event.get("input").and_then(Value::as_str).filter(|input| {
        event.get("title").and_then(Value::as_str).is_none_or(|title| {
            crate::approval::visible(title) != crate::approval::visible(input)
        })
    });
    let cwd = event.get("cwd").and_then(Value::as_str);
    let detail = if event.get("inputWithheld").and_then(Value::as_bool) == Some(true) {
        Some("(input withheld: it matched a credential pattern)".into())
    } else if let Some(input) = input {
        let mut detail = bounded(input, MAX_SUBJECT_CHARS);
        if let Some(cwd) = cwd {
            detail.push_str(&format!("  [in {}]", bounded(cwd, MAX_SUBJECT_CHARS)));
        }
        Some(detail)
    } else if let Some(cwd) = cwd {
        Some(format!("[in {}]", bounded(cwd, MAX_SUBJECT_CHARS)))
    } else {
        event.get("locations").and_then(Value::as_array).map(|paths| {
            paths.iter().filter_map(Value::as_str).take(3)
                .map(|path| bounded(path, MAX_SUBJECT_CHARS)).collect::<Vec<_>>().join(", ")
        }).filter(|paths| !paths.is_empty())
    };
    if let Some(detail) = detail {
        line.push_str(&format!("\n      {detail}"));
    }
    Some(line)
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
        Outcome::Unknown => line.push_str(" · exit status not reported"),
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
#[path = "activity_tests.rs"]
mod tests;
