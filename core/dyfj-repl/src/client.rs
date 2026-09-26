//! Newline-delimited JSON-RPC over a Unix socket.
//!
//! The Workbench runtime is a peer, not a server: it answers our `turn` and
//! `turn/cancel` requests, and it *sends* us `approval` requests mid-turn and
//! `stream` notifications throughout. So this is a bidirectional peer with a
//! reader task fanning messages out, not a request/response client.

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::OwnedWriteHalf;
use tokio::sync::{Mutex, mpsc, oneshot};

/// A frame the server streams during a turn. `t` discriminates the union;
/// unknown variants are tolerated rather than fatal, because the server may
/// add frame kinds without this client needing a rebuild.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "t")]
pub enum StreamFrame {
    #[serde(rename = "delta")]
    Delta { text: String },
    // Event frames carry turn progress and ARE rendered, through
    // `activity::describe`. The `Done` payload is parsed but ignored: the
    // terminal outcome is taken from the `turn` response, which carries the
    // receipt this client reads.
    #[serde(rename = "event")]
    Event { event: Value },
    #[serde(rename = "done")]
    Done {
        #[allow(dead_code)]
        result: Value,
    },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(other)]
    Unknown,
}

/// Our answer to a server-initiated `approval` request.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum Verdict {
    Decision {
        decision: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Select {
        decision: &'static str,
        #[serde(rename = "optionId")]
        option_id: String,
    },
}

impl Verdict {
    pub fn approve() -> Self {
        Verdict::Decision { decision: "approve", reason: None }
    }
    pub fn deny(reason: impl Into<String>) -> Self {
        Verdict::Decision { decision: "deny", reason: Some(reason.into()) }
    }
    pub fn select(option_id: impl Into<String>) -> Self {
        Verdict::Select { decision: "select", option_id: option_id.into() }
    }
}

/// What the reader task hands to the main loop.
pub enum Incoming {
    Stream(StreamFrame),
    /// A server request we must answer. Dropping the responder without a
    /// verdict schedules an attempt to send a denial — delivery still depends
    /// on the socket, which the writer cannot guarantee. Answering
    /// deliberately is preferable anyway: a denial the operator never saw is a
    /// refused tool call they must repeat.
    Approval { params: Value, respond: oneshot::Sender<Verdict> },
}

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

pub struct Client {
    write: Arc<Mutex<OwnedWriteHalf>>,
    pending: Pending,
    next_id: Arc<Mutex<i64>>,
}

impl Client {
    /// Connect and start the reader task. Incoming stream frames and approval
    /// requests arrive on the returned channel.
    pub async fn connect(socket: &str) -> Result<(Self, mpsc::Receiver<Incoming>)> {
        let stream = UnixStream::connect(socket)
            .await
            .with_context(|| format!("connect {socket}"))?;
        let (read, write) = stream.into_split();
        let write = Arc::new(Mutex::new(write));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::channel(256);

        let reader_pending = Arc::clone(&pending);
        let reader_write = Arc::clone(&write);
        tokio::spawn(async move {
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                // Known limit: lines are read without a size bound, so a peer
                // that sends a very large frame — or bytes without a newline —
                // grows this buffer unchecked. The TypeScript peer made the
                // same choice for the same reason, a trusted local socket, and
                // left a bound for when a remote transport arrives.
                dispatch(msg, &reader_pending, &reader_write, &tx).await;
            }
            // EOF: fail every waiter rather than leaving the loop hung.
            //
            // Known limit: no closed state is recorded. A request issued after
            // this point still writes to the retained write half and then
            // waits for a reader that no longer exists. A failed turn ends
            // that invocation of `run_turn`, and the loop then offers another
            // prompt against the same client — so this is reachable, and a
            // longer-lived client needs an explicit closed flag.
            let mut map = reader_pending.lock().await;
            for (_, sender) in map.drain() {
                let _ = sender.send(Err("runtime closed the connection".into()));
            }
        });

