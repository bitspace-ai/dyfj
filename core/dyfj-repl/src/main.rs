//! DYFJ interactive REPL front-end.
//!
//! Owns the terminal and speaks the Workbench UDS protocol. The runtime holds
//! the agent loop; this binary is a client of it, which is why replacing the
//! TypeScript REPL does not touch the engine.

mod activity;
mod approval;
mod client;
mod commands;
#[cfg(test)]
mod fake_runtime;
mod link;
mod posture;
mod receipt;
mod session;
mod terminal;

use anyhow::{Context, Result};
use client::{Client, Incoming, StreamFrame, Verdict};
use serde_json::{Value, json};
use session::Session;
use std::io::Write;
use terminal::{Ask, ReadOutcome};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{mpsc, oneshot};

/// The runtime's input ceiling. Mirrors MAX_INPUT_LENGTH in the TypeScript
/// CLI; a longer prompt is rejected there, so rejecting it here costs the
/// operator a round trip less.
const MAX_INPUT_CHARACTERS: usize = 32_768;

/// What the operator's input turns out to be.
#[derive(Debug, PartialEq, Eq)]
enum Submission {
    Empty,
    Quit,
    TooLong { characters: usize },
    Prompt,
}

/// Classify one completed input.
///
/// A slash command counts only when the WHOLE input is that command. This is
/// what keeps a pasted block whose first line reads `/exit` from quitting the
/// session: the paste arrives as one string, so it is a prompt, not a command.
fn classify(input: &str) -> Submission {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Submission::Empty;
    }
    if trimmed == "/exit" || trimmed == "/quit" {
        return Submission::Quit;
    }
    // Count as the TypeScript CLI does: its ceiling is JavaScript's
    // `line.length`, which is UTF-16 code units. A byte count would reject
    // valid multi-byte input; a scalar count would accept an astral paste
    // (emoji, some CJK) of up to twice what the peer allows.
    let characters = input.encode_utf16().count();
    if characters > MAX_INPUT_CHARACTERS {
        return Submission::TooLong { characters };
    }
    Submission::Prompt
}

fn socket_path() -> Result<String> {
    resolve_socket_path(|key| std::env::var(key).ok())
}

/// Mirrors resolveSocketPath in the runtime's uds-path: `DYFJ_SOCKET`, then
/// `$XDG_RUNTIME_DIR/dyfj`, then `~/.dyfj/run`. An empty value counts as unset,
/// as it does there, so the client finds the socket the runtime is serving.
fn resolve_socket_path(env: impl Fn(&str) -> Option<String>) -> Result<String> {
    let set = |key: &str| env(key).filter(|value| !value.is_empty());
    if let Some(explicit) = set("DYFJ_SOCKET") {
        return Ok(explicit);
    }
    let base = match set("XDG_RUNTIME_DIR") {
        Some(runtime_dir) => format!("{runtime_dir}/dyfj"),
        None => {
            let home = env("HOME")
                .context("HOME is unset and neither DYFJ_SOCKET nor XDG_RUNTIME_DIR was given")?;
            format!("{home}/.dyfj/run")
        }
    };
    Ok(format!("{base}/workbench.sock"))
}

