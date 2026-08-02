-- DYFJ — Persist content-free provider-call attempt spans for each Workbench turn.
--
-- The existing trace_id/span_id/parent_span_id columns form the causal graph:
-- session_start owns the stable turn root; provider_call spans are its ordered
-- children; provider-requested tool_call spans point at the provider_call that
-- requested them;
-- model_selected, budget_summary, context_compressed, runtime-initiated
-- repo-context tool_call, and terminal model_response, error, and session_end
-- spans point at the root.
--
-- provider_call is trace metadata, never a conversation message. `content` and
-- `thinking` remain NULL. Provider failures use provider_error_class, selected
-- only from the runtime's fixed classification table; raw provider bodies,
-- prompts, headers, and credentials do not enter this event.
--
-- The individual token/cache/cost columns already exist and hold per-call
-- accounting. The existing model_response stays the authoritative aggregate
-- replay record for the completed turn.

ALTER TABLE events MODIFY COLUMN event_type ENUM(
    'model_response',
    'tool_call',
    'error',
    'session_start',
    'session_end',
    'model_selected',
    'budget_summary',
    'context_compressed',
    'provider_call'
) NOT NULL;

ALTER TABLE events
  ADD COLUMN provider_call_order INT UNSIGNED NULL AFTER stop_reason,
  ADD COLUMN provider_call_purpose ENUM(
      'initial',
      'tool_followup',
      'forced_conclusion',
      'recovery',
      'context_compression'
    ) NULL AFTER provider_call_order,
  ADD COLUMN provider_error_class VARCHAR(64) NULL AFTER provider_call_purpose,
  ADD INDEX idx_provider_call (trace_id, provider_call_order);