        Ok((Self { write, pending, next_id: Arc::new(Mutex::new(1)) }, rx))
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = {
            let mut next = self.next_id.lock().await;
            let id = *next;
            *next += 1;
            id
        };
        let (tx, rx) = oneshot::channel();
        // Known limit: if this future is dropped before it resolves — which
        // happens when the operator abandons a turn with a second Ctrl-C —
        // the entry stays in the map until the connection closes. One stale
        // sender per abandoned turn against a runtime that never answers.
        self.pending.lock().await.insert(id, tx);
        let frame = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        self.send(&frame).await?;
        match rx.await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => Err(anyhow!(message)),
            Err(_) => Err(anyhow!("request {method} was dropped before it answered")),
        }
    }

    /// Send a request without registering a waiter for its response.
    ///
    /// Used for `turn/cancel`, which is issued from inside the select! that
    /// also renders frames and answers approvals: awaiting it there would
    /// block all of them until the runtime replied. The response arrives with
    /// an id no one is waiting on and is discarded by the dispatcher.
    ///
    /// `Ok` means the frame was queued, not that it arrived. Setup failures
    /// reach the caller; a socket write that fails afterwards is reported on
    /// stderr from the sending task.
    pub fn send_without_waiting(&self, method: &str, params: Value) -> Result<()> {
        let id = {
            let mut next = self
                .next_id
                .try_lock()
                .map_err(|_| anyhow!("client is busy"))?;
            let id = *next;
            *next += 1;
            id
        };
        let frame = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        let mut line = serde_json::to_vec(&frame)?;
        line.push(b'\n');
        let method_for_error = method.to_string();
        let write = Arc::clone(&self.write);
        tokio::spawn(async move {
            let mut write = write.lock().await;
            // Report a delivery failure. Returning Ok from this function means
            // the request was queued, not that it arrived; silence here would
            // leave the operator reading "cancelling…" for a cancel that was
            // never sent.
            if let Err(err) = write.write_all(&line).await {
                eprintln!("{method_for_error} could not be sent: {err}");
                return;
            }
            if let Err(err) = write.flush().await {
                eprintln!("{method_for_error} could not be flushed: {err}");
            }
        });
        Ok(())
    }

    /// Known limit: dropping the caller's future while this is suspended
    /// inside `write_all` can leave a partial frame on the connection, and the
    /// next write would be appended to it. Reachable today only by abandoning
    /// a turn with a second Ctrl-C while the socket is applying backpressure.
    async fn send(&self, frame: &Value) -> Result<()> {
        let mut line = serde_json::to_vec(frame)?;
        line.push(b'\n');
        let mut write = self.write.lock().await;
        write.write_all(&line).await?;
        write.flush().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Drive the real dispatcher, not JSON accessors beside it.
    ///
    /// The earlier version of this test read `msg["id"]` and asserted things
    /// about the value. That passes whether or not `dispatch` handles a string
    /// id, so it could not have caught the defect it was written for: the
    /// runtime ids its own requests `p1`, `p2`, reading them as integers
    /// dropped every approval, and the turn hung with no diagnostic.
    #[tokio::test]
    async fn dispatch_routes_an_approval_whose_id_is_a_string() {
        let (client_side, _server_side) = tokio::net::UnixStream::pair().unwrap();
        let (_read, write) = client_side.into_split();
        let write = Arc::new(Mutex::new(write));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, mut rx) = mpsc::channel(4);

        let msg = json!({
            "jsonrpc": "2.0", "id": "p1", "method": "approval",
            "params": {"commandId": "bash", "title": "Run Bash Command"}
        });
        dispatch(msg, &pending, &write, &tx).await;

        match rx.try_recv() {
            Ok(Incoming::Approval { params, respond }) => {
                assert_eq!(params.get("commandId").and_then(Value::as_str), Some("bash"));
                let _ = respond.send(Verdict::deny("test"));
            }
            other => panic!("a string-id approval must reach the main loop, got {:?}",
                            other.is_ok()),
        }
    }

    /// A numeric id belongs to one of our own requests, not the server's.
    #[tokio::test]
    async fn dispatch_resolves_our_own_numeric_response() {
        let (client_side, _server_side) = tokio::net::UnixStream::pair().unwrap();
        let (_read, write) = client_side.into_split();
        let write = Arc::new(Mutex::new(write));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, _rx) = mpsc::channel(4);

        let (sender, receiver) = oneshot::channel();
        pending.lock().await.insert(7, sender);

        dispatch(json!({"jsonrpc":"2.0","id":7,"result":{"ok":true}}), &pending, &write, &tx).await;

        let resolved = receiver.await.expect("the waiter must be resolved");
        assert_eq!(resolved.unwrap().get("ok").and_then(Value::as_bool), Some(true));
    }

    /// A notification carries no id and must not be taken for either.
    #[tokio::test]
    async fn dispatch_forwards_a_stream_notification() {
        let (client_side, _server_side) = tokio::net::UnixStream::pair().unwrap();
        let (_read, write) = client_side.into_split();
        let write = Arc::new(Mutex::new(write));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, mut rx) = mpsc::channel(4);

        let msg = json!({"jsonrpc":"2.0","method":"stream","params":{"t":"delta","text":"hi"}});
        dispatch(msg, &pending, &write, &tx).await;

        match rx.try_recv() {
            Ok(Incoming::Stream(StreamFrame::Delta { text })) => assert_eq!(text, "hi"),
            _ => panic!("a stream notification must reach the main loop"),
        }
    }
}

