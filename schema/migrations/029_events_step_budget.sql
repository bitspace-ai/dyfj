-- DYFJ - Record a turn's tool-step budget decisions on its event log.
--
-- A turn's tool steps are bounded by a soft limit it may extend while it makes
-- forward progress, and a hard ceiling it may never pass. Each decision the
-- loop makes about that budget (extended on progress, stopped on a stall, on
-- the ceiling or on spent spend) is recorded as a `step_budget` event whose
-- `content` carries the figures, so thresholds can be tuned from real turn
-- telemetry instead of guessed.

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
    'agent_response',
    'approval_parked',
    'approval_resolved',
    'dispatch_started',
    'step_budget'
  ) NOT NULL;
