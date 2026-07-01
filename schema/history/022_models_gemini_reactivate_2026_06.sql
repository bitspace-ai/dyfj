-- DYFJ — Re-activate Gemini rows with confirmed slugs
--
-- 021 deactivated the Google rows pending provider-id verification. The slugs
-- have now been confirmed against the provider model list:
--
--   gemini-3.5-flash   — present and valid. Re-activate as-is.
--   gemini-3.1-pro     — not a served id. The available 3.1 Pro is the
--                        preview-suffixed gemini-3.1-pro-preview (Gemini 3.x
--                        ids still carry the -preview suffix). Correct + reactivate.
--
-- Pricing/context on these rows are unchanged from 015 (informational, not
-- load-bearing for routing); the durable answer is the catalog sync in the
-- 2026-06-20 model-registry working thesis.

-- gemini-3.5-flash: valid, re-activate.
UPDATE models
SET active = TRUE
WHERE slug = 'gemini-3.5-flash';

-- gemini-3.1-pro -> gemini-3.1-pro-preview, re-activate.
UPDATE models
SET slug = 'gemini-3.1-pro-preview', active = TRUE
WHERE slug = 'gemini-3.1-pro';
