-- DYFJ — Memory visibility classification, 2026-06-15
--
-- Memory injection was unscoped: the turn-mode companion path loaded the full
-- personal corpus (user/feedback content + project/reference index) for every
-- consumer, regardless of who was asking. A loopback CLI test surfaced this —
-- an "operator summary of this repository" returned a summary of the operator's
-- private inner world. That's fine for the solo-local companion but a leakage
-- surface for any future remote, shared, or client-facing consumer.
--
-- Add a privacy class per the AGENTS.md taxonomy so the runtime can scope what
-- loads by the consumer's clearance (derived from the auth context's transport).
-- Existing rows default to 'private' — they stay local-only by construction, and
-- the personal corpus cannot reach a non-loopback consumer until a memory is
-- deliberately reclassified. This is the trust-boundary complement to the
-- prompts table (017): prompts are the trusted authored anchor; memory is
-- untrusted, accumulated, and now privacy-scoped at injection time.

ALTER TABLE memories
  ADD COLUMN visibility
    ENUM('private', 'shareable', 'client_safe', 'public')
    NOT NULL DEFAULT 'private'
    AFTER type;

-- Hot lookup: "rows of these types the consumer is cleared to see".
ALTER TABLE memories
  ADD INDEX idx_visibility (visibility, type);
