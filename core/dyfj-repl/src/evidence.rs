//! What a turn did, according to the runtime rather than the model.
//!
//! A turn's reply is the model's own account of its work, and a model can say
//! it ran the tests, or wrote a file, when it did not, or when the tests
//! failed. The runtime's tool frames are the independent record: which calls
//! ran, on what, and how each ended. This collects them for one turn and
//! closes the turn with a short summary beside the answer, so the claim and
//! the evidence are on screen together. `/evidence` prints every call.
//!
//! The record never certifies the reply. A command that exited 0 is shown as
//! exiting 0, not as a check that passed: which command was a check, and
//! whether it checked the claim, is the operator's call.
//!
//! On the external-agent (ACP) route the agent's tool calls arrive as
//! progress frames, which the agent reports and the runtime relays. They are
//! recorded too, marked as the agent's report.

use crate::activity::{self, COMMANDS, Outcome};
use serde_json::Value;

/// One tool call of the turn, as its frames reported it.
#[derive(Debug, Clone, PartialEq)]
struct Call {
    id: String,
    name: String,
    subject: Option<String>,
    /// None while the call has started and not completed.
    outcome: Option<Outcome>,
    status: Option<String>,
    /// The completed line, as the live view rendered it.
    line: Option<String>,
    /// Seconds into the turn when the call started and when it completed.
    started_at: Option<u64>,
    ended_at: Option<u64>,
    /// An external agent's call, known by its title only.
    external: bool,
}

impl Call {
    fn started(name: String, subject: Option<String>, started_at: Option<u64>) -> Self {
        Call {
            id: String::new(),
            name,
            subject,
            outcome: None,
            status: None,
            line: None,
            started_at,
            ended_at: None,
            external: false,
        }
    }
}

/// The tools that write files, whose subject is the path they wrote. Other
/// tools (bash, git) can change files too, which is why the summary says
/// these were the file tools.
const FILE_WRITERS: [&str; 2] = ["write_file", "edit_file"];

/// How many items one summary line lists before it counts the rest.
const MAX_LISTED: usize = 5;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Ledger {
    calls: Vec<Call>,
    steps: i64,
    unparsed_markup: bool,
}

impl Ledger {
    /// Fold one runtime event into the record. `at` is the seconds since
    /// the turn began.
    pub fn observe(&mut self, event: &Value, at: u64) {
        let text = |key: &str| event.get(key).and_then(Value::as_str).map(str::to_string);
        match event.get("type").and_then(Value::as_str) {
            Some("toolStepStarted") => {
                if let Some(step) = event.get("step").and_then(Value::as_i64) {
                    self.steps = self.steps.max(step);
                }
            }
            Some("toolCallStarted") => self.calls.push(Call {
                id: text("callId").unwrap_or_default(),
                ..Call::started(
                    text("commandId").unwrap_or_else(|| "tool".into()),
                    text("subject").filter(|s| !s.trim().is_empty()),
                    Some(at),
                )
            }),
            Some("toolCallCompleted") => {
                let id = text("callId").unwrap_or_default();
                // The started frame for this id, or a record made from the
                // completion alone if it was missed.
                let index = match self
                    .calls
                    .iter()
                    .rposition(|call| call.outcome.is_none() && call.id == id)
                {
                    Some(index) => index,
                    None => {
                        self.calls.push(Call {
                            id,
                            ..Call::started(
                                text("commandId").unwrap_or_else(|| "tool".into()),
                                text("subject").filter(|s| !s.trim().is_empty()),
                                None,
                            )
                        });
                        self.calls.len() - 1
                    }
                };
                let call = &mut self.calls[index];
                call.outcome = Some(activity::outcome(event));
                call.status = text("resultStatus").filter(|s| !s.is_empty());
                call.line = Some(activity::completed_call(event));
                call.ended_at = Some(at);
            }
            Some("agentProgress") => self.observe_agent_call(event, at),
            Some("unparsedToolCallMarkupDetected") => self.unparsed_markup = true,
            _ => {}
        }
    }

