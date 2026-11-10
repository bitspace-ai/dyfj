-- DYFJ — Record a session's lineage and posture on its session_start event.
--
-- A coordinator session will dispatch leaf sessions. The leaf's first
-- session_start event carries the dispatch record: the coordinator's session
-- id, the leaf's depth below it, the coordinator's label for it, and the
-- reasoning effort, route and model family the leaf runs on. Reads take the
-- values from the session's earliest session_start event.
--
-- This migration adds the columns only. No code writes them yet, so every
-- existing row, and every row written before a producer exists, holds NULL
-- in all six.
--
-- `reasoning_effort` is the value the runtime passed to the model or runner,
-- not the value requested. `model_family` comes from the model catalog, not
-- from the model's self-description.

ALTER TABLE events
  ADD COLUMN parent_session_id VARCHAR(64) NULL AFTER permission_verdict,
  ADD COLUMN lineage_depth TINYINT UNSIGNED NULL AFTER parent_session_id,
  ADD COLUMN lineage_label VARCHAR(128) NULL AFTER lineage_depth,
  ADD COLUMN reasoning_effort VARCHAR(16) NULL AFTER lineage_label,
  ADD COLUMN turn_route ENUM('native', 'acp') NULL AFTER reasoning_effort,
  ADD COLUMN model_family VARCHAR(64) NULL AFTER turn_route;
