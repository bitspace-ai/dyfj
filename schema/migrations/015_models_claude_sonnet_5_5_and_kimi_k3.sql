-- Add Claude Sonnet 5.5 (Anthropic direct) and Kimi K3 (OpenRouter) to the
-- model catalog.
--
-- Prices verified 2026-10-18. Per-million USD. Sources, captured figures and
-- the dates behind them are in schema/catalog/VERIFICATION-2026-10-18.md.
--
-- Claude Sonnet 5.5, from Anthropic's model page
-- (https://platform.claude.com/docs/en/models/sonnet-5-5/overview), since
-- this row routes to Anthropic directly: in $2 / out $10 / cache read $0.10 /
-- cache write $2.50. Context 1,000,000, output limit 128,000.
--
-- Anthropic publishes two cache-write prices: $2.50 for a 5-minute cache and
-- $4 for a 1-hour cache. The row stores the 5-minute rate, as the
-- claude-sonnet-5 row does. A consumer writing 1-hour caches pays more than
-- the catalog predicts. The 300,000-token output limit on the Batch API (beta)
-- is not modelled; the row records the standard 128,000.
--
-- Kimi K3, from the OpenRouter catalog (https://openrouter.ai/api/v1/models),
-- since this row routes through OpenRouter as moonshotai/kimi-k2-0905 does:
-- in $0.304 / out $11.936 / cache read $0.21. Context 1,048,576, output limit
-- 943,718. The slug is OpenRouter's alias moonshotai/kimi-k3; its canonical
-- slug is moonshotai/kimi-k3-20260715.
--
-- Kimi K3 cache write is 0, meaning not published rather than free.
--
-- Kimi K3's default reasoning effort is "max", and OpenRouter bills reasoning
-- tokens as output at $11.936 per million. A turn that does not lower the
-- effort can spend far more on output than its visible reply suggests. This
-- codebase sends reasoning_effort only to provider 'openai', so every Kimi K3
-- turn through it runs at the "max" default.
--
-- Kimi K3's prices are OpenRouter's model-level listing, which matched the
-- InferenceNet upstream at capture time. OpenRouter serves the model from many
-- upstream providers at different rates, some much higher (Moonshot AI's own
-- endpoint charges in $3 / out $15). OpenRouter may route a request to any of
-- these upstreams, so the actual charge can differ from this row; see the
-- follow-up on provider pinning. The verification note lists the rates.
--
-- Inferred, not sourced. Each new row copies these fields from its closest
-- sibling rather than from a provider statement:
--   claude-sonnet-5-5 from claude-sonnet-5: provider, api, base_url, tier,
--     reasoning, capabilities, reasoning_effort_control.
--   moonshotai/kimi-k3 from moonshotai/kimi-k2-0905: provider, api, base_url,
--     tier, reasoning, capabilities, reasoning_effort_control.
-- The Kimi K3 architecture fields are NULL. The kimi-k2-0905 values describe a
-- different model, and no source gives K3's active parameter count.
--
-- The older claude-sonnet-5 and moonshotai/kimi-k2-0905 rows stay active, for
-- comparison.
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
    'claude-sonnet-5-5',
    'Claude Sonnet 5.5',
    'anthropic',
    'anthropic-messages',
    'https://api.anthropic.com',
    1,
    1000000,
    128000,
    2.000000,
    10.000000,
    0.100000,
    2.500000,
    TRUE,
    '["text","code","reasoning","vision","tools","thinking","long-context"]',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    TRUE,
    TRUE
),
(
    'moonshotai/kimi-k3',
    'Kimi K3',
    'openrouter',
    'openai-completions',
    'https://openrouter.ai/api/v1',
    2,
    1048576,
    943718,
    0.304000,
    11.936000,
    0.210000,
    0.000000,
    TRUE,
    '["text","code","reasoning","tools","long-context"]',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    FALSE,
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
-- but where either slug already exists its active state is the installation's
-- choice: an operator may have disabled the model on purpose, and re-running
-- this migration must not route traffic back to it.