    /// An ACP tool-call progress frame. It carries no call id, so a frame is
    /// matched to the latest unfinished call with the same title; a call
    /// first seen at its end is recorded from that frame alone.
    fn observe_agent_call(&mut self, event: &Value, at: u64) {
        if event.get("kind").and_then(Value::as_str) != Some("tool_call") {
            return;
        }
        let title = activity::agent_progress_title(event);
        let open = self.calls.iter().rposition(|call| {
            call.external && call.outcome.is_none() && call.subject.as_deref() == Some(&title)
        });
        let outcome = match event.get("status").and_then(Value::as_str) {
            Some("completed") => Outcome::Ok,
            Some("failed") => Outcome::Failed,
            _ => {
                if open.is_none() {
                    self.calls.push(Call {
                        external: true,
                        ..Call::started("agent".into(), Some(title), Some(at))
                    });
                }
                return;
            }
        };
        let index = open.unwrap_or_else(|| {
            self.calls.push(Call {
                external: true,
                ..Call::started("agent".into(), Some(title.clone()), None)
            });
            self.calls.len() - 1
        });
        let call = &mut self.calls[index];
        call.outcome = Some(outcome);
        call.line = Some(format!("{} {title} (external agent)", outcome.mark()));
        call.ended_at = Some(at);
    }

    /// The summary that closes the turn: one header line, then a line each for
    /// what the file tools wrote, the commands run and the calls that went
    /// wrong, when there are any. `elapsed_ms` is the turn's wall time.
    /// The summary for a turn that failed: there is no reply, so a turn with
    /// no tool calls says only that none ran before the failure.
    pub fn failed_summary(&self, elapsed_ms: i64) -> Vec<String> {
        if self.calls.is_empty() {
            return vec![format!(
                "· evidence: no tools ran before the turn failed · {}",
                activity::duration(elapsed_ms)
            )];
        }
        self.summary(elapsed_ms)
    }

    pub fn summary(&self, elapsed_ms: i64) -> Vec<String> {
        let elapsed = activity::duration(elapsed_ms);
        if self.calls.is_empty() {
            let mut lines = vec![format!(
                "· evidence: no tools ran this turn; the reply is the model's own account · {elapsed}"
            )];
            if self.unparsed_markup {
                lines.push("    problems: the model wrote tool-call markup that ran no tools".into());
            }
            return lines;
        }
        let count = |wanted: Option<Outcome>| {
            self.calls.iter().filter(|call| call.outcome == wanted).count()
        };
        let mut tally = vec![format!("{} ok", count(Some(Outcome::Ok)))];
        // A command that exited non-zero or timed out failed, whatever the
        // reply says; another tool's `error:` reply reported a problem.
        let failed_commands: Vec<String> = self
            .calls
            .iter()
            .filter(|call| is_command(call) && call.outcome == Some(Outcome::Reported))
            .map(|call| call.status.as_deref().map(activity::short_status).unwrap_or_default())
            .collect();
        if !failed_commands.is_empty() {
            tally.push(format!(
                "{} failed ({})",
                plural(failed_commands.len(), "command"),
                failed_commands.join("; ")
            ));
        }
        let unknown = self
            .calls
            .iter()
            .filter(|call| call.outcome == Some(Outcome::Unknown))
            .count();
        if unknown > 0 {
            tally.push(format!("{} reported no exit status", plural(unknown, "command")));
        }
        let reported = self
            .calls
            .iter()
            .filter(|call| !is_command(call) && call.outcome == Some(Outcome::Reported))
            .count();
        if reported > 0 {
            tally.push(format!("{reported} reported a problem"));
        }
        for (outcome, label) in [
            (Some(Outcome::Failed), "failed"),
            (Some(Outcome::NotApproved), "not approved"),
            (None, "reported no completion"),
        ] {
            let n = count(outcome);
            if n > 0 {
                tally.push(format!("{n} {label}"));
            }
        }
        let calls = plural(self.calls.len(), "call");
        let steps = if self.steps > 0 {
            format!(" in {}", plural(self.steps as usize, "step"))
        } else {
            String::new()
        };
        let mut lines = vec![format!(
            "· evidence: {calls}{steps}: {} · {elapsed}",
            tally.join(", ")
        )];

        let written: Vec<String> = self
            .calls
            .iter()
            .filter(|call| {
                FILE_WRITERS.contains(&call.name.as_str()) && call.outcome == Some(Outcome::Ok)
            })
            .map(subject_or_unnamed)
            .collect();
        if !written.is_empty() {
            lines.push(format!("    file tools wrote: {}", listed(&dedup(written))));
        }

        let commands: Vec<String> = self
            .calls
            .iter()
            .filter(|call| is_command(call))
            .map(|call| {
                let result = match (call.outcome, &call.status) {
                    (None, _) => "reported no completion".to_string(),
                    (Some(Outcome::NotApproved), _) => "not approved".to_string(),
                    (Some(Outcome::Failed), _) => "failed".to_string(),
                    (_, Some(status)) => activity::short_status(status),
                    (_, None) => "exit status not reported".to_string(),
                };
                let name = if call.name == "bash" { String::new() } else { format!("{} ", call.name) };
                format!("{name}{} → {result}", subject_or_unnamed(call))
            })
            .collect();
        if !commands.is_empty() {
            lines.push(format!("    commands: {}", listed_with(&commands, "; ")));
        }

        let mut problems: Vec<String> = self
            .calls
            .iter()
            .filter(|call| {
                matches!(
                    call.outcome,
                    Some(Outcome::Reported | Outcome::Failed | Outcome::NotApproved) | None
                ) && !is_command(call)
            })
            .map(|call| match &call.line {
                Some(line) => line.clone(),
                None => format!("… {} reported no completion", label(call)),
            })
            .collect();
        if self.unparsed_markup {
            problems.push("the model wrote tool-call markup that ran no tools".into());
        }
        if !problems.is_empty() {
            lines.push(format!("    problems: {}", listed_with(&problems, "; ")));
        }
        let unchecked = self.written_after_last_clean_exit();
        if !unchecked.is_empty() {
            lines.push(format!(
                "    no command reported exit 0 after these writes: {}",
                listed(&unchecked)
            ));
        }
        if self.calls.iter().any(|call| call.external) {
            lines.push("    external agent calls are as the agent reported them".into());
        }
        lines.push(
            "    this is the runtime's record of the calls; it does not check the reply's claims"
                .into(),
        );
        if self.calls.len() > 1 {
            lines.push("    /evidence lists every call".into());
        }
        lines
    }

