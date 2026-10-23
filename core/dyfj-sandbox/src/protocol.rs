//! The executor transport's wire format, as
//! `prototype/src/tools/builtin/executor-transport.ts` speaks it: one request
//! per connection, each message one line of JSON.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const VERSION: u32 = 1;
/// The bash tool's ceiling is 600 s; nothing longer is accepted.
pub const MAX_TIMEOUT_MS: u64 = 600_000;
pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub v: u32,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub timeout_ms: u64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Termination {
    pub group: &'static str,
    pub exited: bool,
    pub output_closed: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub termination: Option<Termination>,
}

pub fn parse_request(line: &[u8]) -> Result<Request, String> {
    if line.len() > MAX_REQUEST_BYTES {
        return Err("request too large".into());
    }
    let request: Request =
        serde_json::from_slice(line).map_err(|_| "request is malformed".to_string())?;
    if request.v != VERSION {
        return Err("request has an unknown version".into());
    }
    if request.argv.is_empty() {
        return Err("request has no command".into());
    }
    if request.timeout_ms == 0 || request.timeout_ms > MAX_TIMEOUT_MS {
        return Err("request timeout out of range".into());
    }
    Ok(request)
}

pub fn reply(outcome: &Outcome) -> String {
    let mut value = serde_json::to_value(outcome).expect("outcome serializes");
    value["v"] = VERSION.into();
    format!("{value}\n")
}

pub fn refusal(reason: &str) -> String {
    format!("{}\n", serde_json::json!({ "v": VERSION, "error": reason }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> serde_json::Value {
        serde_json::json!({
            "v": 1, "argv": ["bash", "-c", "true"], "cwd": "/w",
            "env": { "PATH": "/usr/bin" }, "timeoutMs": 5000
        })
    }

    #[test]
    fn parses_the_transport_request() {
        let parsed = parse_request(request().to_string().as_bytes()).unwrap();
        assert_eq!(parsed.argv, vec!["bash", "-c", "true"]);
        assert_eq!(parsed.env.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(parsed.timeout_ms, 5000);
    }

    #[test]
    fn refuses_bad_requests() {
        let cases: Vec<(&str, serde_json::Value)> = vec![
            ("v", 2.into()),
            ("argv", serde_json::json!([])),
            ("timeoutMs", 0.into()),
            ("timeoutMs", 600_001.into()),
            ("extra", true.into()),
        ];
        for (field, value) in cases {
            let mut r = request();
            r[field] = value;
            assert!(parse_request(r.to_string().as_bytes()).is_err(), "{field}");
        }
        assert!(parse_request(b"not json").is_err());
        assert!(parse_request(&vec![b' '; MAX_REQUEST_BYTES + 1]).is_err());
    }

    #[test]
    fn replies_in_the_shape_the_client_parses() {
        let line = reply(&Outcome {
            code: None,
            signal: Some("SIGKILL".into()),
            stdout: "a".into(),
            stderr: String::new(),
            timed_out: true,
            termination: Some(Termination { group: "stopped", exited: true, output_closed: true }),
        });
        assert!(line.ends_with('\n'));
        let value: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "v": 1, "code": null, "signal": "SIGKILL", "stdout": "a", "stderr": "",
                "timedOut": true,
                "termination": { "group": "stopped", "exited": true, "outputClosed": true }
            })
        );
    }

    #[test]
    fn omits_termination_when_the_command_finished() {
        let line = reply(&Outcome {
            code: Some(0),
            signal: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: false,
            termination: None,
        });
        assert!(!line.contains("termination"));
    }

    #[test]
    fn refusals_carry_the_reason() {
        assert_eq!(refusal("lease expired"), "{\"error\":\"lease expired\",\"v\":1}\n");
    }
}
