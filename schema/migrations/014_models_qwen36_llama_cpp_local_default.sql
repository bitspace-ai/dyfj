-- Use the llama.cpp-compatible Qwen3.6 GGUF at the 32K context actually served.
-- Retain the DeepSeek row for rollback, but do not route it to the Qwen server.
UPDATE models SET active = FALSE WHERE slug = 'llama-cpp/deepseek-r1-32b';

INSERT INTO models (
    slug, display_name, provider, api, base_url, tier,
    context_window, max_output_tokens, cost_input, cost_output,
    cost_cache_read, cost_cache_write, reasoning, capabilities,
    architecture, total_params_b, active_params_b, recommended_quant,
    resident_ram_gib, reasoning_effort_control, active
) VALUES (
    'llama-cpp/qwen3.6-35b-a3b',
    'Qwen3.6 35B-A3B (llama.cpp)',
    'llama-cpp',
    'openai-completions',
    'http://localhost:8080/v1',
    0,
    32768,
    8192,
    0.000000,
    0.000000,
    0.000000,
    0.000000,
    TRUE,
    '["text","code","reasoning","tools"]',
    'moe',
    35.00,
    3.00,
    'UD-Q4_K_XL',
    24.00,
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
