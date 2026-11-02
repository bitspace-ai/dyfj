//! What a turn did, according to the runtime rather than the model.
//!
//! A turn's reply is the model's own account of its work, and a model can say
//! it ran the tests, or wrote a file, when it did not, or when the tests
//! failed. The runtime's tool frames are the independent record: which calls
//! ran, on what, and how each ended. This collects them for one turn and
//! closes the turn with a short summary beside the answer, so the claim and
//! the evidence are on screen together. `/evidence` prints every call.

use crate::activity::{self, Outcome};
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
    /// Fold one runtime event into the record.
    pub fn observe(&mut self, event: &Value) {
        let text = |key: &str| event.get(key).and_then(Value::as_str).map(str::to_string);
        match event.get("type").and_then(Value::as_str) {
            Some("toolStepStarted") => {
                if let Some(step) = event.get("step").and_then(Value::as_i64) {
                    self.steps = self.steps.max(step);
                }
            }
            Some("toolCallStarted") => self.calls.push(Call {
                id: text("callId").unwrap_or_default(),
                name: text("commandId").unwrap_or_else(|| "tool".into()),
                subject: text("subject").filter(|s| !s.trim().is_empty()),
                outcome: None,
                status: None,
                line: None,
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
                            name: text("commandId").unwrap_or_else(|| "tool".into()),
                            subject: text("subject").filter(|s| !s.trim().is_empty()),
                            outcome: None,
                            status: None,
                            line: None,
                        });
                        self.calls.len() - 1
                    }
                };
                let call = &mut self.calls[index];
                call.outcome = Some(activity::outcome(event));
                call.status = text("resultStatus").filter(|s| !s.is_empty());
                call.line = Some(activity::completed_call(event));
            }
            Some("unparsedToolCallMarkupDetected") => self.unparsed_markup = true,
            _ => {}
        }
    }

    /// The summary that closes the turn: one header line, then a line each for
    /// what the file tools wrote, the commands run and the calls that went
    /// wrong, when there are any. `elapsed_ms` is the turn's wall time.
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
        for (outcome, label) in [
            (Some(Outcome::Reported), "reported a problem"),
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
            .filter(|call| call.name == "bash" && call.outcome.is_some())
            .map(|call| {
                let result = match (call.outcome, &call.status) {
                    (Some(Outcome::NotApproved), _) => "not approved".to_string(),
                    (Some(Outcome::Failed), _) => "failed".to_string(),
                    (_, Some(status)) => activity::bounded(status, 40),
                    (_, None) => "no exit status".to_string(),
                };
                format!("{} → {result}", subject_or_unnamed(call))
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
                ) && call.name != "bash"
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
        if self.calls.len() > 1 {
            lines.push("    /evidence lists every call".into());
        }
        lines
    }

    /// Every call, one line each, for `/evidence`.
    pub fn every_call(&self) -> Vec<String> {
        self.calls
            .iter()
            .map(|call| match &call.line {
                Some(line) => format!("  {line}"),
                None => format!("  … {} reported no completion", label(call)),
            })
            .collect()
    }
}

fn label(call: &Call) -> String {
    let name = activity::bounded(&call.name, 80);
    match &call.subject {
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
            ledger.observe(event);
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
            "· evidence: 3 calls: 1 ok, 1 reported a problem, 1 not approved · 1m05s"
        );
        assert_eq!(
            summary[1],
            "    commands: npm test → exit 1; cargo build → exit 0; rm -rf build → not approved"
        );
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
            ]
        );
        assert_eq!(ledger.every_call(), vec!["  … grep_files TODO reported no completion"]);
    }

    #[test]
    fn a_completion_without_its_start_is_still_recorded() {
        let ledger = ledger(&[completed("c9", "read_file", "a.ts", json!({}))]);
        assert_eq!(ledger.every_call(), vec!["  ✓ read_file a.ts (5ms)"]);
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
}
