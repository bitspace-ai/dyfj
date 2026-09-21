//! DYFJ interactive REPL front-end.
//!
//! Owns the terminal and speaks the Workbench UDS protocol. The runtime holds
//! the agent loop; this binary is a client of it, which is why replacing the
//! TypeScript REPL does not touch the engine.

mod activity;
mod approval;
mod client;
mod posture;
mod terminal;

use anyhow::{Context, Result};
use client::{Client, Incoming, StreamFrame, Verdict};
use serde_json::{Value, json};
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
    // Count characters, not bytes: the ceiling the runtime applies is a
    // character count, and a byte count would reject valid multi-byte input.
    let characters = input.chars().count();
    if characters > MAX_INPUT_CHARACTERS {
        return Submission::TooLong { characters };
    }
    Submission::Prompt
}

fn socket_path() -> Result<String> {
    if let Ok(explicit) = std::env::var("DYFJ_SOCKET") {
        return Ok(explicit);
    }
    let home = std::env::var("HOME").context("HOME is unset and DYFJ_SOCKET was not given")?;
    Ok(format!("{home}/.dyfj/run/workbench.sock"))
}

#[tokio::main]
async fn main() -> Result<()> {
    let socket = socket_path()?;
    // Before the terminal is taken, not after: a panic during startup would
    // otherwise leave it in whatever state it had reached.
    terminal::install_panic_restore();
    let input = terminal::spawn()?;
    let (client, mut incoming) = Client::connect(&socket)
        .await
        .with_context(|| format!("no runtime at {socket}; start it with `dyfj start`"))?;

    println!("dyfj — Ctrl-C cancels a turn, Ctrl-D quits");
    // Ask the runtime what it is before the first turn. Without this the
    // operator cannot tell which model they are talking to, or whether a
    // runtime answered at all.
    match client.request("runtime/status", json!({})).await {
        Ok(status) => println!("{}", posture::line(&status, &socket)),
        Err(err) => println!("{}", runtime_line("posture: unavailable", &err.to_string(), &socket)),
    }

    let mut session: Option<String> = None;

    // Ctrl-C reaches us two different ways, and the split is structural rather
    // than a choice. At the prompt rustyline holds the terminal in raw mode
    // with ISIG cleared, so Ctrl-C is a byte it reports as Interrupted. While a
    // turn streams no readline is active, rustyline has restored cooked mode,
    // and Ctrl-C is a real SIGINT. Each mechanism is live exactly when the
    // other is not, so they never compete for the same keypress.
    let mut interrupts = signal(SignalKind::interrupt())
        .context("install SIGINT handler")?;

    loop {
        let (respond, answer) = oneshot::channel();
        if input.send(Ask::Prompt { respond }).await.is_err() {
            break;
        }
        let line = match answer.await {
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

        run_turn(
            &client,
            &input,
            &mut incoming,
            &mut interrupts,
            &line,
            &mut session,
        )
        .await;
    }

    Ok(())
}

/// Issue one turn and render it, answering approvals and honouring Ctrl-C.
///
/// Completion is the `turn` response, not a stream frame: a `done` frame is
/// ignored and an `error` frame is printed, but neither ends the wait.
async fn run_turn(
    client: &Client,
    input: &mpsc::Sender<Ask>,
    incoming: &mut mpsc::Receiver<Incoming>,
    interrupts: &mut tokio::signal::unix::Signal,
    prompt: &str,
    session: &mut Option<String>,
) {
    let turn_id = new_turn_id();
    let mut body = json!({"prompt": prompt, "mode": "turn", "turnId": turn_id});
    if let Some(id) = session.as_ref() {
        body["sessionId"] = Value::String(id.clone());
    }

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
                        if let Some(id) = result.get("sessionId").and_then(Value::as_str) {
                            *session = Some(id.to_string());
                        }
                        // Deltas are not guaranteed. A provider whose
                        // tool-offering calls are buffered streams no text at
                        // all — verified against a live runtime on Anthropic,
                        // where a turn produced seven event frames, zero
                        // deltas, and the answer only in the receipt. Render
                        // the receipt text when nothing was streamed, or the
                        // answer is invisible.
                        if !wrote_any {
                            if let Some(text) = result.get("text").and_then(Value::as_str) {
                                if !text.is_empty() {
                                    println!("{}", approval::visible(text));
                                    wrote_any = true;
                                }
                            }
                        }
                    }
                    Err(err) => eprintln!("\n{}", runtime_error("turn failed", &err.to_string())),
                }
                if wrote_any {
                    println!();
                }
                return;
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
                        // The cost is that a runtime disconnecting mid-
                        // approval is not surfaced until the operator answers
                        // — the prompt stays up either way, so spawning bought
                        // no earlier warning, only the lifetime problems.
                        let verdict = approval::ask(input, &params).await;
                        let _ = respond.send(verdict);
                    }
                    None => return,
                }
            }
            // Ctrl-C during a turn. Cancellation is cooperative: ask the
            // runtime to stop and keep rendering until it settles, because the
            // turn is what owns any tool still running. A second Ctrl-C
            // abandons the wait — the operator has asked twice, and a turn
            // that ignores a cancel should not hold the prompt.
            _ = interrupts.recv() => {
                if cancelling {
                    eprintln!("\ngiving up on the turn; it may still be running");
                    if wrote_any {
                        println!();
                    }
                    discard_abandoned_frames(incoming);
                    return;
                }
                cancelling = true;
                eprintln!("\ncancelling…");
                // Do not await the cancel here. This branch is inside the
                // select! that also renders frames, answers approvals and
                // catches the next interrupt; awaiting would block all three
                // until the runtime answers, and a runtime that never answers
                // would make the promised second Ctrl-C unreachable.
                if let Err(err) =
                    client.send_without_waiting("turn/cancel", json!({"turnId": turn_id}))
                {
                    eprintln!("{}", runtime_error("cancel could not be sent", &err.to_string()));
                }
            }
        }
    }
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

/// The runtime validates `turnId` against a UUID shape and rejects anything
/// else, so this is a protocol requirement rather than a formatting choice. It
/// also routes `turn/cancel` by this id: a repeated id would let a cancel land
/// on the wrong turn.
fn new_turn_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::{MAX_INPUT_CHARACTERS, Submission, classify, new_turn_id};

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
            // guarding the door after the wall.
            print!("{}", approval::visible(&text));
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
