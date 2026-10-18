-- Mark Claude Sonnet 5.5 as a model that writes progress updates between
-- tool calls.
--
-- The Anthropic adapter sends `thinking: {"type": "adaptive", "display":
-- "updates"}` (beta header `thinking-display-updates-2026-08-18`) only to a
-- model whose capabilities include "thinking-progress-updates". Under that
-- setting the model's progress updates come back as readable thinking text,
-- which the operator sees between tool calls, while its reasoning stays
-- hidden. Without it, Sonnet 5.5's default `display: "omitted"` returns those
-- updates empty and the operator sees nothing between tool calls.
--
-- Source: https://platform.claude.com/docs/en/build-with-claude/thinking
-- ("Progress updates between tool calls", "Controlling thinking display"),
-- read 2026-10-18. The docs list progress updates for Claude Fable 5.1,
-- Claude Mythos 5.1, Claude Opus 5.5, Claude Sonnet 5.5 and Claude Fable 5.
-- Only Claude Sonnet 5.5 is marked here; the others are untested with it.
--
-- Idempotent: the row's capabilities are set to the full list, whatever they
-- were.

UPDATE models
SET capabilities =
    '["text","code","reasoning","vision","tools","thinking","thinking-progress-updates","long-context"]'
WHERE slug = 'claude-sonnet-5-5';
