//! The mid-turn approval prompt.
//!
//! Fail-closed. A yes/no request is approved only by `y` or `yes`; a choice
//! request is answered by a valid option number, which selects rather than
//! approves. Everything else denies — a declined answer, an unparseable or
//! out-of-range one, Ctrl-C, Ctrl-D, a failed input flush, and a terminal that
//! has gone away.
//!
//! Delivery of that denial is the client's job, not this module's; see
//! `client::answer_approval`, which reports a write it cannot complete rather
//! than swallowing it.

use crate::client::Verdict;
use crate::terminal::{Ask, ReadOutcome};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

/// Describe what is being approved, from whatever fields the request carries.
///
/// The `arguments` field is rendered in full. An earlier version clipped it at
/// 200 characters, which meant a command whose opening looked harmless could
/// hide a destructive tail behind the cut — the operator would approve what
/// they were shown, not what would run.
///
/// What is shown is the title or command id plus the whole serialized
/// `arguments`. A request that carries consequential detail in some other
/// field would not have that detail displayed.
///
/// The shape is deliberately not modelled strictly: the runtime may add
/// fields, and a client that refuses to render an unfamiliar request would
/// fail closed on a request the operator could have answered.
/// Remove characters that can move the cursor, clear the screen, or hide what
/// follows them.
///
/// The title and arguments are supplied by the runtime and ultimately shaped
/// by a model's tool call, so they are untrusted for display purposes. An
/// escape sequence in a title could conceal the arguments printed beneath it,
/// and an operator cannot consent to what a terminal was instructed not to
/// show them. Rendering the arguments in full is worth nothing if they can be
/// made invisible.
pub fn visible(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c == '\n' || c == '\t' {
                ' '
            } else if c.is_control() {
                '\u{fffd}'
            } else {
                c
            }
        })
        .collect()
}

fn describe(params: &Value) -> String {
    let title = params
        .get("title")
        .and_then(Value::as_str)
        .or_else(|| params.get("commandId").and_then(Value::as_str))
        .unwrap_or("tool");
    match params.get("arguments") {
        Some(args) if !args.is_null() => {
            let rendered = serde_json::to_string(args).unwrap_or_default();
            visible(&format!("{title} {rendered}"))
        }
        _ => visible(title),
    }
}

