-- DYFJ — Gemini hosted rows for the google-generative-ai adapter, 2026-06
--
-- Part A2 of dfj-1dv.15: with the google-generative-ai adapter shipped,
-- reactivate Gemini as metered hosted inference. The stale gemini-2.5-*
-- rows stay deactivated (deactivated in 014); these are the current models.
--
-- Standard (non-cached) per-MTok pricing, verified 2026-06-13 against public
-- aggregators:
--   gemini-3.1-pro    $2.00 / $12.00  (input rises above 200k context)
--   gemini-3.5-flash  $1.50 / $9.00
-- cost_cache_* are 0: Gemini context caching is a separate explicit feature,
-- not wired into the adapter, so no cache pricing is modeled here.
--
-- SLUG CAVEAT: gemini-3.1-pro / gemini-3.5-flash follow Google's consistent
-- generational naming and match every aggregator, but were not confirmed
-- against the live ListModels endpoint (needs a GEMINI_API_KEY, which the
-- operator does not yet hold). Confirm the exact API id when a key is added;
-- a dated/preview suffix is possible. Pricing/context are informational and
-- not load-bearing for routing.
--
-- Tier semantics unchanged: 0 local / 1 API light / 2 API heavy.

-- ── Tier 1: API light ────────────────────────────────────────────────────────

INSERT INTO models
    (slug, display_name, provider, api, base_url, tier,
     context_window, max_output_tokens,
     cost_input, cost_output, cost_cache_read, cost_cache_write,
     reasoning, capabilities)
VALUES
    ('gemini-3.5-flash', 'Gemini 3.5 Flash', 'google',
     'google-generative-ai', 'https://generativelanguage.googleapis.com', 1,
     1000000, 65536,
     1.500000, 9.000000, 0, 0,
     TRUE, '["text","code","reasoning","vision","long-context"]');

-- ── Tier 2: API heavy ────────────────────────────────────────────────────────

INSERT INTO models
    (slug, display_name, provider, api, base_url, tier,
     context_window, max_output_tokens,
     cost_input, cost_output, cost_cache_read, cost_cache_write,
     reasoning, capabilities)
VALUES
    ('gemini-3.1-pro', 'Gemini 3.1 Pro', 'google',
     'google-generative-ai', 'https://generativelanguage.googleapis.com', 2,
     1000000, 65536,
     2.000000, 12.000000, 0, 0,
     TRUE, '["text","code","reasoning","vision","long-context"]');
