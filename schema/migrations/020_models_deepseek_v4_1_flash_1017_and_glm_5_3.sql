-- Add DeepSeek V4.1 Flash 1017 and GLM 5.3 (both OpenRouter) to the model
-- catalog, and remove the superseded and retired rows in one trim.
--
-- Prices verified 2026-10-28 from OpenRouter's own JSON listings
-- (https://openrouter.ai/api/v1/models and
-- https://openrouter.ai/api/v1/models/<slug>/endpoints), captured
-- 2026-10-28. Per-million USD. Sources, captured figures, the upstream spread
-- and the dates behind them are in schema/catalog/VERIFICATION-2026-10-28.md.
--
-- DeepSeek V4.1 Flash 1017, slug deepseek/deepseek-v4.1-flash-1017, created
-- 2026-10-17: in $0.15 / out $0.60 / cache read $0.003 / cache write not
-- published. Context 1,048,576, output limit 393,216.
--
-- GLM 5.3, slug z-ai/glm-5.3, created 2026-08-18: in $0.0699 / out $1.40 /
-- cache read $0.0689 / cache write not published. Context 1,048,576, output
-- limit 943,718.
--
-- Both rows record OpenRouter's MODEL-LEVEL listing, as the moonshotai/kimi-k3
-- row does. OpenRouter serves each model from many upstreams at different
-- rates, and the listing is the rate the model page shows rather than the
-- cheapest or the dearest upstream. The verification note records the spread
-- for each. OpenRouter may route a request to any of these upstreams, so the
-- actual charge can differ from these rows; see the follow-up on provider
-- pinning. cache_write 0 means NOT PUBLISHED, not verified free.
--
-- Inferred, not sourced. Each new row copies these fields from its closest
-- sibling rather than from a provider statement:
--   deepseek/deepseek-v4.1-flash-1017 from deepseek/deepseek-v4.1-flash:
--     provider, api, base_url, tier, reasoning, capabilities,
--     reasoning_effort_control.
--   z-ai/glm-5.3 from z-ai/glm-5.2: provider, api, base_url, tier, reasoning,
--     capabilities, reasoning_effort_control.
-- The architecture columns stay NULL: no source gives either model's active
-- parameter count.
--
-- GPT-6.1 Terra is NOT added. OpenAI's model page states that tool calling on
-- GPT-6.1 requires the Responses API, and the openai rows here use
-- openai-completions, so a direct row could not carry a tool call. The
-- gpt-5.6 rows stay. GLM 5.3 Prime is not added.
--
-- DELETE, not active = FALSE. Rows taken out of view are removed from the
-- table. Nothing in schema/ declares a foreign key to models, and events name
-- a model by slug in a text column, so an older event keeps naming a slug that
-- is no longer in the catalog; the read paths tolerate a missing slug. This is
-- the first trim; more will follow.
--
--   49 rows in all, in three groups:
--     every provider = 'ollama' row (15), some active and some inactive;
--     every other row already inactive (21);
--     the superseded generations still active (13), listed below.
--     One inactive row is the exception kept: gemini-antigravity/gemini-3.7-flash,
--     because no 3.8 has shipped on that route.
--   Superseded generations still active on a route that now has a newer row of
--     the same line:
--       claude-haiku-4-5-20251001  <- claude-haiku-5-5
--       claude-sonnet-5            <- claude-sonnet-5-5
--       gemini-3.6-flash           <- gemini-3.8-flash
--       gemini-3.7-flash           <- gemini-3.8-flash
--       deepseek/deepseek-chat     <- deepseek/deepseek-v4.1-flash-1017
--       deepseek/deepseek-v3.1-terminus <- deepseek/deepseek-v4.1-flash-1017
--       z-ai/glm-4.5               <- z-ai/glm-5.3
--       z-ai/glm-4.5-air           <- z-ai/glm-5.3
--       meta-llama/llama-3.3-70b-instruct <- llama-4-maverick / llama-4-scout
--       moonshotai/kimi-k2-0905    <- moonshotai/kimi-k3
--       grok-4.3                   <- grok-4.6
--       x-ai/grok-4.3              <- x-ai/grok-4.6
--       deepseek/deepseek-v4.1-flash <- deepseek/deepseek-v4.1-flash-1017
--         (the undated slug is the 2026-09-10 snapshot, not 1017)
--
-- Kept: gemini-antigravity/gemini-3.7-flash (no 3.8 on that route) is the
-- only inactive row kept (llama-cpp/deepseek-r1-32b is deleted above), and
-- every other row with a single generation on its route stays.
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
    'deepseek/deepseek-v4.1-flash-1017',
    'DeepSeek V4.1 Flash 1017',
    'openrouter',
    'openai-completions',
    'https://openrouter.ai/api/v1',
    1,
    1048576,
    393216,
    0.150000,
    0.600000,
    0.003000,
    0.000000,
    TRUE,
    '["text","code","reasoning","long-context"]',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    FALSE,
    TRUE
),
(
    'z-ai/glm-5.3',
    'GLM 5.3',
    'openrouter',
    'openai-completions',
    'https://openrouter.ai/api/v1',
    1,
    1048576,
    943718,
    0.069900,
    1.400000,
    0.068900,
    0.000000,
    TRUE,
    '["text","code","reasoning","long-context"]',
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

DELETE FROM models WHERE slug IN (
    -- provider = 'ollama' (15), active and inactive
    'deepseek-r1:32b',
    'gemma4',
    'gemma4:26b',
    'gemma4:e2b',
    'gpt-oss-120b',
    'laguna-xs-2.1',
    'laguna-xs.2',
    'mistral-small-4-119b-a6b',
    'mistral-small:24b-instruct-2501-q4_K_M',
    'muse-glimmer:30b',
    'qwen3-coder-next-80b-a3b',
    'qwen3:30b-a3b',
    'qwen3:32b',
    'qwen3.5-122b-a10b',
    'qwen3.6:35b-a3b',
    -- already inactive, non-ollama (21)
    'claude-acp/claude-fable-5',
    'claude-opus-4-5',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'cursor-agent/composer-2.0',
    'deepseek/deepseek-v4-flash',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-3.5-flash',
    'gpt-5.3-codex',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.5',
    'grok-4.5',
    'grok-build/grok-4.6',
    'llama-cpp/deepseek-r1-32b',
    'mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit',
    'mlx-community/Qwen3.5-4B-8bit',
    'nvidia/nemotron-3-ultra-550b-a55b',
    'tencent/hy3',
    'z-ai/glm-5.2',
    -- superseded generations still active (13)
    'claude-haiku-4-5-20251001',
    'claude-sonnet-5',
    'deepseek/deepseek-chat',
    'deepseek/deepseek-v3.1-terminus',
    'deepseek/deepseek-v4.1-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'grok-4.3',
    'meta-llama/llama-3.3-70b-instruct',
    'moonshotai/kimi-k2-0905',
    'x-ai/grok-4.3',
    'z-ai/glm-4.5',
    'z-ai/glm-4.5-air'
);
