-- DYFJ — Reconcile pre-baseline live databases with the 2026-06-30 baseline.
--
-- The 2026-06-30 schema refactor (schema/current/001_structure.sql) added
-- sessions.status, removed the vestigial sessions.phase column, and dropped
-- the reflections/skills tables from the baseline — but shipped no forward
-- migration. Fresh installs got the new shape; existing databases kept the
-- old one, and the runtime fails with "Unknown column 'status' in 'sessions'".
-- History replay is not an upgrade path (schema/migrations/README.md), so this
-- forward migration moves a live database to the baseline shape.
--
-- Written against the pre-baseline (history replay) shape; the validator
-- applies it on top of the historical replay. Table and index statements are
-- guarded because live databases have drifted from the replay end-state
-- (e.g. carrying vestigial tables that history 018 already dropped); Dolt has
-- no column-level guards, so the column changes assume the pre-baseline shape.

ALTER TABLE sessions
  ADD COLUMN status ENUM('active', 'completed') NOT NULL DEFAULT 'active' AFTER effort_level;

ALTER TABLE sessions DROP INDEX IF EXISTS idx_phase;
ALTER TABLE sessions DROP COLUMN phase;

CREATE INDEX IF NOT EXISTS idx_status ON sessions (status, updated_at);

-- Vestigial tables removed from the baseline (see schema/history/018) that a
-- drifted live database may still carry.
DROP TABLE IF EXISTS reflections;
DROP TABLE IF EXISTS skills;
