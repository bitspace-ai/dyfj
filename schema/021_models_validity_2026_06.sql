-- DYFJ — Model registry validity fixes, 2026-06 (BIT-168)
--
-- The hosted-model slugs were validated against each provider's live model
-- list for the first time (015's "SLUG CAVEAT" asked for exactly this once the
-- slugs could be confirmed). Results:
--
--   OpenAI    gpt-5.4-mini / gpt-5.4 / gpt-5.5            — present, valid.
--   Anthropic claude-sonnet-4-6 / claude-opus-4-8 /
--             claude-fable-5                             — present, valid.
--   Anthropic claude-haiku-4-5                           — wrong: the real API
--             id is claude-haiku-4-5-20251001 (dated). Bare slug is not served.
--   Google    gemini-3.1-pro                             — not found (404) at
--             generateContent.
--   Google    gemini-3.5-flash                           — could not be verified
--             against the provider model list.
--
-- Actions:
--   1. Correct the Anthropic Haiku slug to its dated API id.
--   2. Deactivate both Google rows pending provider-id verification and Google
--      key-configuration cleanup, so the picker (BIT-164) stops surfacing models
--      that fail at call time. Re-activate in a later migration once verified.

-- 1. Anthropic Haiku: bare slug -> dated API id.
UPDATE models
SET slug = 'claude-haiku-4-5-20251001'
WHERE slug = 'claude-haiku-4-5';

-- 2. Google: deactivate pending provider-id verification + key-config cleanup.
UPDATE models
SET active = FALSE
WHERE slug IN ('gemini-3.1-pro', 'gemini-3.5-flash');
