//! Approvals parked for this session by a turn the runtime started itself.
//!
//! A turn with no client connection cannot ask anyone, so the runtime parks
//! each of its approval requests against the session and the turn waits. When
//! the operator attaches (`--session <id>`), and again before each message
//! sent on that session, this lists them (`approvals/pending`), asks each one
//! with the ordinary approval prompt, and sends the answer
//! (`approvals/answer`). The runtime parses that answer with
//! the same fail-closed rules as a live turn's.
//!
//! Ctrl-C leaves an approval parked: it is asked again before the next
//! message, or on the next attach.
//! Nothing typed at the ordinary prompt answers a parked approval; the runtime
//! refuses a turn on a session that has one waiting.

use crate::approval::{self, Asked, Outcome, visible};
use crate::client::Client;
use crate::terminal::Ask;
use serde_json::{Value, json};
use tokio::sync::mpsc;

/// What happened to the session's parked approvals.
#[derive(Debug, PartialEq)]
pub enum Attached {
    /// Every listed approval was handled, or there were none. One with an id
    /// was asked; an answer the runtime refused was reported. One without an
    /// id was reported and skipped.
    Done,
    /// The operator pressed Ctrl-C; the rest are still parked.
    LeftParked,
    /// The list could not be read, or the runtime went away.
    Unavailable,
}

pub async fn answer_parked(client: &Client, input: &mpsc::Sender<Ask>, session_id: &str) -> Attached {
    let listed = match client
        .request("approvals/pending", json!({"sessionId": session_id}))
        .await
    {
        Ok(listed) => listed,
        Err(err) => {
            eprintln!(
                "could not check this session for approvals waiting: {}",
                visible(&err.to_string())
            );
            return Attached::Unavailable;
        }
    };
    let approvals = listed
        .get("approvals")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if approvals.is_empty() {
        return Attached::Done;
    }
    let count = approvals.len();
    let plural = if count == 1 { "" } else { "s" };
    println!("\nthis session's turn is waiting for {count} approval{plural}");
    for parked in approvals {
        let Some(approval_id) = parked.get("approvalId").and_then(Value::as_str) else {
            // Nothing to answer it by; the runtime still holds it.
            eprintln!("an approval waiting here has no id; it was not asked");
            continue;
        };
        let request = parked.get("request").cloned().unwrap_or(Value::Null);
        let verdict = match approval::ask_while_connected(client, input, &request).await {
            Asked::Disconnected => return Attached::Unavailable,
            Asked::Answered(Outcome::Cancelled) => {
                eprintln!("left waiting; it is asked again before your next message, or when you attach");
                return Attached::LeftParked;
            }
            Asked::Answered(Outcome::Verdict(verdict)) => verdict,
        };
        let response = serde_json::to_value(&verdict).unwrap_or(Value::Null);
        match client
            .request(
                "approvals/answer",
                json!({"sessionId": session_id, "approvalId": approval_id, "response": response}),
            )
            .await
        {
            Ok(_) => println!("   answered; the session's turn continues in the runtime"),
            // Timed out, cancelled, or answered elsewhere while it was shown.
            Err(err) => eprintln!("   not answered: {}", visible(&err.to_string())),
        }
    }
    Attached::Done
}

