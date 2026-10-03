//! What one REPL session carries from turn to turn.
//!
//! The runtime owns the conversation; this is only the client's half of it:
//! the session id the runtime handed back, the routing the operator chose,
//! paid consent, and the running spend shown on the receipt line. It mirrors
//! what the TypeScript REPL sends (`buildTurnBody` in `prototype/src/cli/
//! turn-client.ts`), so either front-end produces the same turn request.

use serde_json::{Map, Value, json};

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Session {
    /// The runtime's session id, set by the first turn's receipt or by
    /// `--session` / `/session switch`.
    pub id: Option<String>,
    /// Explicit model choice. `None` lets the runtime pick its default.
    pub model: Option<String>,
    /// Fast speed tier for models that advertise it. `None` sends nothing.
    pub fast: Option<bool>,
    /// Per-turn paid opt-in. The engine still decides; without it, a hosted
    /// turn fails closed unless the runtime's standing posture approves paid.
    pub approve_paid: bool,
    /// The directory file tools are scoped to. Sent only when a turn starts a
    /// NEW session: the runtime stores it on the session row, and a resumed
    /// session reads it back.
    pub workspace: Option<String>,
    /// Running sum of per-turn cost, in USD, since this session began here.
    pub spend_usd: f64,
    pub turns: u32,
    /// The model the last turn actually ran on, from its receipt.
    pub last_model: Option<String>,
    /// The last slash command, for friction context.
    pub last_command: Option<String>,
}

impl Session {
    /// The `turn` request body for one prompt.
    pub fn turn_body(&self, prompt: &str, turn_id: &str) -> Value {
        let mut body = json!({"prompt": prompt, "mode": "turn", "turnId": turn_id});
        let mut routing = Map::new();
        if let Some(model) = &self.model {
            routing.insert("modelId".into(), Value::String(model.clone()));
        }
        if let Some(fast) = self.fast {
            routing.insert("fast".into(), Value::Bool(fast));
        }
        if !routing.is_empty() {
            body["routingOptions"] = Value::Object(routing);
        }
        match &self.id {
            Some(id) => body["sessionId"] = Value::String(id.clone()),
            None => {
                if let Some(workspace) = &self.workspace {
                    body["workspace"] = Value::String(workspace.clone());
                }
            }
        }
        if self.approve_paid {
            body["approvePaidInference"] = Value::Bool(true);
        }
        body
    }

    /// Fold a completed turn's receipt into the session.
    pub fn record(&mut self, receipt: &Value) {
        if let Some(id) = receipt.get("sessionId").and_then(Value::as_str) {
            self.id = Some(id.to_string());
        }
        if let Some(cost) = receipt
            .pointer("/cost/totalUsd")
            .and_then(Value::as_f64)
            .filter(|c| c.is_finite() && *c > 0.0)
        {
            self.spend_usd += cost;
        }
        if let Some(slug) = receipt.pointer("/model/slug").and_then(Value::as_str) {
            self.last_model = Some(slug.to_string());
        }
        self.turns += 1;
    }

    /// Point the session at another runtime session. Spend and turn counts
    /// restart, because they describe what happened in this REPL.
    pub fn switch_to(&mut self, id: String, workspace: Option<String>) {
        self.id = Some(id);
        self.workspace = workspace;
        self.spend_usd = 0.0;
        self.turns = 0;
        self.last_model = None;
        self.last_command = None;
    }
}

#[cfg(test)]
mod tests {
    use super::Session;
    use serde_json::json;

    #[test]
    fn a_bare_session_sends_only_the_prompt() {
        let body = Session::default().turn_body("hi", "t-1");
        assert_eq!(
            body,
            json!({"prompt": "hi", "mode": "turn", "turnId": "t-1"})
        );
    }

    #[test]
    fn a_new_session_sends_its_workspace_and_routing() {
        let session = Session {
            model: Some("z-ai/glm-5.2".into()),
            fast: Some(true),
            approve_paid: true,
            workspace: Some("/work/dyfj".into()),
            ..Session::default()
        };
        assert_eq!(
            session.turn_body("hi", "t-1"),
            json!({
                "prompt": "hi",
                "mode": "turn",
                "turnId": "t-1",
                "routingOptions": {"modelId": "z-ai/glm-5.2", "fast": true},
                "workspace": "/work/dyfj",
                "approvePaidInference": true
            })
        );
    }

    /// The runtime reads the workspace back from the session row, so a
    /// resumed turn must not try to move it.
    #[test]
    fn a_resumed_session_sends_its_id_and_not_the_workspace() {
        let session = Session {
            id: Some("01J0000000000000000000000A".into()),
            workspace: Some("/work/dyfj".into()),
            ..Session::default()
        };
        let body = session.turn_body("hi", "t-1");
        assert_eq!(body["sessionId"], "01J0000000000000000000000A");
        assert!(body.get("workspace").is_none(), "{body}");
    }

    #[test]
    fn a_receipt_sets_the_id_and_accumulates_spend() {
        let mut session = Session::default();
        session.record(&json!({
            "sessionId": "01J0000000000000000000000A",
            "cost": {"totalUsd": 0.0125},
            "model": {"slug": "z-ai/glm-5.2"}
        }));
        session.record(&json!({"cost": {"totalUsd": 0.0075}}));
        assert_eq!(session.id.as_deref(), Some("01J0000000000000000000000A"));
        assert!((session.spend_usd - 0.02).abs() < 1e-12);
        assert_eq!(session.turns, 2);
        assert_eq!(session.last_model.as_deref(), Some("z-ai/glm-5.2"));
    }

    #[test]
    fn switching_resets_what_this_repl_counted() {
        let mut session = Session {
            id: Some("old".into()),
            spend_usd: 1.0,
            turns: 3,
            model: Some("kept".into()),
            ..Session::default()
        };
        session.switch_to("new".into(), Some("/elsewhere".into()));
        assert_eq!(session.id.as_deref(), Some("new"));
        assert_eq!(session.workspace.as_deref(), Some("/elsewhere"));
        assert_eq!(session.spend_usd, 0.0);
        assert_eq!(session.turns, 0);
        // Routing is the operator's choice, not the session's history.
        assert_eq!(session.model.as_deref(), Some("kept"));
    }
}
