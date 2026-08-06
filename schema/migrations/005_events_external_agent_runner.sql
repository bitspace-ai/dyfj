-- DYFJ — Typed outer evidence for external-agent turns.
--
-- External runners are not model providers. Their durable events carry
-- profile-declared runner, transport, access-route, and cost-basis labels; the
-- resolved workspace; and ACP-observed session, capability, and stop metadata
-- without claiming visibility into the inner loop.

ALTER TABLE events
  MODIFY COLUMN event_type ENUM(
    'model_response',
    'tool_call',
    'error',
    'session_start',
    'session_end',
    'model_selected',
    'budget_summary',
    'context_compressed',
    'provider_call',
    'runner_selected',
    'agent_permission',
    'agent_response'
  ) NOT NULL,
  ADD COLUMN runner_kind ENUM('external_agent') NULL AFTER api,
  ADD COLUMN runner_profile VARCHAR(128) NULL AFTER runner_kind,
  ADD COLUMN runner_protocol VARCHAR(32) NULL AFTER runner_profile,
  ADD COLUMN runner_protocol_version VARCHAR(32) NULL AFTER runner_protocol,
  ADD COLUMN runner_stop_reason ENUM('end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled') NULL AFTER runner_protocol_version,
  ADD COLUMN runner_external_session_id VARCHAR(256) NULL AFTER runner_stop_reason,
  ADD COLUMN runner_agent_name VARCHAR(128) NULL AFTER runner_external_session_id,
  ADD COLUMN runner_agent_version VARCHAR(64) NULL AFTER runner_agent_name,
  ADD COLUMN runner_transport ENUM('local_stdio') NULL AFTER runner_agent_version,
  ADD COLUMN runner_access_route ENUM('local_sidecar', 'subscription_oauth', 'metered_direct_api', 'aggregator', 'independent_host') NULL AFTER runner_transport,
  ADD COLUMN runner_cost_basis ENUM('local_free', 'subscription_quota', 'metered_usd', 'unknown') NULL AFTER runner_access_route,
  ADD COLUMN runner_workspace VARCHAR(1024) NULL AFTER runner_cost_basis,
  ADD COLUMN runner_capabilities JSON NULL AFTER runner_workspace,
  ADD COLUMN runner_evidence_scope ENUM('outer_only') NULL AFTER runner_capabilities,
  ADD COLUMN permission_verdict ENUM('approved', 'denied', 'cancelled') NULL AFTER runner_evidence_scope,
  ADD INDEX idx_runner (runner_kind, runner_profile, created_at);
