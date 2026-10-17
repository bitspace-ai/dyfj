//! A stand-in for the Workbench runtime, for tests that need a real socket.
//!
//! It binds a Unix socket, accepts connections one at a time, and lets the
//! test read the client's frames and write its own. Dropping a connection (or
//! the whole runtime) is how a test simulates the runtime going away.

use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{UnixListener, UnixStream};

/// How long a test waits for something before calling it a failure.
pub const PATIENCE: Duration = Duration::from_secs(5);

/// A socket path short enough for macOS's 104-byte `sun_path`; the system
/// temp directory there is long enough to overflow it.
pub fn socket_path() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("/tmp/dyfj-test-{}.sock", &id[..12])
}

pub struct FakeRuntime {
    listener: UnixListener,
    path: String,
}

impl FakeRuntime {
    pub fn bind(path: &str) -> Self {
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path).expect("bind the fake runtime's socket");
        Self { listener, path: path.to_string() }
    }

    pub async fn accept(&self) -> Conn {
        let (stream, _) = tokio::time::timeout(PATIENCE, self.listener.accept())
            .await
            .expect("the client must connect")
            .expect("accept");
        Conn::new(stream)
    }
}

impl Drop for FakeRuntime {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

pub struct Conn {
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
}

impl Conn {
    fn new(stream: UnixStream) -> Self {
        let (read, writer) = stream.into_split();
        Self { reader: BufReader::new(read), writer }
    }

    /// The next frame the client sent, or `None` once it hangs up.
    pub async fn next_frame(&mut self) -> Option<Value> {
        let mut line = String::new();
        let read = tokio::time::timeout(PATIENCE, self.reader.read_line(&mut line))
            .await
            .expect("the client must send a frame or hang up")
            .expect("read a frame");
        if read == 0 {
            return None;
        }
        Some(serde_json::from_str(line.trim()).expect("the client sends JSON"))
    }

    /// The next frame the client sends within `window`, if any. For asserting
    /// that something is NOT sent: the client's reader task keeps the socket
    /// open after the `Client` is dropped, so waiting for a hang-up would wait
    /// forever.
    pub async fn frame_within(&mut self, window: Duration) -> Option<Value> {
        let mut line = String::new();
        match tokio::time::timeout(window, self.reader.read_line(&mut line)).await {
            Ok(Ok(read)) if read > 0 => Some(serde_json::from_str(line.trim()).expect("JSON")),
            _ => None,
        }
    }

    /// Read the next frame and require it to be a request for `method`.
    pub async fn expect_request(&mut self, method: &str) -> Value {
        let frame = self.next_frame().await.expect("the client hung up");
        assert_eq!(
            frame.get("method").and_then(Value::as_str),
            Some(method),
            "expected a {method} request, got {frame}"
        );
        frame
    }

    pub async fn send(&mut self, frame: Value) {
        let mut line = serde_json::to_vec(&frame).unwrap();
        line.push(b'\n');
        self.writer.write_all(&line).await.expect("write a frame");
        self.writer.flush().await.expect("flush a frame");
    }

    pub async fn answer(&mut self, request: &Value, result: Value) {
        self.send(json!({"jsonrpc":"2.0","id":request["id"],"result":result})).await;
    }

    /// Answer the requests a client makes when it attaches: the status the
    /// posture line is built from, then, for a resumed session, the inspect
    /// that confirms the runtime can read it.
    pub async fn answer_attach(&mut self, session: Option<&str>) {
        let status = self.expect_request("runtime/status").await;
        self.answer(&status, json!({"runtime": {"defaultTurnModel": {"slug": "fake/model"}}}))
            .await;
        if let Some(id) = session {
            let inspect = self.expect_request("sessions/inspect").await;
            assert_eq!(inspect["params"]["sessionId"], id, "{inspect}");
            self.answer(&inspect, json!({"model": null})).await;
        }
    }
}
