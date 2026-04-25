-- DYFJ Workbench — Sessions Schema
-- Replaces: MEMORY/WORK/*/PRD.md + work.json + session-names.json
--
-- A session is a unit of work — what PAI calls an "Algorithm run" or a
-- "native mode task." The structured metadata (phase, effort, progress)
-- enables dashboards and queries. The freeform content (context, criteria,
-- decisions, verification) stays as markdown TEXT because the model reads
-- it as prose and makes its own judgments.
--
-- What this eliminates:
--   - work.json session registry → SELECT * FROM sessions WHERE phase != 'complete'
--   - session-names.json → session_name column
--   - PRD frontmatter parsing → direct column access
--   - Criteria duplication between PRD and work.json → single source in content

CREATE TABLE IF NOT EXISTS sessions (
    -- Identity — use ULID/UUIDv7 for time-sortable inserts
    session_id      VARCHAR(64)   NOT NULL PRIMARY KEY,
    -- Slug from PRD directory name (e.g. '20260412-143000_dyfj-m22-event-spec-types')
    slug            VARCHAR(256)  NOT NULL UNIQUE,
    -- Human-readable 4-word session name (e.g. 'Quiet Morning Schema Design')
    session_name    VARCHAR(128)  NULL,
    -- External session ID from the harness (Claude Code UUID, pi session ID, etc.)
    -- Nullable because the workbench will generate its own session IDs
    external_id     VARCHAR(128)  NULL,

    -- Structured work metadata — the queryable envelope
    task_description VARCHAR(256) NOT NULL,
    -- Nullable: NULL before Algorithm mode assigns an effort level
    -- Canonical effort levels — keep in sync with reflections.effort_level
    effort_level    ENUM('standard','extended','advanced','deep','comprehensive') NULL,
    -- Nullable: NULL for native-mode sessions that don't use the Algorithm
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
