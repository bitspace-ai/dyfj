-- DYFJ Workbench — Skills Schema
--
-- A skill is a named reasoning methodology stored as a prompt template.
-- invoke_skill(slug) via MCP loads the template and returns it to the model,
-- which then executes the behavior described in it.
--
-- trigger_patterns: comma-separated phrases that suggest this skill is relevant.
-- prompt_template: the actual prompt injected when the skill is invoked.
--
-- Design: schema defines structure, model interprets content freely.
-- No enforcement of how the model uses the template — that's the point.

CREATE TABLE IF NOT EXISTS skills (
    skill_id        VARCHAR(64)   NOT NULL PRIMARY KEY,
    slug            VARCHAR(128)  NOT NULL UNIQUE,
    name            VARCHAR(256)  NOT NULL,
    description     TEXT          NOT NULL,
    -- Comma-separated trigger phrases to help routing decisions
    trigger_patterns TEXT         NOT NULL DEFAULT '',
    -- The prompt template injected when the skill is invoked
    prompt_template TEXT          NOT NULL,

    created_at      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

    INDEX idx_slug (slug)
);
