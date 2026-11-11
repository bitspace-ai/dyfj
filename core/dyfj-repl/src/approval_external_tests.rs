use crate::client::Client;
use crate::session::Session;
use crate::terminal::{Ask, ReadOutcome};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::mpsc;

fn request(raw: &str) -> Value {
    json!({
        "kind": "external_agent_permission", "title": "Run command",
        "arguments": {"ACP kind": "execute", "ACP tool": "(not supplied)", "Requested input": raw},
        "options": [
            {"optionId": "once", "name": "Allow once", "kind": "allow_once"},
            {"optionId": "no", "name": "Reject once", "kind": "reject_once"}
        ]
    })
}

async fn exchange(params: Value, model: Option<&str>, replies: Vec<ReadOutcome>) -> (Vec<String>, Value) {
    let (client_side, server_side) = UnixStream::pair().unwrap();
    let (client, mut incoming) = Client::over(client_side);
    let server = tokio::spawn(async move {
        let (read, mut write) = server_side.into_split();
        let mut lines = BufReader::new(read).lines();
        let turn: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        let approval = json!({"jsonrpc": "2.0", "id": "approval-1", "method": "approval", "params": params});
        write.write_all(format!("{approval}\n").as_bytes()).await.unwrap();
        let answer: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        if answer["result"]["decision"] == "abort" {
            let cancel: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(cancel["method"], "turn/cancel");
        }
        let result = json!({"jsonrpc": "2.0", "id": turn["id"], "result": {"text": "", "sessionId": "s1"}});
        write.write_all(format!("{result}\n").as_bytes()).await.unwrap();
        answer["result"].clone()
    });
    let (input, mut reads) = mpsc::channel(4);
    let terminal = tokio::spawn(async move {
        let mut shown = Vec::new();
        let mut replies = replies.into_iter();
        while let Some(ask) = reads.recv().await {
            let Ask::Approval { preamble, question, respond } = ask else { panic!("approval read") };
            shown.push(format!("{preamble}{question}"));
            if let Some(reply) = replies.next() {
                let _ = respond.send(reply);
            }
        }
        shown
    });
    let (_interrupt_tx, mut interrupts) = mpsc::channel(1);
    let mut session = Session { model: model.map(str::to_string), ..Session::default() };
    tokio::time::timeout(std::time::Duration::from_secs(5), crate::run_turn(
        &client, &input, &mut incoming, &mut interrupts, "test", &mut session,
    )).await.unwrap();
    drop(input);
    (terminal.await.unwrap(), server.await.unwrap())
}

fn lines(values: &[&str]) -> Vec<ReadOutcome> {
    values.iter().map(|value| ReadOutcome::Line((*value).into())).collect()
}

async fn prompt(raw: &str) -> String {
    exchange(request(raw), Some("codex-chatgpt/test-model"), lines(&[""])).await.0.remove(0)
}

