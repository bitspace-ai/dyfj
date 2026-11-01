-- Refresh seven OpenRouter model rows using the model-level API listing.
-- Observed prices and token limits were captured 2026-11-01T01:01:07Z from
-- https://openrouter.ai/api/v1/models and each model's /endpoints listing.
-- Prices are USD per million tokens; multiply the source per-token value
-- by 1,000,000. For example, DeepSeek input 0.000000115 * 1,000,000 = 0.115000.
-- Source figures and upstream spreads: schema/catalog/VERIFICATION-2026-11-01.md.
-- These are model-level prices, not a selected upstream's prices. The runtime
-- caps OpenRouter input/output prices at the catalog rates; endpoint limits
-- and rates can differ. cache_write 0 means NOT PUBLISHED, not verified free.
--
-- Inferred, not sourced: each new row copies provider, api, base_url, tier,
-- reasoning, capabilities and reasoning_effort_control from its replacement:
--   moonshotai/kimi-k3.1-pro <- moonshotai/kimi-k3
--   deepseek/deepseek-v4-pro-0813 <- deepseek/deepseek-r1
--   x-ai/grok-4.7 <- x-ai/grok-4.6
--   meta/muse-spark-1.3 <- meta/muse-spark-1.2
--   minimax/minimax-m3 <- minimax/minimax-m1
--   mistralai/mistral-small-2603 <- mistralai/mistral-small-3.2-24b-instruct
--   qwen/qwen3-coder-next <- qwen/qwen3-coder
-- Architecture, parameter counts, quantization and resident RAM stay NULL:
-- this capture does not establish them for these rows.
-- Tier semantics unchanged: 0 local / 1 API light / 2 API heavy.
--
-- DELETE, not active = FALSE: replaced slugs are removed from the catalog.
-- No schema foreign key references models; historical events keep their text
-- slugs and the read paths tolerate a missing catalog row.
-- Also remove qwen/qwen3-coder-plus and qwen/qwen3-max (no longer listed),
-- minimax/minimax-01 (superseded by the M line), and
-- tencent/hunyuan-a13b-instruct (renamed hy3, with unclear lineage).
-- Leave qwen/qwen3-next-80b-a3b-instruct as it is: still listed, with no clear
-- successor. The fresh catalog seeds it; this migration neither adds nor deletes it.

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
) VALUES
    (
        'moonshotai/kimi-k3.1-pro',
        'Kimi K3.1 Pro',
        'openrouter',
        'openai-completions',
        'https://openrouter.ai/api/v1',
        2,
        1048576,
        943718,
        2.000000,
        10.000000,
        0.200000,
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
    ),
    (
        'deepseek/deepseek-v4-pro-0813',
        'DeepSeek V4 Pro 0813',
        'openrouter',
        'openai-completions',
        'https://openrouter.ai/api/v1',
        2,
        1048576,
        943718,
        0.115000,
        4.000000,
        0.110000,
        0.000000,
        TRUE,
        '["text","code","reasoning","thinking","long-context"]',
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        FALSE,
        TRUE
    ),
    (
        'x-ai/grok-4.7',
        'Grok 4.7 (OpenRouter)',
        'openrouter',
        'openai-completions',
        'https://openrouter.ai/api/v1',
        2,
        500000,
        450000,
        2.000000,
        6.000000,
        0.500000,
        0.000000,
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
        'meta/muse-spark-1.3',
        'Meta Muse Spark 1.3',
        'openrouter',
        'openai-completions',
        'https://openrouter.ai/api/v1',
        2,
        1048576,
        943718,
        1.250000,
        4.250000,
        0.150000,
        0.000000,
        TRUE,
        '["text","code","reasoning","tools","thinking","long-context"]',
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        TRUE,
        TRUE
    ),
    (
        'minimax/minimax-m3',
        'MiniMax M3',
        'openrouter',
        'openai-completions',
        'https://openrouter.ai/api/v1',
        2,
        1048576,
        512000,
        0.300000,
        1.200000,
        0.060000,
        0.000000,
        TRUE,
        '["text","code","reasoning","thinking","tools","long-context"]',
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        TRUE,
        TRUE
    ),
    (
        'mistralai/mistral-small-2603',
        'Mistral Small 2603',
        'openrouter',
        'openai-completions',
        'https://openrouter.ai/api/v1',
        1,
        262144,
        209715,
        0.150000,
        0.600000,
        0.015000,
        0.000000,
        FALSE,
        '["text","code","reasoning","tools","long-context"]',
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        FALSE,
        TRUE
    ),
    (
        'qwen/qwen3-coder-next',
        'Qwen3 Coder Next',
        'openrouter',
        'openai-completions',
        'https://openrouter.ai/api/v1',
        1,
        262144,
        235929,
        0.120000,
        0.800000,
        0.070000,
        0.000000,
        FALSE,
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
-- `active` is deliberately absent above: the upsert preserves an existing
-- replacement row's active state. Before deleting predecessors, the UPDATE
-- below disables replacements whose predecessors were disabled. It can only
-- disable, so applying or re-running this migration never re-enables a model.

UPDATE models AS replacement
JOIN models AS predecessor ON
    (replacement.slug = 'moonshotai/kimi-k3.1-pro' AND predecessor.slug = 'moonshotai/kimi-k3')
    OR (replacement.slug = 'deepseek/deepseek-v4-pro-0813' AND predecessor.slug = 'deepseek/deepseek-r1')
    OR (replacement.slug = 'x-ai/grok-4.7' AND predecessor.slug = 'x-ai/grok-4.6')
    OR (replacement.slug = 'meta/muse-spark-1.3' AND predecessor.slug = 'meta/muse-spark-1.2')
    OR (replacement.slug = 'minimax/minimax-m3' AND predecessor.slug = 'minimax/minimax-m1')
    OR (replacement.slug = 'mistralai/mistral-small-2603' AND predecessor.slug = 'mistralai/mistral-small-3.2-24b-instruct')
    OR (replacement.slug = 'qwen/qwen3-coder-next' AND predecessor.slug = 'qwen/qwen3-coder')
SET replacement.active = FALSE
WHERE predecessor.active = FALSE;

DELETE FROM models WHERE slug IN (
    'moonshotai/kimi-k3',
    'deepseek/deepseek-r1',
    'x-ai/grok-4.6',
    'meta/muse-spark-1.2',
    'minimax/minimax-m1',
    'mistralai/mistral-small-3.2-24b-instruct',
    'qwen/qwen3-coder',
    'qwen/qwen3-coder-plus',
    'qwen/qwen3-max',
    'minimax/minimax-01',
    'tencent/hunyuan-a13b-instruct'
);
