//! DYFJ interactive REPL front-end.
//!
//! Owns the terminal and speaks the Workbench UDS protocol. The runtime holds
//! the agent loop; this binary is a client of it, which is why replacing the
//! TypeScript REPL does not touch the engine.

mod activity;
mod approval;
mod approval_external;
mod approval_fields;
#[cfg(test)]
mod approval_external_tests;
mod args;
mod budget;
mod client;
mod commands;
mod dev_control;
mod effort;
mod evidence;
#[cfg(test)]
mod fake_runtime;
mod link;
mod parked;
mod posture;
mod progress;
mod receipt;
mod session;
mod submission;
mod terminal;

use anyhow::{Context, Result};
use client::{Client, Incoming, StreamFrame, Verdict, for_turn, new_turn_id};
use serde_json::{Value, json};
use session::Session;
use submission::{MAX_INPUT_CHARACTERS, Submission, classify};
use std::io::{IsTerminal, Write};
use std::time::{Duration, Instant};
use terminal::{Ask, ReadOutcome};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{mpsc, oneshot};


#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned());
    let mut session = match args::parse_args(&args, |key| std::env::var(key).ok(), cwd) {
        Ok(Some(session)) => session,
        Ok(None) => {
            println!("{}", args::USAGE);
            return Ok(());
        }
        Err(message) => {
            eprintln!("dyfj-repl: {message}\n{}", args::USAGE);
            std::process::exit(2);
        }
    };
    let socket = args::socket_path()?;
    // Before the terminal is taken, not after: a panic during startup would
    // otherwise leave it in whatever state it had reached.
    terminal::install_panic_restore();
    let (input, mut orphans) = terminal::spawn()?;
    // Where the launcher writes this runtime's output, when it knows. Read only
    // while the runtime is down, to show why a restart failed.
    let runtime_log = std::env::var("DYFJ_RUNTIME_LOG").ok().filter(|path| !path.is_empty());
    // Under `dyfj dev`, the supervisor's channel: why the runtime restarts,
    // `/reload`, and its request to exit before a rebuilt REPL takes over.
    let mut control = dev_control::DevControl::attach();
    let mut exit = control.as_ref().map_or_else(dev_control::ExitWatch::none, |c| c.exit_watch());
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
    // Replacing a REPL that reloaded together with the runtime: this is the
    // only place the operator hears of it, one notice before the posture line.
    if control.is_some()
        && let Some(reason) = dev_control::reloaded_reason(|key| std::env::var(key).ok())
    {
        println!("\n{}", link::both_reloaded_notice(Some(&reason), session.id.as_deref()));
    }
    // Ask the runtime what it is before the first turn. Without this the
    // operator cannot tell which model they are talking to, or whether a
    // runtime answered at all.
    posture::show(&client.request("runtime/status", json!({})).await, &session, &socket, control.is_some());
    if !commands::startup_model_ok(&client, &session).await {
        std::process::exit(2);
    }
    if let Some(control) = control.as_mut() {
        control.note_session(session.id.as_deref());
    }
    // Attaching to a session: a turn the runtime started there may be waiting
    // for an approval that only an attached operator can give.
    if let Some(id) = session.id.clone() {
        parked::answer_parked_for_agent(&client, &input, &id, session.model.as_deref()).await;
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
                &mut exit,
                &mut log,
                session.last_evidence.as_deref(),
                &mut link::backoff(),
            )
            .await;
            match waited {
                link::Waited::Quit => break,
                link::Waited::Reconnected(restarted, restarted_incoming) => {
                    client = restarted;
                    incoming = restarted_incoming;
                    let reload = control.as_ref().and_then(|c| c.take_reload());
                    // Told it is being replaced: the REPL that takes over
                    // announces the reload, once.
                    if reload.as_ref().is_some_and(|r| r.replaced) {
                        continue;
                    }
                    let reason = reload.map(|r| r.reason);
                    link::resume(&client, &session, &socket, reason, control.is_some()).await;
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
        let outcome = match link::await_prompt(
            &client,
            &mut incoming,
            read,
            &mut orphans,
            &mut exit,
            session.id.as_deref(),
        )
        .await
        {
            link::Prompted::Read(outcome) => outcome,
            link::Prompted::Exit => break,
            // Back to the top, where the disconnect is announced; the prompt
            // read stays open.
            link::Prompted::Disconnected => continue,
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

        // `/reload` and `/rollback` are commands only under `dyfj dev`;
        // elsewhere they are refused as unknown commands, as any `/word` is.
        // A multi-line paste is text, so it is never a control command.
        if let Some(control) = control.as_ref().filter(|_| !line.contains('\n')) {
            match line.trim() {
                "/reload" => {
                    control.request_reload();
                    eprintln!("reload requested");
                    continue;
                }
                "/rollback" => {
                    control.request_rollback();
                    eprintln!("rollback requested");
                    continue;
                }
                _ => {}
            }
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
            let help = command == commands::Command::Help;
            commands::run(command, &client, &mut session, prompter).await;
            if records {
                session.last_command = Some(line.trim().to_string());
            }
            if let Some(control) = control.as_mut() {
                if help {
                    eprintln!("  /reload                                              restart the dev runtime now (dyfj dev)");
                    eprintln!("  /rollback                                            run the last good code instead (dyfj dev)");
                }
                control.note_session(session.id.as_deref());
            }
            continue;
        }

        if !parked::clear_to_send_for_agent(&client, &input, session.id.as_deref(), session.model.as_deref()).await {
            continue;
        }
        run_turn(
            &client,
            &input,
            &mut incoming,
            &mut interrupts,
            &commands::prompt_text(&line),
            &mut session,
        )
        .await;
        // A turn the disconnect interrupted needs nothing more here: the top
        // of the loop sees the closed client and waits for the runtime.
        // `/friction` names only a slash command typed just before it, as the
        // TypeScript REPL does; a turn in between ends that attribution.
        session.last_command = None;
        if let Some(control) = control.as_mut() {
            control.note_session(session.id.as_deref());
        }
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
    // Both streams: the line is drawn on stderr, but whether it may be drawn
    // depends on where streamed text left the cursor on stdout.
    let terminal = std::io::stderr().is_terminal() && std::io::stdout().is_terminal();
    let mut view = TurnView::new(terminal, Instant::now());

    // Acknowledge the submission before anything else. The first event of a
    // turn can be seconds away — context assembly, then a provider round trip
    // — and until it arrives the operator has no evidence their input was
    // taken at all. On a terminal the status line does this, with a clock;
    // elsewhere a line earns its place.
    if view.status.enabled() {
        view.status.draw(Instant::now());
    } else {
        println!("· working…");
    }

    let pending = client.request("turn", body);
    tokio::pin!(pending);
    // Redraws the status line, so a long wait shows its clock moving.
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

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
                flush_queued_frames(incoming, &turn_id, &mut wrote_any, session, &mut view);
                view.status.clear();

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
                        if length_stopped_empty(&result) {
                            eprintln!("turn stopped at the output limit");
                        }
                        if let Some(line) = cancelled_line(&result, wrote_any) {
                            eprintln!("{line}");
                        }
                        view.close(session);
                        eprintln!("{}", receipt::line(&result, session.spend_usd));
                    }
                    Err(_) if client.is_closed() => return interrupted(wrote_any, &mut view, session),
                    Err(err) => {
                        let runtime_log = std::env::var("DYFJ_RUNTIME_LOG").ok();
                        eprintln!("\n{}", turn_failure_line(&err.to_string(), runtime_log.as_deref()));
                        if wrote_any {
                            println!();
                        }
                        view.close_failed(session);
                    }
                }
                return TurnEnd::Settled;
            }
            // Nothing arrived this second: move the clock.
            _ = tick.tick() => view.status.draw(Instant::now()),
            // Something arrived from the runtime while the turn runs.
            message = incoming.recv() => {
                match message {
                    // A frame from a turn abandoned earlier is not this
                    // turn's activity.
                    Some(Incoming::Stream { turn_id: tagged, .. })
                        if !for_turn(tagged.as_deref(), &turn_id) => {}
                    Some(Incoming::Stream { frame, .. }) => {
                        adopt_announced_session(&frame, session);
                        render(frame, &mut wrote_any, &mut view);
                    }
                    Some(Incoming::Approval { params, respond }) => {
                        // The question owns the terminal until it is answered.
                        view.status.clear();
                        if view.status.needs_newline() {
                            println!();
                        }
                        view.status.printed_line();
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
                        match approval::ask_while_connected(client, input, &params, session.model.as_deref()).await {
                            approval::Asked::Disconnected => {
                                return interrupted(wrote_any, &mut view, session);
                            }
                            approval::Asked::Answered(approval::Outcome::Verdict(verdict)) => {
                                let _ = respond.send(verdict);
                            }
                            approval::Asked::Answered(approval::Outcome::Cancelled) => {
                                let _ = respond.send(Verdict::abort());
                                if give_up_or_cancel(
                                    &mut cancelling,
                                    client,
                                    &turn_id,
                                    incoming,
                                    wrote_any,
                                    &mut view,
                                    session,
                                ) {
                                    return TurnEnd::Settled;
                                }
                            }
                        }
                    }
                    // The reader ends only when the connection does.
                    None => return interrupted(wrote_any, &mut view, session),
                }
            }
            // Ctrl-C during a turn. Cancellation is cooperative: ask the
            // runtime to stop and keep rendering until it settles, because the
            // turn is what owns any tool still running. A second Ctrl-C
            // abandons the wait — the operator has asked twice, and a turn
            // that ignores a cancel should not hold the prompt.
            _ = interrupts.recv() => {
                if give_up_or_cancel(
                    &mut cancelling,
                    client,
                    &turn_id,
                    incoming,
                    wrote_any,
                    &mut view,
                    session,
                ) {
                    return TurnEnd::Settled;
                }
            }
        }
    }
}