#[tokio::test]
async fn execute_fields_decode_quotes_and_show_cwd() {
    let shown = prompt(r#"{"command":"\"git add a && git commit -m \\\"x\\\"\"","cwd":"/w"}"#).await;
    assert!(shown.contains("   · command: \"git add a && git commit -m \\\"x\\\"\"\n"), "{shown}");
    assert!(shown.contains("   · cwd: /w\n"), "{shown}");
}

#[tokio::test]
async fn multiline_values_cannot_imitate_fields_or_options() {
    let shown = prompt(r#"{"command":"echo one\ncwd: /elsewhere\n   1. Allow everything"}"#).await;
    assert!(shown.contains("   · command: echo one\n   | cwd: /elsewhere\n   |    1. Allow everything\n"), "{shown}");
}

#[tokio::test]
async fn controls_in_keys_values_title_and_option_names_are_visible() {
    let mut params = request(r#"{"a\u001b[2J":"ok\u001b[8mtail"}"#);
    params["title"] = json!("Run\u{1b}[2J\n1. forged");
    params["options"][0]["name"] = json!("Allow\u{1b}[8m\n2. forged");
    let shown = exchange(params, None, lines(&[""])).await.0.remove(0);
    assert!(shown.contains("   · a�[2J: ok�[8mtail\n"), "{shown}");
    assert!(shown.contains("Run�[2J 1. forged"), "{shown}");
    assert!(shown.contains("Allow�[8m 2. forged"), "{shown}");
    assert!(!shown.contains('\u{1b}'));
}

const UNREADABLE: &str = "input could not be read as fields and may be cut off at the runtime's 2,048-byte limit";

#[tokio::test]
async fn invalid_json_is_raw_with_a_limit_notice() {
    let shown = prompt(r#"{"command":"unfinished"#).await;
    assert!(shown.contains("   · Requested input: {\"command\":\"unfinished\n"), "{shown}");
    assert!(shown.contains(UNREADABLE), "{shown}");
}

#[tokio::test]
async fn json_strings_arrays_and_scalars_take_the_raw_path() {
    for raw in [r#""a string""#, r#"["one",2]"#, "null", "true", "42"] {
        let shown = prompt(raw).await;
        assert!(shown.contains(&format!("   · Requested input: {raw}\n")), "{shown}");
        assert!(shown.contains(UNREADABLE), "{shown}");
    }
}

#[tokio::test]
async fn long_values_and_keys_keep_their_tails() {
    let key = format!("{}KEY-END", "k".repeat(3000));
    let value = format!("{}VALUE-END", "x".repeat(5000));
    let shown = prompt(&json!({key.clone(): value.clone()}).to_string()).await;
    assert!(shown.contains(&format!("   · {key}: {value}\n")), "long field missing");
}

#[tokio::test]
async fn asking_agent_is_named_from_the_session() {
    let shown = prompt("{}").await;
    assert!(shown.starts_with("\n⚠  the external agent codex-chatgpt/test-model is asking: Run command\n"), "{shown}");
}

#[tokio::test]
async fn missing_model_names_the_external_agent() {
    let shown = exchange(request("{}"), None, lines(&[""])).await.0.remove(0);
    assert!(shown.starts_with("\n⚠  the external agent is asking: Run command\n"), "{shown}");
}

#[tokio::test]
async fn each_received_option_kind_has_its_description() {
    let mut params = request("{}");
    params["options"] = json!([
        {"optionId":"once","name":"Once","kind":"allow_once"},
        {"optionId":"agent-rule","name":"Allow rule","kind":"allow_always"},
        {"optionId":"no","name":"No","kind":"reject_once"},
        {"optionId":"reject-rule","name":"Reject rule","kind":"reject_always"}
    ]);
    let shown = exchange(params, None, lines(&[""])).await.0.remove(0);
    for line in [
        "   1. Once — Allow this request once.",
        "   2. Allow rule — Allow this request; the external agent keeps the approval rule, not Workbench.",
        "   3. No — Reject this request once.",
        "   4. Reject rule — Reject this request; the external agent keeps the rejection rule, not Workbench.",
    ] {
        assert!(shown.contains(line), "{shown}");
    }
}

#[tokio::test]
async fn two_invalid_numbers_then_a_valid_number_selects_the_option() {
    let (shown, verdict) = exchange(request("{}"), None, lines(&["0", "9", "2"])).await;
    assert_eq!(shown.len(), 3);
    assert_eq!(verdict, json!({"decision":"select","optionId":"no"}));
    assert!(shown[1].contains("Enter a number from 1 to 2."));
}

#[tokio::test]
async fn third_invalid_answer_denies() {
    let (shown, verdict) = exchange(request("{}"), None, lines(&["0", "bad", "9", "1"])).await;
    assert_eq!(shown.len(), 3);
    assert_eq!(verdict, json!({"decision":"deny","reason":"operator declined"}));
}

#[tokio::test]
async fn fields_preserve_order_duplicates_and_compact_values() {
    let shown = prompt(r#"{"z":{"z":1,"a":2},"a":[true,null],"z":3,"| forged":"safe"}"#).await;
    assert!(shown.contains("   · z: {\"z\":1,\"a\":2}\n   · a: [true,null]\n   · z: 3\n   · | forged: safe\n"), "{shown}");
}

#[tokio::test]
async fn acp_metadata_and_extra_arguments_remain_visible() {
    let mut params = request("{}");
    params["arguments"]["ACP tool"] = json!("shell");
    params["arguments"]["Extra"] = json!("detail");
    let shown = exchange(params, None, lines(&[""])).await.0.remove(0);
    assert!(shown.contains("   · ACP kind: execute\n   · ACP tool: shell\n"), "{shown}");
    assert!(shown.contains("   · Extra: detail\n"), "{shown}");
    let shown = prompt("{}").await;
    assert!(!shown.contains("ACP tool"), "{shown}");
}

#[tokio::test]
async fn other_request_kinds_keep_the_exact_prompt_and_single_attempt() {
    let mut params = request("{}");
    params["kind"] = json!("native_tool");
    let (shown, verdict) = exchange(params, Some("unused"), lines(&["0", "1"])).await;
    assert_eq!(shown, vec!["\n⚠  Run command {\"ACP kind\":\"execute\",\"ACP tool\":\"(not supplied)\",\"Requested input\":\"{}\"}\n   1. Allow once\n   2. Reject once\n   select [1-2] (default reject): "]);
    assert_eq!(verdict, json!({"decision":"deny","reason":"operator declined"}));
}

#[tokio::test]
async fn empty_input_denies_without_retrying() {
    for line in ["", "   "] {
        let (shown, verdict) = exchange(request("{}"), None, lines(&[line, "1"])).await;
        assert_eq!(shown.len(), 1);
        assert_eq!(verdict, json!({"decision":"deny","reason":"operator declined"}));
    }
}

#[tokio::test]
async fn retry_cancellation_and_unavailable_reads_keep_their_verdicts() {
    for (reply, verdict) in [
        (ReadOutcome::Interrupted, json!({"decision":"abort"})),
        (ReadOutcome::Eof, json!({"decision":"deny","reason":"approval prompt was not answered"})),
        (ReadOutcome::Failed("read failed".into()), json!({"decision":"deny","reason":"approval prompt was not answered"})),
    ] {
        let (shown, actual) = exchange(request("{}"), None, vec![ReadOutcome::Line("bad".into()), reply]).await;
        assert_eq!(shown.len(), 2);
        assert_eq!(actual, verdict);
    }
}