const USAGE: &str = "\
usage: dyfj-repl [--model <slug>] [--approve-paid] [--fast] [--session <id>] [--workspace <dir>]
  --model <slug>    route every turn to this model (default: the runtime's; env DYFJ_WORKBENCH_MODEL)
  --approve-paid    opt this session into paid inference
  --fast            use the fast speed tier on models that support it
  --session <id>    resume a runtime session, on the model it last ran on unless --model names one
  --workspace <d>   scope a new session's file tools to this directory (default: cwd; env DYFJ_WORKSPACE)";

/// Build the starting session from the command line and environment.
/// `Ok(None)` means help was asked for.
fn parse_args(
    args: &[String],
    env: impl Fn(&str) -> Option<String>,
    cwd: Option<String>,
) -> std::result::Result<Option<Session>, String> {
    let set = |key: &str| env(key).filter(|value| !value.is_empty());
    let mut session = Session {
        model: set("DYFJ_WORKBENCH_MODEL"),
        default_model: set("DYFJ_WORKBENCH_MODEL"),
        workspace: set("DYFJ_WORKSPACE").or(cwd),
        ..Session::default()
    };
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let mut value = |flag: &str| {
            iter.next()
                .filter(|v| !v.starts_with("--"))
                .cloned()
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        match arg.as_str() {
            "-h" | "--help" => return Ok(None),
            "--approve-paid" => session.approve_paid = true,
            "--fast" => session.fast = Some(true),
            "--model" => {
                session.model = Some(value("--model")?);
                session.model_pinned = true;
            }
            "--workspace" => session.workspace = Some(value("--workspace")?),
            "--session" => {
                let reference = value("--session")?;
                let id = commands::normalize_session_ref(&reference).ok_or_else(|| {
                    format!(
                        "--session expects a session id or a slug as listed by \
                         'dyfj sessions', got: {}",
                        approval::visible(&reference)
                    )
                })?;
                session.id = Some(id);
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    // A resumed session keeps the workspace stored on its row; the runtime
    // never moves it, so a local default here would only misreport it.
    if session.id.is_some() {
        session.workspace = None;
    }
    Ok(Some(session))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned());
    let mut session = match parse_args(&args, |key| std::env::var(key).ok(), cwd) {
        Ok(Some(session)) => session,
        Ok(None) => {
            println!("{USAGE}");
            return Ok(());
        }
        Err(message) => {
            eprintln!("dyfj-repl: {message}\n{USAGE}");
            std::process::exit(2);
        }
    };
    let socket = socket_path()?;
    // Before the terminal is taken, not after: a panic during startup would
    // otherwise leave it in whatever state it had reached.
    terminal::install_panic_restore();
    let (input, mut orphans) = terminal::spawn()?;
    // Where the launcher writes this runtime's output, when it knows. Read only
    // while the runtime is down, to show why a restart failed.
    let runtime_log = std::env::var("DYFJ_RUNTIME_LOG").ok().filter(|path| !path.is_empty());
    // A runtime has to be there at startup; the launcher starts one when it
    // is not. Only an established connection is waited for when it drops.
    let (mut client, mut incoming) = Client::connect(&socket)
        .await
        .with_context(|| format!("no runtime at {socket}; start it with `dyfj start`"))?;

    println!("dyfj — Ctrl-C cancels a turn, Ctrl-D quits, /help lists commands");
    // A resumed session's history was built on the model it last ran on;
    // resuming it on another could overflow that model's window.
    // `--model` names the model outright, so the recorded one is not needed;
    // otherwise a session whose recorded model cannot be read is refused,
    // because sending the configured model would run its history elsewhere.
    if let Some(id) = session.id.clone().filter(|_| !session.model_pinned) {
        match commands::recorded_model(&client, &id).await {
            Ok(recorded) => session.restore_model(recorded),
            Err(()) => {
                eprintln!("not resumed: name a model with --model <slug>");
                std::process::exit(2);
            }
        }
    }
    // Ask the runtime what it is before the first turn. Without this the
    // operator cannot tell which model they are talking to, or whether a
    // runtime answered at all.
    match client.request("runtime/status", json!({})).await {
        Ok(status) => {
            println!("{}", posture::line(&status, &session, &socket));
            for warning in posture::unresolved_pointer_warnings(&status) {
                eprintln!("{warning}");
            }
        }
        Err(err) => println!("{}", runtime_line("posture: unavailable", &err.to_string(), &socket)),
    }
    if !commands::startup_model_ok(&client, &session).await {
        std::process::exit(2);
    }

    // Ctrl-C reaches us two different ways, and the split is structural rather
    // than a choice. While rustyline is reading — the prompt, or an approval —
    // it holds the terminal in raw mode with ISIG cleared, so Ctrl-C is a byte
    // it reports as Interrupted. While a turn streams and no read is active,
    // rustyline has restored cooked mode, and Ctrl-C is a real SIGINT. An
    // approval read's Interrupted cancels the turn the same way that SIGINT
    // does. The two are live at different times, so they do not both see one
    // keypress.
    let mut sigint = signal(SignalKind::interrupt())
        .context("install SIGINT handler")?;
    // Forwarded into a channel so commands can take interrupts from a test as
    // well. Capacity one with `try_send` coalesces them as the signal does.
    let (interrupt_tx, mut interrupts) = mpsc::channel::<()>(1);
    tokio::spawn(async move {
        while sigint.recv().await.is_some() {
            let _ = interrupt_tx.try_send(());
        }
    });

    // The open prompt read. It outlives a disconnect: a prompt still open when
    // the runtime returns is answered against the restarted runtime.
    let mut pending: Option<oneshot::Receiver<ReadOutcome>> = None;
    loop {
        if client.is_closed() {
            eprintln!("\nruntime disconnected; waiting… (Ctrl-C or /quit to leave)");
            // A Ctrl-C pressed before the disconnect was for the work it cut
            // short, not a request to stop waiting.
            while interrupts.try_recv().is_ok() {}
            let mut log = runtime_log.as_deref().map(link::LogTail::from_end);
            let waited = link::wait_for_runtime(
                &socket,
                &input,
                &mut pending,
                &mut orphans,
                &mut interrupts,
                &mut log,
                &mut link::backoff(),
            )
            .await;
            match waited {
                link::Waited::Quit => break,
                link::Waited::Reconnected(restarted, restarted_incoming) => {
                    client = restarted;
                    incoming = restarted_incoming;
                    link::resume(&client, &session, &socket).await;
                    continue;
                }
            }
        }
        if pending.is_none() {
            let (respond, answer) = oneshot::channel();
            if input.send(Ask::Prompt { respond }).await.is_err() {
                break;
            }
            pending = Some(answer);
        }
        let Some(read) = pending.as_mut() else { continue };
        let outcome = tokio::select! {
            biased;
            // Back to the top, where the disconnect is announced; the prompt
            // read stays open.
            () = client.closed() => continue,
            Some(orphan) = orphans.recv() => {
                link::note_orphan(&orphan);
                continue;
            }
            outcome = read => outcome,
        };
        pending = None;
        let line = match outcome {
            Ok(ReadOutcome::Line(line)) => line,
            // Ctrl-C at the prompt clears the line; it does not exit.
            Ok(ReadOutcome::Interrupted) => continue,
            Ok(ReadOutcome::Eof) => break,
            Ok(ReadOutcome::Failed(err)) => {
                eprintln!("input failed: {err}");
                break;
            }
            Err(_) => break,
        };

        // No SIGINT is raised while the prompt reads (rustyline clears ISIG),
        // so one still queued was pressed during earlier work. Spend it now:
        // left queued it would cancel this submission the moment it starts.
        while interrupts.try_recv().is_ok() {}

        // The input ceiling applies before anything is sent, commands included.
        match classify(&line) {
            Submission::Empty => continue,
            Submission::Quit => break,
            Submission::TooLong { characters } => {
                eprintln!(
                    "input is {characters} characters; the limit is {MAX_INPUT_CHARACTERS}. \
                     Nothing was sent."
                );
                continue;
            }
            Submission::Prompt => {}
        }

        if let Some(command) = commands::parse(&line) {
            // `/friction` is not context for the next `/friction`: recording it
            // would post one report's text inside the next one's context.
            let records = commands::records_as_last_command(&line, &command);
            let prompter = commands::Prompter {
                input: &input,
                incoming: &mut incoming,
                interrupts: &mut interrupts,
            };
            commands::run(command, &client, &mut session, prompter).await;
            if records {
                session.last_command = Some(line.trim().to_string());
            }
            continue;
        }

        run_turn(
            &client,
            &input,
            &mut incoming,
            &mut interrupts,
            &line,
            &mut session,
        )
        .await;
        // A turn the disconnect interrupted needs nothing more here: the top
        // of the loop sees the closed client and waits for the runtime.
        // `/friction` names only a slash command typed just before it, as the
        // TypeScript REPL does; a turn in between ends that attribution.
        session.last_command = None;
    }

    // Ordinary exit (Ctrl-D or /quit, including while waiting for the runtime):
    // put the terminal back the way it was before rustyline took it. The panic
    // hook covers the abnormal paths.
    terminal::restore();
    Ok(())
}

/// How a turn ended, for the loop that issued it.
pub(crate) enum TurnEnd {
    /// The runtime settled it, or the operator stopped waiting for it.
    Settled,
    /// The runtime went away before it settled.
    Disconnected,
}

/// Issue one turn and render it, answering approvals and honouring Ctrl-C.
///
/// Completion is the `turn` response, not a stream frame: a `done` frame is
/// ignored and an `error` frame is printed, but neither ends the wait. A
/// disconnect also ends it, reported as interrupted.
async fn run_turn(
    client: &Client,
    input: &mpsc::Sender<Ask>,
    incoming: &mut mpsc::Receiver<Incoming>,
    interrupts: &mut mpsc::Receiver<()>,
    prompt: &str,
    session: &mut Session,
) -> TurnEnd {
    let turn_id = new_turn_id();
    let body = session.turn_body(prompt, &turn_id);

    // Acknowledge the submission before anything else. The first event of a
    // turn can be seconds away — context assembly, then a provider round trip
    // — and until it arrives the operator has no evidence their input was
    // taken at all. On a turn that calls tools this is the only output for a
    // while, so it earns its line.
    println!("· working…");

    let pending = client.request("turn", body);
    tokio::pin!(pending);

    let mut wrote_any = false;
    let mut cancelling = false;
    loop {
        tokio::select! {
            // The turn settled.
            outcome = &mut pending => {
                // Render queued frames FIRST. `select!` can take the response
                // while the answer is still in the channel, and the receipt
                // fallback below keys on whether anything was written — decide
                // that after draining, or a streamed answer prints once from
                // the receipt and again from the queue.
                flush_queued_frames(incoming, &mut wrote_any);

                match outcome {
                    Ok(result) => {
                        session.record(&result);
                        // Deltas are not guaranteed. A provider whose
                        // tool-offering calls are buffered streams no text at
                        // all — verified against a live runtime on Anthropic,
                        // where a turn produced seven event frames, zero
                        // deltas, and the answer only in `text`. Render that
                        // text when nothing was streamed, or the answer is
                        // invisible. Warning lines in the `receipt` string
                        // are shown either way.
                        let close = turn_close(&result, wrote_any);
                        if let Some(text) = close.buffered_text {
                            println!("{text}");
                            wrote_any = true;
                        }
                        if wrote_any {
                            println!();
                        }
                        for warning in close.warnings {
                            eprintln!("{warning}");
                        }
                        eprintln!("{}", receipt::line(&result, session.spend_usd));
                    }
                    Err(_) if client.is_closed() => return interrupted(wrote_any),
                    Err(err) => {
                        eprintln!("\n{}", runtime_error("turn failed", &err.to_string()));
                        if wrote_any {
                            println!();
                        }
                    }
                }
                return TurnEnd::Settled;
            }
            // Something arrived from the runtime while the turn runs.
            message = incoming.recv() => {
                match message {
                    Some(Incoming::Stream(frame)) => {
                        render(frame, &mut wrote_any);
                    }
                    Some(Incoming::Approval { params, respond }) => {
                        // Answered inline, on purpose. An earlier version
                        // spawned this so the loop could keep polling the
                        // turn, which created two worse problems: an approval
                        // could outlive the turn that raised it and consume
                        // input meant for the next prompt, and two concurrent
                        // approvals could interleave so the question on screen
                        // was not the one being answered.
                        //
                        // One terminal, one reader, one approval at a time.
                        //
                        // Ctrl-C here is readline's Interrupted, not the
                        // SIGINT branch below: rustyline has cleared ISIG for
                        // the read. Cancel this turn and answer `abort`, so
                        // the runtime does not record a denial.
                        //
                        // A disconnect while the question is open cancels it:
                        // the responder is dropped unanswered, the client
                        // writes nothing to a closed connection, and the turn
                        // ends as interrupted. The question stays on screen
                        // until answered, because the read cannot be
                        // abandoned; that answer goes nowhere.
                        match link::ask_while_connected(client, input, &params).await {
                            link::Asked::Disconnected => return interrupted(wrote_any),
                            link::Asked::Answered(approval::Outcome::Verdict(verdict)) => {
                                let _ = respond.send(verdict);
                            }
                            link::Asked::Answered(approval::Outcome::Cancelled) => {
                                let _ = respond.send(Verdict::abort());
                                if give_up_or_cancel(
                                    &mut cancelling,
                                    client,
                                    &turn_id,
                                    incoming,
                                    wrote_any,
                                ) {
                                    return TurnEnd::Settled;
                                }
                            }
                        }
                    }
                    // The reader ends only when the connection does.
                    None => return interrupted(wrote_any),
                }
            }
            // Ctrl-C during a turn. Cancellation is cooperative: ask the
            // runtime to stop and keep rendering until it settles, because the
            // turn is what owns any tool still running. A second Ctrl-C
            // abandons the wait — the operator has asked twice, and a turn
            // that ignores a cancel should not hold the prompt.
            _ = interrupts.recv() => {
                if give_up_or_cancel(&mut cancelling, client, &turn_id, incoming, wrote_any) {
                    return TurnEnd::Settled;
                }
            }
        }
    }
}

/// Report a turn the runtime's disconnection cut short. It is not retried:
/// the runtime may have acted on part of it, and only the operator can judge
/// whether to ask again.
fn interrupted(wrote_any: bool) -> TurnEnd {
    if wrote_any {
        println!();
    }
    eprintln!("turn interrupted: the runtime disconnected before it finished; it was not retried");
    TurnEnd::Disconnected
}

/// First Ctrl-C asks the runtime to stop and keeps waiting for the turn to
/// settle. A second one stops waiting. Returns true when the caller should
/// leave the turn.
///
/// The cancel is not awaited. This runs inside the select! that also renders
/// frames, answers approvals and catches the next interrupt; awaiting would
/// block all three until the runtime answers, and a runtime that never
/// answers would make the second Ctrl-C unreachable.
fn give_up_or_cancel(
    cancelling: &mut bool,
    client: &Client,
    turn_id: &str,
    incoming: &mut mpsc::Receiver<Incoming>,
    wrote_any: bool,
) -> bool {
    if *cancelling {
        eprintln!("\ngiving up on the turn; it may still be running");
        if wrote_any {
            println!();
        }
        discard_abandoned_frames(incoming);
        return true;
    }
    *cancelling = true;
    eprintln!("\ncancelling…");
    if let Err(err) = client.send_without_waiting("turn/cancel", json!({"turnId": turn_id})) {
        eprintln!("{}", runtime_error("cancel could not be sent", &err.to_string()));
    }
    false
}

/// Render everything currently queued when a turn completes.
///
/// In practice these are the tail of the answer that just finished: `select!`
/// can take the `turn` response while frames remain in the channel, so leaving
/// them drops the end of the reply. Nothing establishes that, though — frames
/// carry no turn id, so a delayed frame from an abandoned earlier turn would
/// be rendered here too.
fn flush_queued_frames(incoming: &mut mpsc::Receiver<Incoming>, wrote_any: &mut bool) {
    while let Ok(message) = incoming.try_recv() {
        match message {
            Incoming::Stream(frame) => render(frame, wrote_any),
            // An approval arriving as the turn ends has no operator watching
            // for it, and the runtime is blocked on an answer. Deny.
            Incoming::Approval { respond, .. } => {
                let _ = respond.send(Verdict::deny("turn is no longer active"));
            }
        }
    }
}

/// Format an error that came from the runtime, for the terminal.
///
/// The message text is the runtime's, and ultimately a provider's or a model's,
/// so it is sanitised like every other runtime-supplied string. An escape
/// sequence in an error would otherwise reach the terminal on the one path an
/// operator is least likely to be scrutinising.
fn runtime_error(context: &str, message: &str) -> String {
    format!("{context}: {}", approval::visible(message))
}

/// The same, for a line that also carries local context such as the socket
/// path, which is ours and not sanitised away.
fn runtime_line(context: &str, message: &str, local: &str) -> String {
    format!("{context} ({}) · {local}", approval::visible(message))
}

/// Discard frames queued for a turn the operator abandoned.
///
/// Only what is already queued is dropped. Frames are not tagged with a turn,
/// so a frame the abandoned turn emits AFTER this returns will still arrive on
/// the shared channel and render under the next prompt. Closing that gap needs
/// a turn identifier on the frame, which the protocol does not carry.
fn discard_abandoned_frames(incoming: &mut mpsc::Receiver<Incoming>) {
    while let Ok(message) = incoming.try_recv() {
        if let Incoming::Approval { respond, .. } = message {
            let _ = respond.send(Verdict::deny("turn is no longer active"));
        }
    }
}

/// What a settled turn still has to show after queued frames are flushed.
///
/// `buffered_text` is the answer when nothing was streamed. `warnings` are
/// the receipt's safety-warning lines. Those are filled in either case:
/// `wrote_any` decides only whether the answer text is printed again.
struct TurnClose {
    buffered_text: Option<String>,
    warnings: Vec<String>,
}

/// Decide the answer fallback and the receipt warnings for a completed turn.
///
/// `wrote_any` is whether answer text already reached the terminal as deltas.
fn turn_close(result: &Value, wrote_any: bool) -> TurnClose {
    let buffered_text = if wrote_any {
        None
    } else {
        result
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(approval::visible_text)
    };
    TurnClose {
        buffered_text,
        warnings: receipt::safety_warnings(result),
    }
}

/// The runtime validates `turnId` against a UUID shape and rejects anything
/// else, so this is a protocol requirement rather than a formatting choice. It
/// also routes `turn/cancel` by this id: a repeated id would let a cancel land
/// on the wrong turn.
fn new_turn_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::{MAX_INPUT_CHARACTERS, Submission, classify, new_turn_id, resolve_socket_path};

    /// The receipt string carries the audit-gap warning beside the answer.
    /// Streaming must not hide it, and a buffered answer must still appear.
    #[test]
    fn an_audit_gap_warning_is_shown_for_a_streamed_answer_and_a_buffered_one() {
        let warning =
            "WARNING: 2 event write(s) failed \u{2014} the session's audit log has gaps\u{1b}[2J";
        let result = serde_json::json!({
            "sessionId": "01J9ZQ4W8X6V5T3R2P1N0M9K8H",
            "text": "the answer",
            "receipt": format!(
                "Workbench receipt\nSession: 01J\n{warning}\nActual cost:    $0.000000\n"
            ),
        });

        let shows_warning = |lines: &[String]| {
            lines
                .iter()
                .any(|line| line.contains("audit log has gaps") && !line.contains('\u{1b}'))
        };

        let streamed = super::turn_close(&result, true);
        assert!(
            streamed.buffered_text.is_none(),
            "a streamed answer is not printed again from the receipt text"
        );
        assert!(
            shows_warning(&streamed.warnings),
            "streamed answer dropped the warning: {:?}",
            streamed.warnings
        );

        let buffered = super::turn_close(&result, false);
        assert_eq!(buffered.buffered_text.as_deref(), Some("the answer"));
        assert!(
            shows_warning(&buffered.warnings),
            "buffered answer dropped the warning: {:?}",
            buffered.warnings
        );
    }

    /// Sequence tests for supersession. Single-event tests cannot catch this:
    /// the defect is what `wrote_any` carries ACROSS events, and it decides
    /// whether the authoritative receipt is ever displayed.
    #[test]
    fn supersession_resets_the_receipt_fallback_state() {
        let mut wrote_any = false;

        // The abandoned attempt streams something.
        super::render(
            crate::client::StreamFrame::Delta { text: "stale answer".into() },
            &mut wrote_any,
        );
        assert!(wrote_any, "a delta marks the turn as having written");

        // The runtime gives up and starts again.
        super::render(
            crate::client::StreamFrame::Event {
                event: serde_json::json!({"type": crate::activity::SUPERSEDING_RETRY}),
            },
            &mut wrote_any,
        );
        assert!(
            !wrote_any,
            "after supersession the turn has shown nothing authoritative, so a \
             buffered replacement must still be able to print"
        );
    }

    /// A replacement that streams sets the flag again, so the receipt fallback
    /// does not double-print it.
    #[test]
    fn a_streamed_replacement_counts_as_written_again() {
        let mut wrote_any = false;
        super::render(
            crate::client::StreamFrame::Event {
                event: serde_json::json!({"type": crate::activity::SUPERSEDING_RETRY}),
            },
            &mut wrote_any,
        );
        super::render(
            crate::client::StreamFrame::Delta { text: "fresh answer".into() },
            &mut wrote_any,
        );
        assert!(wrote_any);
    }

    /// An ordinary progress event must not disturb the flag either way.
    #[test]
    fn progress_events_do_not_touch_the_fallback_state() {
        for started in [false, true] {
            let mut wrote_any = started;
            super::render(
                crate::client::StreamFrame::Event {
                    event: serde_json::json!({"type": "toolCallStarted", "commandId": "bash"}),
                },
                &mut wrote_any,
            );
            assert_eq!(wrote_any, started);
        }
    }

    /// Drive the formatting paths, not the sanitiser.
    ///
    /// An earlier version of this test called `visible` directly, which proved
    /// only that the sanitiser works — it could not detect a path that never
    /// called it, and three such paths were shipped: stream errors, RPC errors
    /// and the posture line.
    #[test]
    fn runtime_errors_reaching_the_terminal_are_sanitised() {
        let hostile = "boom\u{1b}[2J wiped";
        let rendered = super::runtime_error("turn failed", hostile);
        assert!(!rendered.contains('\u{1b}'), "escape survived: {rendered:?}");
        assert!(rendered.contains("wiped"), "text must not be dropped: {rendered:?}");
        assert!(rendered.starts_with("turn failed: "), "{rendered:?}");

        let line = super::runtime_line("posture: unavailable", hostile, "/tmp/s.sock");
        assert!(!line.contains('\u{1b}'), "escape survived: {line:?}");
        assert!(line.contains("/tmp/s.sock"), "local context must survive: {line:?}");
    }


    #[test]
    fn a_typed_slash_command_is_a_command() {
        assert_eq!(classify("/exit"), Submission::Quit);
        assert_eq!(classify("  /quit  "), Submission::Quit);
    }

    /// The failure this guards against is a pasted block whose first line
    /// happens to be a command quitting the session, or worse, switching the
    /// model mid-paste.
    #[test]
    fn a_slash_line_inside_a_paste_is_content() {
        assert_eq!(classify("/exit\nand then some prose"), Submission::Prompt);
        assert_eq!(classify("explain this:\n/model haiku\ndone"), Submission::Prompt);
        assert_eq!(classify("/model some-slug now"), Submission::Prompt);
    }

    #[test]
    fn blank_input_is_not_a_turn() {
        assert_eq!(classify(""), Submission::Empty);
        assert_eq!(classify("   \n  \n"), Submission::Empty);
    }

    #[test]
    fn the_ceiling_counts_characters_including_newlines() {
        let at_limit = "x".repeat(MAX_INPUT_CHARACTERS);
        assert_eq!(classify(&at_limit), Submission::Prompt);

        let over = "x".repeat(MAX_INPUT_CHARACTERS + 1);
        assert_eq!(
            classify(&over),
            Submission::TooLong { characters: MAX_INPUT_CHARACTERS + 1 }
        );

        // Newlines are part of the assembled prompt and count toward it.
        let lines = vec!["x".repeat(9); 3277].join("\n");
        assert!(lines.chars().count() > MAX_INPUT_CHARACTERS);
        assert!(matches!(classify(&lines), Submission::TooLong { .. }));
    }

    /// A byte count would reject valid input well under the character ceiling.
    #[test]
    fn the_ceiling_is_characters_not_bytes() {
        let multibyte = "é".repeat(MAX_INPUT_CHARACTERS);
        assert!(multibyte.len() > MAX_INPUT_CHARACTERS, "the test string must be multi-byte");
        assert_eq!(classify(&multibyte), Submission::Prompt);
    }

    /// An astral character is two UTF-16 units, as it is to the TypeScript
    /// peer's `line.length`, so half the ceiling of them is already at it.
    #[test]
    fn the_ceiling_counts_utf16_units_like_the_typescript_cli() {
        let at_limit = "😀".repeat(MAX_INPUT_CHARACTERS / 2);
        assert_eq!(classify(&at_limit), Submission::Prompt);

        let over = format!("{at_limit}x");
        assert_eq!(
            classify(&over),
            Submission::TooLong { characters: MAX_INPUT_CHARACTERS + 1 }
        );
    }


    /// Mirrors TURN_ID_SHAPE in the runtime's turn-runner. A turn id that
    /// fails this is rejected before the turn starts, so the check belongs
    /// here rather than being discovered against a live socket.
    #[test]
    fn turn_ids_match_the_shape_the_runtime_requires() {
        let id = new_turn_id();
        let bytes = id.as_bytes();
        assert_eq!(id.len(), 36, "{id}");
        assert_eq!(bytes[8], b'-');
        assert_eq!(bytes[13], b'-');
        assert_eq!(bytes[18], b'-');
        assert_eq!(bytes[23], b'-');
        // Version nibble must be 1-8, variant nibble 8/9/a/b.
        let version = id.chars().nth(14).unwrap();
        let variant = id.chars().nth(19).unwrap();
        assert!(('1'..='8').contains(&version), "version {version} in {id}");
        assert!(matches!(variant, '8' | '9' | 'a' | 'b'), "variant {variant} in {id}");
        assert!(
            id.chars().all(|c| c == '-' || c.is_ascii_hexdigit()),
            "non-hex character in {id}"
        );
        assert_ne!(new_turn_id(), new_turn_id(), "ids must not repeat");
    }

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_string())
        }
    }

    /// The precedence the runtime serves on; a client that skips a step
    /// connects to a socket nobody is listening on.
    #[test]
    fn socket_resolution_matches_the_runtime() {
        let all = [
            ("DYFJ_SOCKET", "/x/explicit.sock"),
            ("XDG_RUNTIME_DIR", "/run/user/1000"),
            ("HOME", "/operator-home"),
        ];
        assert_eq!(resolve_socket_path(env(&all)).unwrap(), "/x/explicit.sock");
        assert_eq!(
            resolve_socket_path(env(&all[1..])).unwrap(),
            "/run/user/1000/dyfj/workbench.sock"
        );
        assert_eq!(
            resolve_socket_path(env(&all[2..])).unwrap(),
            "/operator-home/.dyfj/run/workbench.sock"
        );
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn arguments_set_routing_paid_consent_and_resume() {
        let session = super::parse_args(
            &args(&[
                "--model",
                "z-ai/glm-5.2",
                "--approve-paid",
                "--fast",
                "--session",
                "01J9ZQ4W8X6V5T3R2P1N0M9K8H",
            ]),
            env(&[]),
            Some("/cwd".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(session.model.as_deref(), Some("z-ai/glm-5.2"));
        assert!(session.model_pinned, "--model wins over a resumed session's model");
        assert!(session.approve_paid);
        assert_eq!(session.fast, Some(true));
        assert_eq!(session.id.as_deref(), Some("01J9ZQ4W8X6V5T3R2P1N0M9K8H"));
        // A resumed session's workspace is the one stored on its row.
        assert_eq!(session.workspace, None);
    }

    /// A malformed id fails at startup rather than at the first turn, and the
    /// slug `dyfj sessions` lists is accepted as the TypeScript CLI accepts it.
    #[test]
    fn a_session_reference_is_validated_and_canonicalised() {
        let parse = |value: &str| super::parse_args(&args(&["--session", value]), env(&[]), None);
        let err = parse("nope").unwrap_err();
        assert!(err.contains("--session expects a session id"), "{err}");
        let session = parse("workbench-01j9zq4w8x6v5t3r2p1n0m9k8h").unwrap().unwrap();
        assert_eq!(session.id.as_deref(), Some("01J9ZQ4W8X6V5T3R2P1N0M9K8H"));
    }

    /// The same precedence the TypeScript CLI uses: a flag, then the
    /// environment, then the directory the REPL was started in.
    #[test]
    fn workspace_and_model_fall_back_to_the_environment_then_cwd() {
        let vars = [
            ("DYFJ_WORKSPACE", "/env-ws"),
            ("DYFJ_WORKBENCH_MODEL", "env-model"),
        ];
        let from_env = super::parse_args(&[], env(&vars), Some("/cwd".into()))
            .unwrap()
            .unwrap();
        assert_eq!(from_env.workspace.as_deref(), Some("/env-ws"));
        assert_eq!(from_env.model.as_deref(), Some("env-model"));
        assert!(!from_env.model_pinned, "the environment's model is a default");

        let flag = super::parse_args(
            &args(&["--workspace", "/flag"]),
            env(&vars),
            Some("/cwd".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(flag.workspace.as_deref(), Some("/flag"));

        let bare = super::parse_args(&[], env(&[]), Some("/cwd".into()))
            .unwrap()
            .unwrap();
        assert_eq!(bare.workspace.as_deref(), Some("/cwd"));
        assert_eq!(bare.model, None);
        assert!(!bare.approve_paid, "paid consent is never implied");
    }

    #[test]
    fn bad_arguments_are_refused() {
        assert!(super::parse_args(&args(&["--model"]), env(&[]), None).is_err());
        assert!(super::parse_args(&args(&["--model", "--fast"]), env(&[]), None).is_err());
        assert!(super::parse_args(&args(&["--wat"]), env(&[]), None).is_err());
        assert!(
            super::parse_args(&args(&["--help"]), env(&[]), None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn an_empty_socket_variable_counts_as_unset() {
        let empty = [("DYFJ_SOCKET", ""), ("XDG_RUNTIME_DIR", ""), ("HOME", "/operator-home")];
        assert_eq!(
            resolve_socket_path(env(&empty)).unwrap(),
            "/operator-home/.dyfj/run/workbench.sock"
        );
    }

    /// Two approvals during one turn. The terminal answers `n`, then Ctrl-C.
    ///
    /// `n` denies the first call. Ctrl-C sends `turn/cancel` for the turn this
    /// REPL started and is not a second denial. The turn then settles, and a
    /// later request still reaches the runtime. Approval requests carry no
    /// turn id; the cancel uses the id from the turn request.
    #[tokio::test]
    async fn back_to_back_approvals_deny_on_n_and_cancel_on_ctrl_c() {
        use crate::client::Client;
        use crate::session::Session;
        use crate::terminal::{Ask, ReadOutcome};
        use std::sync::{Arc, Mutex};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixStream;

        let (client_side, server_side) = UnixStream::pair().unwrap();
        let (client, mut incoming) = Client::over(client_side);
        let log = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let seen = Arc::clone(&log);
        let server = tokio::spawn(async move {
            let (read, mut write) = server_side.into_split();
            let mut lines = BufReader::new(read).lines();
            let mut turn_rpc_id = None;
            let mut answers = 0;
            let mut saw_cancel = false;
            loop {
                let Ok(Some(line)) = lines.next_line().await else { break };
                let msg: serde_json::Value = serde_json::from_str(&line).unwrap();
                seen.lock().unwrap().push(msg.clone());
                let method = msg.get("method").and_then(serde_json::Value::as_str).unwrap_or("");
                if method == "turn" {
                    turn_rpc_id = Some(msg["id"].clone());
                    let ask = serde_json::json!({
                        "jsonrpc": "2.0", "id": "p1", "method": "approval",
                        "params": {"commandId": "bash", "title": "bash", "arguments": {"command": "echo one"}}
                    });
                    write.write_all(format!("{ask}\n").as_bytes()).await.unwrap();
                    continue;
                }
                if method == "turn/cancel" {
                    saw_cancel = true;
                    if answers >= 2 {
                        let reply = serde_json::json!({
                            "jsonrpc": "2.0", "id": turn_rpc_id.clone().unwrap(),
                            "result": {"text": "", "stopReason": "aborted", "sessionId": "s1"}
                        });
                        write.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
                    }
                    continue;
                }
                if method == "runtime/status" {
                    let reply = serde_json::json!({"jsonrpc": "2.0", "id": msg["id"], "result": {}});
                    write.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
                    continue;
                }
                if msg.get("result").is_some() {
                    answers += 1;
                    if answers == 1 {
                        let ask = serde_json::json!({
                            "jsonrpc": "2.0", "id": "p2", "method": "approval",
                            "params": {"commandId": "bash", "title": "bash", "arguments": {"command": "echo two"}}
                        });
                        write.write_all(format!("{ask}\n").as_bytes()).await.unwrap();
                    } else if answers == 2 {
                        let decision = msg["result"]["decision"].as_str().unwrap_or("");
                        if decision == "deny" || saw_cancel {
                            let reply = serde_json::json!({
                                "jsonrpc": "2.0", "id": turn_rpc_id.clone().unwrap(),
                                "result": {"text": "", "stopReason": "aborted", "sessionId": "s1"}
                            });
                            write.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
                        }
                    }
                }
            }
        });

        let (input_tx, mut input_rx) = tokio::sync::mpsc::channel(4);
        tokio::spawn(async move {
            let mut scripted = vec![
                ReadOutcome::Line("n".into()),
                ReadOutcome::Interrupted,
            ];
            while let Some(ask) = input_rx.recv().await {
                let respond = match ask {
                    Ask::Prompt { respond } | Ask::Approval { respond, .. } => respond,
                };
                let next = scripted.remove(0);
                let _ = respond.send(next);
            }
        });
        let (_interrupt_tx, mut interrupts) = tokio::sync::mpsc::channel::<()>(1);
        let mut session = Session::default();

        super::run_turn(
            &client,
            &input_tx,
            &mut incoming,
            &mut interrupts,
            "do the thing",
            &mut session,
        )
        .await;
        assert_eq!(session.turns, 1, "the settled turn is recorded on the session");

        client
            .request("runtime/status", serde_json::json!({}))
            .await
            .expect("the connection still accepts a request");

        let seen = log.lock().unwrap().clone();
        server.abort();
        let turn_id = seen.iter().find(|m| m["method"] == "turn").unwrap()["params"]["turnId"].clone();
        let denies: Vec<_> = seen.iter().filter(|m| m["result"]["decision"] == "deny").collect();
        assert_eq!(
            denies.len(),
            1,
            "n denies one call; Ctrl-C is not a second denial. seen={seen:?}"
        );
        assert_eq!(denies[0]["id"], "p1", "the denial is the call answered with n");
        assert_eq!(denies[0]["result"]["reason"], "operator declined");
        let aborts: Vec<_> = seen.iter().filter(|m| m["result"]["decision"] == "abort").collect();
        assert_eq!(aborts.len(), 1, "Ctrl-C answers the second approval as a cancel. seen={seen:?}");
        assert_eq!(aborts[0]["id"], "p2");
        let cancels: Vec<_> = seen.iter().filter(|m| m["method"] == "turn/cancel").collect();
        assert_eq!(cancels.len(), 1, "Ctrl-C sends turn/cancel. seen={seen:?}");
        assert_eq!(cancels[0]["params"]["turnId"], turn_id);
    }
}

/// Render one stream frame as it arrives.
fn render(frame: StreamFrame, wrote_any: &mut bool) {
    match frame {
        StreamFrame::Delta { text } => {
            // An empty delta displays nothing, so it must not count as having
            // written: it would suppress the receipt fallback and the answer
            // would never appear.
            if text.is_empty() {
                return;
            }
            // Sanitised for the same reason approval text is. Model output
            // reaches the terminal verbatim otherwise, and an escape sequence
            // in a streamed answer could change terminal state before a later
            // approval is displayed — sanitising only the approval would be
            // guarding the door after the wall. Newlines and tabs are kept:
            // they are the answer's formatting, not terminal control.
            print!("{}", approval::visible_text(&text));
            let _ = std::io::stdout().flush();
            *wrote_any = true;
        }
        StreamFrame::Error { message } => {
            eprintln!("\n{}", runtime_error("error", &message))
        }
        // Progress. On a provider that buffers its tool-offering calls these
        // are the only sign a turn is alive, so they are shown rather than
        // discarded. The terminal outcome comes from the `turn` response, not
        // from this frame.
        StreamFrame::Event { event } => {
            // Supersession abandons what was already shown. Clearing
            // `wrote_any` matters as much as the marker: leaving it set would
            // suppress the receipt fallback, so a buffered replacement would
            // never print and the abandoned attempt would remain as the
            // visible answer.
            if event.get("type").and_then(Value::as_str) == Some(activity::SUPERSEDING_RETRY) {
                println!();
                println!("{}", activity::SUPERSEDED_MARKER);
                *wrote_any = false;
                return;
            }
            if let Some(line) = activity::describe(&event) {
                println!("{line}");
            }
        }
        StreamFrame::Done { .. } => {}
        // A frame kind this client does not know. Ignored rather than fatal,
        // so the runtime can add kinds without breaking an older front-end.
        StreamFrame::Unknown => {}
    }
}
