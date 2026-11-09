//! `/effort`: the reasoning effort of a Codex ChatGPT turn.
//!
//! The session carries the operator's level and sends it on every turn as
//! `routingOptions.reasoningEffort`; with none set, the runtime's configured
//! default applies. Only a codex-chatgpt model takes one, so a switch to any
//! other model drops it rather than have every turn refused.

use crate::approval::visible;
use crate::client::Client;
use crate::commands::{Command, error_line, list_models};
use crate::session::{REASONING_EFFORTS, Session, is_codex_model};
use serde_json::{Value, json};

const USAGE: &str = "usage: /effort [low|medium|high|xhigh|default]";

/// What a changed effort does to a session's Codex conversation; the
/// TypeScript REPL prints the same words.
const RESTART_NOTE: &str = "a session with earlier turns continues in a new Codex session, \
     which is given this session's transcript";

/// What `/effort` was asked to do.
#[derive(Debug, PartialEq)]
pub enum EffortTarget {
    /// `/effort`: show the effort the next Codex turn runs at.
    Show,
    /// `/effort <level>`: one of `REASONING_EFFORTS`.
    Set(String),
    /// `/effort default`: back to the runtime's configured effort.
    Default,
}

/// Parse the words after `/effort`.
pub fn parse(args: &[&str]) -> Command {
    match args {
        [] => Command::Effort(EffortTarget::Show),
        ["default"] => Command::Effort(EffortTarget::Default),
        [level] if REASONING_EFFORTS.contains(level) => {
            Command::Effort(EffortTarget::Set((*level).to_string()))
        }
        _ => Command::Usage(USAGE.into()),
    }
}

/// `--effort <level>` as given on the command line.
pub fn level_flag(level: String) -> Result<String, String> {
    if REASONING_EFFORTS.contains(&level.as_str()) {
        Ok(level)
    } else {
        Err("--effort must be low, medium, high, or xhigh".into())
    }
}

/// Refuse a startup effort for a model off the Codex route, before the
/// session starts. With no model named, the runtime's default may be a Codex
/// one, and the runtime refuses the turn if it is not. A resumed session
/// without `--model` runs on its recorded model, not yet known here.
pub fn check_startup(session: &Session) -> Result<(), String> {
    if session.id.is_some() && !session.model_pinned {
        return Ok(());
    }
    match &session.model {
        Some(model) if session.effort.is_some() && !is_codex_model(model) => {
            Err("--effort applies only to codex-chatgpt/* models".into())
        }
        _ => Ok(()),
    }
}

/// Drop the session's effort when `slug` is not a Codex model.
pub fn clear_off_codex(session: &mut Session, slug: &str) {
    if session.effort.is_some() && !is_codex_model(slug) {
        session.effort = None;
        eprintln!("reasoning effort cleared: {} is not a codex-chatgpt model", visible(slug));
    }
}

