-- DYFJ Workbench — Models Registry Schema
-- Replaces: hardcoded model definitions in TypeScript (index.ts localModel)
--
-- Design: Dolt is the source of truth for model specs and routing metadata.
-- The TypeScript router reads this table at session startup and caches for the
-- lifetime of the process. Adding, deprecating, or repricing a model is a
-- Dolt commit — not a code change.
--
-- Note: Uses slug as primary key (vs ULID model_id in the original plan).
-- Rationale: slug is already the natural routing key used by selectModel(),
-- it's stable, and avoids the redundancy of a PK that always equals the slug.
--
-- Tier semantics:
--   0 = Local (Ollama) — always free, no consent required
--   1 = API Light       — session-grant: prompt once, sticky for session
--   2 = API Heavy       — per-call: prompt every time with cost estimate
--
-- cost_input / cost_output: USD per million tokens (matches pi-ai Model.cost unit)
-- calculateCost() divides by 1,000,000 before multiplying by token count.

CREATE TABLE IF NOT EXISTS models (
    slug              VARCHAR(128)   NOT NULL PRIMARY KEY,
    display_name      VARCHAR(256)   NOT NULL,
    provider          VARCHAR(64)    NOT NULL,  -- 'ollama' | 'anthropic' | 'google' | 'openai'
    api               VARCHAR(64)    NOT NULL,  -- pi-ai Api discriminant
    base_url          VARCHAR(512)   NULL,
    tier              TINYINT UNSIGNED NOT NULL, -- 0, 1, 2
    context_window    INT UNSIGNED   NOT NULL,
    max_output_tokens INT UNSIGNED   NOT NULL,
    cost_input        DECIMAL(12,6)  NOT NULL DEFAULT 0, -- USD per MTok
    cost_output       DECIMAL(12,6)  NOT NULL DEFAULT 0,
    cost_cache_read   DECIMAL(12,6)  NOT NULL DEFAULT 0,
    cost_cache_write  DECIMAL(12,6)  NOT NULL DEFAULT 0,
    reasoning         BOOLEAN        NOT NULL DEFAULT FALSE,
    capabilities      JSON           NOT NULL,  -- e.g. '["code","reasoning","vision"]'
    active            BOOLEAN        NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMP(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at        TIMESTAMP(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                     ON UPDATE CURRENT_TIMESTAMP(6),

    INDEX idx_tier (tier, active)
);

-- ── Tier 0: Local (Ollama) ────────────────────────────────────────────────────
-- cost = 0 for all local models

INSERT INTO models
    (slug, display_name, provider, api, base_url, tier,
     context_window, max_output_tokens,
     cost_input, cost_output, cost_cache_read, cost_cache_write,
     reasoning, capabilities)
VALUES
    ('gemma4', 'Gemma 4 27B', 'ollama', 'openai-completions',
     'http://localhost:11434/v1', 0,
     131072, 8192,
     0, 0, 0, 0,
     TRUE, '["text","reasoning","vision","long-context"]'),

    ('gemma4:e2b', 'Gemma 4 2B (dev)', 'ollama', 'openai-completions',
     'http://localhost:11434/v1', 0,
     131072, 8192,
     0, 0, 0, 0,
     TRUE, '["text","reasoning"]'),

    -- Primary coding model (LiveCodeBench leader among open weights)
    ('qwen3:32b', 'Qwen3 32B', 'ollama', 'openai-completions',
     'http://localhost:11434/v1', 0,
     131072, 8192,
     0, 0, 0, 0,
     TRUE, '["text","code","reasoning"]'),

    -- MoE fast variant — lower active params (~3B), lower latency
    ('qwen3:30b-a3b', 'Qwen3 30B-A3B (MoE)', 'ollama', 'openai-completions',
     'http://localhost:11434/v1', 0,
     131072, 8192,
     0, 0, 0, 0,
     TRUE, '["text","code","chat"]');

-- ── Tier 1: API Light ─────────────────────────────────────────────────────────
-- Session-grant consent: prompt once, sticky for session duration.
-- Cost values from pi-ai generated models (USD per MTok).

INSERT INTO models
    (slug, display_name, provider, api, base_url, tier,
     context_window, max_output_tokens,
     cost_input, cost_output, cost_cache_read, cost_cache_write,
     reasoning, capabilities)
VALUES
    -- Anthropic: $1/$5 per MTok in/out (from pi-ai models.generated.js)
    ('claude-haiku-4-5', 'Claude Haiku 4.5', 'anthropic', 'anthropic-messages',
     'https://api.anthropic.com', 1,
     200000, 64000,
     1.000000, 5.000000, 0.100000, 1.250000,
     TRUE, '["text","code","vision"]'),

    -- Google: $0.30/$2.50 per MTok (non-thinking; thinking is higher)
    ('gemini-2.5-flash', 'Gemini 2.5 Flash', 'google', 'google-generative-ai',
     'https://generativelanguage.googleapis.com/v1beta', 1,
     1048576, 65536,
     0.300000, 2.500000, 0.075000, 0.000000,
     TRUE, '["text","code","reasoning","vision","long-context"]');

-- ── Tier 2: API Heavy ─────────────────────────────────────────────────────────
-- Per-call consent: prompt every time with cost estimate.

INSERT INTO models
    (slug, display_name, provider, api, base_url, tier,
     context_window, max_output_tokens,
     cost_input, cost_output, cost_cache_read, cost_cache_write,
     reasoning, capabilities)
VALUES
    -- Anthropic: $5/$25 per MTok
    ('claude-opus-4-5', 'Claude Opus 4.5', 'anthropic', 'anthropic-messages',
     'https://api.anthropic.com', 2,
     200000, 64000,
     5.000000, 25.000000, 0.500000, 6.250000,
     TRUE, '["text","code","reasoning","vision"]'),

    -- Google: $1.25/$10 per MTok
    ('gemini-2.5-pro', 'Gemini 2.5 Pro', 'google', 'google-generative-ai',
     'https://generativelanguage.googleapis.com/v1beta', 2,
     1048576, 65536,
     1.250000, 10.000000, 0.310000, 0.000000,
     TRUE, '["text","code","reasoning","vision","long-context"]');