/// Before a message is sent on a session: ask any approval parked since
/// attach, including the next one a parked turn raised after an answer. The
/// runtime refuses a turn while one waits. False when the operator left one
/// parked, so the message is not sent.
pub async fn clear_to_send(client: &Client, input: &mpsc::Sender<Ask>, session_id: Option<&str>) -> bool {
    let Some(id) = session_id else { return true };
    if answer_parked(client, input, id).await == Attached::LeftParked {
        eprintln!("nothing was sent");
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_runtime::{FakeRuntime, socket_path};
    use crate::terminal::ReadOutcome;
    use std::time::Duration;

    const SESSION: &str = "01J9ZQ4W8X6V5T3R2P1N0M9K8H";

    fn parked_tool(id: &str) -> Value {
        json!({
            "approvalId": id,
            "parkedAt": "2026-11-08T00:00:00.000Z",
            "request": {
                "commandId": "bash",
                "callId": "c1",
                "title": "Run Bash Command",
                "arguments": {"command": "touch x"}
            }
        })
    }

    /// A terminal that answers each approval question with the next line.
    fn terminal(lines: Vec<ReadOutcome>) -> (mpsc::Sender<Ask>, tokio::task::JoinHandle<Vec<String>>) {
        let (tx, mut rx) = mpsc::channel::<Ask>(4);
        let shown = tokio::spawn(async move {
            let mut shown = Vec::new();
            for line in lines {
                match rx.recv().await {
                    Some(Ask::Approval { preamble, respond, .. }) => {
                        shown.push(preamble);
                        let _ = respond.send(line);
                    }
                    Some(Ask::Prompt { .. }) => panic!("expected an approval question"),
                    None => break,
                }
            }
            shown
        });
        (tx, shown)
    }

    #[tokio::test]
    async fn a_parked_approval_is_asked_on_attach_and_its_answer_sent() {
        let path = socket_path();
        let runtime = FakeRuntime::bind(&path);
        let (client, _incoming) = Client::connect(&path).await.unwrap();
        let mut conn = runtime.accept().await;
        let (input, shown) = terminal(vec![ReadOutcome::Line("y".into())]);

        let attach = tokio::spawn(async move { answer_parked(&client, &input, SESSION).await });
        let pending = conn.expect_request("approvals/pending").await;
        assert_eq!(pending["params"], json!({"sessionId": SESSION}));
        conn.answer(&pending, json!({"approvals": [parked_tool("a1")]})).await;

        let answer = conn.expect_request("approvals/answer").await;
        assert_eq!(
            answer["params"],
            json!({"sessionId": SESSION, "approvalId": "a1", "response": {"decision": "approve"}})
        );
        conn.answer(&answer, json!({"answered": true})).await;
        assert_eq!(attach.await.unwrap(), Attached::Done);
        // The request's command was in the approval prompt.
        let shown = shown.await.unwrap();
        assert!(shown[0].contains("touch x"), "{shown:?}");
    }

    #[tokio::test]
    async fn anything_but_yes_is_sent_as_a_denial() {
        let path = socket_path();
        let runtime = FakeRuntime::bind(&path);
        let (client, _incoming) = Client::connect(&path).await.unwrap();
        let mut conn = runtime.accept().await;
        let (input, _shown) = terminal(vec![ReadOutcome::Line("sure".into())]);

        let attach = tokio::spawn(async move { answer_parked(&client, &input, SESSION).await });
        let pending = conn.expect_request("approvals/pending").await;
        conn.answer(&pending, json!({"approvals": [parked_tool("a1")]})).await;
        let answer = conn.expect_request("approvals/answer").await;
        assert_eq!(answer["params"]["response"]["decision"], "deny");
        conn.answer(&answer, json!({"answered": true})).await;
        assert_eq!(attach.await.unwrap(), Attached::Done);
    }

    #[tokio::test]
    async fn ctrl_c_leaves_the_approval_parked_and_sends_nothing() {
        let path = socket_path();
        let runtime = FakeRuntime::bind(&path);
        let (client, _incoming) = Client::connect(&path).await.unwrap();
        let mut conn = runtime.accept().await;
        let (input, _shown) = terminal(vec![ReadOutcome::Interrupted]);

        let attach = tokio::spawn(async move { answer_parked(&client, &input, SESSION).await });
        let pending = conn.expect_request("approvals/pending").await;
        conn.answer(&pending, json!({"approvals": [parked_tool("a1"), parked_tool("a2")]}))
            .await;
        assert_eq!(attach.await.unwrap(), Attached::LeftParked);
        assert!(conn.frame_within(Duration::from_millis(200)).await.is_none());
    }

    #[tokio::test]
    async fn no_parked_approvals_asks_nothing() {
        let path = socket_path();
        let runtime = FakeRuntime::bind(&path);
        let (client, _incoming) = Client::connect(&path).await.unwrap();
        let mut conn = runtime.accept().await;
        let (input, shown) = terminal(vec![]);

        let attach = tokio::spawn(async move { answer_parked(&client, &input, SESSION).await });
        let pending = conn.expect_request("approvals/pending").await;
        conn.answer(&pending, json!({"approvals": []})).await;
        assert_eq!(attach.await.unwrap(), Attached::Done);
        assert!(shown.await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_refused_answer_is_reported_and_the_rest_still_asked() {
        let path = socket_path();
        let runtime = FakeRuntime::bind(&path);
        let (client, _incoming) = Client::connect(&path).await.unwrap();
        let mut conn = runtime.accept().await;
        let (input, _shown) =
            terminal(vec![ReadOutcome::Line("y".into()), ReadOutcome::Line("n".into())]);

        let attach = tokio::spawn(async move { answer_parked(&client, &input, SESSION).await });
        let pending = conn.expect_request("approvals/pending").await;
        conn.answer(&pending, json!({"approvals": [parked_tool("a1"), parked_tool("a2")]}))
            .await;
        let first = conn.expect_request("approvals/answer").await;
        conn.send(json!({
            "jsonrpc": "2.0", "id": first["id"],
            "error": {"code": -32602, "message": "approval a1 is not pending for session"}
        }))
        .await;
        let second = conn.expect_request("approvals/answer").await;
        assert_eq!(second["params"]["approvalId"], "a2");
        conn.answer(&second, json!({"answered": true})).await;
        assert_eq!(attach.await.unwrap(), Attached::Done);
    }

    #[tokio::test]
    async fn an_approval_parked_after_attach_is_asked_before_the_next_message() {
        let path = socket_path();
        let runtime = FakeRuntime::bind(&path);
        let (client, _incoming) = Client::connect(&path).await.unwrap();
        let mut conn = runtime.accept().await;
        let (input, _shown) = terminal(vec![ReadOutcome::Line("y".into())]);

        let check = tokio::spawn(async move { clear_to_send(&client, &input, Some(SESSION)).await });
        let pending = conn.expect_request("approvals/pending").await;
        conn.answer(&pending, json!({"approvals": [parked_tool("a2")]})).await;
        let answer = conn.expect_request("approvals/answer").await;
        assert_eq!(answer["params"]["approvalId"], "a2");
        conn.answer(&answer, json!({"answered": true})).await;
        assert!(check.await.unwrap(), "answered, so the message is sent");
    }

    #[tokio::test]
    async fn a_message_is_not_sent_while_an_approval_is_left_parked() {
        let path = socket_path();
        let runtime = FakeRuntime::bind(&path);
        let (client, _incoming) = Client::connect(&path).await.unwrap();
        let mut conn = runtime.accept().await;
        let (input, _shown) = terminal(vec![ReadOutcome::Interrupted]);

        let check = tokio::spawn(async move { clear_to_send(&client, &input, Some(SESSION)).await });
        let pending = conn.expect_request("approvals/pending").await;
        conn.answer(&pending, json!({"approvals": [parked_tool("a1")]})).await;
        assert!(!check.await.unwrap());
        assert!(conn.frame_within(Duration::from_millis(200)).await.is_none());
    }

    #[tokio::test]
    async fn a_new_session_has_nothing_parked_to_check() {
        let path = socket_path();
        let runtime = FakeRuntime::bind(&path);
        let (client, _incoming) = Client::connect(&path).await.unwrap();
        let mut conn = runtime.accept().await;
        let (input, _shown) = terminal(vec![]);
        assert!(clear_to_send(&client, &input, None).await);
        assert!(conn.frame_within(Duration::from_millis(200)).await.is_none());
    }

    #[tokio::test]
    async fn a_runtime_without_the_method_is_reported_not_fatal() {
        let path = socket_path();
        let runtime = FakeRuntime::bind(&path);
        let (client, _incoming) = Client::connect(&path).await.unwrap();
        let mut conn = runtime.accept().await;
        let (input, _shown) = terminal(vec![]);

        let attach = tokio::spawn(async move { answer_parked(&client, &input, SESSION).await });
        let pending = conn.expect_request("approvals/pending").await;
        conn.send(json!({
            "jsonrpc": "2.0", "id": pending["id"],
            "error": {"code": -32601, "message": "method not found: approvals/pending"}
        }))
        .await;
        assert_eq!(attach.await.unwrap(), Attached::Unavailable);
    }
}
