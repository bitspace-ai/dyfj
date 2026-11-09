-- DYFJ — Record approvals that wait for the operator.
--
-- A turn the runtime starts itself has no client connection to ask. Its
-- approval requests (a mutating tool call, an external agent's permission
-- request, a spend check) are parked: the runtime holds each request in memory
-- against the session until the operator attaches and answers it through the
-- `approvals/answer` RPC method, or until the park times out or the turn is
-- cancelled.
--
-- `approval_parked` records that a request was parked: `resource` is the
-- approval id and `content` names its kind. The request's arguments are not
-- recorded here. `approval_resolved` records how it ended: the operator's
-- verdict, a timeout, or a cancellation, in `permission_verdict`. It is a
-- best-effort write: a failed one is logged and leaves no event.

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
    'approval_resolved'
  ) NOT NULL;
