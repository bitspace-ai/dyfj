-- Align ACP model active states: keep implemented codex-chatgpt active,
-- while deactivating ACP runner routes whose subprocess adapters are not yet implemented.

UPDATE models SET active = FALSE WHERE slug IN (
    'claude-acp/claude-fable-5',
    'cursor-agent/composer-2.0',
    'gemini-antigravity/gemini-3.7-flash',
    'grok-build/grok-4.6'
);
