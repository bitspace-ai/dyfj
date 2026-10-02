//! Slash commands: model choice, session control, and in-session capture.
//!
//! A command is recognised only when the WHOLE input is one line that starts
//! with a known command word. A paste is one string with newlines in it, so a
//! pasted block whose first line reads `/model x` stays a prompt. An unknown
//! `/word` is also sent as a prompt, as the TypeScript REPL does.
//!
//! Each command talks to the runtime over the same socket the turns use and
//! prints to stderr, keeping stdout for answers.

use crate::approval::{self, visible};
use crate::client::{Client, Incoming};
use crate::session::Session;
use crate::terminal::Ask;
use serde_json::{Value, json};
use tokio::sync::mpsc;

/// The terminal side a command needs when the runtime may ask the operator
/// something mid-request: the input reader and the runtime's message channel.
pub struct Prompter<'a> {
    pub input: &'a mpsc::Sender<Ask>,
    pub incoming: &'a mut mpsc::Receiver<Incoming>,
}

/// Matches `FRICTION_COMMAND_MAX_CHARACTERS` in the TypeScript friction
/// extension: the posted last-command context is clipped to this length.
const FRICTION_COMMAND_MAX_CHARACTERS: usize = 120;

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Help,
    /// `/model [slug] [--approve-paid] [--fast | --no-fast]`
    Model {
        slug: Option<String>,
        approve_paid: bool,
        fast: Option<bool>,
    },
    /// `/fast [on|off]`; `None` toggles.
    Fast(Option<bool>),
    /// `/session`
    SessionShow,
    /// `/session list`
    SessionList,
    /// `/session switch <id>`
    SessionSwitch(String),
    /// `/friction <sev> [--escaped] <text...>`
    Friction {
        severity: String,
        escaped: bool,
        text: String,
    },
    /// `/idea mark [--] <label...>`
    IdeaMark(String),
    /// `/idea list`
    IdeaList,
    /// A recognised command used wrongly; the message says how to use it.
    Usage(String),
}

const SEVERITIES: [&str; 4] = ["blocker", "major", "minor", "paper-cut"];

/// The 26-character Crockford Base32 shape the runtime gives session ids
/// (`SESSION_ID_SHAPE` in `prototype/src/contract/turn.ts`).
fn is_session_id(id: &str) -> bool {
    id.len() == 26
        && id
            .chars()
            .all(|c| c.is_ascii_digit() || (c.is_ascii_alphabetic() && !"IiLlOoUu".contains(c)))
}

/// A session reference as `--session` and `/session switch` accept it: the
/// bare id or the `workbench-<id>` slug `dyfj sessions` lists, returned as the
/// canonical uppercase id (`normalizeSessionRef` in the TypeScript client).
pub fn normalize_session_ref(value: &str) -> Option<String> {
    let candidate = match value.get(..10) {
        Some(prefix) if prefix.eq_ignore_ascii_case("workbench-") => &value[10..],
        _ => value,
    };
    is_session_id(candidate).then(|| candidate.to_ascii_uppercase())
}

/// Parse one completed input. `None` means it is a prompt, not a command.
pub fn parse(input: &str) -> Option<Command> {
    let trimmed = input.trim();
    if !trimmed.starts_with('/') || trimmed.contains('\n') {
        return None;
    }
    let mut words = trimmed.split_whitespace();
    let head = words.next()?;
    let args: Vec<&str> = words.collect();
    Some(match head {
        "/help" => Command::Help,
        "/model" => parse_model(&args),
        "/fast" => match args.as_slice() {
            [] => Command::Fast(None),
            ["on"] => Command::Fast(Some(true)),
            ["off"] => Command::Fast(Some(false)),
            _ => Command::Usage("usage: /fast [on|off]".into()),
        },
        "/session" => match args.as_slice() {
            [] => Command::SessionShow,
            ["list"] => Command::SessionList,
            ["switch", id] => match normalize_session_ref(id) {
                Some(id) => Command::SessionSwitch(id),
                None => Command::Usage(
                    "session ids are 26 Crockford Base32 characters (see /session list)".into(),
                ),
            },
            _ => Command::Usage("usage: /session, /session list, /session switch <id>".into()),
        },
        "/friction" => parse_friction(trimmed["/friction".len()..].trim()),
        "/idea" => match args.as_slice() {
            ["list"] => Command::IdeaList,
            ["mark", rest @ ..] => {
                let separated = rest.first() == Some(&"--");
                let rest = if separated { &rest[1..] } else { rest };
                if rest.is_empty() || (!separated && rest[0].starts_with('-')) {
                    Command::Usage("usage: /idea mark [--] <label...>".into())
                } else {
                    Command::IdeaMark(strip_quotes(&rest.join(" ")))
                }
            }
            _ => Command::Usage("usage: /idea mark <label...>, /idea list".into()),
        },
        _ => return None,
    })
}

