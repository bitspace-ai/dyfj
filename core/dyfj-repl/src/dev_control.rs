//! The control channel `dyfj dev` gives the REPL it supervises.
//!
//! The supervisor starts the REPL with one end of a socket pair as an extra
//! file descriptor and names it in `DYFJ_DEV_CONTROL_FD`. Messages are JSON
//! objects, one per line, each with a `type`:
//!
//! - supervisor to REPL: `reloading` (with a `reason`, such as
//!   `3 files changed`), sent before it restarts the runtime, so the
//!   `runtime reloaded` notice can say why, and with `replaced: true` when it
//!   is going to replace this REPL too, which then leaves the notice to its
//!   replacement; and `exit`, which asks the REPL to
//!   leave as `/quit` does, before a rebuilt REPL takes its place;
//! - REPL to supervisor: `session` (with the `id` the REPL is in), so the
//!   rebuilt REPL resumes it; `reload`, for `/reload`; and `rollback`, for
//!   `/rollback`, which switches the runtime to the last good code.
//!
//! One thing travels outside the channel: when a change reloads the runtime
//! and the REPL together, the supervisor starts the new REPL with the reason in
//! `DYFJ_DEV_RELOADED`, and the new REPL tells the operator
//! (`reloaded_reason`); the old one was marked `replaced`, so it does not.
//!
//! Anything else is dropped without a word: a line that is not JSON, an
//! unknown type, a line longer than `MAX_LINE`. A channel that closes means
//! the supervisor is gone, and the REPL carries on as a plain REPL. Without the
//! variable there is no channel, and the REPL behaves as plain `dyfj`'s does.

use crate::approval::visible;
use serde_json::{Value, json};
use std::os::fd::{FromRawFd, RawFd};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, watch};

pub const CONTROL_FD_ENV: &str = "DYFJ_DEV_CONTROL_FD";

/// Set by the supervisor on a REPL that replaces one, after a change that
/// reloaded the runtime too; its value is the reason, such as `1 file changed`.
pub const RELOADED_ENV: &str = "DYFJ_DEV_RELOADED";

/// The longest control line read, in bytes; a longer one is dropped whole.
pub const MAX_LINE: usize = 4096;

/// The longest reload reason shown, in characters.
const MAX_REASON: usize = 120;

/// A runtime restart the supervisor announced.
#[derive(Debug, PartialEq, Eq)]
pub struct Reload {
    pub reason: String,
    /// This REPL is about to be replaced; its replacement announces the reload.
    pub replaced: bool,
}

/// A message from the supervisor.
#[derive(Debug, PartialEq, Eq)]
pub enum Control {
    Reloading(Reload),
    Exit,
}

/// A reason as shown: no terminal control, at most `MAX_REASON` characters.
fn clean_reason(raw: &str) -> String {
    visible(raw).chars().take(MAX_REASON).collect()
}

/// Why this REPL replaced one that reloaded with the runtime, from the
/// environment; `None` when the variable is unset or empty.
pub fn reloaded_reason(env: impl Fn(&str) -> Option<String>) -> Option<String> {
    env(RELOADED_ENV).filter(|raw| !raw.is_empty()).map(|raw| clean_reason(&raw))
}

/// One control line as the supervisor sent it, or `None` for anything that is
/// not a known message.
pub fn parse_line(line: &[u8]) -> Option<Control> {
    let value: Value = serde_json::from_slice(line).ok()?;
    let object = value.as_object()?;
    match object.get("type")?.as_str()? {
        "reloading" => Some(Control::Reloading(Reload {
            reason: clean_reason(object.get("reason")?.as_str()?),
            replaced: object.get("replaced").and_then(Value::as_bool).unwrap_or(false),
        })),
        "exit" => Some(Control::Exit),
        _ => None,
    }
}

