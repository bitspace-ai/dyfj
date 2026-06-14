-- DYFJ — Local default becomes a capable MoE coder, 2026-06
--
-- The 4B MLX default badly under-used a high-memory Apple Silicon machine.
-- Replace it with Qwen3-Coder-30B-A3B-Instruct (8-bit): a Mixture-of-Experts
-- coder, 30B total / ~3B active per token, so it is capable AND fast on Apple
-- Silicon (~32GB resident, with ample headroom on a high-memory machine).
-- This is the "owned-local-large" sovereign-capable tier — capable open
-- weights running on owned hardware. Ollama (laguna/gemma) remains the
-- fast-small local floor on its own endpoint.
--
-- The MLX-LM server loads one model per endpoint, so the old 4B row is
-- deactivated (it pointed at the same 127.0.0.1:18080 endpoint that now serves
-- the 30B). Context window reflects the model's long-context capability;
-- max_output matches the server's operational cap.
--
-- Tier semantics unchanged: 0 local / 1 API light / 2 API heavy.

UPDATE models SET active = FALSE
  WHERE slug = 'mlx-community/Qwen3.5-4B-8bit';

INSERT INTO models
    (slug, display_name, provider, api, base_url, tier,
     context_window, max_output_tokens,
     cost_input, cost_output, cost_cache_read, cost_cache_write,
     reasoning, capabilities)
VALUES
    ('mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit', 'Qwen3-Coder 30B MLX',
     'mlx-lm', 'openai-completions', 'http://127.0.0.1:18080/v1', 0,
     262144, 8192,
     0, 0, 0, 0,
     TRUE, '["text","code","reasoning","long-context"]');
