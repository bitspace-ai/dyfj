-- DYFJ — Sessions Schema
-- A session is a durable interaction container. It may hold freeform
-- conversation, focused work, delegated execution, writing, inspection, or
-- orchestration history without changing its core identity. Structured
-- metadata (phase, effort, progress) remains optional query context;
-- freeform content stays as markdown TEXT because models read it as prose.

CREATE TABLE IF NOT EXISTS sessions (
    -- Identity — use ULID/UUIDv7 for time-sortable inserts
    session_id      VARCHAR(64)   NOT NULL PRIMARY KEY,
    -- Slug: time-prefixed identifier (e.g. '20260412-143000_dyfj-event-schema')
    slug            VARCHAR(256)  NOT NULL UNIQUE,
    -- Human-readable 4-word session name (e.g. 'Quiet Morning Schema Design')
    session_name    VARCHAR(128)  NULL,
    -- External session ID from the harness (Claude Code UUID, Codex thread ID, etc.)
    -- Nullable because the workbench will generate its own session IDs
    external_id     VARCHAR(128)  NULL,

    -- Structured session metadata — the queryable envelope
    task_description VARCHAR(256) NOT NULL,
    -- Nullable: NULL when a session has no effort classification
    -- Canonical effort levels — keep in sync with reflections.effort_level
    effort_level    ENUM('standard','extended','advanced','deep','comprehensive') NULL,
    -- Nullable: NULL when a session has no structured phase
    phase           ENUM('observe','think','plan','build','execute','verify','learn','complete') NULL,
    progress_done   INT UNSIGNED  NOT NULL DEFAULT 0,
    progress_total  INT UNSIGNED  NOT NULL DEFAULT 0,
    mode            ENUM('interactive','loop') NOT NULL DEFAULT 'interactive',
    iteration       INT UNSIGNED  NULL,

    -- The full session content — freeform markdown
    -- Contains: context, risks, plan, criteria (as checkboxes), decisions, verification
    -- The model reads this as a unit; no need to parse subsections into separate tables
    content         TEXT          NULL,

    created_at      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

    -- Indexes — each is a prolly-tree in Dolt, so keep minimal
    INDEX idx_phase       (phase, updated_at)
);
