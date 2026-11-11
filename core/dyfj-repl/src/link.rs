//! The REPL's connection to the runtime across a runtime restart.
//!
//! A runtime can go away under an open REPL: `dyfj stop` then `dyfj start`, a
//! crash, or a reload. The REPL stays attached: it says so once, retries with a
//! capped backoff until the runtime is back or the operator quits, and then
//! resumes the session it was in. The session lives in the runtime's store, not
//! in the connection, so the next turn names the same id and carries on.

use crate::approval::visible;
use crate::client::{Client, Incoming, Verdict};
use crate::dev_control::ExitWatch;
use crate::session::Session;
use crate::submission::{Submission, classify};
use crate::terminal::{Ask, ReadOutcome};
use crate::{commands, posture};
use serde_json::json;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

/// The longest wait between two connection attempts.
pub const MAX_BACKOFF: Duration = Duration::from_secs(2);

/// Delays between connection attempts: doubling from 100 ms, capped at
/// `MAX_BACKOFF`, without end. The operator, not a retry budget, decides when
/// to stop waiting.
pub fn backoff() -> impl Iterator<Item = Duration> {
    std::iter::successors(Some(Duration::from_millis(100)), |delay| {
        Some((*delay * 2).min(MAX_BACKOFF))
    })
}

/// How a wait for the runtime ended.
pub enum Waited {
    Reconnected(Client, mpsc::Receiver<Incoming>),
    Quit,
}

/// Wait for the runtime to come back, while still taking input.
///
/// A prompt read stays open the whole time, so Ctrl-C, Ctrl-D and `/quit`
/// quit at once rather than after the next attempt; a SIGINT between reads
/// does too. `/evidence` prints the last turn's local record; any other line
/// is refused, because there is nowhere to send it.
/// A prompt still open when the runtime returns is left in `pending`, and its
/// answer is the first submission to the restarted runtime.
///
/// Each failed attempt checks the runtime's log, when its path is known, and
/// shows a new error line from it: a runtime that crashes while starting says
/// why there, and the REPL keeps waiting for the next start.
///
/// Under `dyfj dev`, the supervisor asking the REPL to exit ends the wait as a
/// quit does.
#[allow(clippy::too_many_arguments)]
pub async fn wait_for_runtime(
    socket: &str,
    input: &mpsc::Sender<Ask>,
    pending: &mut Option<oneshot::Receiver<ReadOutcome>>,
    orphans: &mut mpsc::Receiver<ReadOutcome>,
    interrupts: &mut mpsc::Receiver<()>,
    exit: &mut ExitWatch,
    log: &mut Option<LogTail>,
    last_evidence: Option<&[String]>,
    delays: &mut dyn Iterator<Item = Duration>,
) -> Waited {
    let mut attempt = Box::pin(connect_after(socket, delays.next().unwrap_or(MAX_BACKOFF)));
    loop {
        if pending.is_none() {
            let (respond, answer) = oneshot::channel();
            if input.send(Ask::Prompt { respond }).await.is_err() {
                return Waited::Quit;
            }
            *pending = Some(answer);
        }
        let Some(read) = pending.as_mut() else { continue };
        // Biased toward the operator: a quit already given wins over a
        // connection that happens to succeed in the same instant.
        let event = tokio::select! {
            biased;
            Some(()) = interrupts.recv() => return Waited::Quit,
            () = exit.requested() => return Waited::Quit,
            Some(orphan) = orphans.recv() => {
                if orphan_quits(&orphan) {
                    return Waited::Quit;
                }
                note_orphan(&orphan);
                continue;
            }
            outcome = read => Event::Read(outcome),
            connected = &mut attempt => Event::Attempt(connected),
        };
        match event {
            Event::Read(outcome) => {
                *pending = None;
                match outcome {
                    Ok(ReadOutcome::Line(line)) => match classify(&line) {
                        Submission::Quit => return Waited::Quit,
                        Submission::Empty => {}
                        // The last turn's record is local; it needs no runtime.
                        _ if commands::parse(&line) == Some(commands::Command::Evidence) => {
                            commands::print_evidence(last_evidence)
                        }
                        _ => eprintln!(
                            "the runtime is disconnected; nothing was sent. \
                             Waiting for it (Ctrl-C or /quit to leave)."
                        ),
                    },
                    // Ctrl-C at the prompt only clears the line while the
                    // runtime is up. While it is down there is nothing to
                    // clear the line for, and the operator asked to leave.
                    Ok(ReadOutcome::Interrupted | ReadOutcome::Eof | ReadOutcome::Failed(_))
                    | Err(_) => return Waited::Quit,
                }
            }
            Event::Attempt(Ok((client, incoming))) => return Waited::Reconnected(client, incoming),
            Event::Attempt(Err(_)) => {
                if let Some(line) = log.as_mut().and_then(LogTail::new_error_line) {
                    eprintln!("\nruntime log: {line}");
                }
                attempt = Box::pin(connect_after(socket, delays.next().unwrap_or(MAX_BACKOFF)));
            }
        }
    }
}