fn parse_model(args: &[&str]) -> Command {
    let approve_paid = args.contains(&"--approve-paid");
    let fast_on = args.contains(&"--fast");
    let fast_off = args.contains(&"--no-fast");
    if fast_on && fast_off {
        return Command::Usage("cannot specify both --fast and --no-fast".into());
    }
    let rest: Vec<&str> = args
        .iter()
        .copied()
        .filter(|a| !matches!(*a, "--approve-paid" | "--fast" | "--no-fast"))
        .collect();
    match rest.as_slice() {
        [] => Command::Model {
            slug: None,
            approve_paid,
            fast: fast_on.then_some(true).or(fast_off.then_some(false)),
        },
        [slug] if !slug.starts_with('-') => Command::Model {
            slug: Some((*slug).to_string()),
            approve_paid,
            fast: fast_on.then_some(true).or(fast_off.then_some(false)),
        },
        _ => Command::Usage("usage: /model [slug] [--approve-paid] [--fast|--no-fast]".into()),
    }
}

fn parse_friction(rest: &str) -> Command {
    const USAGE: &str = "usage: /friction <blocker|major|minor|paper-cut> [--escaped] <text...>";
    let (severity, remainder) = match rest.split_once(char::is_whitespace) {
        Some((s, r)) => (s, r.trim()),
        None => (rest, ""),
    };
    if !SEVERITIES.contains(&severity) {
        return Command::Usage(USAGE.into());
    }
    let (escaped, text) = match remainder.strip_prefix("--escaped") {
        Some(after) if after.is_empty() || after.starts_with(char::is_whitespace) => {
            (true, after.trim())
        }
        _ => (false, remainder),
    };
    if text.is_empty() || text.starts_with('-') {
        return Command::Usage(USAGE.into());
    }
    Command::Friction {
        severity: severity.into(),
        escaped,
        text: text.into(),
    }
}

fn strip_quotes(label: &str) -> String {
    let t = label.trim();
    for q in ['"', '\''] {
        if t.len() >= 2 && t.starts_with(q) && t.ends_with(q) {
            return t[1..t.len() - 1].to_string();
        }
    }
    t.to_string()
}

const HELP: &str = "\
commands (type them alone on a line; inside a paste they are prompt text):
  /model [slug] [--approve-paid] [--fast|--no-fast]   show or switch the model
  /fast [on|off]                                       toggle the fast speed tier
  /session | /session list | /session switch <id>     show, list or resume sessions
  /friction <sev> [--escaped] <text...>                post a daily-driver friction
  /idea mark <label...> | /idea list                   mark or list ideas
  /quit, /exit, Ctrl-D                                 leave";

/// Run a parsed command against the runtime.
pub async fn run(
    command: Command,
    client: &Client,
    session: &mut Session,
    prompter: Prompter<'_>,
) {
    match command {
        Command::Help => eprintln!("{HELP}"),
        Command::Usage(message) => eprintln!("{message}"),
        Command::Model {
            slug,
            approve_paid,
            fast,
        } => model(client, session, slug, approve_paid, fast).await,
        Command::Fast(target) => fast_toggle(client, session, target).await,
        Command::SessionShow => session_show(session),
        Command::SessionList => session_list(client).await,
        Command::SessionSwitch(id) => session_switch(client, session, id).await,
        Command::Friction {
            severity,
            escaped,
            text,
        } => friction(client, prompter, session, &severity, escaped, &text).await,
        Command::IdeaMark(label) => idea_mark(client, session, &label).await,
        Command::IdeaList => idea_list(client, session).await,
    }
}

fn error_line(context: &str, err: &anyhow::Error) {
    eprintln!("{context}: {}", visible(&err.to_string()));
}

