-- DYFJ — Models registry refresh, 2026-06
--
-- Brings the seed registry current with the working model set:
--   * Deprecates the stale Opus 4.5 row (superseded generation).
--   * Adds the current Anthropic lineup with cache economics. Cache costs
--     follow provider pricing: reads at 0.1x input, 5-minute-TTL writes at
--     1.25x input, per MTok.
--   * Adds the MLX local default adopted by the 2026-06 provider decision
--     (Apple silicon path; Ollama rows remain the fallback).
--
-- Tier semantics unchanged from 006: 0 local / 1 API light / 2 API heavy.

UPDATE models SET active = FALSE WHERE slug = 'claude-opus-4-5';

-- ── Tier 0: MLX local default ────────────────────────────────────────────────

INSERT INTO models
    (slug, display_name, provider, api, base_url, tier,
     context_window, max_output_tokens,
     cost_input, cost_output, cost_cache_read, cost_cache_write,
     reasoning, capabilities)
VALUES
    ('mlx-community/Qwen3.5-4B-8bit', 'Qwen3.5 4B MLX', 'mlx-lm',
     'openai-completions', 'http://127.0.0.1:18080/v1', 0,
     131072, 8192,
     0, 0, 0, 0,
     TRUE, '["text","code","reasoning"]');

-- ── Tier 1: API light ────────────────────────────────────────────────────────

INSERT INTO models
    (slug, display_name, provider, api, base_url, tier,
     context_window, max_output_tokens,
     cost_input, cost_output, cost_cache_read, cost_cache_write,
     reasoning, capabilities)
VALUES
    -- Anthropic: $3/$15 per MTok
    ('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'anthropic',
     'anthropic-messages', 'https://api.anthropic.com', 1,
     1000000, 64000,
     3.000000, 15.000000, 0.300000, 3.750000,
     TRUE, '["text","code","reasoning","vision","long-context"]');

-- ── Tier 2: API heavy ────────────────────────────────────────────────────────

INSERT INTO models
    (slug, display_name, provider, api, base_url, tier,
     context_window, max_output_tokens,
     cost_input, cost_output, cost_cache_read, cost_cache_write,
     reasoning, capabilities)
VALUES
    -- Anthropic: $5/$25 per MTok
    ('claude-opus-4-8', 'Claude Opus 4.8', 'anthropic',
     'anthropic-messages', 'https://api.anthropic.com', 2,
     1000000, 128000,
     5.000000, 25.000000, 0.500000, 6.250000,
     TRUE, '["text","code","reasoning","vision","long-context"]'),

    -- Anthropic: $10/$50 per MTok
    ('claude-fable-5', 'Claude Fable 5', 'anthropic',
     'anthropic-messages', 'https://api.anthropic.com', 2,
     1000000, 128000,
     10.000000, 50.000000, 1.000000, 12.500000,
     TRUE, '["text","code","reasoning","vision","long-context"]');
