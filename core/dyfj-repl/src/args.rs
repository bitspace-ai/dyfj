//! The command line and environment the REPL starts from: the socket it
//! connects to and the session its first turn carries.

use crate::session::Session;
use crate::{approval, budget, commands, effort};
use anyhow::{Context, Result};

pub fn socket_path() -> Result<String> {
    resolve_socket_path(|key| std::env::var(key).ok())
}

/// Mirrors resolveSocketPath in the runtime's uds-path: `DYFJ_SOCKET`, then
/// `$XDG_RUNTIME_DIR/dyfj`, then `~/.dyfj/run`. An empty value counts as unset,
/// as it does there, so the client finds the socket the runtime is serving.
fn resolve_socket_path(env: impl Fn(&str) -> Option<String>) -> Result<String> {
    let set = |key: &str| env(key).filter(|value| !value.is_empty());
    if let Some(explicit) = set("DYFJ_SOCKET") {
        return Ok(explicit);
    }
    let base = match set("XDG_RUNTIME_DIR") {
        Some(runtime_dir) => format!("{runtime_dir}/dyfj"),
        None => {
            let home = env("HOME")
                .context("HOME is unset and neither DYFJ_SOCKET nor XDG_RUNTIME_DIR was given")?;
            format!("{home}/.dyfj/run")
        }
    };
    Ok(format!("{base}/workbench.sock"))
}