/// Options for an exact-permission request, when the runtime offers a choice
/// rather than a yes/no.
fn options(params: &Value) -> Vec<(String, String)> {
    params
        .get("options")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|option| {
                    let id = option.get("optionId").or_else(|| option.get("id"))?;
                    let name = option.get("name").and_then(Value::as_str).unwrap_or("option");
                    Some((id.as_str()?.to_string(), name.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Request kinds that are not a tool call and carry their detail in named
/// fields rather than in `arguments`.
///
/// A budget request asks the operator to authorise spending past a limit. Its
/// amounts, limits and crossed scopes live in their own fields alongside a
/// preformatted `message`; it has no `arguments` at all. Rendering it the way
/// a tool call is rendered would show the operator the words "Budget ceiling"
/// and nothing else, and ask them to approve exceeding a spending boundary
/// without naming the amount or the limit.
fn spending_request(params: &Value) -> Option<&'static str> {
    match params.get("kind").and_then(Value::as_str) {
        Some("budget_ceiling") => Some("spending past a budget ceiling"),
        Some("runaway_anomaly") => Some("continuing despite a runaway-spend halt"),
        _ => None,
    }
}

/// Ask for a spending authorisation, or refuse if its detail cannot be read.
///
/// The runtime formats the warning itself; `message` is the authoritative
/// rendering of amounts, limits and scopes. Without it this client cannot say
/// what is being authorised, and an approval nobody could read is not consent
/// — so it denies rather than showing a bare question.
async fn spending(
    input: &mpsc::Sender<Ask>,
    params: &Value,
    authorises: &str,
) -> Verdict {
    let message = params
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty());

    println!();
    let Some(message) = message else {
        println!("⚠  {}", visible(title_of(params)));
        println!("   this request's details could not be read, so it cannot be approved here");
        return Verdict::deny("spending request details could not be read");
    };

    println!("⚠  {}", visible(title_of(params)));
    for line in message.lines() {
        println!("   {}", visible(line));
    }
    println!("   approving authorises {authorises}");
    yes_no(input).await
}

fn title_of(params: &Value) -> &str {
    params
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("approval request")
}

pub async fn ask(input: &mpsc::Sender<Ask>, params: &Value) -> Verdict {
    if let Some(authorises) = spending_request(params) {
        return spending(input, params, authorises).await;
    }

    // Present and non-null is the whole test. Enumerating shapes is what let
    // an options object through on one iteration and an empty array on the
    // next: any `options` the reader cannot turn into choices is a request
    // whose offered choices are unknown, and `y` there would approve more than
    // anything the request actually offered.
    let offers_options = params
        .get("options")
        .is_some_and(|value| !value.is_null());
    let choices = options(params);
    println!();
    println!("⚠  {}", describe(params));

    // A request that offers options wants one of them chosen. If none could be
    // read — whatever shape the field took — falling through to a yes/no would
    // turn `y` into an unrestricted approve, broader consent than any option
    // on offer, for choices the operator was never shown. Refuse instead.
    //
    // The check is on the field being PRESENT rather than on it parsing as an
    // array: an earlier version only recognised arrays, so an options object
    // still degraded to yes/no.
    if offers_options && choices.is_empty() {
        println!("   the options on this request could not be read");
        return Verdict::deny("options could not be read");
    }

    if choices.is_empty() {
        return yes_no(input).await;
    }
    for (index, (_, name)) in choices.iter().enumerate() {
        println!("   {}. {}", index + 1, visible(name));
    }
    select(input, &choices).await
}

async fn yes_no(input: &mpsc::Sender<Ask>) -> Verdict {
    match read(input, "   approve? [y/N] ").await {
        Some(answer) if is_yes(&answer) => Verdict::approve(),
        Some(_) => Verdict::deny("operator declined"),
        // Ctrl-C, Ctrl-D, or a terminal that went away. None of these is
        // consent.
        None => Verdict::deny("operator declined"),
    }
}

async fn select(input: &mpsc::Sender<Ask>, choices: &[(String, String)]) -> Verdict {
    let prompt = format!("   select [1-{}] (default reject): ", choices.len());
    match read(input, &prompt).await {
        Some(answer) => match answer.trim().parse::<usize>() {
            Ok(index) if index >= 1 && index <= choices.len() => {
                Verdict::select(choices[index - 1].0.clone())
            }
            // An unparseable or out-of-range answer is not a choice.
            _ => Verdict::deny("operator declined"),
        },
        None => Verdict::deny("operator declined"),
    }
}

fn is_yes(answer: &str) -> bool {
    matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}

/// Ask the terminal thread for one line. `Ask::Approval` makes it discard
/// input typed before the question appeared.
async fn read(input: &mpsc::Sender<Ask>, question: &str) -> Option<String> {
    let (respond, answer) = oneshot::channel();
    let ask = Ask::Approval { question: question.to_string(), respond };
    if input.send(ask).await.is_err() {
        return None;
    }
    match answer.await {
        Ok(ReadOutcome::Line(line)) => Some(line),
        Ok(ReadOutcome::Interrupted | ReadOutcome::Eof) => None,
        Ok(ReadOutcome::Failed(err)) => {
            eprintln!("approval input failed: {err}");
            None
        }
        Err(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn describes_a_request_by_title_then_command_id() {
        assert_eq!(describe(&json!({"title": "write_file"})), "write_file");
        assert_eq!(describe(&json!({"commandId": "bash"})), "bash");
        assert_eq!(describe(&json!({})), "tool");
    }

    /// The operator must see everything they are approving. Clipping let a
    /// benign opening hide a destructive tail.
    #[test]
    fn renders_long_arguments_in_full() {
        let tail = "rm -rf /important";
        let command = format!("{}{}", "echo hello && ".repeat(40), tail);
        let rendered = describe(&json!({"title": "Run Bash Command", "arguments": {"command": command}}));
        assert!(rendered.len() > 500, "rendered only {} chars", rendered.len());
        assert!(rendered.contains(tail), "the tail of the command must be shown");
    }

    #[test]
    fn only_an_explicit_yes_is_consent() {
        assert!(is_yes("y"));
        assert!(is_yes("Y"));
        assert!(is_yes(" yes "));
        assert!(!is_yes(""));
        assert!(!is_yes("n"));
        assert!(!is_yes("yep"));
        assert!(!is_yes("ye"));
    }

    #[test]
    fn reads_options_from_either_id_field() {
        let params = json!({"options": [
            {"optionId": "allow-once", "name": "Allow once"},
            {"id": "always", "name": "Always allow"}
        ]});
        let parsed = options(&params);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].0, "allow-once");
        assert_eq!(parsed[1].0, "always");
    }

    /// Escape sequences in runtime-supplied text must not be able to hide what
    /// the operator is approving. Rendering arguments in full is worthless if
    /// a title can instruct the terminal to conceal them.
    #[test]
    fn control_characters_cannot_conceal_the_arguments() {
        let params = json!({
            "title": "Safe\u{1b}[8m",
            "arguments": {"command": "rm -rf /important"}
        });
        let rendered = describe(&params);
        assert!(!rendered.contains('\u{1b}'), "escape survived: {rendered:?}");
        assert!(rendered.contains("rm -rf /important"), "arguments must still show");
    }

    #[test]
    fn newlines_and_tabs_become_spaces_rather_than_breaking_the_prompt() {
        let rendered = describe(&json!({"title": "a\nb\tc"}));
        assert_eq!(rendered, "a b c");
    }

    /// An options field of any shape that yields no readable choices must be
    /// refused. An earlier version recognised only arrays, so an object still
    /// fell through to a yes/no where `y` granted unrestricted approval.
    #[tokio::test]
    async fn an_unreadable_options_object_is_refused_too() {
        let (tx, mut rx) = mpsc::channel(1);
        tokio::spawn(async move {
            if rx.recv().await.is_some() {
                panic!("an unreadable-options request must not prompt");
            }
        });
        let params = json!({"title": "Permission", "options": {"optionId": "allow-once"}});
        let rendered = serde_json::to_string(&ask(&tx, &params).await).unwrap();
        assert!(rendered.contains("deny"), "expected a denial, got {rendered}");
    }

    /// Record whether the terminal was asked for anything. Panicking inside a
    /// detached task cannot serve here: dropping its receiver makes `ask`
    /// return a denial anyway, so the test would pass for the wrong reason
    /// whether or not a prompt was issued.
    async fn verdict_and_prompts(params: &Value) -> (String, usize) {
        let (tx, mut rx) = mpsc::channel(4);
        let verdict = tokio::select! {
            verdict = ask(&tx, params) => verdict,
            // If anything is asked of the terminal, stop here and report it
            // rather than answering, so the count is observable.
            _ = rx.recv() => {
                return ("prompted".into(), 1);
            }
        };
        (serde_json::to_string(&verdict).unwrap(), rx.try_recv().is_ok() as usize)
    }

    /// A request offering options none of which can be read must be refused,
    /// whatever shape the field took. `y` at a yes/no fallback would be an
    /// unrestricted approve — broader than any option the request offered.
    #[tokio::test]
    async fn unreadable_options_are_refused_in_every_shape() {
        for options in [
            json!([{"optionId": 1, "name": "Allow once"}]),
            json!({"optionId": "allow-once"}),
            json!([]),
            json!("allow-once"),
        ] {
            let params = json!({"title": "Permission", "options": options});
            let (verdict, prompts) = verdict_and_prompts(&params).await;
            assert_eq!(prompts, 0, "must not prompt for {options}");
            assert!(verdict.contains("deny"), "expected denial for {options}, got {verdict}");
        }
    }

    /// Shapes taken from the runtime's own budget request builders. These
    /// carry no `arguments`: the amounts and limits live in named fields and a
    /// preformatted `message`. Rendering them as a tool call would ask the
    /// operator to approve exceeding a spending limit while showing only the
    /// words "Budget ceiling".
    #[tokio::test]
    async fn a_spending_request_shows_its_warning_before_asking() {
        let params = json!({
            "kind": "budget_ceiling",
            "title": "Budget ceiling",
            "estimatedCostUsd": 0.42,
            "limitUsd": 0.25,
            "crossedScopes": ["perCall"],
            "message": "estimated $0.42 exceeds the per-call limit of $0.25"
        });
        let (_verdict, prompts) = verdict_and_prompts(&params).await;
        assert_eq!(prompts, 1, "a readable spending request must ask the operator");
    }

    /// Without a readable warning this client cannot say what is being
    /// authorised, and an approval nobody could read is not consent.
    #[tokio::test]
    async fn a_spending_request_without_a_readable_warning_is_denied() {
        for params in [
            json!({"kind": "budget_ceiling", "title": "Budget ceiling"}),
            json!({"kind": "runaway_anomaly", "title": "Runaway spend anomaly", "message": "   "}),
        ] {
            let (verdict, prompts) = verdict_and_prompts(&params).await;
            assert_eq!(prompts, 0, "must not ask when the detail is unreadable: {params}");
            assert!(verdict.contains("deny"), "expected denial for {params}, got {verdict}");
        }
    }

    /// A tool call keeps the tool rendering; only spending requests divert.
    #[test]
    fn only_spending_kinds_take_the_spending_path() {
        assert!(spending_request(&json!({"kind": "budget_ceiling"})).is_some());
        assert!(spending_request(&json!({"kind": "runaway_anomaly"})).is_some());
        assert!(spending_request(&json!({"commandId": "bash"})).is_none());
        assert!(spending_request(&json!({"kind": "something_new"})).is_none());
    }

    #[test]
    fn a_request_without_options_is_a_yes_no() {
        assert!(options(&json!({"title": "write_file"})).is_empty());
    }
}