/// The next line, without its newline. `None` at the end of the stream (or a
/// read error); `Some(None)` for a line over `MAX_LINE`, which is skipped.
async fn next_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Option<Option<Vec<u8>>> {
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let chunk = reader.fill_buf().await.ok()?;
        if chunk.is_empty() {
            return None;
        }
        match chunk.iter().position(|&b| b == b'\n') {
            Some(end) => {
                if !oversized && line.len() + end <= MAX_LINE {
                    line.extend_from_slice(&chunk[..end]);
                } else {
                    oversized = true;
                }
                reader.consume(end + 1);
                return Some((!oversized).then_some(line));
            }
            None => {
                let len = chunk.len();
                if !oversized && line.len() + len <= MAX_LINE {
                    line.extend_from_slice(chunk);
                } else {
                    oversized = true;
                    line.clear();
                }
                reader.consume(len);
            }
        }
    }
}

/// The REPL's end of the channel.
pub struct DevControl {
    outgoing: mpsc::Sender<String>,
    reload: Arc<Mutex<Option<Reload>>>,
    exit: watch::Receiver<bool>,
    last_session: Option<String>,
}

impl DevControl {
    /// Attach to the descriptor `DYFJ_DEV_CONTROL_FD` names. Unset means no
    /// channel. A value that is not a socket descriptor is ignored with one
    /// line, rather than reading from whatever the descriptor is.
    pub fn attach() -> Option<Self> {
        let raw = std::env::var(CONTROL_FD_ENV).ok()?;
        let fd = raw.parse::<RawFd>().ok().filter(|&fd| fd > 2 && is_socket(fd));
        let Some(fd) = fd else {
            eprintln!("dyfj-repl: {CONTROL_FD_ENV} does not name a socket descriptor; ignoring it");
            return None;
        };
        // SAFETY: the descriptor is an open socket (checked above) that the
        // supervisor gave this process for this purpose; nothing else owns it.
        let std_stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(fd) };
        if std_stream.set_nonblocking(true).is_err() {
            return None;
        }
        let stream = UnixStream::from_std(std_stream).ok()?;
        Some(Self::over(stream))
    }

    /// The channel over an already-connected stream.
    pub fn over(stream: UnixStream) -> Self {
        let (read_half, mut write_half) = stream.into_split();
        let reload = Arc::new(Mutex::new(None));
        let (exit_tx, exit) = watch::channel(false);
        let (outgoing, mut queue) = mpsc::channel::<String>(16);
        let stored = Arc::clone(&reload);
        tokio::spawn(async move {
            let mut reader = BufReader::new(read_half);
            while let Some(line) = next_line(&mut reader).await {
                match line.as_deref().and_then(parse_line) {
                    Some(Control::Reloading(announced)) => {
                        if let Ok(mut slot) = stored.lock() {
                            *slot = Some(announced);
                        }
                    }
                    Some(Control::Exit) => {
                        let _ = exit_tx.send(true);
                    }
                    None => {}
                }
            }
            // Closed: the supervisor is gone. Dropping `exit_tx` without
            // having sent `true` leaves exit requests pending for ever.
        });
        tokio::spawn(async move {
            while let Some(message) = queue.recv().await {
                if write_half.write_all(message.as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        Self { outgoing, reload, exit, last_session: None }
    }

    /// Ask the supervisor to reload now.
    pub fn request_reload(&self) {
        self.send(json!({"type": "reload"}));
    }

    /// Ask the supervisor to run the last good code now.
    pub fn request_rollback(&self) {
        self.send(json!({"type": "rollback"}));
    }

    /// Tell the supervisor which session the REPL is in, once per change.
    pub fn note_session(&mut self, id: Option<&str>) {
        let Some(id) = id else { return };
        if self.last_session.as_deref() == Some(id) {
            return;
        }
        self.last_session = Some(id.to_string());
        self.send(json!({"type": "session", "id": id}));
    }

    /// The latest restart the supervisor announced, once.
    pub fn take_reload(&self) -> Option<Reload> {
        self.reload.lock().ok().and_then(|mut slot| slot.take())
    }

    /// Resolves once the supervisor asks the REPL to exit; never otherwise,
    /// including after the channel closes.
    pub fn exit_watch(&self) -> ExitWatch {
        ExitWatch(Some(self.exit.clone()))
    }

    fn send(&self, message: Value) {
        // A full queue or a closed channel drops the message: the supervisor
        // is gone or not reading, and neither is the REPL's problem.
        let _ = self.outgoing.try_send(format!("{message}\n"));
    }
}

/// An exit request from the supervisor, or a future that never resolves when
/// there is no supervisor.
pub struct ExitWatch(Option<watch::Receiver<bool>>);

impl ExitWatch {
    pub fn none() -> Self {
        Self(None)
    }

    pub async fn requested(&mut self) {
        if let Some(rx) = self.0.as_mut()
            && rx.wait_for(|requested| *requested).await.is_ok()
        {
            return;
        }
        std::future::pending::<()>().await
    }
}

fn is_socket(fd: RawFd) -> bool {
    // SAFETY: fstat only writes the zeroed stat buffer it is given.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    unsafe { libc::fstat(fd, &mut stat) == 0 && (stat.st_mode & libc::S_IFMT) == libc::S_IFSOCK }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd;
    use std::time::Duration;
    use tokio::io::AsyncReadExt;

    #[test]
    fn parses_the_two_supervisor_messages() {
        assert_eq!(
            parse_line(br#"{"type":"reloading","reason":"3 files changed"}"#),
            Some(Control::Reloading(Reload { reason: "3 files changed".into(), replaced: false }))
        );
        assert_eq!(
            parse_line(br#"{"type":"reloading","reason":"1 file changed","replaced":true}"#),
            Some(Control::Reloading(Reload { reason: "1 file changed".into(), replaced: true })),
            "a REPL told it is being replaced leaves the notice to its replacement"
        );
        assert_eq!(
            parse_line(br#"{"type":"reloading","reason":"x","replaced":"yes"}"#),
            Some(Control::Reloading(Reload { reason: "x".into(), replaced: false })),
            "only a true boolean counts"
        );
        assert_eq!(parse_line(br#"{"type":"exit"}"#), Some(Control::Exit));
    }

    #[test]
    fn drops_malformed_and_unknown_messages() {
        for line in [
            &b"not json"[..],
            br#"["exit"]"#,
            br#"{"kind":"exit"}"#,
            br#"{"type":"shutdown"}"#,
            br#"{"type":7}"#,
            br#"{"type":"reloading"}"#,
            br#"{"type":"reloading","reason":3}"#,
            b"",
        ] {
            assert_eq!(parse_line(line), None, "{}", String::from_utf8_lossy(line));
        }
    }

    #[test]
    fn a_reason_is_sanitised_and_capped() {
        let long = format!(r#"{{"type":"reloading","reason":"a\u001b[2Jb{}"}}"#, "x".repeat(500));
        let Some(Control::Reloading(Reload { reason, .. })) = parse_line(long.as_bytes()) else {
            panic!("not parsed")
        };
        assert!(!reason.contains('\u{1b}'));
        assert_eq!(reason.chars().count(), MAX_REASON);
    }

    #[test]
    fn a_reload_reason_in_the_environment_is_read_sanitised_and_capped() {
        let env = |value: &'static str| {
            move |key: &str| (key == RELOADED_ENV).then(|| value.to_string())
        };
        assert_eq!(reloaded_reason(env("1 file changed")).as_deref(), Some("1 file changed"));
        assert_eq!(reloaded_reason(env("")), None, "an empty reason is no reason");
        assert_eq!(reloaded_reason(|_| None), None);
        let long = "x".repeat(500);
        let reason = reloaded_reason(|_| Some(format!("a\u{1b}[2Jb{long}"))).unwrap();
        assert!(!reason.contains('\u{1b}'));
        assert_eq!(reason.chars().count(), MAX_REASON);
    }

    #[test]
    fn only_a_socket_descriptor_is_accepted() {
        let file = std::fs::File::open("/dev/null").unwrap();
        assert!(!is_socket(file.as_raw_fd()));
        let (a, _b) = std::os::unix::net::UnixStream::pair().unwrap();
        assert!(is_socket(a.as_raw_fd()));
    }

    async fn pair() -> (DevControl, UnixStream) {
        let (ours, theirs) = UnixStream::pair().unwrap();
        (DevControl::over(ours), theirs)
    }

    async fn eventually(mut check: impl FnMut() -> bool) -> bool {
        for _ in 0..200 {
            if check() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        false
    }

    #[tokio::test]
    async fn noise_is_skipped_and_the_messages_after_it_still_arrive() {
        let (control, mut supervisor) = pair().await;
        let oversized = format!("{{\"type\":\"exit\",\"pad\":\"{}\"}}\n", "x".repeat(MAX_LINE));
        supervisor.write_all(b"garbage\n{\"type\":\"unknown\"}\n").await.unwrap();
        supervisor.write_all(oversized.as_bytes()).await.unwrap();
        supervisor
            .write_all(b"{\"type\":\"reloading\",\"reason\":\"2 files changed\"}\n")
            .await
            .unwrap();
        assert!(eventually(|| control.reload.lock().unwrap().is_some()).await);
        let reload = control.take_reload().unwrap();
        assert_eq!(reload.reason, "2 files changed");
        assert!(!reload.replaced);
        assert!(control.take_reload().is_none(), "a reason is shown once");
        // The oversized line was an exit; dropped, it must not have exited.
        let mut exit = control.exit_watch();
        let early = tokio::time::timeout(Duration::from_millis(50), exit.requested()).await;
        assert!(early.is_err());
        supervisor.write_all(b"{\"type\":\"exit\"}\n").await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), exit.requested()).await.unwrap();
    }

    #[tokio::test]
    async fn sends_session_once_per_change_and_reload_on_request() {
        let (mut control, mut supervisor) = pair().await;
        control.note_session(None);
        control.note_session(Some("01J0000000000000000000000A"));
        control.note_session(Some("01J0000000000000000000000A"));
        control.request_reload();
        let expected = "{\"id\":\"01J0000000000000000000000A\",\"type\":\"session\"}\n{\"type\":\"reload\"}\n";
        let mut got = vec![0; expected.len()];
        tokio::time::timeout(Duration::from_secs(2), supervisor.read_exact(&mut got))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(String::from_utf8(got).unwrap(), expected);
    }

    #[tokio::test]
    async fn sends_rollback_on_request() {
        // `parseReplMessage` in `prototype/scripts/dyfj-dev.ts` pins the same bytes.
        let (control, mut supervisor) = pair().await;
        control.request_rollback();
        let expected = "{\"type\":\"rollback\"}\n";
        let mut got = vec![0; expected.len()];
        tokio::time::timeout(Duration::from_secs(2), supervisor.read_exact(&mut got))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(String::from_utf8(got).unwrap(), expected);
    }

    #[tokio::test]
    async fn a_closed_channel_leaves_the_repl_usable() {
        let (control, supervisor) = pair().await;
        drop(supervisor);
        tokio::time::sleep(Duration::from_millis(20)).await;
        control.request_reload();
        let mut control = control;
        control.note_session(Some("01J0000000000000000000000A"));
        assert!(control.take_reload().is_none());
        let mut exit = control.exit_watch();
        let waited = tokio::time::timeout(Duration::from_millis(50), exit.requested()).await;
        assert!(waited.is_err(), "a closed channel is not an exit request");
    }

    #[tokio::test]
    async fn without_a_channel_exit_is_never_requested() {
        let mut exit = ExitWatch::none();
        let waited = tokio::time::timeout(Duration::from_millis(20), exit.requested()).await;
        assert!(waited.is_err());
    }
}