    /// Files the file tools wrote after the last command that reported exit
    /// 0, or every file written when none did. Saying nothing when a command
    /// did exit 0 afterwards is deliberate: the record cannot tell whether
    /// that command checked the write. A command whose exit status was not
    /// reported may have exited 0, which is why the line says "reported".
    fn written_after_last_clean_exit(&self) -> Vec<String> {
        let last_clean = self.calls.iter().rposition(|call| {
            is_command(call)
                && call.outcome == Some(Outcome::Ok)
                && call.status.as_deref() == Some("exit 0")
        });
        let after = last_clean.map_or(0, |index| index + 1);
        dedup(
            self.calls[after..]
                .iter()
                .filter(|call| {
                    FILE_WRITERS.contains(&call.name.as_str()) && call.outcome == Some(Outcome::Ok)
                })
                .map(subject_or_unnamed)
                .collect(),
        )
    }

    /// Every call, one line each, for `/evidence`: when it ran, in seconds
    /// into the turn, and how it ended.
    pub fn every_call(&self) -> Vec<String> {
        self.calls
            .iter()
            .map(|call| {
                let when = match (call.started_at, call.ended_at) {
                    (Some(start), Some(end)) if end > start => format!("[{start}s→{end}s] "),
                    (Some(at), _) | (None, Some(at)) => format!("[{at}s] "),
                    (None, None) => String::new(),
                };
                match &call.line {
                    Some(line) => format!("  {when}{line}"),
                    None => format!("  {when}… {} reported no completion", label(call)),
                }
            })
            .collect()
    }
}

fn is_command(call: &Call) -> bool {
    COMMANDS.contains(&call.name.as_str())
}

fn label(call: &Call) -> String {
    let name = activity::bounded(&call.name, 80);
    match &call.subject {
        Some(subject) if call.external => format!("{subject} (external agent)"),
        Some(subject) => format!("{name} {}", activity::bounded(subject, 80)),
        None => name,
    }
}

