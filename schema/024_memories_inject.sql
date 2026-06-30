-- DYFJ — Memory injection classification, 2026-06-22
--
-- Memory injection was scoped only by privacy clearance (019): every cleared
-- consumer received the full personal corpus — all user+feedback content
-- (~44k tokens) plus the project+reference index — on every turn-mode turn,
-- with no relevance, recency, or task scoping. That corpus was a frozen one-time
-- seed with no live source, so it injected stale material — defunct vocabulary
-- and ephemeral dated session-state checkpoints — as if current:
-- staleness as a correctness failure, not just token cost.
--
-- Classify each memory by how it should reach the context, independent of type:
--   always — full content injected every turn (the small curated worldview:
--            identity core + operating preferences). The stable persona.
--   index  — slug+name+description only; the model pulls full content on demand
--            via read_memory. The default: reachable, never bulk-injected.
--   never  — withheld from both injection and the index (defunct rows kept for
--            provenance without polluting context).
--
-- Existing rows default to 'index': nothing bulk-injects until deliberately
-- promoted to 'always'. This is the relevance-scoping complement to 019's
-- privacy-scoping — injection is now curated by classification, not by type.

ALTER TABLE memories
  ADD COLUMN inject
    ENUM('always', 'index', 'never')
    NOT NULL DEFAULT 'index'
    AFTER visibility;

-- Hot lookup: "rows to inject (or index) that the consumer is cleared to see".
ALTER TABLE memories
  ADD INDEX idx_inject (inject, visibility);
