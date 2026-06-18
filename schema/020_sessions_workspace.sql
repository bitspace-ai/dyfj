-- DYFJ — Sessions gain a workspace binding
--
-- The workspace is the directory the read-only file tools are scoped to for a
-- session. It is set once, when the session is created (the `dyfj` client's cwd,
-- honored only for a loopback operator), and persisted here so resumed turns
-- read it back instead of the client re-sending its cwd on every turn. A session
-- stays bound to where it started even if the client is later relaunched from a
-- different directory.
--
-- Free-form absolute path, like `project` (migration 013). Nullable: NULL means
-- no workspace was bound, so the runtime falls back to the server default root.

ALTER TABLE sessions
  ADD COLUMN workspace VARCHAR(1024) NULL AFTER project;
