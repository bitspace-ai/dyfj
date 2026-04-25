-- DYFJ Workbench — Add model_selected to events ENUM
--
-- A routing decision is a distinct operation from a model response.
-- We need a record of which model was chosen — and which were considered
-- and rejected — independent of whether the call succeeds or fails.
--
-- Field usage for model_selected events:
--   event_type  = 'model_selected'
--   model_id    = the selected model's slug
--   provider    = selected model's provider
--   content     = JSON: { "selected": "gemma4", "considered": [...], "reason": "..." }
--   resource    = selected model's slug (mirrors model_id for auditability)
--   duration_ms = time taken by selection + consent process
--   tokens_*    = NULL (not known at selection time)
--   cost_total  = NULL (not known at selection time)
--
-- This gives a permanent record of routing decisions — including rejected
-- candidates — that can feed into a future scoring system without retrofitting.

ALTER TABLE events
  MODIFY COLUMN event_type
    ENUM('model_response','tool_call','error','session_start','session_end','model_selected')
    NOT NULL;
