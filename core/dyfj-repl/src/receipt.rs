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
    if let Some(runner) = receipt.get("runner") {
        return runner_line(receipt, runner);
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

/// External-agent accounting stays separate from native USD and token totals.
/// Missing or malformed numeric fields never become invented zeroes.
fn runner_line(receipt: &Value, runner: &Value) -> String {
    let text = |path: &str| runner.pointer(path).and_then(Value::as_str);
    let number = |path: &str| runner.pointer(path).and_then(Value::as_u64);
    let mut parts = vec![visible(
        text("/modelSlug").or_else(|| text("/profile")).unwrap_or("external runner"),
    )];
    let reported_cost = runner.pointer("/sessionCost/amount")
        .and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0)
        .zip(text("/sessionCost/currency"));
    parts.push(match reported_cost {
        Some((amount, "USD")) => format!("session cost {}", usd(amount)),
        Some((amount, currency)) => format!("session cost {amount} {}", visible(currency)),
        None => match text("/costBasis") {
            Some("local_free") => "$0".into(),
            Some("subscription_quota") => "subscription quota (USD not reported)".into(),
            Some("metered_usd") => "USD not reported".into(),
            _ => "cost unknown".into(),
        },
    });
    if let (Some(input), Some(output)) = (number("/usage/input"), number("/usage/output")) {
        let mut usage = format!("{}→{} tok", count(input), count(output));
        if let Some(reasoning) = number("/usage/reasoning").filter(|n| *n > 0) {
            usage.push_str(&format!(" (+{} reasoning)", count(reasoning)));
        }
        usage.push_str(" (agent-reported)");
        parts.push(usage);
    }
    if let (Some(used), Some(size)) = (number("/contextWindow/used"), number("/contextWindow/size")) {
        parts.push(format!("ctx {}/{}", count(used), count(size)));
    }
    let state = text("/continuity/state");
    let mut continuity = state.map(|s| format!("continuity {}", visible(s)))
        .unwrap_or_else(|| "continuity unestablished".into());
    if state == Some("reconstructed") {
        match (number("/continuity/priorMessagesProjected"), number("/continuity/toolExchangesProjected")) {
            (Some(messages), Some(tools)) => continuity.push_str(&format!(" {messages}msg/{tools}tool")),
            (Some(messages), None) => continuity.push_str(&format!(" {messages}msg")),
            (None, Some(tools)) => continuity.push_str(&format!(" {tools}tool")),
            _ => {}
        }
        if let Some(left_out) = number("/continuity/priorMessagesLeftOut").filter(|n| *n > 0) {
            continuity.push_str(&format!(" (shortened, {left_out} left out)"));
        }
    }
    parts.push(continuity);
    parts.push(match state {
        Some("new") => "native session new",
        Some("warm-reused" | "durably-resumed") => "native session reused",
        Some("reconstructed") => "native session replaced",
        _ => "native session unverified",
    }.into());
    let tools = match (text("/toolEvidence/status"), number("/toolEvidence/observedCalls")) {
        (Some("unavailable"), Some(observed)) => Some(format!("ACP tools unavailable ({observed} observed)")),
        (Some("complete" | "partial"), Some(observed)) => number("/toolEvidence/recordedCalls").and_then(|recorded| {
            let prefix = format!("ACP tools {recorded}/{observed} recorded");
            if text("/toolEvidence/status") == Some("partial") {
                number("/toolEvidence/partialCalls").zip(number("/toolEvidence/rejectedCalls"))
                    .map(|(partial, rejected)| format!("{prefix} ({partial} partial, {rejected} rejected)"))
            } else {
                Some(prefix)
            }
        }),
        _ => None,
    };
    parts.push(tools.unwrap_or_else(|| "ACP tools unreported".into()));
    if let Some(history) = receipt.get("historyOmission").and_then(history_omission_summary) {
        parts.push(history);
    }
    if let Some(elapsed) = number("/elapsedMs") {
        parts.push(format!("{elapsed}ms"));
    }
    format!("— {}", parts.join(" · "))
}