/// The model rows from `models/list`, or `None` after reporting why not.
async fn list_models(client: &Client) -> Option<Vec<Value>> {
    match client.request("models/list", json!({})).await {
        Ok(v) => Some(
            v.get("models")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        ),
        Err(err) => {
            error_line("could not list models", &err);
            None
        }
    }
}

fn str_field<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or("")
}

fn fast_capable(row: Option<&Value>) -> bool {
    row.and_then(|r| r.get("capabilities"))
        .and_then(Value::as_array)
        .is_some_and(|caps| caps.iter().any(|c| c.as_str() == Some("fast-speed")))
}

/// The model a turn would run on: the explicit choice, else the runtime's
/// default turn model from `runtime/status`.
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

fn find_row<'a>(rows: &'a [Value], slug: Option<&str>) -> Option<&'a Value> {
    slug.and_then(|s| rows.iter().find(|r| str_field(r, "slug") == s))
}

/// Answer approvals the runtime raises while `method` is in flight. A
/// `friction/post` write can need the operator's verdict before the runtime
/// answers, and nothing else reads the channel between turns.
async fn request_answering_approvals(
    client: &Client,
    prompter: Prompter<'_>,
    method: &str,
    params: Value,
) -> anyhow::Result<Value> {
    let pending = client.request(method, params);
    tokio::pin!(pending);
    loop {
        tokio::select! {
            outcome = &mut pending => return outcome,
            message = prompter.incoming.recv() => match message {
                Some(Incoming::Approval { params, respond }) => {
                    let verdict = approval::ask(prompter.input, &params).await;
                    let _ = respond.send(verdict);
                }
                // No turn is running, so a stray frame has nothing to render into.
                Some(Incoming::Stream(_)) => {}
                None => return (&mut pending).await,
            },
        }
    }
}

/// The posted friction context, normalised as the TypeScript client does:
/// the workspace reduced to its basename and the command clipped, so an
/// absolute path never leaves the machine.
fn friction_context(session: &Session, id: &str) -> Value {
    let mut context = json!({"sessionId": id});
    if let Some(model) = &session.last_model {
        context["model"] = json!(model);
    }
    if let Some(name) = session
        .workspace
        .as_deref()
        .and_then(|w| std::path::Path::new(w).file_name())
    {
        context["workspace"] = json!(name.to_string_lossy());
    }
    if let Some(command) = session.last_command.as_deref().filter(|c| c.starts_with('/')) {
        let clipped = if command.chars().count() <= FRICTION_COMMAND_MAX_CHARACTERS {
            command.to_string()
        } else {
            let mut head: String = command
                .chars()
                .take(FRICTION_COMMAND_MAX_CHARACTERS - 1)
                .collect();
            head.push('…');
            head
        };
        context["command"] = json!(clipped);
    }
    context
}

/// The selectable rows grouped by access modality, then the quarantined
/// (unpriced) rows in their own section so a pricing gap stays visible.
pub fn format_models(rows: &[Value]) -> Vec<String> {
    const ORDER: [&str; 5] = [
        "local",
        "frontier-hosted",
        "aggregator-hosted",
        "subscription-oauth",
        "custom-hosted",
    ];
    let width = rows
        .iter()
        .map(|r| str_field(r, "slug").len())
        .max()
        .unwrap_or(0);
    let render = |r: &Value| {
        let tier = r
            .get("tier")
            .and_then(Value::as_i64)
            .map_or("?".into(), |t| t.to_string());
        format!(
            "    {:width$} t{tier}  {}",
            visible(str_field(r, "slug")),
            visible(str_field(r, "displayName")),
        )
    };
    let routable = |r: &&Value| r.get("routable").and_then(Value::as_bool) != Some(false);
    let mut out = Vec::new();
    let mut groups: Vec<&str> = ORDER.to_vec();
    for r in rows.iter().filter(routable) {
        let m = str_field(r, "modality");
        if !groups.contains(&m) {
            groups.push(m);
        }
    }
    for group in groups {
        let members: Vec<&Value> = rows
            .iter()
            .filter(routable)
            .filter(|r| str_field(r, "modality") == group)
            .collect();
        if members.is_empty() {
            continue;
        }
        out.push(format!(
            "  {}:",
            if group.is_empty() {
                "(unclassified)"
            } else {
                group
            }
        ));
        out.extend(members.into_iter().map(render));
    }
    let quarantined: Vec<&Value> = rows.iter().filter(|r| !routable(r)).collect();
    if !quarantined.is_empty() {
        out.push(format!(
            "  unavailable, not selectable ({}):",
            quarantined.len()
        ));
        out.extend(
            quarantined
                .into_iter()
                .map(|r| format!("{}  [not routable: unpriced]", render(r))),
        );
    }
    if out.is_empty() {
        out.push("  (none)".into());
    }
    out
}

