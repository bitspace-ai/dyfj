//! The session's spend limits (BIT-785): `--budget-turn`, `--budget-session`,
//! `--budget-day`, `--budget-per-call` and `--budget-runaway` at launch, and
//! `/budget` in the REPL. A limit the session sets rides every turn as the
//! request's `budget` override; the others are the runtime's configured
//! defaults, read from `runtime/status`.

use serde_json::{Map, Value};

/// The runtime refuses a limit above this (a fat-finger guard).
pub const MAX_BUDGET_USD: f64 = 1000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limit {
    Turn,
    Session,
    Day,
    PerCall,
    Runaway,
}

const LIMITS: [Limit; 5] = [Limit::Turn, Limit::Session, Limit::Day, Limit::PerCall, Limit::Runaway];

impl Limit {
    /// The launch flag that sets this limit.
    pub fn from_flag(flag: &str) -> Option<Limit> {
        LIMITS.into_iter().find(|limit| limit.flag() == flag)
    }

    /// The `/budget` word that names this limit.
    pub fn from_word(word: &str) -> Option<Limit> {
        LIMITS.into_iter().find(|limit| limit.word() == word)
    }

    pub fn flag(self) -> &'static str {
        match self {
            Limit::Turn => "--budget-turn",
            Limit::Session => "--budget-session",
            Limit::Day => "--budget-day",
            Limit::PerCall => "--budget-per-call",
            Limit::Runaway => "--budget-runaway",
        }
    }

    fn word(self) -> &'static str {
        match self {
            Limit::Turn => "turn",
            Limit::Session => "session",
            Limit::Day => "day",
            Limit::PerCall => "per-call",
            Limit::Runaway => "runaway",
        }
    }

    /// The field in the turn request's `budget` override.
    fn wire(self) -> &'static str {
        match self {
            Limit::Turn => "turnLimitUsd",
            Limit::Session => "sessionLimitUsd",
            Limit::Day => "dailyLimitUsd",
            Limit::PerCall => "perCallLimitUsd",
            Limit::Runaway => "runawayStallUsd",
        }
    }

    /// The runtime's configured default, in `runtime/status`.
    fn status_field(self) -> &'static str {
        match self {
            Limit::Turn => "defaultTurnBudgetUsd",
            Limit::Session => "defaultSessionBudgetUsd",
            Limit::Day => "defaultDailyBudgetUsd",
            Limit::PerCall => "defaultPerCallBudgetUsd",
            Limit::Runaway => "defaultRunawayStallUsd",
        }
    }
}

/// A positive dollar amount no larger than `MAX_BUDGET_USD`, with or without
/// a leading `$`.
pub fn parse_usd(raw: &str) -> Option<f64> {
    let value: f64 = raw.trim().trim_start_matches('$').parse().ok()?;
    (value.is_finite() && value > 0.0 && value <= MAX_BUDGET_USD).then_some(value)
}

/// The usage line for a malformed limit.
pub fn usage() -> String {
    format!("usage: /budget [turn|session|day|per-call|runaway <usd>], with <usd> above 0 and at most {MAX_BUDGET_USD}")
}

/// The limits this session set for itself; an unset one is the runtime's.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct SessionBudget {
    turn: Option<f64>,
    session: Option<f64>,
    day: Option<f64>,
    per_call: Option<f64>,
    runaway: Option<f64>,
}

impl SessionBudget {
    fn slot(&mut self, limit: Limit) -> &mut Option<f64> {
        match limit {
            Limit::Turn => &mut self.turn,
            Limit::Session => &mut self.session,
            Limit::Day => &mut self.day,
            Limit::PerCall => &mut self.per_call,
            Limit::Runaway => &mut self.runaway,
        }
    }

    pub fn get(&self, limit: Limit) -> Option<f64> {
        match limit {
            Limit::Turn => self.turn,
            Limit::Session => self.session,
            Limit::Day => self.day,
            Limit::PerCall => self.per_call,
            Limit::Runaway => self.runaway,
        }
    }

    pub fn set(&mut self, limit: Limit, usd: f64) {
        *self.slot(limit) = Some(usd);
    }

    /// The turn request's `budget` override, or `None` when the session set
    /// no limit of its own.
    pub fn override_body(&self) -> Option<Value> {
        let mut out = Map::new();
        for limit in LIMITS {
            if let Some(usd) = self.get(limit) {
                out.insert(limit.wire().into(), Value::from(usd));
            }
        }
        (!out.is_empty()).then_some(Value::Object(out))
    }
}

/// The one budget line every surface prints, the same text the TypeScript
/// REPL prints (`prototype/src/cli/budget.ts`): the session's own limits,
/// else the runtime's. `None` when neither names any (an older runtime).
pub fn line(status: &Value, budget: &SessionBudget) -> Option<String> {
    let runtime = status.get("runtime").unwrap_or(status);
    let figure = |limit: Limit| {
        budget
            .get(limit)
            .or_else(|| runtime.get(limit.status_field()).and_then(Value::as_f64))
    };
    if LIMITS.iter().all(|limit| figure(*limit).is_none()) {
        return None;
    }
    let usd = |limit: Limit| figure(limit).map_or("unknown".to_string(), |v| format!("${v:.2}"));
    Some(format!(
        "budget: turn {} · session {} · today {} · per call {} · runaway {} without tool progress",
        usd(Limit::Turn),
        usd(Limit::Session),
        usd(Limit::Day),
        usd(Limit::PerCall),
        usd(Limit::Runaway),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn defaults() -> Value {
        json!({"runtime": {
            "defaultTurnBudgetUsd": 4.0,
            "defaultSessionBudgetUsd": 10.0,
            "defaultDailyBudgetUsd": 25.0,
            "defaultPerCallBudgetUsd": 0.5,
            "defaultRunawayStallUsd": 0.5,
        }})
    }

    #[test]
    fn the_line_shows_the_runtimes_limits_as_the_typescript_repl_does() {
        assert_eq!(
            line(&defaults(), &SessionBudget::default()).as_deref(),
            Some("budget: turn $4.00 · session $10.00 · today $25.00 · per call $0.50 · runaway $0.50 without tool progress")
        );
    }

    #[test]
    fn a_limit_the_session_set_replaces_the_runtimes_and_rides_the_turn() {
        let mut budget = SessionBudget::default();
        budget.set(Limit::Turn, 6.0);
        assert!(line(&defaults(), &budget).unwrap().starts_with("budget: turn $6.00 · session $10.00"));
        assert_eq!(budget.override_body(), Some(json!({"turnLimitUsd": 6.0})));
        assert_eq!(SessionBudget::default().override_body(), None);
    }

    #[test]
    fn an_older_runtime_with_no_figures_prints_no_line() {
        assert_eq!(line(&json!({"runtime": {}}), &SessionBudget::default()), None);
    }

    #[test]
    fn amounts_must_be_positive_and_within_the_guard() {
        assert_eq!(parse_usd("6"), Some(6.0));
        assert_eq!(parse_usd("$0.75"), Some(0.75));
        for bad in ["0", "-1", "1001", "lots", "", "NaN", "inf"] {
            assert_eq!(parse_usd(bad), None, "{bad}");
        }
    }

    #[test]
    fn flags_and_words_name_each_limit() {
        assert_eq!(Limit::from_flag("--budget-per-call"), Some(Limit::PerCall));
        assert_eq!(Limit::from_flag("--budget-week"), None);
        assert_eq!(Limit::from_word("runaway"), Some(Limit::Runaway));
        assert_eq!(Limit::from_word("per_call"), None);
    }
}
