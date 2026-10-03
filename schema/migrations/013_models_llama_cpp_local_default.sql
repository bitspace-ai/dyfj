-- Add DeepSeek-R1 Distill 32B served by llama.cpp's llama-server as the
-- preferred local model. It reaches llama-server's OpenAI-compatible endpoint
-- on its default port, http://localhost:8080/v1. llama-server serves the model it was started
-- with; start it with `--alias llama-cpp/deepseek-r1-32b` so its model list
-- reports this slug. Local inference is free, so every cost field is 0.
--
-- The Ollama rows stay as they are: Ollama remains a supported local provider,
-- now second in the local preference order.
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
    'llama-cpp/deepseek-r1-32b',
    'DeepSeek-R1 Distill 32B (llama.cpp)',
    'llama-cpp',
    'openai-completions',
    'http://localhost:8080/v1',
    0,
    131072,
    8192,
    0.000000,
    0.000000,
    0.000000,
    0.000000,
    TRUE,
    '["text","code","reasoning","thinking"]',
    'dense',
    32.80,
    32.80,
    'Q4_K_M',
    22.00,
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
-- `active` is deliberately absent above: where the slug already exists, its
-- active state is the installation's choice and re-running this migration must
-- not change it.
