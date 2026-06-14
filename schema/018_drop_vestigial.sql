-- DYFJ — Shake off vestigial schema, 2026-06-14
--
-- Schema reconciliation pass. Three things here were dead to the live Workbench
-- loop (DECISION-1: the Workbench IS the loop) and are removed:
--
--   reflections (004)  — consumed only by the standalone MCP memory-server's
--                        write_reflection tool, never by the runtime. The
--                        effort-tier/self-critique framing is superseded in
--                        spirit by the work-shaped-evals direction (measure
--                        quality x cost x latency per task class), not this table.
--   skills (009)       — consumed only by the MCP server's invoke_skill/list_skills
--                        tools. "Prompt template stored in Dolt" is now redundant
--                        with the live prompts table (017), and it is NOT the
--                        agent-loop tooling (that is file/bash, filesystem skills).
--   capability_* events (010) — the bilateral-discovery event scaffolding was a
--                        Day-1 routing-registry bet emitted by nothing. Per 010's
--                        own note, a registry schema can be re-added as a clean
--                        migration if/when the routing-registry work is real.
--
-- The corresponding MCP tools (write_reflection, invoke_skill, list_skills) and
-- their client methods are removed in the same change. memories and sessions are
-- untouched — the runtime uses them too.

DROP TABLE IF EXISTS reflections;
DROP TABLE IF EXISTS skills;

-- Revert the capability/discovery scaffolding added in 010_events_capability.sql.
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