enum Event {
    Read(Result<ReadOutcome, oneshot::error::RecvError>),
    Attempt(anyhow::Result<(Client, mpsc::Receiver<Incoming>)>),
}

async fn connect_after(socket: &str, delay: Duration) -> anyhow::Result<(Client, mpsc::Receiver<Incoming>)> {
    tokio::time::sleep(delay).await;
    Client::connect(socket).await
}

/// What ended a wait at the prompt while the runtime is up.
pub enum Prompted {
    Read(Result<ReadOutcome, oneshot::error::RecvError>),
    Disconnected,
    /// The `dyfj dev` supervisor asked the REPL to exit.
    Exit,
}

/// Wait for the operator's next line while the runtime is up, or for the
/// runtime to go away.
///
/// The runtime's messages are drained here too, not left queued. Nothing it
/// sends between turns belongs to a turn: stream frames are from one the
/// operator abandoned, and are discarded rather than shown under the next
/// prompt; an approval has no operator watching for it, and is denied, on the
/// connection that raised it. Left queued, they would fill the channel, the
/// reader would stall on it, and a stalled reader never sees the connection
/// end, so the disconnect would go unnoticed.
pub async fn await_prompt(
    client: &Client,
    incoming: &mut mpsc::Receiver<Incoming>,
    read: &mut oneshot::Receiver<ReadOutcome>,
    orphans: &mut mpsc::Receiver<ReadOutcome>,
    exit: &mut ExitWatch,
    session_id: Option<&str>,
) -> Prompted {
    loop {
        tokio::select! {
            biased;
            () = client.closed() => return Prompted::Disconnected,
            () = exit.requested() => return Prompted::Exit,
            Some(orphan) = orphans.recv() => note_orphan(&orphan),
            message = incoming.recv() => match message {
                Some(Incoming::Stream {
                    frame: crate::client::StreamFrame::Event { event },
                    turn_id: None,
                }) => {
                    if session_id.is_some_and(|id| {
                        event.get("sessionId").and_then(serde_json::Value::as_str) == Some(id)
                    }) && let Some(line) = crate::activity::child_approval_parked(&event)
                    {
                        eprintln!("\n{line}");
                    }
                }
                Some(Incoming::Stream { .. }) => {}
                Some(Incoming::Approval { respond, .. }) => {
                    let _ = respond.send(Verdict::deny("turn is no longer active"));
                }
                // The reader ends only when the connection does.
                None => return Prompted::Disconnected,
            },
            outcome = &mut *read => return Prompted::Read(outcome),
        }
    }
}

/// Whether an orphaned read is the operator asking to leave. Only consulted
/// while the runtime is down; with it up, the next prompt follows anyway.
pub fn orphan_quits(outcome: &ReadOutcome) -> bool {
    match outcome {
        ReadOutcome::Interrupted | ReadOutcome::Eof => true,
        ReadOutcome::Line(line) => classify(line) == Submission::Quit,
        ReadOutcome::Failed(_) => false,
    }
}

/// Say what happened to a line typed into a read nobody waits for any more:
/// the approval question it answered was cancelled by a disconnect.
pub fn note_orphan(outcome: &ReadOutcome) {
    if let ReadOutcome::Line(line) = outcome
        && !line.trim().is_empty()
    {
        eprintln!(
            "that answer was not sent: the approval it was typed for was cancelled \
             when the runtime disconnected"
        );
    }
}

/// Re-attach to a runtime that came back: confirm it can read the session
/// this REPL was in, then show the posture line from the new runtime.
///
/// The session is resumed the way `--session` resumes one: the runtime keeps
/// it in its store, and the next turn names its id. Nothing about the session
/// changes here, and nothing that was in flight is resent. `reason` is why the
/// runtime restarted, when `dyfj dev` said.
pub async fn resume(client: &Client, session: &Session, socket: &str, reason: Option<String>, dev: bool) {
    let status = client.request("runtime/status", json!({})).await;
    let resumed = match &session.id {
        Some(id) => match commands::recorded_model(client, id).await {
            Ok(_) => format!("; resumed session {}", visible(id)),
            Err(()) => format!(
                "; session {} could not be read back, and the next turn still names it",
                visible(id)
            ),
        },
        None => String::new(),
    };
    println!("\n{}", reloaded_notice(reason.as_deref(), &resumed));
    posture::show(&status, session, socket, dev);
}

