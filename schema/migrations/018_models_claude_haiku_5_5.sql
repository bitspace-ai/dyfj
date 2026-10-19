-- Add Claude Haiku 5.5 (Anthropic direct) to the model catalog.
--
-- Prices verified 2026-10-18. Per-million USD. The source, captured figures
-- and the date behind them are in schema/catalog/VERIFICATION-2026-10-18.md.
--
-- Claude Haiku 5.5, from Anthropic's model page
-- (https://platform.claude.com/docs/en/models/haiku-5-5/overview), since this
-- row routes to Anthropic directly. Context 1,000,000, output limit 128,000.
--
-- Anthropic prices Haiku 5.5 by prompt size, and a row holds one number per
-- field. The row records the tier for prompts over 100,000 tokens: in $0.50 /
-- out $2.50 / cache read $0.05 / cache write $0.625. Prompts up to 100,000
-- tokens are billed at a fifth of these rates: in $0.10 / out $0.50 / cache
-- read $0.01 / cache write $0.125. As in migration 012, the higher figure
-- wins, because spending past a limit cannot be undone. A long agent session
-- passes 100,000 tokens of prompt quickly, so the higher tier is the
-- realistic one there; a short turn costs less than the catalog predicts.
--
-- Anthropic publishes two cache-write prices: $0.625 for a 5-minute cache and
-- $1 for a 1-hour cache (over 100,000 tokens). The row stores the 5-minute
-- rate, as the claude-sonnet-5-5 row does. The 300,000-token output limit on
-- the Batch API (beta) is not modelled; the row records the standard 128,000.
--
-- No "thinking-progress-updates" capability. Haiku 5.5 runs adaptive
-- thinking by default, but Anthropic's thinking guide
-- (https://platform.claude.com/docs/en/build-with-claude/thinking, read
-- 2026-10-18) lists progress updates between tool calls only for Claude
-- Fable 5.1, Claude Mythos 5.1, Claude Opus 5.5, Claude Sonnet 5.5 and
-- Claude Fable 5. The adapter therefore sends Haiku 5.5 no thinking
-- configuration, and the model's default `display: "omitted"` applies. The
-- adapter still preserves and replays its thinking blocks.
--
-- Inferred, not sourced. The row copies these fields from claude-sonnet-5-5
-- rather than from a provider statement: provider, api, base_url, tier,
-- reasoning, reasoning_effort_control, and capabilities without
-- "thinking-progress-updates".
--
-- The older claude-haiku-4-5-20251001 row stays active, for comparison.
--
-- Tier semantics unchanged from 006: 0 local / 1 API light / 2 API heavy.

INSERT INTO models (
    slug,
    display_name,
    provider,
    api,
    base_url,
    tier,
    context_window,
    max_output_tokens,
    cost_input,
    cost_output,
    cost_cache_read,
    cost_cache_write,
    reasoning,
    capabilities,
    architecture,
    total_params_b,
    active_params_b,
    recommended_quant,
    resident_ram_gib,
    reasoning_effort_control,
    active
) VALUES (
    'claude-haiku-5-5',
    'Claude Haiku 5.5',
    'anthropic',
    'anthropic-messages',
    'https://api.anthropic.com',
    1,
    1000000,
    128000,
    0.500000,
    2.500000,
    0.050000,
    0.625000,
    TRUE,
    '["text","code","reasoning","vision","tools","thinking","long-context"]',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    TRUE,
    TRUE
)
ON DUPLICATE KEY UPDATE
    `display_name` = VALUES(`display_name`),
    `provider` = VALUES(`provider`),
    `api` = VALUES(`api`),
    `base_url` = VALUES(`base_url`),
    `tier` = VALUES(`tier`),
    `context_window` = VALUES(`context_window`),
    `max_output_tokens` = VALUES(`max_output_tokens`),
    `cost_input` = VALUES(`cost_input`),
    `cost_output` = VALUES(`cost_output`),
    `cost_cache_read` = VALUES(`cost_cache_read`),
    `cost_cache_write` = VALUES(`cost_cache_write`),
    `reasoning` = VALUES(`reasoning`),
    `capabilities` = VALUES(`capabilities`),
    `architecture` = VALUES(`architecture`),
    `total_params_b` = VALUES(`total_params_b`),
    `active_params_b` = VALUES(`active_params_b`),
    `recommended_quant` = VALUES(`recommended_quant`),
    `resident_ram_gib` = VALUES(`resident_ram_gib`),
    `reasoning_effort_control` = VALUES(`reasoning_effort_control`);
-- `active` is deliberately absent above. A fresh row takes the INSERT value,
-- but where the slug already exists its active state is the installation's
-- choice: an operator may have disabled the model on purpose, and re-running
-- this migration must not route traffic back to it.
