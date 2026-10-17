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
use crate::terminal::{Ask, ReadOutcome};
use crate::submission::{Submission, classify};
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
/// does too. Any other line is refused, because there is nowhere to send it.
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
) -> Prompted {
    loop {
        tokio::select! {
            biased;
            () = client.closed() => return Prompted::Disconnected,
            () = exit.requested() => return Prompted::Exit,
            Some(orphan) = orphans.recv() => note_orphan(&orphan),
            message = incoming.recv() => match message {
                Some(Incoming::Stream(_)) => {}
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

    /// The last line reporting an error among the complete lines written since
    /// the previous call, sanitised and capped, unless it is the line shown
    /// last time.
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
        let line = text
            .lines()
            .rev()
            .find(|line| line.to_lowercase().contains("error"))
            .map(|line| cap(visible(line.trim()).trim()))?;
        if self.shown.as_ref() == Some(&line) {
            return None;
        }
        self.shown = Some(line.clone());
        Some(line)
    }
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
mod tests {
    use super::*;
    use crate::dev_control::DevControl;
    use crate::fake_runtime::{FakeRuntime, PATIENCE, socket_path};
    use crate::{TurnEnd, run_turn};
    use serde_json::json;
    use std::io::Write as _;
    use tokio::time::timeout;

    /// The REPL loop's side of what a test stands in for: its channel to the
    /// terminal thread, the open prompt read, orphaned reads, and SIGINT.
    struct Repl {
        input: mpsc::Sender<Ask>,
        pending: Option<oneshot::Receiver<ReadOutcome>>,
        orphans: mpsc::Receiver<ReadOutcome>,
        interrupts: mpsc::Receiver<()>,
        exit: ExitWatch,
    }

    /// The test's side: it receives the asks and answers them, as the
    /// terminal thread would, and raises orphans and SIGINT.
    struct Terminal {
        asks: mpsc::Receiver<Ask>,
        orphans_tx: mpsc::Sender<ReadOutcome>,
        interrupts_tx: mpsc::Sender<()>,
    }

    fn harness() -> (Repl, Terminal) {
        let (input, asks) = mpsc::channel(8);
        let (orphans_tx, orphans) = mpsc::channel(8);
        let (interrupts_tx, interrupts) = mpsc::channel(1);
        (
            Repl { input, pending: None, orphans, interrupts, exit: ExitWatch::none() },
            Terminal { asks, orphans_tx, interrupts_tx },
        )
    }

    impl Repl {
        async fn wait(&mut self, socket: &str) -> Waited {
            let mut delays = fast_backoff();
            wait_for_runtime(
                socket,
                &self.input,
                &mut self.pending,
                &mut self.orphans,
                &mut self.interrupts,
                &mut self.exit,
                &mut None,
                &mut delays,
            )
            .await
        }
    }

    impl Terminal {
        /// The next prompt read the loop asked for.
        async fn next_prompt(&mut self) -> oneshot::Sender<ReadOutcome> {
            match timeout(PATIENCE, self.asks.recv()).await.expect("a prompt must be asked") {
                Some(Ask::Prompt { respond }) => respond,
                Some(Ask::Approval { .. }) => panic!("expected a prompt, got an approval"),
                None => panic!("the input channel closed"),
            }
        }
    }

    /// Short delays keep the tests quick; `backoff` itself is tested apart.
    fn fast_backoff() -> impl Iterator<Item = Duration> {
        std::iter::repeat(Duration::from_millis(20))
    }

    fn resumed_session(id: &str) -> Session {
        Session { id: Some(id.into()), ..Session::default() }
    }

    const SESSION: &str = "01J0000000000000000000000A";

    #[test]
    fn backoff_doubles_to_a_two_second_cap_and_never_ends() {
        let delays: Vec<Duration> = backoff().take(100).collect();
        assert_eq!(delays.len(), 100, "the backoff must not run out");
        assert_eq!(delays[0], Duration::from_millis(100));
        assert_eq!(delays[1], Duration::from_millis(200));
        assert!(delays.iter().all(|d| *d <= MAX_BACKOFF), "{delays:?}");
        assert_eq!(delays[99], MAX_BACKOFF);
    }

    /// The client notices the runtime going away on its own, without a request
    /// in flight, and a request made afterwards fails at once rather than
    /// waiting on a reader that no longer exists.
    #[tokio::test]
    async fn a_dropped_connection_closes_the_client() {
        let path = socket_path();
        let runtime = FakeRuntime::bind(&path);
        let (client, _incoming) = Client::connect(&path).await.unwrap();
        drop(runtime.accept().await);

        timeout(PATIENCE, client.closed()).await.expect("the client must notice the drop");
        assert!(client.is_closed());
        let late = timeout(Duration::from_secs(1), client.request("runtime/status", json!({})))
            .await
            .expect("a request on a closed client must fail at once, not wait");
        assert!(late.is_err());
    }

    /// Drop, reconnect, resume: the runtime comes back on the same socket, the
    /// REPL re-attaches with the session it was in, and the next turn names
    /// that session.
    #[tokio::test]
    async fn the_repl_reconnects_and_resumes_the_same_session() {
        let path = socket_path();
        let first = FakeRuntime::bind(&path);
        let (client, _incoming) = Client::connect(&path).await.unwrap();
        drop(first.accept().await);
        drop(first);
        timeout(PATIENCE, client.closed()).await.unwrap();

        let (mut repl, _terminal) = harness();
        let restarted = {
            let path = path.clone();
            tokio::spawn(async move {
                // The runtime is down for a few attempts before it returns.
                tokio::time::sleep(Duration::from_millis(150)).await;
                FakeRuntime::bind(&path)
            })
        };
        let waited = timeout(PATIENCE, repl.wait(&path)).await.expect("must reconnect");
        let Waited::Reconnected(client, mut incoming) = waited else {
            panic!("the wait must end in a reconnection, not a quit");
        };
        let second = restarted.await.unwrap();
        let mut conn = second.accept().await;

        let mut session = resumed_session(SESSION);
        let attach = async { conn.answer_attach(Some(SESSION)).await };
        tokio::join!(resume(&client, &session, &path, None, false), attach);

        let turn = async {
            let frame = conn.expect_request("turn").await;
            assert_eq!(frame["params"]["sessionId"], SESSION, "{frame}");
            conn.answer(&frame, json!({"sessionId": SESSION, "text": "back"})).await;
        };
        let (end, ()) = tokio::join!(
            run_turn(&client, &repl.input, &mut incoming, &mut repl.interrupts, "hi", &mut session),
            turn
        );
        assert!(matches!(end, TurnEnd::Settled), "the resumed turn must settle");
        assert_eq!(session.id.as_deref(), Some(SESSION));
    }

    /// A turn in flight when the runtime goes away is reported as interrupted,
    /// not retried, and the next prompt works against the restarted runtime.
    #[tokio::test]
    async fn a_turn_interrupted_mid_stream_ends_and_the_next_one_works() {
        let path = socket_path();
        let first = FakeRuntime::bind(&path);
        let (client, mut incoming) = Client::connect(&path).await.unwrap();
        let (mut repl, _terminal) = harness();
        let mut session = resumed_session(SESSION);

        let mut conn = first.accept().await;
        let runtime_dies = async move {
            conn.expect_request("turn").await;
            conn.send(json!({"jsonrpc":"2.0","method":"stream","params":{"t":"delta","text":"part"}}))
                .await;
            drop(conn);
        };
        let (end, ()) = tokio::join!(
            timeout(
                PATIENCE,
                run_turn(&client, &repl.input, &mut incoming, &mut repl.interrupts, "hi", &mut session),
            ),
            runtime_dies
        );
        let end = end.expect("an interrupted turn must end, not hang");
        assert!(matches!(end, TurnEnd::Disconnected), "the turn must report the disconnect");
        assert_eq!(session.turns, 0, "an interrupted turn is not recorded as completed");
        drop(first);

        let second = FakeRuntime::bind(&path);
        let Waited::Reconnected(client, mut incoming) = repl.wait(&path).await else {
            panic!("must reconnect");
        };
        let mut conn = second.accept().await;
        let next = async {
            conn.answer_attach(Some(SESSION)).await;
            let frame = conn.expect_request("turn").await;
            assert_eq!(frame["params"]["prompt"], "again", "the old turn is not resent: {frame}");
            conn.answer(&frame, json!({"sessionId": SESSION, "text": "ok"})).await;
        };
        let run = async {
            resume(&client, &session, &path, None, false).await;
            run_turn(&client, &repl.input, &mut incoming, &mut repl.interrupts, "again", &mut session)
                .await
        };
        let (end, ()) = tokio::join!(run, next);
        assert!(matches!(end, TurnEnd::Settled));
    }

    /// An approval prompt open when the runtime goes away is cancelled. Its
    /// answer, typed afterwards, reaches neither the old runtime nor the new
    /// one: nothing the new runtime receives is a response to anything.
    #[tokio::test]
    async fn an_open_approval_is_cancelled_and_never_answered() {
        let path = socket_path();
        let first = FakeRuntime::bind(&path);
        let (client, mut incoming) = Client::connect(&path).await.unwrap();
        let (mut repl, mut terminal) = harness();
        let mut session = resumed_session(SESSION);

        let mut conn = first.accept().await;
        let runtime_asks_then_dies = async move {
            conn.expect_request("turn").await;
            conn.send(json!({
                "jsonrpc":"2.0","id":"p1","method":"approval",
                "params":{"commandId":"bash","title":"Run Bash Command","arguments":{"command":"ls"}}
            }))
            .await;
            conn
        };
        let input = repl.input.clone();
        let mut turn =
            Box::pin(run_turn(&client, &input, &mut incoming, &mut repl.interrupts, "hi", &mut session));

        // The approval question reaches the terminal and stays open.
        let conn = tokio::select! {
            _ = &mut turn => panic!("the turn ended before the approval was asked"),
            conn = runtime_asks_then_dies => conn,
        };
        let open_read = tokio::select! {
            _ = &mut turn => panic!("the turn ended before the approval was asked"),
            ask = terminal.asks.recv() => match ask {
                Some(Ask::Approval { respond, .. }) => respond,
                _ => panic!("expected the approval question"),
            },
        };
        drop(conn);
        drop(first);

        let end = timeout(PATIENCE, &mut turn)
            .await
            .expect("the disconnect must cancel the open approval, not wait for an answer");
        assert!(matches!(end, TurnEnd::Disconnected));
        drop(turn);

        let second = FakeRuntime::bind(&path);
        let Waited::Reconnected(client, mut incoming) = repl.wait(&path).await else {
            panic!("must reconnect");
        };
        let mut conn = second.accept().await;
        tokio::join!(resume(&client, &session, &path, None, false), conn.answer_attach(Some(SESSION)));

        // The operator answers the cancelled question only now.
        let _ = open_read.send(ReadOutcome::Line("y".into()));

        let next = async {
            let frame = conn.expect_request("turn").await;
            conn.answer(&frame, json!({"sessionId": SESSION, "text": "ok"})).await;
        };
        let run = async {
            run_turn(&client, &repl.input, &mut incoming, &mut repl.interrupts, "next", &mut session)
                .await
        };
        let (end, ()) = tokio::join!(run, next);
        assert!(matches!(end, TurnEnd::Settled));

        // Anything else the new runtime receives from this client.
        while let Some(frame) = conn.frame_within(Duration::from_millis(300)).await {
            assert!(
                frame.get("method").is_some(),
                "the new runtime must receive no answer to anything, got {frame}"
            );
        }
    }

    /// Frames that arrive while the REPL sits at the prompt (a turn abandoned
    /// with a second Ctrl-C keeps streaming) must not fill the channel and
    /// stall the reader: a stalled reader never sees the connection end, and
    /// the REPL would never notice the runtime going away.
    #[tokio::test]
    async fn an_idle_prompt_notices_a_drop_behind_a_flood_of_frames() {
        let path = socket_path();
        let runtime = FakeRuntime::bind(&path);
        let (client, mut incoming) = Client::connect(&path).await.unwrap();
        let (mut repl, _terminal) = harness();
        let (_respond, mut read) = oneshot::channel();

        let mut conn = runtime.accept().await;
        for _ in 0..300 {
            conn.send(json!({"jsonrpc":"2.0","method":"stream","params":{"t":"delta","text":"late"}}))
                .await;
        }
        drop(conn);

        let prompted = timeout(PATIENCE, await_prompt(&client, &mut incoming, &mut read, &mut repl.orphans, &mut repl.exit))
            .await
            .expect("the drop must be noticed behind the flood");
        assert!(matches!(prompted, Prompted::Disconnected));
    }

    /// An approval request that arrives while the REPL sits at the prompt has
    /// no turn and no operator watching for it. It is denied, on the
    /// connection that raised it: never left unanswered, never approved.
    #[tokio::test]
    async fn a_stray_approval_at_the_idle_prompt_is_denied() {
        let path = socket_path();
        let runtime = FakeRuntime::bind(&path);
        let (client, mut incoming) = Client::connect(&path).await.unwrap();
        let (mut repl, _terminal) = harness();
        let (_respond, mut read) = oneshot::channel();
        let mut conn = runtime.accept().await;

        let runtime_side = async {
            conn.send(json!({
                "jsonrpc":"2.0","id":"p9","method":"approval",
                "params":{"commandId":"bash","title":"Run Bash Command"}
            }))
            .await;
            let answer = conn.next_frame().await.expect("the stray approval must be answered");
            assert_eq!(answer["id"], "p9", "{answer}");
            assert_eq!(answer["result"]["decision"], "deny", "never approved: {answer}");
            drop(conn);
        };
        let (prompted, ()) = tokio::join!(
            timeout(PATIENCE, await_prompt(&client, &mut incoming, &mut read, &mut repl.orphans, &mut repl.exit)),
            runtime_side
        );
        assert!(matches!(prompted.expect("the drop must end the wait"), Prompted::Disconnected));
    }

    /// Once the session is known, a `sessionStart` naming another one (a
    /// stray frame, say) does not move this REPL to it.
    #[tokio::test]
    async fn a_session_start_does_not_replace_a_known_session() {
        let path = socket_path();
        let runtime = FakeRuntime::bind(&path);
        let (client, mut incoming) = Client::connect(&path).await.unwrap();
        let (mut repl, _terminal) = harness();
        let mut session = resumed_session(SESSION);

        let mut conn = runtime.accept().await;
        let runtime_dies = async move {
            conn.expect_request("turn").await;
            conn.send(json!({"jsonrpc":"2.0","method":"stream","params":{
                "t":"event","event":{"type":"sessionStart","sessionId":"01J0000000000000000000000B"}
            }}))
            .await;
            drop(conn);
        };
        let (end, ()) = tokio::join!(
            run_turn(&client, &repl.input, &mut incoming, &mut repl.interrupts, "hi", &mut session),
            runtime_dies
        );
        assert!(matches!(end, TurnEnd::Disconnected));
        assert_eq!(session.id.as_deref(), Some(SESSION));
    }

    /// A first turn interrupted before it settles has no receipt to take the
    /// session id from, but the runtime announced the session when it opened
    /// it. That id is kept, so the next turn resumes the session the runtime
    /// created rather than opening a second one.
    #[tokio::test]
    async fn an_interrupted_first_turn_keeps_the_session_it_opened() {
        let path = socket_path();
        let first = FakeRuntime::bind(&path);
        let (client, mut incoming) = Client::connect(&path).await.unwrap();
        let (mut repl, _terminal) = harness();
        let mut session = Session::default();

        let mut conn = first.accept().await;
        let runtime_dies = async move {
            let frame = conn.expect_request("turn").await;
            assert!(frame["params"].get("sessionId").is_none(), "a first turn names no session");
            conn.send(json!({"jsonrpc":"2.0","method":"stream","params":{
                "t":"event","event":{"type":"sessionStart","sessionId":SESSION,"traceId":"t","mode":"turn"}
            }}))
            .await;
            drop(conn);
        };
        let (end, ()) = tokio::join!(
            run_turn(&client, &repl.input, &mut incoming, &mut repl.interrupts, "hi", &mut session),
            runtime_dies
        );
        assert!(matches!(end, TurnEnd::Disconnected));
        assert_eq!(session.id.as_deref(), Some(SESSION), "the announced session is kept");
        drop(first);

        let second = FakeRuntime::bind(&path);
        let Waited::Reconnected(client, mut incoming) = repl.wait(&path).await else {
            panic!("must reconnect");
        };
        let mut conn = second.accept().await;
        let next = async {
            conn.answer_attach(Some(SESSION)).await;
            let frame = conn.expect_request("turn").await;
            assert_eq!(frame["params"]["sessionId"], SESSION, "{frame}");
            conn.answer(&frame, json!({"sessionId": SESSION, "text": "ok"})).await;
        };
        let run = async {
            resume(&client, &session, &path, None, false).await;
            run_turn(&client, &repl.input, &mut incoming, &mut repl.interrupts, "again", &mut session).await
        };
        let (end, ()) = tokio::join!(run, next);
        assert!(matches!(end, TurnEnd::Settled));
    }

    /// While the runtime is down, Ctrl-C, Ctrl-D and `/quit` at the prompt
    /// quit at once, as does a SIGINT between reads.
    #[tokio::test]
    async fn quitting_while_waiting_is_immediate() {
        let path = socket_path();
        for outcome in [
            ReadOutcome::Interrupted,
            ReadOutcome::Eof,
            ReadOutcome::Line("/quit".into()),
            ReadOutcome::Line("/exit".into()),
        ] {
            let (mut repl, mut terminal) = harness();
            let label = format!("{outcome:?}");
            let waiting = repl.wait(&path);
            tokio::pin!(waiting);
            let respond = tokio::select! {
                _ = &mut waiting => panic!("the wait ended before the prompt was asked"),
                ask = terminal.asks.recv() => match ask {
                    Some(Ask::Prompt { respond }) => respond,
                    _ => panic!("expected a prompt"),
                },
            };
            respond.send(outcome).unwrap();
            let waited = timeout(Duration::from_secs(1), waiting)
                .await
                .unwrap_or_else(|_| panic!("{label} must quit at once"));
            assert!(matches!(waited, Waited::Quit), "{label}");
        }

        let (mut repl, terminal) = harness();
        terminal.interrupts_tx.try_send(()).unwrap();
        let waited = timeout(Duration::from_secs(1), repl.wait(&path)).await.expect("SIGINT quits");
        assert!(matches!(waited, Waited::Quit));

        // Ctrl-C at a cancelled approval's read, which is still on screen.
        let (mut repl, terminal) = harness();
        terminal.orphans_tx.try_send(ReadOutcome::Interrupted).unwrap();
        let waited = timeout(Duration::from_secs(1), repl.wait(&path)).await.expect("orphan Ctrl-C quits");
        assert!(matches!(waited, Waited::Quit));
    }

    /// A line typed while the runtime is down is not sent anywhere, and the
    /// prompt comes back for the next one.
    #[tokio::test]
    async fn a_line_typed_while_waiting_is_refused_and_the_prompt_returns() {
        let path = socket_path();
        let (mut repl, mut terminal) = harness();
        let waiting = repl.wait(&path);
        tokio::pin!(waiting);
        for line in ["hello", "/help"] {
            let respond = tokio::select! {
                _ = &mut waiting => panic!("a typed line must not end the wait"),
                ask = terminal.asks.recv() => match ask {
                    Some(Ask::Prompt { respond }) => respond,
                    _ => panic!("expected a prompt"),
                },
            };
            respond.send(ReadOutcome::Line(line.into())).unwrap();
        }
        let respond = tokio::select! {
            _ = &mut waiting => panic!("a typed line must not end the wait"),
            ask = terminal.asks.recv() => match ask {
                Some(Ask::Prompt { respond }) => respond,
                _ => panic!("expected a prompt"),
            },
        };
        respond.send(ReadOutcome::Eof).unwrap();
        assert!(matches!(timeout(PATIENCE, waiting).await.unwrap(), Waited::Quit));
    }

    /// A prompt read still open when the runtime returns carries over: the
    /// operator's next line is the next submission, not lost.
    #[tokio::test]
    async fn an_open_prompt_survives_the_reconnection() {
        let path = socket_path();
        let runtime = FakeRuntime::bind(&path);
        let (mut repl, mut terminal) = harness();
        let Waited::Reconnected(_client, _incoming) =
            timeout(PATIENCE, repl.wait(&path)).await.expect("must reconnect")
        else {
            panic!("must reconnect");
        };
        let _conn = runtime.accept().await;
        let respond = terminal.next_prompt().await;
        let pending = repl.pending.take().expect("the open prompt is handed back");
        respond.send(ReadOutcome::Line("carried".into())).unwrap();
        assert!(matches!(pending.await, Ok(ReadOutcome::Line(line)) if line == "carried"));
    }

    fn temp_log() -> (String, std::fs::File) {
        let path = std::env::temp_dir()
            .join(format!("dyfj-log-{}.log", uuid::Uuid::new_v4().simple()))
            .to_string_lossy()
            .into_owned();
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path).unwrap();
        (path, file)
    }

    /// Only what the runtime wrote after the disconnect counts, and of that
    /// only the last line that reports an error, once.
    #[test]
    fn the_log_tail_shows_the_last_new_error_line_once() {
        let (path, mut file) = temp_log();
        writeln!(file, "Error: an old crash, before the disconnect").unwrap();
        let mut tail = LogTail::from_end(&path);
        assert_eq!(tail.new_error_line(), None, "nothing new yet");

        writeln!(file, "starting runtime").unwrap();
        writeln!(file, "Error: Dolt is not reachable").unwrap();
        writeln!(file, "    at connect (store.ts:12)").unwrap();
        writeln!(file, "Node.js v24.0.0").unwrap();
        assert_eq!(tail.new_error_line().as_deref(), Some("Error: Dolt is not reachable"));
        assert_eq!(tail.new_error_line(), None, "the same line is not shown twice");

        writeln!(file, "Error: Dolt is not reachable").unwrap();
        assert_eq!(tail.new_error_line(), None, "a repeat of the shown line stays quiet");
        writeln!(file, "error: port in use").unwrap();
        assert_eq!(tail.new_error_line().as_deref(), Some("error: port in use"));
        let _ = std::fs::remove_file(&path);
    }

    /// The log is the runtime's output and untrusted: control bytes are
    /// stripped and the line is capped.
    #[test]
    fn the_log_tail_line_is_sanitised_and_capped() {
        let (path, mut file) = temp_log();
        let mut tail = LogTail::from_end(&path);
        writeln!(file, "Error: \u{1b}[2Jwiped {}", "x".repeat(500)).unwrap();
        let line = tail.new_error_line().expect("an error line");
        assert!(!line.contains('\u{1b}'), "{line:?}");
        assert!(line.contains("wiped"), "{line:?}");
        assert!(line.chars().count() <= 200, "{} chars", line.chars().count());
        let _ = std::fs::remove_file(&path);
    }

    /// A missing, unreadable or replaced log never fails the wait.
    #[test]
    fn a_missing_or_replaced_log_is_quiet() {
        let mut missing = LogTail::from_end("/tmp/dyfj-no-such-log.log");
        assert_eq!(missing.new_error_line(), None);

        let (path, mut file) = temp_log();
        writeln!(file, "{}", "padding ".repeat(50)).unwrap();
        let mut tail = LogTail::from_end(&path);
        // Replaced by a shorter file: read the new file from its start.
        std::fs::write(&path, "Error: fresh boot failed\n").unwrap();
        assert_eq!(tail.new_error_line().as_deref(), Some("Error: fresh boot failed"));
        std::fs::remove_file(&path).unwrap();
        assert_eq!(tail.new_error_line(), None);
    }

    /// The notice after a restart says why, when the supervisor said.
    #[test]
    fn the_reloaded_notice_names_the_reason_when_there_is_one() {
        assert_eq!(
            reloaded_notice(Some("3 files changed"), "; resumed session X"),
            "runtime reloaded (3 files changed); resumed session X"
        );
        assert_eq!(reloaded_notice(None, ""), "runtime reloaded");
    }

    /// `dyfj dev` asks the REPL to leave before a rebuilt one takes over; at
    /// the idle prompt that ends the wait as a quit would.
    #[tokio::test]
    async fn a_supervisor_exit_request_ends_the_idle_prompt() {
        let path = socket_path();
        let runtime = FakeRuntime::bind(&path);
        let (client, mut incoming) = Client::connect(&path).await.unwrap();
        let _conn = runtime.accept().await;
        let (mut repl, _terminal) = harness();
        let (ours, mut supervisor) = tokio::net::UnixStream::pair().unwrap();
        let control = DevControl::over(ours);
        repl.exit = control.exit_watch();
        let (_respond, mut read) = oneshot::channel();
        tokio::io::AsyncWriteExt::write_all(&mut supervisor, b"{\"type\":\"exit\"}\n").await.unwrap();
        let prompted = timeout(
            PATIENCE,
            await_prompt(&client, &mut incoming, &mut read, &mut repl.orphans, &mut repl.exit),
        )
        .await
        .expect("the exit request must end the wait");
        assert!(matches!(prompted, Prompted::Exit));
    }

    /// The same request while the runtime is down ends the wait for it.
    #[tokio::test]
    async fn a_supervisor_exit_request_ends_a_wait_for_the_runtime() {
        let path = socket_path();
        let (mut repl, _terminal) = harness();
        let (ours, mut supervisor) = tokio::net::UnixStream::pair().unwrap();
        let control = DevControl::over(ours);
        repl.exit = control.exit_watch();
        tokio::io::AsyncWriteExt::write_all(&mut supervisor, b"{\"type\":\"exit\"}\n").await.unwrap();
        let waited = timeout(PATIENCE, repl.wait(&path)).await.expect("must end");
        assert!(matches!(waited, Waited::Quit));
    }
}
