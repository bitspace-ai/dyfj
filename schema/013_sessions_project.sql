-- DYFJ — Sessions gain a project binding
--
-- The Workbench shell lists sessions grouped by project (left pane of the
-- cockpit). Project is a free-form label, not a foreign key: projects are
-- working directories and operator-selected project labels, not rows we manage.

ALTER TABLE sessions
  ADD COLUMN project VARCHAR(128) NULL AFTER external_id,
  ADD INDEX idx_project (project, updated_at);