/// One line saying what the next turn will run on.
fn posture(session: &Session, rows: &[Value]) -> String {
    let mut parts = Vec::new();
    match &session.model {
        Some(slug) => {
            parts.push(visible(slug));
            if let Some(row) = rows.iter().find(|r| str_field(r, "slug") == slug) {
                if let Some(t) = row.get("tier").and_then(Value::as_i64) {
                    parts.push(format!("tier {t}"));
                }
                match row.get("local").and_then(Value::as_bool) {
                    Some(true) => parts.push("local".into()),
                    Some(false) => parts.push("hosted".into()),
                    None => {}
                }
            }
        }
        None => parts.push("runtime default model".into()),
    }
    if session.fast == Some(true) {
        parts.push("fast".into());
    }
    parts.push(if session.approve_paid {
        "paid approved for this session".into()
    } else {
        "paid per runtime posture".into()
    });
    format!("posture: {}", parts.join(" · "))
}

async fn model(
    client: &Client,
    session: &mut Session,
    slug: Option<String>,
    approve_paid: bool,
    fast: Option<bool>,
) {
    let Some(rows) = list_models(client).await else {
        return;
    };
    let target = match &slug {
        Some(s) => Some(s.clone()),
        None => active_slug(client, session).await,
    };
    let row = find_row(&rows, target.as_deref());
    if let Some(slug) = &slug {
        let Some(row) = row else {
            eprintln!(
                "unknown model \"{}\"; /model lists the available ones",
                visible(slug)
            );
            return;
        };
        // Fail at selection, not at the first turn: an unpriced model cannot
        // be routed, because its spend could not be bounded.
        if row.get("routable").and_then(Value::as_bool) == Some(false) {
            eprintln!("model \"{}\" is not routable: unpriced", visible(slug));
            return;
        }
    }
    if fast == Some(true) && !fast_capable(row) {
        eprintln!(
            "the fast speed tier is not supported by \"{}\"",
            visible(target.as_deref().unwrap_or("the runtime default"))
        );
        return;
    }
    if slug.is_none() && fast.is_none() && !approve_paid {
        eprintln!("available:");
        for line in format_models(&rows) {
            eprintln!("{line}");
        }
    }
    if let Some(slug) = slug {
        // A fast flag carried over to a model without it would be refused.
        if fast.is_none() && session.fast == Some(true) && !fast_capable(row) {
            session.fast = None;
            eprintln!(
                "fast speed tier turned off: {} does not support it",
                visible(&slug)
            );
        }
        session.model = Some(slug);
    }
    if let Some(f) = fast {
        session.fast = Some(f);
    }
    if approve_paid {
        session.approve_paid = true;
    }
    eprintln!("{}", posture(session, &rows));
}

async fn fast_toggle(client: &Client, session: &mut Session, target: Option<bool>) {
    let want = target.unwrap_or(session.fast != Some(true));
    let Some(rows) = list_models(client).await else {
        return;
    };
    if want {
        let active = active_slug(client, session).await;
        if !fast_capable(find_row(&rows, active.as_deref())) {
            eprintln!(
                "the fast speed tier is not supported by \"{}\"; pick another model with /model",
                visible(active.as_deref().unwrap_or("the runtime default"))
            );
            return;
        }
    }
    session.fast = Some(want);
    eprintln!("{}", posture(session, &rows));
}

fn session_show(session: &Session) {
    let Some(id) = &session.id else {
        eprintln!("no session yet; send a prompt first");
        return;
    };
    eprintln!("session: {}", visible(id));
    eprintln!(
        "turns here: {} · spend here: ${:.4}",
        session.turns, session.spend_usd
    );
    eprintln!("resume later with: dyfj-repl --session {}", visible(id));
}

