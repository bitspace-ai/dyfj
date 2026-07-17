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
--   { summary, turnsRetained, turnsCompressed, compressorModelSlug, trigger,
--     tokensBeforeEstimate, tokensAfterEstimate }
-- `summary` and `turnsRetained` are REPLAY-CRITICAL: together they are how a
-- resumed transcript is reconstructed. `turnsRetained` is the number of turns
-- kept verbatim at this event's boundary — a TRAILING count, because replay
-- rebuilds the full history while the live path compressed a seed already capped
-- to the recent turns, so a leading count would mean a different thing to each
-- side. An event missing either field replays uncompressed rather than
-- half-applying. `summary` is transcript-derived content (it may carry the same
-- private/PII material as any prompt, response, or tool result) and inherits the
-- events store's existing access, retention, and export policy.
--
-- Egress, stated precisely: GENERATING the summary is always a local call, but
-- the summary itself re-enters the conversation and is sent to the ACTIVE session
-- model like the turns it replaced — hosted or not. Ordinarily that discloses
-- nothing new (those verbatim turns already went to that model), with two
-- caveats: it is pinned past the recent-turns cap, so its gist outlives the turns
-- it replaced, and a mid-session model switch can carry that gist to a provider
-- which never saw the originals.
--
-- The remaining fields, `turnsCompressed` included, are observability metadata
-- that replay never keys on. No new columns: none of this is a queried dimension.
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
