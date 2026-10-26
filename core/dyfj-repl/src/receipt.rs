//! The per-turn receipt line.
//!
//! Cost visibility is part of the product's done-line, so every turn ends
//! with what it cost, what the session has cost so far (the runtime's figure,
//! the one its spending envelope checks), and how many tokens it used. The layout follows `formatReceipt` in the TypeScript CLI
//! (`prototype/src/cli/render/receipt.ts`) so the two front-ends read alike.
//! Every field is optional: a receipt missing one costs a narrower line.
//!
//! The same turn result carries a `receipt` string. A skipped event write is
//! reported there as its own `WARNING:` line, beside the answer `text`.
//! `safety_warnings` returns those lines; the cost line above does not.

use crate::approval::visible;
use serde_json::Value;

fn usd(amount: f64) -> String {
    if amount > 0.0 {
        format!("${amount:.4}")
    } else {
        "$0".into()
    }
}

/// Group digits by thousands, as the TypeScript line's `Intl.NumberFormat` does.
fn count(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn tokens(receipt: &Value, key: &str) -> u64 {
    receipt
        .pointer(&format!("/tokens/{key}"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

/// Render the receipt line for a completed turn. `repl_total` is the REPL's
/// running spend including this turn, shown only when the runtime sends no
/// session figure of its own.
pub fn line(receipt: &Value, repl_total: f64) -> String {
    if receipt.get("runner").is_some() {
        // External-agent receipts carry their own cost semantics. That route
        // is deferred for the daily driver, so this front-end names it rather
        // than rendering half of it.
        let profile = receipt
            .pointer("/runner/profile")
            .and_then(Value::as_str)
            .unwrap_or("external runner");
        return format!("— {} · external runner receipt", visible(profile));
    }

    let mut parts: Vec<String> = Vec::new();
    let model = receipt
        .pointer("/model/displayName")
        .or_else(|| receipt.pointer("/model/slug"))
        .and_then(Value::as_str)
        .unwrap_or("unknown model");
    parts.push(visible(model));

    let cost = receipt
        .pointer("/cost/totalUsd")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    // A catalog estimate is marked `~`; a billed cost, a free turn and a
    // runtime that reports no basis are not.
    let estimated = cost > 0.0
        && receipt.pointer("/cost/basis").and_then(Value::as_str) == Some("catalog_estimate");
    let mark = if estimated { "~" } else { "" };
    // The runtime's session figure is the one its spending envelope checks,
    // and it counts turns this REPL never saw complete. Only a runtime that
    // sends none falls back to this REPL's own sum, labelled as such.
    match receipt
        .pointer("/cost/sessionUsd")
        .and_then(Value::as_f64)
        .filter(|usd| usd.is_finite())
    {
        Some(session) => parts.push(format!("{mark}{} · session {}", usd(cost), usd(session))),
        None => parts.push(format!("{mark}{} · repl total {}", usd(cost), usd(repl_total))),
    }

    let mut token_line = format!(
        "{}→{} tok",
        count(tokens(receipt, "input")),
        count(tokens(receipt, "output"))
    );
    let reasoning = tokens(receipt, "reasoning");
    if reasoning > 0 {
        token_line.push_str(&format!(" (+{} reasoning)", count(reasoning)));
    }
    parts.push(token_line);
    // `input` excludes cache traffic, so the cached share is shown beside it.
    let (read, write) = (tokens(receipt, "cacheRead"), tokens(receipt, "cacheWrite"));
    if read > 0 || write > 0 {
        let mut cache = format!("cache {} read", count(read));
        if write > 0 {
            cache.push_str(&format!(", {} write", count(write)));
        }
        parts.push(cache);
        parts.push(format!("cached {}%", cached_percent(tokens(receipt, "input"), read, write)));
    }

    if let (Some(used), Some(max)) = (
        receipt
            .pointer("/agent/toolStepsUsed")
            .and_then(Value::as_u64),
        receipt
            .pointer("/agent/maxToolSteps")
            .and_then(Value::as_u64),
    ) {
        let limit = receipt
            .pointer("/agent/limitReached")
            .and_then(Value::as_bool)
            == Some(true);
        let handoff = receipt.pointer("/agent/handoff").and_then(Value::as_str);
        parts.push(format!(
            "tools {used}/{max}{}",
            match (limit, handoff) {
                (false, _) => "",
                (true, Some("model")) => " (limit reached · handoff)",
                (true, Some("notice")) => " (limit reached · handoff failed)",
                (true, _) => " (limit reached)",
            }
        ));
    }
    // Calls that ran without a prompt: the read-only allowlist and the
    // operator's "allow for the rest of the session" grants.
    let allowlist = receipt
        .pointer("/agent/autoApprovals/allowlist")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let session_grant = receipt
        .pointer("/agent/autoApprovals/sessionGrant")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if allowlist + session_grant > 0 {
        parts.push(format!(
            "auto-approved {} (allowlist {allowlist}, session {session_grant})",
            allowlist + session_grant
        ));
    }
    if receipt.get("historyOmission").is_some_and(|v| !v.is_null()) {
        parts.push("history omitted (see TypeScript receipt)".into());
    }
    if let Some(reason) = receipt.pointer("/route/reason").and_then(Value::as_str) {
        parts.push(visible(reason));
    }
    format!("— {}", parts.join(" · "))
}

/// The share of the turn's input served from cache, in whole percent, rounded
/// as the TypeScript line's `Math.round` rounds.
fn cached_percent(input: u64, read: u64, write: u64) -> u64 {
    let prompt = input + read + write;
    if prompt == 0 {
        return 0;
    }
    (read as f64 / prompt as f64 * 100.0 + 0.5).floor() as u64
}

/// `/receipt steps`: one line per recorded agent-loop provider call of the last turn,
/// in call order, as `formatStepLines` in the TypeScript CLI prints them.
pub fn step_lines(steps: &[Value]) -> Vec<String> {
    let field = |step: &Value, key: &str| step.get(key).and_then(Value::as_u64).unwrap_or(0);
    steps
        .iter()
        .map(|step| {
            let purpose = step.get("purpose").and_then(Value::as_str).unwrap_or("call");
            format!(
                "  #{} {} · {} in · {} read · {} write · {} out · {}",
                field(step, "order"),
                visible(purpose),
                count(field(step, "input")),
                count(field(step, "cacheRead")),
                count(field(step, "cacheWrite")),
                count(field(step, "output")),
                usd(step.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0)),
            )
        })
        .collect()
}

/// Safety-warning lines from the turn result's `receipt` string.
///
/// The runtime writes a skipped-event-write warning into that string. It is
/// not a separate field, and it is not part of `text`. Each line that begins
/// with `WARNING:` is returned, sanitized the same way other single-line
/// runtime strings are. A result with no such line returns nothing.
pub fn safety_warnings(result: &Value) -> Vec<String> {
    let Some(text) = result.get("receipt").and_then(Value::as_str) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            line.starts_with("WARNING:").then(|| visible(line))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{count, line, safety_warnings, step_lines};
    use serde_json::json;

    fn receipt() -> serde_json::Value {
        json!({
            "model": {"slug": "z-ai/glm-5.2", "displayName": "GLM 5.2"},
            "cost": {"totalUsd": 0.0123, "sessionUsd": 0.0456},
            "tokens": {"input": 1200, "output": 50, "cacheRead": 0, "cacheWrite": 0, "totalCalls": 1},
            "agent": {"toolStepsUsed": 2, "maxToolSteps": 32, "limitReached": false},
            "route": {"reason": "explicit_model_id"}
        })
    }

    #[test]
    fn names_model_cost_session_tokens_tools_and_route() {
        assert_eq!(
            line(&receipt(), 0.0456),
            "— GLM 5.2 · $0.0123 · session $0.0456 · 1,200→50 tok · tools 2/32 · explicit_model_id"
        );
    }

    #[test]
    fn says_how_a_reached_limit_left_its_handoff() {
        let mut r = receipt();
        r["agent"] = json!({"toolStepsUsed": 2, "maxToolSteps": 2, "limitReached": true, "handoff": "model"});
        assert!(line(&r, 0.0).contains("tools 2/2 (limit reached · handoff)"));
        r["agent"]["handoff"] = json!("notice");
        assert!(line(&r, 0.0).contains("tools 2/2 (limit reached · handoff failed)"));
        r["agent"].as_object_mut().unwrap().remove("handoff");
        assert!(line(&r, 0.0).contains("tools 2/2 (limit reached) ·"));
    }

    /// BIT-707: calls that ran without a prompt are counted beside the tools.
    #[test]
    fn counts_auto_approved_calls_when_there_were_any() {
        let mut r = receipt();
        r["agent"]["autoApprovals"] = json!({"allowlist": 2, "sessionGrant": 1});
        assert_eq!(
            line(&r, 0.0456),
            "— GLM 5.2 · $0.0123 · session $0.0456 · 1,200→50 tok · tools 2/32 · auto-approved 3 (allowlist 2, session 1) · explicit_model_id"
        );
        r["agent"]["autoApprovals"] = json!({"allowlist": 0, "sessionGrant": 0});
        assert!(!line(&r, 0.0456).contains("auto-approved"));
    }

    /// The session figure is the runtime's, the one its spending envelope
    /// checks: it counts turns this REPL never saw complete (a halted turn,
    /// a turn before a resume). The REPL's own running sum does not.
    #[test]
    fn the_session_figure_is_the_runtimes_not_the_repls() {
        let mut r = receipt();
        r["cost"]["sessionUsd"] = json!(3.21);
        assert!(
            line(&r, 1.0404).contains("$0.0123 · session $3.2100 ·"),
            "{}",
            line(&r, 1.0404)
        );
    }

    /// BIT-698's estimate mark and the runtime's session figure render together.
    #[test]
    fn an_estimated_turn_marks_its_cost_beside_the_session_figure() {
        let mut r = receipt();
        r["cost"]["basis"] = json!("catalog_estimate");
        r["cost"]["sessionUsd"] = json!(3.21);
        assert!(
            line(&r, 1.0404).contains("~$0.0123 · session $3.2100 ·"),
            "{}",
            line(&r, 1.0404)
        );
    }

    /// A runtime that sends no session figure gets the REPL's own sum, and
    /// the line says that is what it is.
    #[test]
    fn without_a_runtime_figure_the_repl_total_is_labelled() {
        let mut r = receipt();
        r["cost"]
            .as_object_mut()
            .expect("cost")
            .remove("sessionUsd");
        assert!(
            line(&r, 1.0404).contains("$0.0123 · repl total $1.0404 ·"),
            "{}",
            line(&r, 1.0404)
        );
    }

    #[test]
    fn shows_cache_and_reasoning_only_when_reported() {
        let mut r = receipt();
        r["tokens"]["cacheRead"] = json!(9000);
        r["tokens"]["cacheWrite"] = json!(100);
        r["tokens"]["reasoning"] = json!(7);
        let rendered = line(&r, 0.0123);
        assert!(
            rendered.contains("1,200→50 tok (+7 reasoning) · cache 9,000 read, 100 write"),
            "{rendered}"
        );
        assert!(!line(&receipt(), 0.0).contains("cache"));
        assert!(!line(&receipt(), 0.0).contains("reasoning"));
    }

    #[test]
    fn a_free_turn_reads_zero_dollars() {
        let mut r = receipt();
        r["cost"]["totalUsd"] = json!(0);
        r["cost"]["sessionUsd"] = json!(0);
        assert!(line(&r, 0.0).contains("$0 · session $0"));
    }

    #[test]
    fn an_estimated_cost_is_marked_and_a_billed_one_is_not() {
        let mut r = receipt();
        r["cost"]["basis"] = json!("catalog_estimate");
        assert!(line(&r, 0.0456).contains("~$0.0123 · session $0.0456"));
        r["cost"]["basis"] = json!("provider_billed");
        assert!(line(&r, 0.0456).contains("— GLM 5.2 · $0.0123 · session"));
        r["cost"]["basis"] = json!("catalog_estimate");
        r["cost"]["totalUsd"] = json!(0);
        assert!(line(&r, 0.0).contains("· $0 · session $0"));
    }

    #[test]
    fn a_reached_step_limit_is_named() {
        let mut r = receipt();
        r["agent"]["limitReached"] = json!(true);
        assert!(line(&r, 0.0).contains("tools 2/32 (limit reached)"));
    }

    #[test]
    fn runtime_strings_are_sanitised() {
        let mut r = receipt();
        r["model"]["displayName"] = json!("evil\u{1b}[2J");
        assert!(!line(&r, 0.0).contains('\u{1b}'));
    }

    #[test]
    fn a_sparse_receipt_still_renders() {
        assert_eq!(
            line(&json!({}), 0.0),
            "— unknown model · $0 · repl total $0 · 0→0 tok"
        );
    }

    /// The warning lives in the receipt string, not in the answer, and a
    /// line that merely contains the word is not one.
    #[test]
    fn safety_warnings_are_the_receipt_lines_that_begin_with_warning() {
        let warning = "WARNING: 2 event write(s) failed \u{2014} the session's audit log has gaps";
        let hostile = "WARNING: 1 event write(s) failed \u{2014} \u{1b}[2Jwiped";
        let result = json!({
            "text": "WARNING: this is the answer, not a receipt warning",
            "receipt": format!(
                "Workbench receipt\nSession: x\n- notes/WARNING: not a warning\n{warning}\n{hostile}\n"
            ),
        });
        let warnings = safety_warnings(&result);
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert_eq!(warnings[0], warning);
        assert!(
            !warnings[1].contains('\u{1b}'),
            "escape survived: {:?}",
            warnings[1]
        );
        assert!(
            warnings[1].contains("wiped"),
            "text must not be dropped: {:?}",
            warnings[1]
        );
        assert!(warnings[1].starts_with("WARNING:"), "{:?}", warnings[1]);

        assert!(safety_warnings(&json!({"receipt": "Workbench receipt\nSession: x\n"})).is_empty());
        assert!(safety_warnings(&json!({})).is_empty());
        assert!(safety_warnings(&json!({"receipt": 3})).is_empty());
    }

    #[test]
    fn counts_group_by_thousands() {
        assert_eq!(count(0), "0");
        assert_eq!(count(999), "999");
        assert_eq!(count(1000), "1,000");
        assert_eq!(count(1234567), "1,234,567");
    }

    /// BIT-717: the share of input served from cache, as the TypeScript
    /// line shows it.
    #[test]
    fn the_cache_segment_shows_the_cached_share() {
        let mut r = receipt();
        r["tokens"]["input"] = json!(1000);
        r["tokens"]["cacheRead"] = json!(8800);
        r["tokens"]["cacheWrite"] = json!(200);
        assert!(
            line(&r, 0.0).contains("cache 8,800 read, 200 write · cached 88% ·"),
            "{}",
            line(&r, 0.0)
        );
    }

    /// The same lines `formatStepLines` prints for the same steps.
    #[test]
    fn step_lines_match_the_typescript_layout() {
        let steps = vec![
            json!({"order": 1, "purpose": "initial", "input": 312, "cacheRead": 0,
                   "cacheWrite": 22021, "output": 203, "costUsd": 0.0634}),
            json!({"order": 2, "purpose": "tool_followup", "input": 1204, "cacheRead": 22333,
                   "cacheWrite": 7661, "output": 270, "costUsd": 0}),
        ];
        assert_eq!(
            step_lines(&steps),
            vec![
                "  #1 initial · 312 in · 0 read · 22,021 write · 203 out · $0.0634",
                "  #2 tool_followup · 1,204 in · 22,333 read · 7,661 write · 270 out · $0",
            ]
        );
    }
}