pub const USAGE: &str = "\
usage: dyfj-repl [--model <slug>] [--approve-paid] [--fast] [--effort <level>] [--tool-steps <N>] [--budget-<limit> <usd>] [--session <id>] [--workspace <dir>]
  --model <slug>    route every turn to this model (default: the runtime's; env DYFJ_WORKBENCH_MODEL)
  --approve-paid    opt this session into paid inference
  --fast            use the fast speed tier on models that support it
  --effort <level>  reasoning effort for codex-chatgpt/* models: low, medium, high or xhigh
                    (default: the runtime's [codex] reasoning_effort, else medium)
  --tool-steps <N>  this session's tool-step limit, 1 through 64 and not above the runtime's ceiling
  --budget-turn, --budget-session, --budget-day, --budget-per-call, --budget-runaway <usd>
                    this session's spend limits (default: the runtime's [budget] config);
                    runaway is spend with no tool progress
  --session <id>    resume a runtime session, on the model it last ran on unless --model names one
  --workspace <d>   scope a new session's file tools to this directory (default: cwd; env DYFJ_WORKSPACE)";

/// Build the starting session from the command line and environment.
/// `Ok(None)` means help was asked for.
pub fn parse_args(
    args: &[String],
    env: impl Fn(&str) -> Option<String>,
    cwd: Option<String>,
) -> std::result::Result<Option<Session>, String> {
    let set = |key: &str| env(key).filter(|value| !value.is_empty());
    let mut session = Session {
        model: set("DYFJ_WORKBENCH_MODEL"),
        default_model: set("DYFJ_WORKBENCH_MODEL"),
        workspace: set("DYFJ_WORKSPACE").or(cwd),
        ..Session::default()
    };
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let mut value = |flag: &str| {
            iter.next()
                .filter(|v| !v.starts_with("--"))
                .cloned()
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        match arg.as_str() {
            "-h" | "--help" => return Ok(None),
            "--approve-paid" => session.approve_paid = true,
            "--fast" => session.fast = Some(true),
            "--model" => {
                session.model = Some(value("--model")?);
                session.model_pinned = true;
            }
            "--workspace" => session.workspace = Some(value("--workspace")?),
            "--effort" => session.effort = Some(effort::level_flag(value("--effort")?)?),
            "--tool-steps" => {
                let raw = value("--tool-steps")?;
                session.max_tool_steps = Some(commands::parse_tool_steps(&raw).ok_or_else(|| {
                    format!(
                        "--tool-steps must be an integer from 1 through {}",
                        commands::TOOL_STEPS_BOUND
                    )
                })?);
            }
            "--session" => {
                let reference = value("--session")?;
                let id = commands::normalize_session_ref(&reference).ok_or_else(|| {
                    format!(
                        "--session expects a session id or a slug as listed by \
                         'dyfj sessions', got: {}",
                        approval::visible(&reference)
                    )
                })?;
                session.id = Some(id);
            }
            flag if budget::Limit::from_flag(flag).is_some() => {
                let limit = budget::Limit::from_flag(flag).expect("matched above");
                let raw = value(flag)?;
                let usd = budget::parse_usd(&raw).ok_or_else(|| {
                    format!(
                        "{flag} must be a dollar amount above 0 and at most {}",
                        budget::MAX_BUDGET_USD
                    )
                })?;
                session.budget.set(limit, usd);
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    effort::check_startup(&session)?;
    // A resumed session keeps the workspace stored on its row; the runtime
    // never moves it, so a local default here would only misreport it.
    if session.id.is_some() {
        session.workspace = None;
    }
    Ok(Some(session))
}

#[cfg(test)]
mod tests {
    use super::resolve_socket_path;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_string())
        }
    }

    /// The precedence the runtime serves on; a client that skips a step
    /// connects to a socket nobody is listening on.
    #[test]
    fn socket_resolution_matches_the_runtime() {
        let all = [
            ("DYFJ_SOCKET", "/x/explicit.sock"),
            ("XDG_RUNTIME_DIR", "/run/user/1000"),
            ("HOME", "/operator-home"),
        ];
        assert_eq!(resolve_socket_path(env(&all)).unwrap(), "/x/explicit.sock");
        assert_eq!(
            resolve_socket_path(env(&all[1..])).unwrap(),
            "/run/user/1000/dyfj/workbench.sock"
        );
        assert_eq!(
            resolve_socket_path(env(&all[2..])).unwrap(),
            "/operator-home/.dyfj/run/workbench.sock"
        );
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn budget_flags_set_the_sessions_spend_limits_and_ride_the_turn() {
        let session = super::parse_args(
            &args(&["--budget-turn", "6", "--budget-runaway", "$0.75"]),
            env(&[]),
            None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            session.turn_body("hi", "t")["budget"],
            serde_json::json!({"turnLimitUsd": 6.0, "runawayStallUsd": 0.75})
        );
        let plain = super::parse_args(&args(&[]), env(&[]), None).unwrap().unwrap();
        assert!(plain.turn_body("hi", "t").get("budget").is_none(), "no limit set sends none");
        assert_eq!(
            super::parse_args(&args(&["--budget-day", "lots"]), env(&[]), None).unwrap_err(),
            "--budget-day must be a dollar amount above 0 and at most 1000"
        );
    }

    #[test]
    fn tool_steps_sets_the_sessions_limit_within_the_bound() {
        let session = super::parse_args(&args(&["--tool-steps", "12"]), env(&[]), None)
            .unwrap()
            .unwrap();
        assert_eq!(session.max_tool_steps, Some(12));
        // The flag is in the turn body this session builds.
        assert_eq!(session.turn_body("hi", "t")["maxToolSteps"], 12);
        for value in ["0", "65", "x", "1.5"] {
            assert_eq!(
                super::parse_args(&args(&["--tool-steps", value]), env(&[]), None).unwrap_err(),
                "--tool-steps must be an integer from 1 through 64",
                "{value}"
            );
        }
    }

    #[test]
    fn arguments_set_routing_paid_consent_and_resume() {
        let session = super::parse_args(
            &args(&[
                "--model",
                "z-ai/glm-5.2",
                "--approve-paid",
                "--fast",
                "--session",
                "01J9ZQ4W8X6V5T3R2P1N0M9K8H",
            ]),
            env(&[]),
            Some("/cwd".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(session.model.as_deref(), Some("z-ai/glm-5.2"));
        assert!(session.model_pinned, "--model wins over a resumed session's model");
        assert!(session.approve_paid);
        assert_eq!(session.fast, Some(true));
        assert_eq!(session.id.as_deref(), Some("01J9ZQ4W8X6V5T3R2P1N0M9K8H"));
        // A resumed session's workspace is the one stored on its row.
        assert_eq!(session.workspace, None);
    }

    /// A malformed id fails at startup rather than at the first turn, and the
    /// slug `dyfj sessions` lists is accepted as the TypeScript CLI accepts it.
    #[test]
    fn a_session_reference_is_validated_and_canonicalised() {
        let parse = |value: &str| super::parse_args(&args(&["--session", value]), env(&[]), None);
        let err = parse("nope").unwrap_err();
        assert!(err.contains("--session expects a session id"), "{err}");
        let session = parse("workbench-01j9zq4w8x6v5t3r2p1n0m9k8h").unwrap().unwrap();
        assert_eq!(session.id.as_deref(), Some("01J9ZQ4W8X6V5T3R2P1N0M9K8H"));
    }

    /// The same precedence the TypeScript CLI uses: a flag, then the
    /// environment, then the directory the REPL was started in.
    #[test]
    fn workspace_and_model_fall_back_to_the_environment_then_cwd() {
        let vars = [
            ("DYFJ_WORKSPACE", "/env-ws"),
            ("DYFJ_WORKBENCH_MODEL", "env-model"),
        ];
        let from_env = super::parse_args(&[], env(&vars), Some("/cwd".into()))
            .unwrap()
            .unwrap();
        assert_eq!(from_env.workspace.as_deref(), Some("/env-ws"));
        assert_eq!(from_env.model.as_deref(), Some("env-model"));
        assert!(!from_env.model_pinned, "the environment's model is a default");

        let flag = super::parse_args(
            &args(&["--workspace", "/flag"]),
            env(&vars),
            Some("/cwd".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(flag.workspace.as_deref(), Some("/flag"));

        let bare = super::parse_args(&[], env(&[]), Some("/cwd".into()))
            .unwrap()
            .unwrap();
        assert_eq!(bare.workspace.as_deref(), Some("/cwd"));
        assert_eq!(bare.model, None);
        assert!(!bare.approve_paid, "paid consent is never implied");
    }

    #[test]
    fn bad_arguments_are_refused() {
        assert!(super::parse_args(&args(&["--model"]), env(&[]), None).is_err());
        assert!(super::parse_args(&args(&["--model", "--fast"]), env(&[]), None).is_err());
        assert!(super::parse_args(&args(&["--wat"]), env(&[]), None).is_err());
        assert!(
            super::parse_args(&args(&["--help"]), env(&[]), None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn an_empty_socket_variable_counts_as_unset() {
        let empty = [("DYFJ_SOCKET", ""), ("XDG_RUNTIME_DIR", ""), ("HOME", "/operator-home")];
        assert_eq!(
            resolve_socket_path(env(&empty)).unwrap(),
            "/operator-home/.dyfj/run/workbench.sock"
        );
    }
}
