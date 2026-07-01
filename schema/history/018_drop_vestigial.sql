-- DYFJ — Reconcile schema around live runtime surfaces, 2026-06-14
--
-- Schema reconciliation pass. The live Workbench loop keeps the surfaces it
-- consumes directly:
--
--   reflections (004)  — replaced by the work-shaped-evals direction: measure
--                        quality x cost x latency per task class.
--   skills (009)       — prompt templates live in the prompts table (017);
--                        agent-loop tooling is represented by concrete tools.
--   capability_* events (010) — discovery behavior should be shaped by concrete
--                        registry producers and consumers.
--
-- The corresponding MCP tools (write_reflection, invoke_skill, list_skills) and
-- their client methods are removed in the same change. memories and sessions are
-- untouched — the runtime uses them too.

DROP TABLE IF EXISTS reflections;
DROP TABLE IF EXISTS skills;

-- Remove the capability/discovery fields added in 010_events_capability.sql.
-- Drop the indexes before the columns they cover.
ALTER TABLE events DROP INDEX idx_capability_name;
ALTER TABLE events DROP INDEX idx_capability_lease;

ALTER TABLE events
  DROP COLUMN capability_name,
  DROP COLUMN capability_version,
  DROP COLUMN capability_lease_id,
  DROP COLUMN capability_lease_expires,
  DROP COLUMN capability_metadata;

-- Restore event_type to the live taxonomy (001 + 007 model_selected + 008
-- budget_summary), removing the four capability_* values.
ALTER TABLE events
  MODIFY COLUMN event_type
    ENUM(
      'model_response',
      'tool_call',
      'error',
      'session_start',
      'session_end',
      'model_selected',
      'budget_summary'
    )
    NOT NULL;
