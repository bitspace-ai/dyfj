//! The executor transport's wire format, as
//! `prototype/src/tools/builtin/executor-transport.ts` speaks it: one request
//! per connection, each message one line of JSON. Version 2 adds the
//! `attest` request and an exec request's `binding` (BIT-736); a version 1
//! request is refused.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const VERSION: u32 = 2;
/// The bash tool's ceiling is 600 s; nothing longer is accepted.
pub const MAX_TIMEOUT_MS: u64 = 600_000;
pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;

/// Run one command in a fresh executor sandbox.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Exec {
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub timeout_ms: u64,
    /// The supervisor instance the runtime attested, sent when the call was
    /// allowed by the attested envelope. A request bound to another instance
    /// is refused, so an allow never outlives the supervisor it was decided
    /// against.
    #[serde(default)]
    pub binding: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attest {
    nonce: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Request {
    Exec(Exec),
    /// Describe what this supervisor enforces, echoing `nonce`.
    Attest { nonce: String },
}

/// The nonce is the runtime's fresh hex string, 32 to 128 characters.
fn valid_nonce(nonce: &str) -> bool {
    (32..=128).contains(&nonce.len()) && nonce.bytes().all(|b| b.is_ascii_hexdigit())
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
    let mut value: serde_json::Value =
        serde_json::from_slice(line).map_err(|_| "request is malformed".to_string())?;
    let object = value.as_object_mut().ok_or("request is malformed")?;
    if object.remove("v") != Some(VERSION.into()) {
        return Err("request has an unknown version".into());
    }
    let op = object.remove("op");
    match op.as_ref().and_then(|op| op.as_str()) {
        Some("exec") => {
            let request: Exec =
                serde_json::from_value(value).map_err(|_| "request is malformed".to_string())?;
            if request.argv.is_empty() {
                return Err("request has no command".into());
            }
            if request.timeout_ms == 0 || request.timeout_ms > MAX_TIMEOUT_MS {
                return Err("request timeout out of range".into());
            }
            Ok(Request::Exec(request))
        }
        Some("attest") => {
            let Attest { nonce } =
                serde_json::from_value(value).map_err(|_| "request is malformed".to_string())?;
            if !valid_nonce(&nonce) {
                return Err("attest nonce is malformed".into());
            }
            Ok(Request::Attest { nonce })
        }
        _ => Err("request has an unknown op".into()),
    }
}

/// The enforcement probe's result, from `attest::probe_verdict`.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub passed: bool,
    /// The connect attempt's error code, or `connected` / `timeout` / `none`.
    pub connect: String,
    /// The outside-workspace write's error code, or `written` / `none`.
    pub write: String,
    /// How long the probe's executor took, start to exit.
    pub ms: u64,
}

/// What the supervisor attests. The runtime verifies the policy's digest
/// itself; the supervisor only checks that it names the executor plan's.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attestation {
    pub nonce: String,
    pub instance: String,
    pub landlock_abi: i32,
    pub lease: &'static str,
    /// The executor's effective policy as installed, or null when the
    /// supervisor was started without one.
    pub executor_policy: Option<serde_json::Value>,
    /// The plan and policy files still hash as they did at start.
    pub files_unchanged: bool,
    /// The granted policy digest, when a trusted grant names the executor's.
    pub grant: Option<String>,
    /// Why a present grant was not accepted.
    pub grant_refusal: Option<String>,
    pub probe: Probe,
}

pub fn attestation(attestation: &Attestation) -> String {
    let mut value = serde_json::to_value(attestation).expect("attestation serializes");
    value["v"] = VERSION.into();
    format!("{value}\n")
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
            "v": 2, "op": "exec", "argv": ["bash", "-c", "true"], "cwd": "/w",
            "env": { "PATH": "/usr/bin" }, "timeoutMs": 5000
        })
    }

    fn exec(value: &serde_json::Value) -> Result<Exec, String> {
        match parse_request(value.to_string().as_bytes())? {
            Request::Exec(exec) => Ok(exec),
            other => Err(format!("not exec: {other:?}")),
        }
    }

    #[test]
    fn parses_the_transport_request() {
        let parsed = exec(&request()).unwrap();
        assert_eq!(parsed.argv, vec!["bash", "-c", "true"]);
        assert_eq!(parsed.env.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(parsed.timeout_ms, 5000);
        assert_eq!(parsed.binding, None);
        let mut bound = request();
        bound["binding"] = "abc".into();
        assert_eq!(exec(&bound).unwrap().binding.as_deref(), Some("abc"));
    }

    #[test]
    fn refuses_a_version_1_request() {
        let mut r = request();
        r["v"] = 1.into();
        r.as_object_mut().unwrap().remove("op");
        assert!(parse_request(r.to_string().as_bytes()).is_err());
    }

    #[test]
    fn parses_an_attest_request_and_refuses_a_bad_nonce() {
        let nonce = "0123456789abcdef0123456789abcdef";
        let line = serde_json::json!({ "v": 2, "op": "attest", "nonce": nonce }).to_string();
        assert_eq!(parse_request(line.as_bytes()).unwrap(), Request::Attest { nonce: nonce.into() });
        for bad in ["short", "zz23456789abcdef0123456789abcdef"] {
            let line = serde_json::json!({ "v": 2, "op": "attest", "nonce": bad }).to_string();
            assert!(parse_request(line.as_bytes()).is_err(), "{bad}");
        }
        let extra = serde_json::json!({ "v": 2, "op": "attest", "nonce": nonce, "x": 1 }).to_string();
        assert!(parse_request(extra.as_bytes()).is_err());
        let unknown = serde_json::json!({ "v": 2, "op": "grant", "nonce": nonce }).to_string();
        assert!(parse_request(unknown.as_bytes()).is_err());
    }

    #[test]
    fn refuses_bad_requests() {
        let cases: Vec<(&str, serde_json::Value)> = vec![
            ("v", 3.into()),
            ("op", "attest".into()),
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
                "v": 2, "code": null, "signal": "SIGKILL", "stdout": "a", "stderr": "",
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
        assert_eq!(refusal("lease expired"), "{\"error\":\"lease expired\",\"v\":2}\n");
    }
}
