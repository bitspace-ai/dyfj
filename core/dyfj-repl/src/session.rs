//! What one REPL session carries from turn to turn.
//!
//! The runtime owns the conversation; this is only the client's half of it:
//! the session id the runtime handed back, the routing the operator chose or
//! the resumed session recorded, paid consent, and the running spend shown on
//! the receipt line. It mirrors
//! what the TypeScript REPL sends (`buildTurnBody` in `prototype/src/cli/
//! turn-client.ts`), so either front-end produces the same turn request.

use serde_json::{Map, Value, json};

/// Where the session's model came from, so the posture line can say so.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum ModelOrigin {
    /// The operator's: `--model`, `DYFJ_WORKBENCH_MODEL`, `/model`, or none
    /// (the runtime's default).
    #[default]
    Operator,
    /// The model the resumed session last ran on, as the runtime recorded it.
    Restored,
    /// A resumed session the runtime holds no model for (one that predates
    /// recording it, or never routed a native turn).
    Unrecorded,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Session {
    /// The runtime's session id, set by the first turn's receipt or by
    /// `--session` / `/session switch`.
    pub id: Option<String>,
    /// Explicit model choice. `None` lets the runtime pick its default.
    pub model: Option<String>,
    /// Where `model` came from.
    pub model_origin: ModelOrigin,
    /// The operator named the model with `--model`; a resumed session's
    /// recorded model does not replace it at startup.
    pub model_pinned: bool,
    /// The configured default (`DYFJ_WORKBENCH_MODEL`), or `None` for the
    /// runtime's. A switch to a session with no recorded model runs on it,
    /// not on a model chosen for the session switched away from.
    pub default_model: Option<String>,
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
        // A restored model is the runtime's to route: a resumed turn that
        // names no model runs on the session's recorded one and reports the
        // route as `session_model`. Sending it would claim the operator chose
        // it.
        if let Some(model) = self.model.as_ref().filter(|_| self.model_origin != ModelOrigin::Restored) {
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

    /// Take a resumed session's recorded model, as `sessions/inspect`
    /// reports it, unless `--model` named one. With nothing recorded the
    /// operator's choice, or the runtime's default, stands.
    pub fn restore_model(&mut self, recorded: Option<String>) {
        if self.model_pinned {
            return;
        }
        match recorded {
            Some(slug) => {
                self.model = Some(slug);
                self.model_origin = ModelOrigin::Restored;
            }
            None => self.model_origin = ModelOrigin::Unrecorded,
        }
    }

    /// The operator chose `slug` with `/model`; the next turn records it.
    pub fn choose_model(&mut self, slug: String) {
        self.model = Some(slug);
        self.model_origin = ModelOrigin::Operator;
        self.model_pinned = true;
    }

    /// Point the session at another runtime session and its recorded model.
    /// Spend and turn counts restart, because they describe what happened in
    /// this REPL. A model chosen for the previous session never carries over:
    /// the target runs on its recorded model, or, with none recorded, on the
    /// configured default.
    pub fn switch_to(&mut self, id: String, workspace: Option<String>, recorded: Option<String>) {
        self.id = Some(id);
        self.workspace = workspace;
        self.spend_usd = 0.0;
        self.turns = 0;
        self.last_model = None;
        self.last_command = None;
        self.model_pinned = false;
        self.model = self.default_model.clone();
        self.model_origin = ModelOrigin::Operator;
        self.restore_model(recorded);
    }
}

#[cfg(test)]
mod tests {
    use super::{ModelOrigin, Session};
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
        session.switch_to("new".into(), Some("/elsewhere".into()), None);
        assert_eq!(session.id.as_deref(), Some("new"));
        assert_eq!(session.workspace.as_deref(), Some("/elsewhere"));
        assert_eq!(session.spend_usd, 0.0);
        assert_eq!(session.turns, 0);
        assert_eq!(session.model_origin, ModelOrigin::Unrecorded);
    }

    /// A target with no recorded model runs on the configured default, not
    /// on a model chosen or restored for the session switched away from.
    #[test]
    fn switching_to_an_unrecorded_session_drops_the_previous_sessions_model() {
        let mut chosen = Session { default_model: Some("env-default".into()), ..Session::default() };
        chosen.choose_model("chosen-for-old".into());
        chosen.switch_to("new".into(), None, None);
        assert_eq!(chosen.model.as_deref(), Some("env-default"));
        assert_eq!(chosen.turn_body("hi", "t")["routingOptions"]["modelId"], "env-default");

        let mut restored = Session::default();
        restored.switch_to("old".into(), None, Some("recorded-for-old".into()));
        restored.switch_to("new".into(), None, None);
        assert_eq!(restored.model, None, "the runtime's default");
        assert!(restored.turn_body("hi", "t").get("routingOptions").is_none());
    }

    /// The target session's history was built on its recorded model, so a
    /// switch routes there even over a model chosen for the previous one.
    #[test]
    fn switching_restores_the_target_sessions_recorded_model() {
        let mut session = Session::default();
        session.choose_model("local/qwen".into());
        session.switch_to("new".into(), None, Some("claude-sonnet-5".into()));
        assert_eq!(session.model.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(session.model_origin, ModelOrigin::Restored);
        assert!(!session.model_pinned);
        // The runtime restores it from the log and labels the route; the
        // request names only the session.
        session.fast = Some(true);
        let body = session.turn_body("hi", "t-1");
        assert_eq!(body["routingOptions"], json!({"fast": true}));
        assert_eq!(body["sessionId"], "new");
    }

    /// `--model` wins over the recorded model at startup; the environment's
    /// model is a default, and does not.
    #[test]
    fn a_pinned_model_survives_restore_and_an_environment_model_does_not() {
        let mut pinned = Session { model: Some("flag".into()), model_pinned: true, ..Session::default() };
        pinned.restore_model(Some("recorded".into()));
        assert_eq!(pinned.model.as_deref(), Some("flag"));
        assert_eq!(pinned.model_origin, ModelOrigin::Operator);

        let mut from_env = Session { model: Some("env".into()), ..Session::default() };
        from_env.restore_model(Some("recorded".into()));
        assert_eq!(from_env.model.as_deref(), Some("recorded"));
        assert_eq!(from_env.model_origin, ModelOrigin::Restored);

        let mut unrecorded = Session::default();
        unrecorded.restore_model(None);
        assert_eq!(unrecorded.model, None);
        assert_eq!(unrecorded.model_origin, ModelOrigin::Unrecorded);
    }

    /// A `/model` change replaces a restored model and is what the next turn
    /// sends, so the runtime records it.
    #[test]
    fn choosing_a_model_replaces_a_restored_one() {
        let mut session = Session::default();
        session.switch_to("S".into(), None, Some("recorded".into()));
        session.choose_model("chosen".into());
        assert_eq!(session.model_origin, ModelOrigin::Operator);
        assert_eq!(session.turn_body("hi", "t")["routingOptions"]["modelId"], "chosen");
    }
}