/// `runtime reloaded`, with the restart's reason when there is one.
pub fn reloaded_notice(reason: Option<&str>, resumed: &str) -> String {
    match reason {
        Some(reason) => format!("runtime reloaded ({reason}){resumed}"),
        None => format!("runtime reloaded{resumed}"),
    }
}

/// The one notice for a change that reloaded the runtime and the REPL
/// together, printed by the REPL that took over. The old REPL was told it is
/// being replaced (`replaced`) and stays quiet on reconnecting.
pub fn both_reloaded_notice(reason: Option<&str>, session: Option<&str>) -> String {
    let resumed = session.map_or_else(String::new, |id| format!("; resumed session {}", visible(id)));
    match reason {
        Some(reason) => format!("runtime and REPL reloaded ({reason}){resumed}"),
        None => format!("runtime and REPL reloaded{resumed}"),
    }
}

/// The longest log line shown, in characters. The log is the runtime's output
/// and untrusted; one line is enough to say why a start failed.
const MAX_LOG_LINE: usize = 200;

/// The most of a log read at once. A runtime that writes a lot while down
/// costs no more than this per attempt; only the tail is searched.
const MAX_LOG_READ: u64 = 64 * 1024;

/// The runtime's log, read from where it stood when the connection dropped.
///
/// Every failure here is silent: a log that is missing, unreadable or replaced
/// is no reason to stop waiting for the runtime.
pub struct LogTail {
    path: String,
    offset: u64,
    inode: Option<u64>,
    shown: Option<String>,
}

impl LogTail {
    /// Start at the log's current end, so only what is written from now on
    /// counts. A log that does not exist yet is read from its start once it
    /// appears.
    pub fn from_end(path: &str) -> Self {
        let meta = std::fs::metadata(path).ok();
        Self {
            path: path.to_string(),
            offset: meta.as_ref().map_or(0, |m| m.len()),
            inode: meta.map(|m| m.ino()),
            shown: None,
        }
    }

    /// The runtime's failed-boot line, else the last line reporting an error,
    /// among the complete lines written since the previous call, sanitised and
    /// capped, unless it is the line shown last time.
    pub fn new_error_line(&mut self) -> Option<String> {
        let meta = std::fs::metadata(&self.path).ok()?;
        // A different file at the path, or one shorter than where we stopped,
        // has been replaced or truncated: all of it is new.
        if self.inode != Some(meta.ino()) || meta.len() < self.offset {
            self.inode = Some(meta.ino());
            self.offset = 0;
        }
        if meta.len() == self.offset {
            return None;
        }
        let start = self.offset.max(meta.len().saturating_sub(MAX_LOG_READ));
        let mut file = std::fs::File::open(&self.path).ok()?;
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut bytes = Vec::new();
        file.take(meta.len() - start).read_to_end(&mut bytes).ok()?;
        // Only complete lines: a line still being written is read whole on the
        // next call.
        let complete = bytes.iter().rposition(|&b| b == b'\n')? + 1;
        self.offset = start + complete as u64;
        let text = String::from_utf8_lossy(&bytes[..complete]);
        let line = boot_failure_line(&text)
            .or_else(|| text.lines().rev().find(|line| line.to_lowercase().contains("error")))
            .map(|line| cap(visible(line.trim()).trim()))?;
        if self.shown.as_ref() == Some(&line) {
            return None;
        }
        self.shown = Some(line.clone());
        Some(line)
    }
}

/// The runtime's own reason for a failed boot: its last `dyfj runtime:
/// failed to start:`, `dyfj runtime: config:` or `dyfj: could not start
/// local runtime:` line (the last from `dyfj start`), without the `dyfj
/// runtime: ` or `dyfj: ` prefix. None when there is none, or when that line
/// only names an error's class and size, whose stack trace says more.
fn boot_failure_line(text: &str) -> Option<&str> {
    let line = text.lines().rev().find(|line| {
        line.starts_with("dyfj runtime: failed to start: ")
            || line.starts_with("dyfj runtime: config:")
            || line.starts_with("dyfj: could not start local runtime: ")
    })?;
    let end = line.trim_end();
    if end.ends_with("its stack trace follows") || end.ends_with("bytes]") {
        return None;
    }
    line.strip_prefix("dyfj runtime: ").or_else(|| line.strip_prefix("dyfj: "))
}

fn cap(line: &str) -> String {
    if line.chars().count() <= MAX_LOG_LINE {
        return line.to_string();
    }
    // The ellipsis is one of the characters the cap allows.
    let mut capped: String = line.chars().take(MAX_LOG_LINE - 1).collect();
    capped.push('…');
    capped
}

#[cfg(test)]
#[path = "link_tests.rs"]
mod tests;
