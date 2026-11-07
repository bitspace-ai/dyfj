-- Verified effort support for the request defaults. No prices or activation
-- settings change. Sources checked 2026-11-05:
-- https://openrouter.ai/api/v1/models
-- https://platform.claude.com/docs/en/build-with-claude/effort
-- https://docs.x.ai/developers/model-capabilities/text/reasoning

UPDATE models SET reasoning_effort_control = TRUE WHERE slug IN (
    'claude-fable-5',
    'deepseek/deepseek-v4-pro-0813',
    'deepseek/deepseek-v4.1-flash-1017',
    'meta/muse-glimmer-30b',
    'moonshotai/kimi-k3.1-pro',
    'z-ai/glm-5.3'
);

-- These models expose reasoning without an effort-level control.
UPDATE models SET reasoning_effort_control = FALSE WHERE slug IN (
    'grok-build-0.1',
    'minimax/minimax-m3'
);

-- Keep the larger request default within the advertised provider limit.
UPDATE models SET max_output_tokens = 16384 WHERE slug IN (
    'meta/muse-glimmer-30b',
    'qwen/qwen3-next-80b-a3b-instruct'
);
