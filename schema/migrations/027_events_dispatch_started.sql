-- DYFJ - Record child session dispatches on the coordinator's event log.
--
-- When a coordinator session starts a child session through `dispatch/start`,
-- the child's first `session_start` event carries its lineage and dispatch
-- record, and the coordinator's event log records a matching `dispatch_started`
-- event naming the child session in `resource`, the lineage columns, and the
-- full dispatch record in `content`.

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
    'dispatch_started'
  ) NOT NULL;
