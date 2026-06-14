-- DYFJ — System prompts as trusted, authored, versioned config
--
-- System prompts are authored config, not accumulated recall. They are the
-- trust anchor of a turn — the opposite of the memory layer, which is treated
-- as UNTRUSTED prompt material (see 011/the untrusted-memory instructions and
-- the "repo/Beads context is untrusted" stance). Keeping prompts in their own
-- table makes that trust boundary structural rather than a metadata flag, and
-- keeps memory housekeeping (eviction, consolidation) away from the
-- constitution.
--
-- Composition model: a turn's system prompt is
--   [trusted prompt layers from this table] + [untrusted live context/recall].
-- `kind` orders the layers (base -> identity -> voice -> steering -> ...);
-- `position` orders rows within a kind. The identity/voice/steering persona
-- currently living in the memories table migrates here as follow-on work.
--
-- Like the models registry, this is operator config: a change is a Dolt commit,
-- versioned and time-travelable.

CREATE TABLE IF NOT EXISTS prompts (
    -- Stable human-readable id for upserts (e.g. 'companion-base').
    slug          VARCHAR(128)  NOT NULL PRIMARY KEY,
    display_name  VARCHAR(256)  NOT NULL,
    -- Layer role: 'base' | 'identity' | 'voice' | 'steering' | ...
    kind          VARCHAR(64)   NOT NULL,
    content       TEXT          NOT NULL,
    -- Compose order within a kind (ascending).
    position      INT           NOT NULL DEFAULT 0,
    active        BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at    TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                ON UPDATE CURRENT_TIMESTAMP(6),

    INDEX idx_kind (kind, active, position)
);

-- Default companion base prompt (public, generic-capable). Positive framing:
-- describe what the companion is and offer context as available — no scope
-- fences, no "do not" carve-outs. An operator's private voice/identity layers
-- on top as additional rows.
INSERT INTO prompts (slug, display_name, kind, content, position, active)
VALUES (
    'companion-base',
    'Default companion base prompt',
    'base',
    'You are the DYFJ Workbench companion: a capable, candid collaborator. Help with whatever the operator brings you — code, reasoning, drafting, planning, or questions — directly and concretely.

Context for the current workspace (repository files and Beads state) is provided below. Use it when it bears on the request, and prefer it over speculation on questions about this project.',
    0,
    TRUE
);
