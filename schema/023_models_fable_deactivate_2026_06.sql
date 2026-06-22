-- DYFJ — Deactivate Claude Fable 5 (UAT)
--
-- claude-fable-5 appears in the provider model list but is not currently usable
-- (availability is externally constrained). This is the case that proves
-- ListModels presence is necessary but not sufficient: a model can be in the
-- catalog yet not callable, and only operator curation catches it. Deactivate
-- until it is generally available; the durable home for this kind of
-- enabled/usable judgement is the curation layer in the 2026-06-20
-- model-registry working thesis.

UPDATE models
SET active = FALSE
WHERE slug = 'claude-fable-5';