/// Answer a server-initiated request. Write failures are reported rather than
/// swallowed: an unanswered approval leaves the runtime blocked with no
/// diagnostic at either end, which is the hardest failure of this protocol to
/// diagnose from the outside.
async fn answer_approval(write: &Arc<Mutex<OwnedWriteHalf>>, id: Value, verdict: Verdict) {
    let frame = json!({"jsonrpc":"2.0","id":id,"result":verdict});
    let Ok(mut line) = serde_json::to_vec(&frame) else {
        eprintln!("approval answer could not be encoded; the runtime is still waiting");
        return;
    };
    line.push(b'\n');
    let mut w = write.lock().await;
    if let Err(err) = w.write_all(&line).await {
        eprintln!("approval answer could not be sent: {err}");
        return;
    }
    if let Err(err) = w.flush().await {
        eprintln!("approval answer could not be flushed: {err}");
    }
}

async fn dispatch(
    msg: Value,
    pending: &Pending,
    write: &Arc<Mutex<OwnedWriteHalf>>,
    tx: &mpsc::Sender<Incoming>,
) {
    let method = msg.get("method").and_then(Value::as_str);
    // JSON-RPC ids may be strings or numbers. Ours are numbers, but the
    // runtime numbers its own requests `p1`, `p2`, … — reading the id as an
    // integer silently dropped every approval request, leaving the runtime
    // waiting on an answer that never came and the turn hung mid-tool.
    let id = msg.get("id").filter(|value| !value.is_null());

    match (method, id) {
        // A response to something we asked. Our own ids are numbers, so a
        // non-numeric id here is not ours.
        (None, Some(id)) => {
            let Some(id) = id.as_i64() else { return };
            if let Some(sender) = pending.lock().await.remove(&id) {
                let outcome = match msg.get("error") {
                    Some(err) => Err(err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("request failed")
                        .to_string()),
                    None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = sender.send(outcome);
            }
        }
        // A notification from the server.
        (Some("stream"), None) => {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            if let Ok(frame) = serde_json::from_value::<StreamFrame>(params) {
                let _ = tx.send(Incoming::Stream(frame)).await;
            }
        }
        // A request from the server that we must answer. The id is echoed
        // back verbatim, whatever its JSON type.
        (Some("approval"), Some(id)) => {
            let id = id.clone();
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let (respond, answer) = oneshot::channel();
            let write = Arc::clone(write);
            // Waiting for the operator's answer HERE would stall the only
            // reader of the socket: a runtime that disconnected mid-approval
            // would go unnoticed, and outstanding requests would never fail.
            // Wait for it on its own task so the reader keeps reading.
            if tx.send(Incoming::Approval { params, respond }).await.is_err() {
                // No one is listening for approvals. The runtime is still
                // blocked on an answer, so send a denial rather than nothing.
                answer_approval(&write, id, Verdict::deny("client has no approver")).await;
                return;
            }
            tokio::spawn(async move {
                // Fail closed: a dropped responder is not consent.
                let verdict = answer
                    .await
                    .unwrap_or_else(|_| Verdict::deny("client did not answer"));
                answer_approval(&write, id, verdict).await;
            });
        }
        _ => {}
    }
}