/// Take the session id the runtime announces when it opens a session, if this
/// REPL has none yet.
///
/// The receipt carries the id too, but only when the turn settles. A first
/// turn cut short by a disconnect has no receipt, and without this the next
/// turn would open a second session instead of resuming the one the runtime
/// already created. Only frames read while this turn runs reach here (the
/// idle prompt discards the rest), and a known id is never replaced.
fn adopt_announced_session(frame: &StreamFrame, session: &mut Session) {
    if session.id.is_some() {
        return;
    }
    let StreamFrame::Event { event } = frame else { return };
    if event.get("type").and_then(Value::as_str) != Some("sessionStart") {
        return;
    }
    if let Some(id) = event.get("sessionId").and_then(Value::as_str) {
        session.id = Some(id.to_string());
    }
}

/// Report a turn the runtime's disconnection cut short. It is not retried:
/// the runtime may have acted on part of it, and only the operator can judge
/// whether to ask again.
fn interrupted(wrote_any: bool, view: &mut TurnView, session: &mut Session) -> TurnEnd {
    view.status.clear();
    if wrote_any {
        println!();
    }
    eprintln!("turn interrupted: the runtime disconnected before it finished; it was not retried");
    view.close(session);
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
#[allow(clippy::too_many_arguments)]
fn give_up_or_cancel(
    cancelling: &mut bool,
    client: &Client,
    turn_id: &str,
    incoming: &mut mpsc::Receiver<Incoming>,
    wrote_any: bool,
    view: &mut TurnView,
    session: &mut Session,
) -> bool {
    view.status.clear();
    if *cancelling {
        eprintln!("\ngiving up on the turn; it may still be running");
        if wrote_any {
            println!();
        }
        discard_abandoned_frames(incoming);
        view.close(session);
        return true;
    }
    *cancelling = true;
    view.status.cancelling();
    eprintln!("\ncancelling…");
    view.status.printed_line();
    if let Err(err) = client.send_without_waiting("turn/cancel", json!({"turnId": turn_id})) {
        eprintln!("{}", runtime_error("cancel could not be sent", &err.to_string()));
    }
    false
}

/// Render everything currently queued when a turn completes.
///
/// These are the tail of the answer that just finished: `select!` can take
/// the `turn` response while frames remain in the channel, so leaving them
/// drops the end of the reply. A delayed frame tagged with another turn's id
/// is dropped instead.
fn flush_queued_frames(
    incoming: &mut mpsc::Receiver<Incoming>,
    turn_id: &str,
    wrote_any: &mut bool,
    session: &mut Session,
    view: &mut TurnView,
) {
    while let Ok(message) = incoming.try_recv() {
        match message {
            Incoming::Stream { turn_id: tagged, .. } if !for_turn(tagged.as_deref(), turn_id) => {}
            Incoming::Stream { frame, .. } => {
                // The turn may have failed with the disconnect before its
                // `sessionStart` was taken from the queue.
                adopt_announced_session(&frame, session);
                render(frame, wrote_any, view);
            }
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

/// The `turn failed` line. A failure that sends the operator to the runtime
/// log names the file when the launcher said where it is (`DYFJ_RUNTIME_LOG`);
/// the runtime itself does not know.
fn turn_failure_line(message: &str, runtime_log: Option<&str>) -> String {
    let line = runtime_error("turn failed", message);
    match runtime_log.filter(|path| !path.is_empty() && message.contains("runtime log")) {
        Some(path) => format!("{line} (runtime log: {})", approval::visible(path)),
        None => line,
    }
}


/// Discard frames queued for a turn the operator abandoned.
///
/// Only what is already queued is dropped. A frame the abandoned turn emits
/// later, while the REPL waits at the prompt, is discarded there
/// (`link::await_prompt`); one that arrives after the next turn has started
/// carries the abandoned turn's id, and that turn drops it.
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

/// A turn that reported a length stop with empty reply text otherwise shows
/// no reply and no explanation. The REPL prints one line saying why.
/// The line for a turn the runtime settled as cancelled, so the record says
/// so and any streamed text above reads as cut short.
fn cancelled_line(result: &Value, wrote_any: bool) -> Option<&'static str> {
    (result.get("stopReason").and_then(Value::as_str) == Some("aborted")).then_some(if wrote_any {
        "turn cancelled; the reply above was cut short"
    } else {
        "turn cancelled"
    })
}

fn length_stopped_empty(result: &Value) -> bool {
    result.get("stopReason").and_then(Value::as_str) == Some("length")
        && result.get("text").and_then(Value::as_str).unwrap_or("").is_empty()
}

#[cfg(test)]
mod tests {
    use super::{MAX_INPUT_CHARACTERS, Submission, classify};

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
            &mut super::TurnView::new(false, std::time::Instant::now()),
        );
        assert!(wrote_any, "a delta marks the turn as having written");

        // The runtime gives up and starts again.
        super::render(
            crate::client::StreamFrame::Event {
                event: serde_json::json!({"type": crate::activity::SUPERSEDING_RETRY}),
            },
            &mut wrote_any,
            &mut super::TurnView::new(false, std::time::Instant::now()),
        );
        assert!(
            !wrote_any,
            "after supersession the turn has shown nothing authoritative, so a \
             buffered replacement must still be able to print"
        );
    }

    /// A handoff that failed after streaming part of itself is followed by the
    /// runtime's notice, which is the reply: the receipt fallback must print it.
    #[test]
    fn a_failed_handoff_lets_the_notice_print_after_streamed_text() {
        let mut wrote_any = false;
        super::render(
            crate::client::StreamFrame::Delta { text: "partial handoff".into() },
            &mut wrote_any,
            &mut super::TurnView::new(false, std::time::Instant::now()),
        );
        super::render(
            crate::client::StreamFrame::Event {
                event: serde_json::json!({"type": "toolStepLimitHandoff", "source": "notice"}),
            },
            &mut wrote_any,
            &mut super::TurnView::new(false, std::time::Instant::now()),
        );
        assert!(!wrote_any);
        // A handoff the model wrote is the reply as streamed.
        let mut wrote_any = true;
        super::render(
            crate::client::StreamFrame::Event {
                event: serde_json::json!({"type": "toolStepLimitHandoff", "source": "model"}),
            },
            &mut wrote_any,
            &mut super::TurnView::new(false, std::time::Instant::now()),
        );
        assert!(wrote_any);
    }

    /// A length stop with empty reply text is the case the REPL prints one
    /// line for.
    #[test]
    fn a_length_stop_with_no_text_prints_the_output_limit_line() {
        let empty_length = serde_json::json!({"stopReason": "length", "text": ""});
        assert!(super::length_stopped_empty(&empty_length));

        let with_text = serde_json::json!({"stopReason": "length", "text": "partial"});
        assert!(!super::length_stopped_empty(&with_text));

        let normal = serde_json::json!({"stopReason": "stop", "text": ""});
        assert!(!super::length_stopped_empty(&normal));

        let aborted = serde_json::json!({"stopReason": "aborted", "text": ""});
        assert!(!super::length_stopped_empty(&aborted));
        assert_eq!(super::cancelled_line(&aborted, false), Some("turn cancelled"));
        assert_eq!(
            super::cancelled_line(&aborted, true),
            Some("turn cancelled; the reply above was cut short")
        );
        assert_eq!(super::cancelled_line(&normal, true), None);
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
            &mut super::TurnView::new(false, std::time::Instant::now()),
        );
        super::render(
            crate::client::StreamFrame::Delta { text: "fresh answer".into() },
            &mut wrote_any,
            &mut super::TurnView::new(false, std::time::Instant::now()),
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
            &mut super::TurnView::new(false, std::time::Instant::now()),
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
    fn an_unclassified_turn_failure_names_the_runtime_log_when_the_launcher_said_where_it_is() {
        let unclassified = "The turn failed on an unclassified error (Error, 29 bytes); its message is withheld. The runtime log records its class, and its code when it has one.";
        let line = super::turn_failure_line(unclassified, Some("/h/.dyfj/log/runtime-workbench-1.log"));
        assert!(line.starts_with("turn failed: The turn failed"), "{line:?}");
        assert!(line.ends_with(" (runtime log: /h/.dyfj/log/runtime-workbench-1.log)"), "{line:?}");
        assert!(!super::turn_failure_line(unclassified, None).contains("runtime log:"));
        let stated = super::turn_failure_line("Budget exceeded [turn_limit]", Some("/h/l.log"));
        assert_eq!(stated, "turn failed: Budget exceeded [turn_limit]");
    }

    #[test]
    fn runtime_errors_reaching_the_terminal_are_sanitised() {
        let hostile = "boom\u{1b}[2J wiped";
        let rendered = super::runtime_error("turn failed", hostile);
        assert!(!rendered.contains('\u{1b}'), "escape survived: {rendered:?}");
        assert!(rendered.contains("wiped"), "text must not be dropped: {rendered:?}");
        assert!(rendered.starts_with("turn failed: "), "{rendered:?}");

        let line = crate::posture::runtime_line("posture: unavailable", hostile, "/tmp/s.sock");
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

/// What one turn shows besides its answer: the live status line, and the
/// record of its tool calls that closes it.
struct TurnView {
    status: progress::StatusLine,
    ledger: evidence::Ledger,
}

impl TurnView {
    fn new(terminal: bool, now: Instant) -> Self {
        TurnView {
            status: progress::StatusLine::new(terminal, now),
            ledger: evidence::Ledger::default(),
        }
    }

    /// Print the evidence summary and keep every call for `/evidence`.
    fn close(&mut self, session: &mut Session) {
        self.close_with(session, evidence::Ledger::summary);
    }

    /// `close` for a turn that failed, which has no reply to speak of.
    fn close_failed(&mut self, session: &mut Session) {
        self.close_with(session, evidence::Ledger::failed_summary);
    }

    fn close_with(
        &mut self,
        session: &mut Session,
        summary: fn(&evidence::Ledger, i64) -> Vec<String>,
    ) {
        self.status.clear();
        let elapsed = self.status.elapsed(Instant::now()).as_millis() as i64;
        for line in summary(&self.ledger, elapsed) {
            eprintln!("{line}");
        }
        session.last_evidence = Some(self.ledger.every_call());
    }

    /// Start a whole line of progress: erase the status line, and end any
    /// streamed text the cursor is still on.
    fn line(&mut self, line: &str) {
        self.status.clear();
        if self.status.needs_newline() {
            println!();
        }
        println!("{line}");
        self.status.printed_line();
    }
}

/// Render one stream frame as it arrives.
fn render(frame: StreamFrame, wrote_any: &mut bool, view: &mut TurnView) {
    match frame {
        StreamFrame::Delta { text } => {
            // An empty delta displays nothing, so it must not count as having
            // written: it would suppress the receipt fallback and the answer
            // would never appear.
            if text.is_empty() {
                return;
            }
            view.status.clear();
            // Sanitised for the same reason approval text is. Model output
            // reaches the terminal verbatim otherwise, and an escape sequence
            // in a streamed answer could change terminal state before a later
            // approval is displayed — sanitising only the approval would be
            // guarding the door after the wall. Newlines and tabs are kept:
            // they are the answer's formatting, not terminal control.
            let shown = approval::visible_text(&text);
            print!("{shown}");
            let _ = std::io::stdout().flush();
            view.status.observe_text(&shown, Instant::now());
            *wrote_any = true;
        }
        StreamFrame::Error { message } => {
            view.status.clear();
            eprintln!("\n{}", runtime_error("error", &message));
            view.status.printed_line();
        }
        // Progress. On a provider that buffers its tool-offering calls these
        // are the only sign a turn is alive, so they are shown rather than
        // discarded. The terminal outcome comes from the `turn` response, not
        // from this frame.
        StreamFrame::Event { event } => {
            let now = Instant::now();
            view.ledger.observe(&event, view.status.elapsed(now).as_secs());
            view.status.observe_event(&event, now);
            // Supersession abandons what was already shown. Clearing
            // `wrote_any` matters as much as the marker: leaving it set would
            // suppress the receipt fallback, so a buffered replacement would
            // never print and the abandoned attempt would remain as the
            // visible answer.
            if event.get("type").and_then(Value::as_str) == Some(activity::SUPERSEDING_RETRY) {
                view.status.clear();
                println!();
                view.status.printed_line();
                view.line(activity::SUPERSEDED_MARKER);
                *wrote_any = false;
                return;
            }
            // A handoff that failed part way is followed by the runtime's
            // notice, which is the reply: clearing `wrote_any` lets the
            // receipt fallback print it after what already streamed.
            if event.get("type").and_then(Value::as_str) == Some("toolStepLimitHandoff")
                && event.get("source").and_then(Value::as_str) == Some("notice")
            {
                if *wrote_any && !view.status.needs_newline() {
                    println!();
                }
                *wrote_any = false;
            }
            // On a terminal the status line names a running call, and the
            // completed line follows; a started line as well would double
            // every call in scrollback.
            let started = event.get("type").and_then(Value::as_str) == Some("toolCallStarted");
            if let Some(line) = activity::describe(&event)
                && !(started && view.status.enabled())
            {
                view.line(&line);
            }
            view.status.draw(now);
        }
        StreamFrame::Done { .. } => {}
        // A frame kind this client does not know. Ignored rather than fatal,
        // so the runtime can add kinds without breaking an older front-end.
        StreamFrame::Unknown => {}
    }
}