async fn session_list(client: &Client) {
    let res = match client.request("sessions/list", json!({"limit": 15})).await {
        Ok(v) => v,
        Err(err) => return error_line("could not list sessions", &err),
    };
    let mut sessions: Vec<&Value> = res
        .get("projects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|p| p.get("sessions").and_then(Value::as_array))
        .flatten()
        .collect();
    let key = |s: &Value| {
        let updated = str_field(s, "updatedAt");
        if updated.is_empty() {
            str_field(s, "createdAt").to_string()
        } else {
            updated.to_string()
        }
    };
    sessions.sort_by_key(|s| std::cmp::Reverse(key(s)));
    sessions.truncate(15);
    if sessions.is_empty() {
        eprintln!("no sessions found");
        return;
    }
    eprintln!("recent sessions:");
    for s in sessions {
        let date: String = key(s).chars().take(10).collect();
        eprintln!(
            "  {}  {}  {}",
            visible(str_field(s, "sessionId")),
            visible(&date),
            visible(str_field(s, "taskDescription"))
        );
    }
    eprintln!("resume with: /session switch <id>");
}

async fn session_switch(client: &Client, session: &mut Session, id: String) {
    let mut workspace = None;
    match client
        .request("sessions/inspect", json!({"sessionId": id}))
        .await
    {
        Ok(v) => {
            if v.get("exists").and_then(Value::as_bool) == Some(false) {
                eprintln!("warning: the runtime has no session {}", visible(&id));
            }
            workspace = v
                .get("workspace")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        Err(err) => error_line("could not inspect the session", &err),
    }
    eprintln!("switched to session: {}", visible(&id));
    session.switch_to(id, workspace);
}

async fn friction(
    client: &Client,
    prompter: Prompter<'_>,
    session: &Session,
    severity: &str,
    escaped: bool,
    text: &str,
) {
    let Some(id) = &session.id else {
        eprintln!("no session yet; send a prompt first before posting friction");
        return;
    };
    let context = friction_context(session, id);
    let params =
        json!({"severity": severity, "escaped": escaped, "text": text, "context": context});
    match request_answering_approvals(client, prompter, "friction/post", params).await {
        Ok(v) => {
            eprintln!("{}", visible(str_field(&v, "firstLine")));
            eprintln!("comment id: {}", visible(str_field(&v, "commentId")));
        }
        Err(err) => error_line("friction capture failed", &err),
    }
}

async fn idea_mark(client: &Client, session: &Session, label: &str) {
    let Some(id) = &session.id else {
        eprintln!("no session yet; send a prompt first before marking ideas");
        return;
    };
    match client
        .request("ideas/mark", json!({"sessionId": id, "label": label}))
        .await
    {
        Ok(v) => {
            let idea = v.get("idea").unwrap_or(&Value::Null);
            eprintln!(
                "marked idea [{}]: \"{}\"",
                visible(str_field(idea, "ideaId")),
                visible(str_field(idea, "label"))
            );
        }
        Err(err) => error_line("could not mark the idea", &err),
    }
}

async fn idea_list(client: &Client, session: &Session) {
    let Some(id) = &session.id else {
        eprintln!("no session yet; send a prompt first");
        return;
    };
    match client.request("ideas/list", json!({"sessionId": id})).await {
        Ok(v) => {
            let ideas = v
                .get("ideas")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if ideas.is_empty() {
                eprintln!("no ideas marked in this session");
            }
            for idea in ideas {
                let date: String = str_field(&idea, "createdAt").chars().take(10).collect();
                eprintln!(
                    "  [{}] {} ({})",
                    visible(str_field(&idea, "ideaId")),
                    visible(str_field(&idea, "label")),
                    visible(&date)
                );
            }
        }
        Err(err) => error_line("could not list ideas", &err),
    }
}

#[cfg(test)]
mod tests {
    use super::{Command, format_models, friction_context, parse};
    use crate::session::Session;

    /// The posted context never carries an absolute path, and a long command
    /// is clipped as the TypeScript client clips it.
    #[test]
    fn friction_context_posts_the_workspace_basename_and_a_clipped_command() {
        let session = Session {
            workspace: Some("/work/projects/dyfj".into()),
            last_model: Some("z-ai/glm-5.2".into()),
            last_command: Some(format!("/idea mark {}", "x".repeat(200))),
            ..Session::default()
        };
        let context = friction_context(&session, "S1");
        assert_eq!(context["sessionId"], "S1");
        assert_eq!(context["model"], "z-ai/glm-5.2");
        assert_eq!(context["workspace"], "dyfj");
        let command = context["command"].as_str().unwrap();
        assert_eq!(command.chars().count(), 120);
        assert!(command.ends_with('…'));

        let bare = friction_context(&Session::default(), "S1");
        assert_eq!(bare, serde_json::json!({"sessionId": "S1"}));
    }
    use serde_json::json;

    #[test]
    fn prompts_are_not_commands() {
        assert_eq!(parse("explain /model"), None);
        assert_eq!(parse("/usr/bin/env is what?"), None);
        // A paste is one string; its first line is content, not a command.
        assert_eq!(parse("/model z-ai/glm-5.2\nand then prose"), None);
    }

    #[test]
    fn model_takes_a_slug_and_flags_in_any_order() {
        assert_eq!(
            parse("/model --approve-paid z-ai/glm-5.2 --fast"),
            Some(Command::Model {
                slug: Some("z-ai/glm-5.2".into()),
                approve_paid: true,
                fast: Some(true)
            })
        );
        assert_eq!(
            parse("/model"),
            Some(Command::Model {
                slug: None,
                approve_paid: false,
                fast: None
            })
        );
        assert!(matches!(
            parse("/model --fast --no-fast"),
            Some(Command::Usage(_))
        ));
        assert!(matches!(parse("/model a b"), Some(Command::Usage(_))));
    }

    #[test]
    fn fast_and_session_subcommands() {
        assert_eq!(parse("/fast"), Some(Command::Fast(None)));
        assert_eq!(parse("/fast off"), Some(Command::Fast(Some(false))));
        assert_eq!(parse("/session"), Some(Command::SessionShow));
        assert_eq!(parse("/session list"), Some(Command::SessionList));
        assert_eq!(
            parse("/session switch 01J9ZQ4W8X6V5T3R2P1N0M9K8H"),
            Some(Command::SessionSwitch("01J9ZQ4W8X6V5T3R2P1N0M9K8H".into()))
        );
        // I, L, O and U are not Crockford Base32.
        assert!(matches!(
            parse("/session switch 01J9ZQ4W8X6V5T3R2P1N0M9K8I"),
            Some(Command::Usage(_))
        ));
        assert!(matches!(
            parse("/session switch short"),
            Some(Command::Usage(_))
        ));
        // The slug `dyfj sessions` lists, in any case, resolves to the id.
        assert_eq!(
            parse("/session switch workbench-01j9zq4w8x6v5t3r2p1n0m9k8h"),
            Some(Command::SessionSwitch("01J9ZQ4W8X6V5T3R2P1N0M9K8H".into()))
        );
    }

    #[test]
    fn friction_needs_a_severity_and_text() {
        assert_eq!(
            parse("/friction major --escaped paste split into turns"),
            Some(Command::Friction {
                severity: "major".into(),
                escaped: true,
                text: "paste split into turns".into()
            })
        );
        // An unknown option is refused rather than posted as text.
        assert!(matches!(
            parse("/friction paper-cut --escapedness is not a flag"),
            Some(Command::Usage(_))
        ));
        assert!(matches!(
            parse("/friction huge it broke"),
            Some(Command::Usage(_))
        ));
        assert!(matches!(parse("/friction minor"), Some(Command::Usage(_))));
        assert!(matches!(
            parse("/friction minor --escaped"),
            Some(Command::Usage(_))
        ));
    }

    #[test]
    fn idea_mark_takes_the_rest_as_its_label() {
        assert_eq!(
            parse("/idea mark \"cache tokens on the turn line\""),
            Some(Command::IdeaMark("cache tokens on the turn line".into()))
        );
        assert_eq!(
            parse("/idea mark -- -leading dash"),
            Some(Command::IdeaMark("-leading dash".into()))
        );
        assert_eq!(parse("/idea list"), Some(Command::IdeaList));
        assert!(matches!(parse("/idea mark"), Some(Command::Usage(_))));
    }

    #[test]
    fn models_group_by_modality_and_quarantine_unpriced_rows() {
        let rows = vec![
            json!({"slug": "z-ai/glm-5.2", "displayName": "GLM 5.2", "tier": 1, "modality": "aggregator-hosted", "routable": true}),
            json!({"slug": "gemma4", "displayName": "Gemma 4", "tier": 0, "modality": "local", "routable": true}),
            json!({"slug": "router-unpriced", "displayName": "X", "tier": 1, "modality": "aggregator-hosted", "routable": false}),
        ];
        let lines = format_models(&rows);
        let local = lines.iter().position(|l| l == "  local:").unwrap();
        let agg = lines
            .iter()
            .position(|l| l == "  aggregator-hosted:")
            .unwrap();
        let quarantine = lines
            .iter()
            .position(|l| l.starts_with("  unavailable"))
            .unwrap();
        assert!(local < agg && agg < quarantine, "{lines:#?}");
        let selectable = lines[..quarantine].join("\n");
        assert!(!selectable.contains("router-unpriced"), "{selectable}");
        assert!(lines[quarantine + 1].contains("router-unpriced"));
        assert!(lines[quarantine + 1].ends_with("[not routable: unpriced]"));
    }
}

/// The command paths driven end to end against a fake runtime on the other
/// end of a socket pair: the requests each command sends, the approvals it
/// answers, and what it changes on the session.
#[cfg(test)]
mod run_tests {
    use super::{Command, Prompter, run};
    use crate::client::{Client, Incoming};
    use crate::session::Session;
    use crate::terminal::{Ask, ReadOutcome};
    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;
    use tokio::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use tokio::task::JoinHandle;

    type Answer = fn(&str, &Value) -> Value;
    type Log = Arc<Mutex<Vec<Value>>>;

    /// A runtime that answers every request with `answer(method, params)`.
    /// Before answering `friction/post` it asks the client for an approval,
    /// as a Linear write can. Every request and approval answer it sees is
    /// logged, in order. The client's reader task keeps the socket open, so the
    /// test reads the log and aborts the server instead of waiting for EOF.
    fn fake_runtime(answer: Answer) -> (Client, mpsc::Receiver<Incoming>, Log, JoinHandle<()>) {
        let (client_side, server_side) = UnixStream::pair().unwrap();
        let (client, incoming) = Client::over(client_side);
        let log = Log::default();
        let seen = Arc::clone(&log);
        let server = tokio::spawn(async move {
            let (read, mut write) = server_side.into_split();
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let msg: Value = serde_json::from_str(&line).unwrap();
                let method = msg["method"].as_str().unwrap_or("").to_string();
                seen.lock().unwrap().push(msg.clone());
                if method == "friction/post" {
                    let ask = json!({"jsonrpc": "2.0", "id": "a1", "method": "approval",
                        "params": {"commandId": "linear", "title": "Post a Linear comment"}});
                    write.write_all(format!("{ask}\n").as_bytes()).await.unwrap();
                    let verdict = lines.next_line().await.unwrap().unwrap();
                    seen.lock().unwrap().push(serde_json::from_str(&verdict).unwrap());
                }
                let reply = json!({"jsonrpc": "2.0", "id": msg["id"],
                    "result": answer(&method, &msg["params"])});
                write.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
            }
        });
        (client, incoming, log, server)
    }

    /// A terminal that answers every question with `line`.
    fn terminal(line: &'static str) -> mpsc::Sender<Ask> {
        let (tx, mut rx) = mpsc::channel::<Ask>(4);
        tokio::spawn(async move {
            while let Some(ask) = rx.recv().await {
                let (Ask::Prompt { respond } | Ask::Approval { respond, .. }) = ask;
                let _ = respond.send(ReadOutcome::Line(line.into()));
            }
        });
        tx
    }

    async fn drive(answer: Answer, session: &mut Session, commands: Vec<Command>) -> Vec<Value> {
        let (client, mut incoming, log, server) = fake_runtime(answer);
        let input = terminal("y");
        for command in commands {
            let prompter = Prompter { input: &input, incoming: &mut incoming };
            run(command, &client, session, prompter).await;
        }
        server.abort();
        drop(client);
        log.lock().unwrap().clone()
    }

    fn methods(seen: &[Value]) -> Vec<&str> {
        seen.iter().filter_map(|m| m["method"].as_str()).collect()
    }

    fn catalog(method: &str, _: &Value) -> Value {
        match method {
            "models/list" => json!({"models": [
                {"slug": "local/qwen", "tier": 0, "local": true, "modality": "local"},
                {"slug": "z-ai/glm-5.2", "tier": 2, "local": false,
                 "modality": "aggregator-hosted", "capabilities": ["fast-speed"]},
                {"slug": "unpriced/x", "routable": false, "modality": "aggregator-hosted"}
            ]}),
            "runtime/status" => json!({"runtime": {"defaultTurnModel": {"slug": "z-ai/glm-5.2"}}}),
            "sessions/inspect" => json!({"exists": true, "workspace": "/work/projects/dyfj"}),
            "friction/post" => json!({"firstLine": "friction posted", "commentId": "c1"}),
            "ideas/mark" => json!({"idea": {"ideaId": "i1", "label": "x"}}),
            _ => json!({}),
        }
    }

    fn model(slug: &str) -> Command {
        Command::Model { slug: Some(slug.into()), approve_paid: false, fast: None }
    }

    #[tokio::test]
    async fn model_switches_only_to_a_known_routable_model() {
        let mut session = Session::default();
        drive(catalog, &mut session, vec![model("nope"), model("unpriced/x")]).await;
        assert_eq!(session.model, None, "unknown and unpriced models are refused");

        let seen = drive(catalog, &mut session, vec![model("local/qwen")]).await;
        assert_eq!(methods(&seen), ["models/list"]);
        assert_eq!(session.model.as_deref(), Some("local/qwen"));
    }

    /// With no explicit model, `/fast on` checks the runtime's default turn
    /// model, which here is fast-capable.
    #[tokio::test]
    async fn fast_checks_the_runtime_default_when_no_model_is_chosen() {
        let mut session = Session::default();
        let seen = drive(catalog, &mut session, vec![Command::Fast(Some(true))]).await;
        assert_eq!(methods(&seen), ["models/list", "runtime/status"]);
        assert_eq!(session.fast, Some(true));

        let mut local = Session { model: Some("local/qwen".into()), ..Session::default() };
        drive(catalog, &mut local, vec![Command::Fast(Some(true))]).await;
        assert_eq!(local.fast, None, "a model without the tier is refused");
    }

    #[tokio::test]
    async fn session_switch_adopts_the_rows_workspace() {
        let mut session = Session::default();
        let id = "01J9ZQ4W8X6V5T3R2P1N0M9K8H";
        let seen = drive(catalog, &mut session, vec![Command::SessionSwitch(id.into())]).await;
        assert_eq!(seen[0]["params"], json!({"sessionId": id}));
        assert_eq!(session.id.as_deref(), Some(id));
        assert_eq!(session.workspace.as_deref(), Some("/work/projects/dyfj"));
    }

    /// The runtime asks for approval while `friction/post` is in flight; the
    /// command answers it from the terminal instead of deadlocking.
    #[tokio::test]
    async fn friction_answers_the_approval_raised_mid_request() {
        let friction = || Command::Friction {
            severity: "minor".into(),
            escaped: true,
            text: "paste lost".into(),
        };
        let mut fresh = Session::default();
        let seen = drive(catalog, &mut fresh, vec![friction()]).await;
        assert!(seen.is_empty(), "nothing is posted before a session exists");

        let mut session = Session {
            id: Some("S1".into()),
            workspace: Some("/work/projects/dyfj".into()),
            last_command: Some("/model local/qwen".into()),
            ..Session::default()
        };
        let seen = drive(catalog, &mut session, vec![friction()]).await;
        assert_eq!(seen.len(), 2, "{seen:?}");
        let params = &seen[0]["params"];
        assert_eq!(params["severity"], "minor");
        assert_eq!(params["escaped"], true);
        assert_eq!(
            params["context"],
            json!({"sessionId": "S1", "workspace": "dyfj", "command": "/model local/qwen"})
        );
        assert_eq!(seen[1]["id"], "a1");
        assert_eq!(seen[1]["result"]["decision"], "approve");
    }

    #[tokio::test]
    async fn idea_mark_posts_the_label_against_the_session() {
        let mut session = Session { id: Some("S1".into()), ..Session::default() };
        let seen = drive(catalog, &mut session, vec![Command::IdeaMark("x".into())]).await;
        assert_eq!(methods(&seen), ["ideas/mark"]);
        assert_eq!(seen[0]["params"], json!({"sessionId": "S1", "label": "x"}));
    }
}
