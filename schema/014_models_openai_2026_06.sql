-- DYFJ — OpenAI hosted rows + deactivate the adapterless Gemini rows, 2026-06
--
-- Part A of the subscription-inference-lanes work: make the GPT
-- family selectable as metered hosted inference through the openai-completions
-- adapter (hosted path: https base URL + OPENAI_API_KEY bearer, behind the
-- existing paid-escalation gate). The subscription lane (Part B) is separate.
--
-- Pricing is standard (non-cached) per-MTok, verified 2026-06-13 against
-- public OpenAI pricing aggregators:
--   gpt-5.5      $5.00 / $30.00   (cached input ~$0.50)
--   gpt-5.4      $2.50 / $15.00   (cached input ~$0.25)
--   gpt-5.4-mini $0.75 / $4.50    (cached input ~$0.075)
-- cost_cache_write is 0: OpenAI prompt caching is automatic with no write
-- surcharge (unlike Anthropic). Cache accounting is not yet wired into the
-- openai adapter, so cost_cache_read here is informational until then.
-- Context windows for the 5.4 family are inferred from the 5.5 generation
-- (1,050,000 / 128K) pending confirmation; not load-bearing for routing.
--
-- Tier semantics unchanged: 0 local / 1 API light / 2 API heavy.

-- ── Deactivate Gemini rows until native routing owns them ────────────────────
-- Keep the picker aligned with provider adapters that can execute a turn.

UPDATE models SET active = FALSE
  WHERE slug IN ('gemini-2.5-flash', 'gemini-2.5-pro');

-- ── Tier 1: API light ────────────────────────────────────────────────────────

INSERT INTO models
    (slug, display_name, provider, api, base_url, tier,
     context_window, max_output_tokens,
     cost_input, cost_output, cost_cache_read, cost_cache_write,
     reasoning, capabilities)
VALUES
    ('gpt-5.4-mini', 'GPT-5.4 mini', 'openai',
     'openai-completions', 'https://api.openai.com/v1', 1,
     1050000, 128000,
     0.750000, 4.500000, 0.075000, 0,
     TRUE, '["text","code","reasoning","vision","long-context"]');

-- ── Tier 2: API heavy ────────────────────────────────────────────────────────

INSERT INTO models
    (slug, display_name, provider, api, base_url, tier,
     context_window, max_output_tokens,
     cost_input, cost_output, cost_cache_read, cost_cache_write,
     reasoning, capabilities)
VALUES
    ('gpt-5.4', 'GPT-5.4', 'openai',
     'openai-completions', 'https://api.openai.com/v1', 2,
     1050000, 128000,
     2.500000, 15.000000, 0.250000, 0,
     TRUE, '["text","code","reasoning","vision","long-context"]'),

    ('gpt-5.5', 'GPT-5.5', 'openai',
     'openai-completions', 'https://api.openai.com/v1', 2,
     1050000, 128000,
     5.000000, 30.000000, 0.500000, 0,
     TRUE, '["text","code","reasoning","vision","long-context"]');
