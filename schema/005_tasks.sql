-- DYFJ Workbench — Tasks Schema
-- Replaces: manual context handoff for project visibility
--
-- Design: Notion is the human interface for task management. This table
-- is the AI's read-only mirror — giving pi/Sonnet holistic project
-- visibility so it can reason about what to work on next.
--
-- Sync direction: Notion → Dolt (one-way). A sync script pulls tasks
-- from the Notion Tasks database and upserts into this table.
-- Write-back (Dolt → Notion) is deferred to a future milestone.
--
-- What this enables:
--   - pi can SELECT tasks ORDER BY milestone, sequence to see the backlog
--   - pi can filter by status to see what's in flight vs. available
--   - pi can read notes/context without Notion API calls or token burn
--   - blocked_by is a Dolt-only field — pi can annotate dependencies
--     that Chris doesn't track in Notion

CREATE TABLE IF NOT EXISTS tasks (
    -- Identity — use ULID/UUIDv7 for time-sortable inserts
    task_id         VARCHAR(64)   NOT NULL PRIMARY KEY,

    -- Notion sync identity — stable keys for idempotent upsert
    -- notion_page_id is the Notion page UUID (without dashes)
    -- Used as the merge key: ON DUPLICATE KEY UPDATE
    notion_page_id  VARCHAR(64)   NOT NULL UNIQUE,
    -- Notion auto-increment ID (e.g. 108). Stored for human reference.
    notion_task_num INT UNSIGNED  NULL,

    -- Task content
    title           VARCHAR(512)  NOT NULL,
    notes           TEXT          NULL,

    -- Project context — denormalized from Notion relation
    -- Resolved to human-readable name by the sync script
    -- e.g. "DYFJ — Sovereign AI Stack" not a Notion URL
    project_name    VARCHAR(256)  NULL,
    -- Original Notion project page ID for future sync/linking
    project_page_id VARCHAR(64)   NULL,

    -- Prioritization fields — what pi uses to reason about ordering
    status          ENUM('Not started','In progress','Done') NOT NULL DEFAULT 'Not started',
    priority        ENUM('Urgent','High','Normal','Low') NOT NULL DEFAULT 'Normal',
    milestone       ENUM(
                        'M1: Dolt Foundation',
                        'M2: Model Interaction Layer',
                        'M3: Agent Workbench UI',
                        'M4: PAI Migration',
                        'M5: Bilateral Discovery'
                    ) NULL,
    -- Float to match Notion's ordering semantics (allows insertion between items)
    sequence        FLOAT         NULL,
    effort          ENUM('Small','Medium','Large') NULL,

    -- Category — multi_select in Notion, stored as JSON array
    -- e.g. '["AI-Automatable", "Learning Sprint"]'
    category        JSON          NULL,

    -- Due date — nullable, date only (no time component in Notion)
    due_date        DATE          NULL,

    -- Legacy Linear ID (e.g. "BIT-86") — preserved for historical reference
    linear_id       VARCHAR(32)   NULL,

    -- Dolt-only fields — data that lives in the AI's layer, not in Notion
    -- pi can annotate task dependencies that aren't tracked in Notion
    -- Stores a task_id (not notion_page_id) of the blocking task
    blocked_by      VARCHAR(64)   NULL,

    -- Timestamps
    created_at      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    -- When this row was last synced from Notion
    last_synced_at  TIMESTAMP(6)  NULL,

    -- Indexes — each is a prolly-tree in Dolt, so keep minimal
    -- Primary query: "what should I work on?" = status + milestone + sequence
    INDEX idx_backlog    (status, milestone, sequence),
    INDEX idx_priority   (priority, status)
);
