-- DYFJ — Add the `context_compressed` event type.
--
-- The context compressor replaces elder conversation turns with a model-
-- generated named-section summary when the transcript crosses ~50% of the
-- active model's context window, or when a turn overflows the window. Each
-- compression records one event so the summary survives resume (replayed by
-- buildConversationMessages) and is visible in receipts/inspector rather than
-- being invisible context surgery.
--
-- The payload rides on `content` as JSON, mirroring the tool_call events:
--   { summary, turnsCompressed, compressorModelSlug, trigger,
--     tokensBeforeEstimate, tokensAfterEstimate }
-- `summary` is transcript-derived content (it may carry the same private/PII
-- material as any prompt, response, or tool result) and inherits the events
-- store's existing access, retention, and export policy — it introduces no new
-- egress. The other fields are compression metadata. No new columns: none of
-- this is a queried dimension.
--
-- ENUM extension is append-only, matching the precedent in schema/history
-- (007 model_selected, 008 budget_summary). Keep this list in lockstep with
-- schema/current/001_structure.sql.

ALTER TABLE events MODIFY COLUMN event_type ENUM(
    'model_response',
    'tool_call',
    'error',
    'session_start',
    'session_end',
    'model_selected',
    'budget_summary',
    'context_compressed'
) NOT NULL;
