//! The per-turn receipt line.
//!
//! Cost visibility is part of the product's done-line, so every turn ends
//! with what it cost, what the session has cost so far, and how many tokens
//! it used. The layout follows `formatReceipt` in the TypeScript CLI
//! (`prototype/src/cli/render/receipt.ts`) so the two front-ends read alike.
//! Every field is optional: a receipt missing one costs a narrower line.

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

/// Render the receipt line for a completed turn. `session_total` is the
/// REPL's running spend including this turn.
pub fn line(receipt: &Value, session_total: f64) -> String {
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
    parts.push(format!("{} · session {}", usd(cost), usd(session_total)));

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
        parts.push(format!(
            "tools {used}/{max}{}",
            if limit { " (limit reached)" } else { "" }
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

#[cfg(test)]
mod tests {
    use super::{count, line};
    use serde_json::json;

    fn receipt() -> serde_json::Value {
        json!({
            "model": {"slug": "z-ai/glm-5.2", "displayName": "GLM 5.2"},
            "cost": {"totalUsd": 0.0123},
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
        assert!(line(&r, 0.0).contains("$0 · session $0"));
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
            "— unknown model · $0 · session $0 · 0→0 tok"
        );
    }

    #[test]
    fn counts_group_by_thousands() {
        assert_eq!(count(0), "0");
        assert_eq!(count(999), "999");
        assert_eq!(count(1000), "1,000");
        assert_eq!(count(1234567), "1,234,567");
    }
}
