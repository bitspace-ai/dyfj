-- DYFJ Workbench — Memories Schema
-- Replaces: memory/*.md files + MEMORY.md index
--
-- Design: structured metadata as columns, freeform body as TEXT.
-- The model reads content and makes its own judgments — columns enable
-- finding and filtering, not prescribing behavior.
--
-- What this eliminates:
--   - MEMORY.md hand-maintained index → SELECT slug, name, description FROM memories
--   - Filename prefix convention (user_*, feedback_*) → type ENUM column
--   - YAML frontmatter parsing → direct column access

CREATE TABLE IF NOT EXISTS memories (
    -- Identity — use ULID/UUIDv7 for time-sortable inserts
    memory_id       VARCHAR(64)   NOT NULL PRIMARY KEY,
    -- Slug derived from original filename (e.g. 'user_profile', 'feedback_humor')
    -- Serves as a human-readable stable identifier for upserts
    slug            VARCHAR(128)  NOT NULL UNIQUE,
    -- user:        personal identity and preferences — always loaded
    -- feedback:    learned corrections and working style — always loaded
    -- environment: runtime environment facts (tool paths, commands, service names)
    --              always loaded; static rows authored in Dolt, dynamic status
    --              injected fresh each session by the host extension
    -- project:     project-specific context — lazy (on-demand via read_memory)
    -- reference:   reference material — lazy (on-demand via read_memory)
    type            ENUM('user','feedback','environment','project','reference') NOT NULL,
    name            VARCHAR(256)  NOT NULL,
    description     TEXT          NOT NULL,

    -- The actual memory — freeform markdown, interpreted by the model
    -- This is the filing cabinet, not the straitjacket
    content         TEXT          NOT NULL,

    created_at      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

    -- Indexes — each is a prolly-tree in Dolt, so keep minimal
    INDEX idx_type        (type, updated_at)
);