/// `/effort` shows the effort the next Codex turn runs at; `/effort <level>`
/// sets it for the rest of the session, and `/effort default` returns to the
/// runtime's configured one. A changed effort starts a new Codex session on
/// the next turn, which is given this session's transcript.
pub async fn run(client: &Client, session: &mut Session, target: EffortTarget) {
    let status = match client.request("runtime/status", json!({})).await {
        Ok(status) => status,
        Err(err) => return error_line("could not read the runtime's posture", &err),
    };
    let active = session.model.clone().or_else(|| {
        status
            .pointer("/runtime/defaultTurnModel/slug")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let codex = active.as_deref().is_some_and(is_codex_model);
    // Clearing needs no Codex model: it is how an effort the current route
    // refuses is dropped.
    if target == EffortTarget::Default && !codex {
        session.effort = None;
        return eprintln!("reasoning effort cleared; turns name none");
    }
    if !codex {
        return eprintln!(
            "reasoning effort applies only to codex-chatgpt models; \"{}\" is not one",
            visible(active.as_deref().unwrap_or("the runtime default"))
        );
    }
    let configured = status
        .pointer("/runtime/codexReasoningEffort")
        .and_then(Value::as_str)
        .unwrap_or("medium")
        .to_string();
    let before = session.effort.clone().unwrap_or_else(|| configured.clone());
    match target {
        EffortTarget::Show => {
            return match &session.effort {
                Some(effort) => eprintln!("reasoning effort: {effort}"),
                None => eprintln!("reasoning effort: {} (runtime default)", visible(&configured)),
            };
        }
        EffortTarget::Set(level) => session.effort = Some(level),
        EffortTarget::Default => session.effort = None,
    }
    let now = session.effort.clone().unwrap_or(configured);
    if now == before {
        eprintln!("reasoning effort stays {}", visible(&now));
    } else {
        eprintln!("reasoning effort {} from the next turn; {RESTART_NOTE}", visible(&now));
    }
    if let Some(rows) = list_models(client).await {
        eprintln!("{}", crate::posture::switch_line(session, &rows));
    }
}

#[cfg(test)]
mod tests {
    use super::{EffortTarget, check_startup, level_flag};
    use crate::commands::run_tests::{catalog, drive, model};
    use crate::commands::{Command, parse};
    use crate::session::Session;
    use serde_json::{Value, json};

    #[test]
    fn parses_effort_levels_the_codex_route_accepts() {
        assert_eq!(parse("/effort"), Some(Command::Effort(EffortTarget::Show)));
        for level in ["low", "medium", "high", "xhigh"] {
            assert_eq!(
                parse(&format!("/effort {level}")),
                Some(Command::Effort(EffortTarget::Set(level.into())))
            );
        }
        assert_eq!(parse("/effort default"), Some(Command::Effort(EffortTarget::Default)));
        for line in ["/effort max", "/effort HIGH", "/effort high now"] {
            assert!(matches!(parse(line), Some(Command::Usage(_))), "{line}");
        }
    }

    /// `--effort` takes the levels the Codex route accepts, on a Codex model
    /// only, and fails at startup otherwise.
    #[test]
    fn a_startup_effort_is_validated_before_the_session_starts() {
        assert_eq!(level_flag("xhigh".into()), Ok("xhigh".into()));
        assert_eq!(level_flag("max".into()), Err("--effort must be low, medium, high, or xhigh".into()));
        let effort = Some("high".to_string());
        let codex = Session { model: Some("codex-chatgpt/gpt-6.1-sol".into()), effort: effort.clone(), ..Session::default() };
        assert_eq!(check_startup(&codex), Ok(()));
        let unnamed = Session { effort: effort.clone(), ..Session::default() };
        assert_eq!(check_startup(&unnamed), Ok(()), "the runtime default may be a Codex model");
        let local = Session { model: Some("local/qwen".into()), effort: effort.clone(), ..Session::default() };
        assert_eq!(check_startup(&local), Err("--effort applies only to codex-chatgpt/* models".into()));
        // A resumed session's recorded model replaces the configured one,
        // so the configured one is not checked.
        let resumed = Session { id: Some("01J9ZQ4W8X6V5T3R2P1N0M9K8H".into()), ..local };
        assert_eq!(check_startup(&resumed), Ok(()));
    }

    /// The commands' catalog with a Codex model in it.
    fn codex_catalog(method: &str, params: &Value) -> Value {
        let mut value = catalog(method, params);
        if method == "models/list" {
            value["models"].as_array_mut().unwrap().push(json!({
                "slug": "codex-chatgpt/gpt-6.1-sol", "tier": 2, "local": false,
                "modality": "subscription-hosted"
            }));
        }
        value
    }

    /// `/effort` sets the next turn's effort on a Codex model only, and a
    /// switch to a model off that route drops it.
    #[tokio::test]
    async fn effort_applies_to_codex_models_only() {
        let mut session = Session::default();
        drive(codex_catalog, &mut session, vec![Command::Effort(EffortTarget::Set("high".into()))]).await;
        assert_eq!(session.effort, None, "the runtime default z-ai/glm-5.2 is not a Codex model");

        drive(
            codex_catalog,
            &mut session,
            vec![model("codex-chatgpt/gpt-6.1-sol"), Command::Effort(EffortTarget::Set("high".into()))],
        )
        .await;
        assert_eq!(session.effort.as_deref(), Some("high"));
        assert_eq!(session.turn_body("hi", "t-1")["routingOptions"]["reasoningEffort"], "high");

        drive(codex_catalog, &mut session, vec![Command::Effort(EffortTarget::Default)]).await;
        assert_eq!(session.effort, None);

        session.effort = Some("xhigh".into());
        drive(codex_catalog, &mut session, vec![model("local/qwen")]).await;
        assert_eq!(session.effort, None, "a non-Codex model drops the effort");

        // `/effort default` clears an effort the route refuses, so the
        // operator is never left with turns that all fail.
        session.effort = Some("high".into());
        drive(codex_catalog, &mut session, vec![Command::Effort(EffortTarget::Default)]).await;
        assert_eq!(session.effort, None);
    }
}