fn subject_or_unnamed(call: &Call) -> String {
    match &call.subject {
        Some(subject) => activity::bounded(subject, 60),
        None => "(unnamed)".into(),
    }
}

fn plural(n: usize, noun: &str) -> String {
    if n == 1 { format!("1 {noun}") } else { format!("{n} {noun}s") }
}

fn dedup(items: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for item in items {
        if !seen.contains(&item) {
            seen.push(item);
        }
    }
    seen
}

fn listed(items: &[String]) -> String {
    listed_with(items, ", ")
}

fn listed_with(items: &[String], separator: &str) -> String {
    let shown: Vec<&str> = items.iter().take(MAX_LISTED).map(String::as_str).collect();
    let mut out = shown.join(separator);
    if items.len() > MAX_LISTED {
        out.push_str(&format!(" and {} more", items.len() - MAX_LISTED));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::Ledger;
    use serde_json::{Value, json};

    fn ledger(events: &[Value]) -> Ledger {
        let mut ledger = Ledger::default();
        for event in events {
            ledger.observe(event, 0);
        }
        ledger
    }

    fn started(id: &str, name: &str, subject: &str) -> Value {
        json!({"type": "toolCallStarted", "callId": id, "commandId": name, "subject": subject})
    }

    fn completed(id: &str, name: &str, subject: &str, extra: Value) -> Value {
        let mut event = json!({
            "type": "toolCallCompleted", "callId": id, "commandId": name,
            "subject": subject, "isError": false, "durationMs": 5
        });
        for (key, value) in extra.as_object().unwrap() {
            event[key] = value.clone();
        }
        event
    }

    /// The turn the disposable runtime ran: the model said it read a file and
    /// that the tests pass. The read found nothing and no tests ran.
    #[test]
    fn the_summary_sets_the_record_beside_the_claim() {
        let ledger = ledger(&[
            json!({"type": "toolStepStarted", "step": 1, "toolCallCount": 1}),
            started("c1", "list_files", "."),
            completed("c1", "list_files", ".", json!({})),
            json!({"type": "toolStepStarted", "step": 2, "toolCallCount": 1}),
            started("c2", "read_file", "missing.txt"),
            completed("c2", "read_file", "missing.txt", json!({
                "resultStatus": "error: cannot read missing.txt: not found"
            })),
            json!({"type": "toolStepStarted", "step": 3, "toolCallCount": 1}),
            started("c3", "write_file", "notes.md"),
            completed("c3", "write_file", "notes.md", json!({"durationMs": 3307})),
        ]);
        assert_eq!(
            ledger.summary(4_100),
            vec![
                "· evidence: 3 calls in 3 steps: 2 ok, 1 reported a problem · 4.1s",
                "    file tools wrote: notes.md",
                "    problems: ! read_file missing.txt (5ms) · error: cannot read missing.txt: not found",
                "    no command reported exit 0 after these writes: notes.md",
                "    this is the runtime's record of the calls; it does not check the reply's claims",
                "    /evidence lists every call",
            ]
        );
    }

    #[test]
    fn commands_are_listed_with_how_they_exited() {
        let ledger = ledger(&[
            started("c1", "bash", "npm test"),
            completed("c1", "bash", "npm test", json!({"resultStatus": "exit 1"})),
            started("c2", "bash", "cargo build"),
            completed("c2", "bash", "cargo build", json!({"resultStatus": "exit 0"})),
            started("c3", "bash", "rm -rf build"),
            completed("c3", "bash", "rm -rf build", json!({"isError": true, "verdict": "approval_denied"})),
        ]);
        let summary = ledger.summary(65_000);
        assert_eq!(
            summary[0],
            "· evidence: 3 calls: 1 ok, 1 command failed (exit 1), 1 not approved · 1m05s"
        );
        assert_eq!(
            summary[1],
            "    commands: npm test → exit 1; cargo build → exit 0; rm -rf build → not approved"
        );
    }

    /// A failed turn has no reply to vouch for: with no tool calls it says
    /// only that none ran, and with calls it keeps their record.
    #[test]
    fn a_failed_turn_does_not_speak_of_a_reply() {
        assert_eq!(
            Ledger::default().failed_summary(800),
            vec!["· evidence: no tools ran before the turn failed · 800ms"]
        );
        let ran = ledger(&[
            started("a", "read_file", "x"),
            completed("a", "read_file", "x", json!({})),
        ]);
        assert_eq!(ran.failed_summary(800), ran.summary(800));
    }

    #[test]
    fn a_turn_with_no_tools_says_the_reply_is_unchecked() {
        assert_eq!(
            Ledger::default().summary(800),
            vec!["· evidence: no tools ran this turn; the reply is the model's own account · 800ms"]
        );
        let markup = ledger(&[json!({"type": "unparsedToolCallMarkupDetected"})]);
        assert_eq!(markup.summary(800).len(), 2);
    }

    /// A call cut short by a cancel has a start and no completion. It did
    /// not finish, and the summary does not count it as ok.
    #[test]
    fn a_call_that_never_finished_is_named() {
        let ledger = ledger(&[started("c1", "grep_files", "TODO")]);
        assert_eq!(
            ledger.summary(10_000),
            vec![
                "· evidence: 1 call: 0 ok, 1 reported no completion · 10.0s",
                "    problems: … grep_files TODO reported no completion",
                "    this is the runtime's record of the calls; it does not check the reply's claims",
            ]
        );
        assert_eq!(ledger.every_call(), vec!["  [0s] … grep_files TODO reported no completion"]);
    }

    #[test]
    fn a_completion_without_its_start_is_still_recorded() {
        let ledger = ledger(&[completed("c9", "read_file", "a.ts", json!({}))]);
        assert_eq!(ledger.every_call(), vec!["  [0s] ✓ read_file a.ts (5ms)"]);
    }

    #[test]
    fn long_lists_are_counted_not_flooded() {
        let mut events = Vec::new();
        for i in 0..8 {
            let path = format!("f{i}.md");
            events.push(started(&format!("c{i}"), "write_file", &path));
            events.push(completed(&format!("c{i}"), "write_file", &path, json!({})));
        }
        // A rewrite of the same file is one file written.
        events.push(started("again", "write_file", "f0.md"));
        events.push(completed("again", "write_file", "f0.md", json!({})));
        let summary = ledger(&events).summary(1_000);
        assert_eq!(summary[1], "    file tools wrote: f0.md, f1.md, f2.md, f3.md, f4.md and 3 more");
    }

    /// The acceptance probe's turn: a write, a command that exits 7 after a
    /// 35 s wait, a command that times out, then a reply claiming everything
    /// passed. Both commands are failures, nothing says a check passed, and
    /// the write is named as unchecked.
    #[test]
    fn the_probe_turn_records_both_failures_and_no_pass() {
        let mut ledger = Ledger::default();
        let timeout = "timed out after 3000ms (killed; output shown up to the deadline)";
        for (event, at) in [
            (started("c1", "list_files", "."), 0),
            (completed("c1", "list_files", ".", json!({})), 0),
            (started("c2", "write_file", "notes.txt"), 0),
            (completed("c2", "write_file", "notes.txt", json!({})), 1),
            (started("c3", "bash", "sleep 35; exit 7"), 1),
            (completed("c3", "bash", "sleep 35; exit 7", json!({"resultStatus": "exit 7"})), 36),
            (started("c4", "bash", "sleep 10; npm test"), 36),
            (completed("c4", "bash", "sleep 10; npm test", json!({"resultStatus": timeout})), 39),
        ] {
            ledger.observe(&event, at);
        }
        let summary = ledger.summary(39_000);
        assert_eq!(
            summary,
            vec![
                "· evidence: 4 calls: 2 ok, 2 commands failed (exit 7; timed out after 3000ms) · 39.0s",
                "    file tools wrote: notes.txt",
                "    commands: sleep 35; exit 7 → exit 7; sleep 10; npm test → timed out after 3000ms",
                "    no command reported exit 0 after these writes: notes.txt",
                "    this is the runtime's record of the calls; it does not check the reply's claims",
                "    /evidence lists every call",
            ]
        );
        let text = summary.join("\n");
        assert!(!text.contains("passed") && !text.contains("verified"), "{text}");
        assert_eq!(ledger.every_call()[2], "  [1s→36s] ! bash sleep 35; exit 7 (5ms) · exit 7");
    }

    /// A command that exits 0 after a write is not called a check, and the
    /// write is no longer listed as unchecked.
    #[test]
    fn a_clean_exit_after_a_write_is_shown_but_not_certified() {
        let ledger = ledger(&[
            started("c1", "edit_file", "a.rs"),
            completed("c1", "edit_file", "a.rs", json!({})),
            started("c2", "git", "status"),
            completed("c2", "git", "status", json!({"resultStatus": "exit 0"})),
        ]);
        let summary = ledger.summary(1_000);
        assert_eq!(summary[0], "· evidence: 2 calls: 2 ok · 1.0s");
        assert_eq!(summary[2], "    commands: git status → exit 0");
        assert!(!summary.iter().any(|line| line.contains("no command reported exit 0")));
    }

    /// An older runtime sends no `resultStatus`. Its commands are counted
    /// as unknown, never as ok, and the write is not said to be unchecked
    /// by a command whose exit is unknown.
    #[test]
    fn commands_from_a_runtime_without_exit_statuses_are_unknown() {
        let ledger = ledger(&[
            started("c1", "write_file", "a.rs"),
            completed("c1", "write_file", "a.rs", json!({})),
            started("c2", "bash", "npm test"),
            completed("c2", "bash", "npm test", json!({})),
        ]);
        let summary = ledger.summary(1_000);
        assert_eq!(
            summary[0],
            "· evidence: 2 calls: 1 ok, 1 command reported no exit status · 1.0s"
        );
        assert_eq!(summary[2], "    commands: npm test → exit status not reported");
        assert_eq!(summary[3], "    no command reported exit 0 after these writes: a.rs");
        assert_eq!(ledger.every_call()[1], "  [0s] ? bash npm test (5ms) · exit status not reported");
    }

    /// An external agent's tool calls arrive as progress frames with a
    /// title and no call id. They are calls this turn made, as the agent
    /// reported them.
    #[test]
    fn external_agent_tool_calls_are_recorded() {
        let progress = |title: &str, status: &str| {
            json!({"type": "agentProgress", "kind": "tool_call", "title": title, "status": status})
        };
        let mut ledger = Ledger::default();
        for (event, at) in [
            (progress("Run npm test", "pending"), 0),
            (progress("Run npm test", "in_progress"), 1),
            (progress("Run npm test", "failed"), 9),
            (progress("Edit a.rs", "in_progress"), 10),
            (progress("Edit a.rs", "completed"), 11),
            (progress("Read b.rs", "in_progress"), 12),
            (json!({"type": "agentProgress", "kind": "thought"}), 12),
        ] {
            ledger.observe(&event, at);
        }
        let summary = ledger.summary(13_000);
        assert_eq!(
            summary[0],
            "· evidence: 3 calls: 1 ok, 1 failed, 1 reported no completion · 13.0s"
        );
        assert!(summary.iter().any(|line| line
            == "    external agent calls are as the agent reported them"));
        assert_eq!(
            ledger.every_call(),
            vec![
                "  [0s→9s] ✗ Run npm test (external agent)",
                "  [10s→11s] ✓ Edit a.rs (external agent)",
                "  [12s] … Read b.rs (external agent) reported no completion",
            ]
        );
    }

    /// A command cut short by a cancel is named with the other commands.
    #[test]
    fn a_command_that_never_completed_is_listed() {
        let ledger = ledger(&[started("c1", "bash", "npm test")]);
        assert_eq!(ledger.summary(1_000)[1], "    commands: npm test → reported no completion");
    }

    #[test]
    fn an_untitled_external_agent_call_is_recorded() {
        let ledger = ledger(&[json!({"type": "agentProgress", "kind": "tool_call", "status": "completed"})]);
        assert_eq!(ledger.every_call(), vec!["  [0s] ✓ external tool (external agent)"]);
    }
}