/// The TypeScript contract's `formatHistoryOmissionSummary` wording, when
/// the runtime supplies the counts needed to make that disclosure.
fn history_omission_summary(history: &Value) -> Option<String> {
    let number = |key: &str| history.get(key).and_then(Value::as_u64);
    let counted = |n: u64, noun: &str| format!("{n} {noun}{}", if n == 1 { "" } else { "s" });
    let records = counted(number("detectedInHistory")?, "record");
    let malformed = counted(number("malformedToolRecords")?, "malformed tool record");
    let gaps = counted(number("gapMarkers")?, "gap marker");
    let unknown = if history.get("callsUnknown")?.as_bool()? {
        "; number of lost calls unknown (possibly zero)"
    } else { "" };
    let selected = number("withheldFromProjection")?;
    let pairs = number("projectedPairs")?;
    let delivery = visible(history.get("historyDelivery")?.as_str()?);
    Some(format!("Tool evidence withheld: {records} ({malformed}, {gaps}{unknown}); selected window {selected}; valid projected pairs {pairs}; history delivery {delivery}; notice composed for this request"))
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
            // The upstream that served this call, when the provider named one.
            // Two calls of one turn can be served by different upstreams, and
            // a prompt cache belongs to one of them.
            let upstream = step
                .get("upstream")
                .and_then(Value::as_str)
                .map(|name| format!(" · {}", visible(name)))
                .unwrap_or_default();
            format!(
                "  #{} {} · {} in · {} read · {} write · {} out · {}{}",
                field(step, "order"),
                visible(purpose),
                count(field(step, "input")),
                count(field(step, "cacheRead")),
                count(field(step, "cacheWrite")),
                count(field(step, "output")),
                usd(step.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0)),
                upstream,
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

    fn runner_receipt() -> serde_json::Value {
        json!({
            "runner": {
                "profile": "fixture", "modelSlug": "fixture/model",
                "protocol": "acp", "protocolVersion": 1, "transport": "local_stdio",
                "accessRoute": "local", "costBasis": "metered_usd",
                "sessionCost": {"amount": 0.125, "currency": "USD"},
                "usage": {"input": 1200, "output": 50, "reasoning": 7},
                "contextWindow": {"used": 2400, "size": 32000},
                "continuity": {"state": "warm-reused"},
                "toolEvidence": {"status": "partial", "observedCalls": 4,
                    "recordedCalls": 2, "partialCalls": 1, "rejectedCalls": 1},
                "elapsedMs": 1234
            },
            "historyOmission": {"detectedInHistory": 2, "malformedToolRecords": 1,
                "gapMarkers": 1, "callsUnknown": true, "withheldFromProjection": 1,
                "projectedPairs": 3, "historyDelivery": "warm-no-replay"},
            "route": {"reason": "fixture_route"}
        })
    }

    #[test]
    fn runner_warm_reused_renders_reported_fields_in_order() {
        assert_eq!(line(&runner_receipt(), 99.0),
            "— fixture/model · session cost $0.1250 · 1,200→50 tok (+7 reasoning) (agent-reported) · ctx 2,400/32,000 · continuity warm-reused · native session reused · ACP tools 2/4 recorded (1 partial, 1 rejected) · Tool evidence withheld: 2 records (1 malformed tool record, 1 gap marker; number of lost calls unknown (possibly zero)); selected window 1; valid projected pairs 3; history delivery warm-no-replay; notice composed for this request · 1234ms");
    }

    #[test]
    fn runner_reconstructed_shows_projected_counts() {
        let mut r = runner_receipt();
        r["runner"]["continuity"] = json!({"state": "reconstructed",
            "priorMessagesProjected": 12, "toolExchangesProjected": 3});
        assert!(line(&r, 0.0).contains("continuity reconstructed 12msg/3tool · native session replaced"), "{}", line(&r, 0.0));
    }

    #[test]
    fn runner_reconstructed_shortened_shows_left_out_count_from_numeric_field_only() {
        let mut r = runner_receipt();
        r["runner"]["continuity"] = json!({
            "state": "reconstructed",
            "priorMessagesProjected": 32,
            "toolExchangesProjected": 0,
            "priorMessagesLeftOut": 8,
            "leftOutCauses": ["message_limit"],
        });
        let rendered = line(&r, 0.0);
        assert!(
            rendered.contains("continuity reconstructed 32msg/0tool (shortened, 8 left out) · native session replaced"),
            "{rendered}"
        );

        r["runner"]["continuity"] = json!({
            "state": "reconstructed",
            "priorMessagesProjected": 12,
            "toolExchangesProjected": 3,
        });
        let unshortened = line(&r, 0.0);
        assert!(
            unshortened.contains("continuity reconstructed 12msg/3tool · native session replaced"),
            "{unshortened}"
        );
        assert!(!unshortened.contains("shortened"), "{unshortened}");

        r["runner"]["continuity"]["priorMessagesLeftOut"] = json!("8\u{1b}[2J");
        let non_numeric = line(&r, 0.0);
        assert!(!non_numeric.contains("shortened"), "{non_numeric}");
        assert!(!non_numeric.contains('\u{1b}'), "{non_numeric:?}");
    }

    #[test]
    fn runner_without_usage_or_context_has_no_placeholder_numbers() {
        let r = json!({"runner": {"profile": "fixture", "costBasis": "unknown"}});
        assert_eq!(line(&r, 99.0), "— fixture · cost unknown · continuity unestablished · native session unverified · ACP tools unreported");
        let malformed = json!({"runner": {"profile": "fixture", "usage": {}, "contextWindow": {},
            "sessionCost": {}, "continuity": {"state": "reconstructed"}, "toolEvidence": {}, "elapsedMs": "bad"}});
        assert_eq!(line(&malformed, 99.0), "— fixture · cost unknown · continuity reconstructed · native session replaced · ACP tools unreported");
    }

    #[test]
    fn runner_subscription_quota_has_no_dollar_figure() {
        let r = json!({"runner": {"profile": "subscription", "costBasis": "subscription_quota", "elapsedMs": 2}});
        let rendered = line(&r, 99.0);
        assert!(!rendered.contains('$'), "{rendered}");
        assert_eq!(rendered, "— subscription · subscription quota (USD not reported) · continuity unestablished · native session unverified · ACP tools unreported · 2ms");
    }

    #[test]
    fn runner_hostile_model_slug_stays_visible_in_the_full_footer() {
        let r = json!({"runner": {"profile": "fixture", "modelSlug": "evil\u{1b}[2J\nmodel", "costBasis": "unknown"}});
        let rendered = line(&r, 0.0);
        assert!(!rendered.chars().any(char::is_control), "{rendered:?}");
        assert_eq!(rendered, format!("— {} · cost unknown · continuity unestablished · native session unverified · ACP tools unreported", crate::approval::visible("evil\u{1b}[2J\nmodel")));
    }

    #[test]
    fn runner_cost_bases_sessions_and_tool_evidence_follow_typescript_wording() {
        for (basis, expected) in [("local_free", "$0"), ("metered_usd", "USD not reported"), ("unknown", "cost unknown")] {
            let mut r = json!({"runner": {"profile": "fixture", "modelSlug": null, "costBasis": basis,
                "continuity": {"state": "new"}, "toolEvidence": {"status": "complete", "observedCalls": 0, "recordedCalls": 0}}});
            assert_eq!(line(&r, 99.0), format!("— fixture · {expected} · continuity new · native session new · ACP tools 0/0 recorded"));
            r["runner"]["continuity"]["state"] = json!("durably-resumed");
            r["runner"]["toolEvidence"] = json!({"status": "unavailable", "observedCalls": 2});
            r["runner"]["sessionCost"] = json!({"amount": 1.5, "currency": "EUR\u{1b}"});
            assert_eq!(line(&r, 0.0), format!("— fixture · session cost 1.5 {} · continuity durably-resumed · native session reused · ACP tools unavailable (2 observed)", crate::approval::visible("EUR\u{1b}")));
        }
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

    /// The upstream that served each call, or nothing when the provider named
    /// none — the same rendering `formatStepLines` uses.
    #[test]
    fn step_lines_name_the_serving_upstream_when_one_is_reported() {
        let steps = vec![
            json!({"order": 1, "purpose": "initial", "input": 312, "cacheRead": 0,
                   "cacheWrite": 22021, "output": 203, "costUsd": 0.0634,
                   "upstream": "Fireworks"}),
            json!({"order": 2, "purpose": "tool_followup", "input": 1204, "cacheRead": 22333,
                   "cacheWrite": 7661, "output": 270, "costUsd": 0, "upstream": "Together"}),
            json!({"order": 3, "purpose": "recovery", "input": 1, "cacheRead": 0,
                   "cacheWrite": 0, "output": 2, "costUsd": 0}),
        ];
        assert_eq!(
            step_lines(&steps),
            vec![
                "  #1 initial · 312 in · 0 read · 22,021 write · 203 out · $0.0634 · Fireworks",
                "  #2 tool_followup · 1,204 in · 22,333 read · 7,661 write · 270 out · $0 · Together",
                "  #3 recovery · 1 in · 0 read · 0 write · 2 out · $0",
            ]
        );
    }
}
