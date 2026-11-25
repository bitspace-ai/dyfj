//! `/effort`: the reasoning effort of a turn.
//!
//! The session carries the operator's level and sends it on every turn as
//! `routingOptions.reasoningEffort`; with none set, the runtime's default
//! applies. The runtime decides what the active model accepts and reports it
//! on `models/list` as `reasoningEfforts`, so this client never decides from a
//! slug prefix: a level the model's row does not list is refused here, and a
//! switch to a model with no effort control drops the session's level rather
//! than have every turn refused.

use crate::approval::visible;
use crate::client::Client;
use crate::commands::{Command, list_models};
use crate::session::{
    REASONING_EFFORTS, Session, find_model_row, is_codex_model, row_effort_levels,
};
use serde_json::{Value, json};

const USAGE: &str = "usage: /effort [low|medium|high|xhigh|default]";

/// What a changed effort does to a session's Codex conversation; the
/// TypeScript REPL prints the same words.
const RESTART_NOTE: &str = "a warm Codex session opened at another effort is not reused for it";

/// The runner a session names that has no reasoning-effort channel at all.
/// Every other model's capability is its catalog row's answer.
const NO_EFFORT_RUNNER: &str = "fixture";

/// What `/effort` was asked to do.
#[derive(Debug, PartialEq)]
pub enum EffortTarget {
    /// `/effort`: show the effort the next turn runs at.
    Show,
    /// `/effort <level>`: one of `REASONING_EFFORTS`.
    Set(String),
    /// `/effort default`: back to the model's default effort.
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

/// Refuse a startup effort for the one runner that has no effort channel,
/// before the session starts. A named model is not judged here: whether it
/// accepts an effort is its catalog row's answer, which the runtime reports
/// on `models/list`. With no model named, the runtime's default decides, and
/// the runtime refuses the turn if it takes no effort.
pub fn check_startup(session: &Session) -> Result<(), String> {
    match &session.model {
        Some(model) if session.effort.is_some() && model == NO_EFFORT_RUNNER => {
            Err("--effort does not apply to the fixture runner".into())
        }
        _ => Ok(()),
    }
}

/// Drop the session's effort when `slug`'s catalog row accepts none, or does
/// not accept the level the session carries: carried over, it would refuse
/// every turn. `rows` is the `models/list` answer; without it (a runtime that
/// could not answer) the level is kept and the runtime refuses it at the turn.
pub fn clear_off_unsupported(session: &mut Session, slug: &str, rows: Option<&[Value]>) {
    let Some(effort) = session.effort.clone() else {
        return;
    };
    let Some(row) = rows.and_then(|rows| find_model_row(rows, slug)) else {
        return;
    };
    match row_effort_levels(row) {
        None => {
            session.effort = None;
            eprintln!(
                "reasoning effort cleared: {} takes no reasoning effort",
                visible(slug)
            );
        }
        Some(levels) if !levels.iter().any(|level| level == &effort) => {
            session.effort = None;
            eprintln!(
                "reasoning effort cleared for \"{}\" (it does not accept \"{}\"; it accepts {})",
                visible(slug),
                visible(&effort),
                visible(&levels.join(", "))
            );
        }
        Some(_) => {}
    }
}

/// What a bare `/effort` prints: the effort the next turn runs at, whether it
/// is the session's own or the model's default, and the levels that model
/// accepts. The TypeScript REPL prints the same fact (`/effort` in
/// `prototype/src/cli/commands/effort.ts`).
pub fn show_line(session_effort: Option<&str>, default_effort: &str, levels: &[String]) -> String {
    let accepted = format!(" (accepts {})", visible(&levels.join(", ")));
    match session_effort {
        Some(effort) => format!("reasoning effort: {}{accepted}", visible(effort)),
        None => format!(
            "reasoning effort: {} (model default){accepted}",
            visible(default_effort)
        ),
    }
}

/// The exact line a bare `/effort` prints, for the model the next turn runs
/// on. `None` when that model's row takes no effort, which `/effort` reports
/// separately. One implementation, so the printed text is what a test reads.
pub fn show_message(
    rows: &[Value],
    active: Option<&str>,
    session_effort: Option<&str>,
    runtime_effort: Option<&str>,
) -> Option<String> {
    let levels = active
        .and_then(|slug| find_model_row(rows, slug))
        .and_then(row_effort_levels)?;
    let default = default_effort(rows, active, runtime_effort);
    Some(show_line(session_effort, &default, &levels))
}

/// The effort a turn runs at when the session names none: the value
/// `models/list` reports on the active model's row. A native row's is `low`;
/// a Codex row's is the runtime's configured `[codex] reasoning_effort`, else
/// `medium`. A runtime from before that reports no row value is read through
/// `runtime/status`'s `codexReasoningEffort` instead, and only for Codex, so
/// neither route falls back to a shared guess.
pub fn default_effort(
    rows: &[Value],
    active: Option<&str>,
    runtime_effort: Option<&str>,
) -> String {
    row_default_effort(rows, active).unwrap_or_else(|| {
        if active.is_some_and(is_codex_model) {
            runtime_effort.unwrap_or("medium").to_string()
        } else {
            "low".into()
        }
    })
}

/// The default `models/list` reports on the active model's row, when it
/// reports one.
fn row_default_effort(rows: &[Value], active: Option<&str>) -> Option<String> {
    active
        .and_then(|slug| find_model_row(rows, slug))
        .and_then(|row| row.get("reasoningEffort"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The runtime's configured `[codex] reasoning_effort` from
/// `runtime/status`, for a runtime from before `models/list` reported it.
async fn runtime_effort(client: &Client) -> Option<String> {
    let status = client.request("runtime/status", json!({})).await.ok()?;
    status
        .pointer("/runtime/codexReasoningEffort")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The model the next turn runs on: the session's own choice, else the
/// runtime's default turn model.
async fn active_slug(client: &Client, session: &Session) -> Option<String> {
    if let Some(model) = &session.model {
        return Some(model.clone());
    }
    let status = client.request("runtime/status", json!({})).await.ok()?;
    status
        .pointer("/runtime/defaultTurnModel/slug")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// `/effort` shows the effort the next turn runs at; `/effort <level>` sets
/// it for the rest of the session, and `/effort default` returns to the
/// model's default. A level the active model's row does not list is refused
/// here, with the levels it does accept.
pub async fn run(client: &Client, session: &mut Session, target: EffortTarget) {
    // Clearing comes before any runtime read and needs no effort-capable
    // model: it is how an effort the current route refuses is dropped.
    let previous = session.effort.clone();
    let clearing = target == EffortTarget::Default;
    if clearing {
        session.effort = None;
    }
    let cleared = "reasoning effort cleared; turns name none";
    let Some(rows) = list_models(client).await else {
        if clearing {
            eprintln!("{cleared}");
        }
        return;
    };
    let active = active_slug(client, session).await;
    let levels = active
        .as_deref()
        .and_then(|slug| find_model_row(&rows, slug))
        .and_then(row_effort_levels);
    let Some(levels) = levels else {
        if clearing {
            return eprintln!("{cleared}");
        }
        return eprintln!(
            "reasoning effort does not apply to \"{}\": its catalog row does not support effort control",
            visible(active.as_deref().unwrap_or("the runtime default"))
        );
    };
    // A Codex row's default is the runtime's configured `[codex]
    // reasoning_effort` (else `medium`), which `models/list` reports on the
    // row; a native row's is `low`. A runtime from before that reports no row
    // value is read through `runtime/status`, for a Codex session only, so a
    // native row costs one read rather than two.
    let configured = if row_default_effort(&rows, active.as_deref()).is_none()
        && active.as_deref().is_some_and(is_codex_model)
    {
        runtime_effort(&client).await
    } else {
        None
    };
    let default_effort =
        default_effort(&rows, active.as_deref(), configured.as_deref());
    let before = previous.unwrap_or_else(|| default_effort.clone());
    match target {
        EffortTarget::Show => {
            let line = show_message(
                &rows,
                active.as_deref(),
                session.effort.as_deref(),
                configured.as_deref(),
            );
            if let Some(line) = line {
                eprintln!("{line}");
            }
            return;
        }
        EffortTarget::Set(level) => {
            if !levels.iter().any(|accepted| accepted == &level) {
                eprintln!(
                    "dyfj: \"{}\" does not accept reasoning effort \"{}\"; it accepts {}",
                    visible(active.as_deref().unwrap_or("the model")),
                    visible(&level),
                    visible(&levels.join(", "))
                );
                return;
            }
            session.effort = Some(level);
        }
        EffortTarget::Default => {}
    }
    let now = session.effort.clone().unwrap_or(default_effort);
    if now == before {
        eprintln!("reasoning effort stays {}", visible(&now));
    } else {
        eprintln!("reasoning effort {} from the next turn; {RESTART_NOTE}", visible(&now));
    }
    eprintln!("{}", crate::posture::switch_line(session, &rows));
}

#[cfg(test)]
mod tests {
    use super::{EffortTarget, check_startup, clear_off_unsupported, level_flag};
    use crate::commands::run_tests::{catalog, drive, methods, model};
    use crate::commands::{Command, parse};
    use crate::session::Session;
    use serde_json::{Value, json};

    #[test]
    fn parses_effort_levels_every_route_accepts() {
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

    /// `--effort` takes the levels the runtime names. A named model is
    /// checked by the runtime, which holds the catalog; this client refuses
    /// only the runner with no effort channel at all.
    #[test]
    fn a_startup_effort_is_validated_before_the_session_starts() {
        assert_eq!(level_flag("xhigh".into()), Ok("xhigh".into()));
        assert_eq!(level_flag("max".into()), Err("--effort must be low, medium, high, or xhigh".into()));
        let effort = Some("high".to_string());
        let codex = Session { model: Some("codex-chatgpt/gpt-6.1-sol".into()), effort: effort.clone(), ..Session::default() };
        assert_eq!(check_startup(&codex), Ok(()));
        let unnamed = Session { effort: effort.clone(), ..Session::default() };
        assert_eq!(check_startup(&unnamed), Ok(()));
        // Whether a named native model accepts an effort is its catalog row's
        // answer, which only the runtime holds.
        let local = Session { model: Some("local/qwen".into()), effort: effort.clone(), ..Session::default() };
        assert_eq!(check_startup(&local), Ok(()));
        let fixture = Session { model: Some("fixture".into()), effort: effort.clone(), ..Session::default() };
        assert_eq!(check_startup(&fixture), Err("--effort does not apply to the fixture runner".into()));
    }

    /// The commands' catalog with the rows the effort cases need.
    fn effort_catalog(method: &str, params: &Value) -> Value {
        let mut value = catalog(method, params);
        if method == "models/list" {
            let models = value["models"].as_array_mut().unwrap();
            models.push(json!({
                "slug": "codex-chatgpt/gpt-6.1-sol", "tier": 2, "local": false,
                "modality": "subscription-hosted",
                "reasoningEfforts": ["low", "medium", "high", "xhigh"]
            }));
            models.push(json!({
                "slug": "deepseek/deepseek-v4.1-flash-1017", "tier": 1, "local": false,
                "modality": "aggregator-hosted", "reasoningEffort": "low",
                "reasoningEfforts": ["low", "medium", "high", "xhigh"]
            }));
            models.push(json!({
                "slug": "gemini-3.8-flash", "tier": 1, "local": false,
                "modality": "frontier-hosted", "reasoningEffort": "low",
                "reasoningEfforts": ["low", "medium", "high"]
            }));
        }
        value
    }

    fn rows() -> Vec<Value> {
        effort_catalog("models/list", &json!({}))["models"]
            .as_array()
            .unwrap()
            .clone()
    }

    /// `/effort` sets the next turn's effort on any model whose row accepts
    /// one, refuses a level the provider does not, and a switch to a model
    /// without effort control drops it.
    #[tokio::test]
    async fn effort_applies_to_every_model_that_accepts_one() {
        let mut session = Session::default();
        // The runtime default z-ai/glm-5.2 takes no reasoning effort.
        drive(effort_catalog, &mut session, vec![Command::Effort(EffortTarget::Set("high".into()))]).await;
        assert_eq!(session.effort, None);

        drive(effort_catalog, &mut session, vec![model("codex-chatgpt/gpt-6.1-sol"), Command::Effort(EffortTarget::Set("high".into()))]).await;
        assert_eq!(session.effort.as_deref(), Some("high"));
        assert_eq!(session.turn_body("hi", "t-1")["routingOptions"]["reasoningEffort"], "high");

        // A native model that takes an effort takes the same level.
        drive(effort_catalog, &mut session, vec![model("deepseek/deepseek-v4.1-flash-1017"), Command::Effort(EffortTarget::Set("xhigh".into()))]).await;
        assert_eq!(session.effort.as_deref(), Some("xhigh"));
        assert_eq!(session.turn_body("hi", "t-1")["routingOptions"]["reasoningEffort"], "xhigh");

        drive(effort_catalog, &mut session, vec![Command::Effort(EffortTarget::Default)]).await;
        assert_eq!(session.effort, None);
    }

    /// A switch drops a level the new model does not accept, and keeps one it
    /// does, so no turn is refused for a carried-over setting.
    #[test]
    fn a_switch_clears_only_a_level_the_new_model_refuses() {
        let rows = rows();
        let mut session = Session { effort: Some("xhigh".into()), ..Session::default() };
        clear_off_unsupported(&mut session, "deepseek/deepseek-v4.1-flash-1017", Some(rows.as_slice()));
        assert_eq!(session.effort.as_deref(), Some("xhigh"), "DeepSeek accepts xhigh");
        clear_off_unsupported(&mut session, "gemini-3.8-flash", Some(rows.as_slice()));
        assert_eq!(session.effort, None, "Gemini tops out at high");
        session.effort = Some("high".into());
        clear_off_unsupported(&mut session, "local/qwen", Some(rows.as_slice()));
        assert_eq!(session.effort, None, "no effort control at all");
        // A runtime that could not answer keeps the level: the runtime itself
        // refuses a level the model cannot take.
        session.effort = Some("high".into());
        clear_off_unsupported(&mut session, "local/qwen", None);
        assert_eq!(session.effort.as_deref(), Some("high"));
    }

    /// A Codex row takes the runtime's configured `[codex] reasoning_effort`
    /// as its default, not the native `low`. `models/list` reports it on the
    /// row; a runtime from before that reports it on runtime/status.
    #[tokio::test]
    async fn a_codex_session_defaults_to_the_runtime_effort_not_low() {
        let mut session = Session { model: Some("codex-chatgpt/gpt-6.1-sol".into()), ..Session::default() };
        let seen = drive(
            effort_catalog,
            &mut session,
            vec![Command::Effort(EffortTarget::Show)],
        )
        .await;
        // A bare /effort reads the catalog, then the runtime's configured
        // effort, because this row reports no default of its own.
        assert_eq!(methods(&seen), ["models/list", "runtime/status"]);
        // What it prints: `medium`, the Codex fallback, never the native `low`
        // — and the levels that row accepts. This is the text `/effort` emits.
        assert_eq!(
            super::show_message(&rows(), Some("codex-chatgpt/gpt-6.1-sol"), None, None),
            Some(
                "reasoning effort: medium (model default) (accepts low, medium, high, xhigh)"
                    .to_string()
            ),
        );
        let mut rows_high = rows();
        for row in rows_high.iter_mut() {
            if row.get("slug").and_then(Value::as_str) == Some("codex-chatgpt/gpt-6.1-sol") {
                row["reasoningEffort"] = json!("high");
            }
        }
        // A row value wins; a runtime configuration is read only when the row
        // reports none.
        assert_eq!(super::default_effort(&rows_high, Some("codex-chatgpt/gpt-6.1-sol"), Some("xhigh")), "high");
        assert_eq!(super::default_effort(&rows_high, Some("codex-chatgpt/gpt-6.1-sol"), None), "high");
        // A native model keeps `low`, whatever the runtime configures.
        assert_eq!(super::default_effort(&rows_high, Some("deepseek/deepseek-v4.1-flash-1017"), Some("xhigh")), "low");
        // A Codex row that reports no default reads the runtime's configured
        // effort, then `medium`.
        assert_eq!(super::default_effort(&[], Some("codex-chatgpt/gpt-6.1-sol"), Some("xhigh")), "xhigh");
        assert_eq!(super::default_effort(&[], Some("codex-chatgpt/gpt-6.1-sol"), None), "medium");
        // A row with no levels takes no effort at all, so there is no line.
        assert_eq!(
            super::show_message(&[], Some("codex-chatgpt/gpt-6.1-sol"), None, Some("xhigh")),
            None,
        );
    }

    /// A bare `/effort` names the levels its model accepts, as the README
    /// says, whether the session set one or the model default applies.
    #[test]
    fn a_bare_effort_names_the_levels_the_model_accepts() {
        let levels = vec!["low".to_string(), "high".to_string()];
        assert_eq!(
            super::show_line(None, "low", &levels),
            "reasoning effort: low (model default) (accepts low, high)"
        );
        assert_eq!(
            super::show_line(Some("high"), "low", &levels),
            "reasoning effort: high (accepts low, high)"
        );
        let all = vec!["low".to_string(), "medium".to_string(), "high".to_string(), "xhigh".to_string()];
        assert_eq!(
            super::show_line(Some("xhigh"), "medium", &all),
            "reasoning effort: xhigh (accepts low, medium, high, xhigh)"
        );
    }
}
