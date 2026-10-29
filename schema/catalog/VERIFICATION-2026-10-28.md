# Catalog verification — 2026-10-28

Sources and figures behind the `deepseek/deepseek-v4.1-flash-1017` and
`z-ai/glm-5.3` rows in `001_models.sql`, the matching
`../migrations/020_models_deepseek_v4_1_flash_1017_and_glm_5_3.sql`, and the
49-row trim that migration performs.

This file records the source and capture date for each new row's input, output,
cache-read and cache-write prices and its token limits, so a later reader can
re-check them against the same source. It does not cover every column in the
row; the fields copied from a sibling row are listed under "Inferred fields".

Both rows route through OpenRouter, so both are verified against OpenRouter's
own API listings rather than a vendor page.

## DeepSeek V4.1 Flash 1017

Routes to OpenRouter: `provider = 'openrouter'`,
`base_url = 'https://openrouter.ai/api/v1'`.

Source: `https://openrouter.ai/api/v1/models` and
`https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash-1017/endpoints`,
captured 2026-10-28. The model-level listing gives `id`
`deepseek/deepseek-v4.1-flash-1017`, `created` 2026-10-17. The row uses the
`id`, which is the alias a request names. The listing is a dated snapshot:
DeepSeek V4.1 Flash also has an undated alias, `deepseek/deepseek-v4.1-flash`,
which is a different entry (see "The undated slug" below).

| field | source value | row |
| --- | --- | --- |
| `pricing.prompt` | 0.00000015 per token | `cost_input` 0.150000 |
| `pricing.completion` | 0.0000006 per token | `cost_output` 0.600000 |
| `pricing.input_cache_read` | 0.000000003 per token | `cost_cache_read` 0.003000 |
| `pricing.input_cache_write` | absent | `cost_cache_write` 0.000000 |
| `context_length` | 1,048,576 | `context_window` 1048576 |
| `top_provider.max_completion_tokens` | 393,216 | `max_output_tokens` 393216 |

`cost_cache_write` 0 means **not published**, not verified free.

The row records OpenRouter's model-level listing, as the `moonshotai/kimi-k3`
row does. That is the entry the model page shows, not the cheapest or the
dearest upstream.

### The upstream spread

OpenRouter serves this model from 41 upstream providers at different rates.
The endpoints listing, captured 2026-10-28, gives these per-million prices at
the ends of the spread:

| upstream | input | output |
| --- | --- | --- |
| OpenInference | $0.0138 | $1.80 |
| Fireworks | $0.45 | $1.80 |

The model page's rendered headline and the API's endpoint prices do not agree:
the page shows "$0.02 / $1 per 1M", while the endpoint listing gives no
upstream at those figures (the cheapest, OpenInference, is $0.0138 / $1.80).
The row records the API's model-level listing ($0.15 in / $0.60 out), as
migration 015's Kimi K3 row does, rather than the rendered headline or either
end of the upstream spread. A request served by OpenInference costs about a
tenth of the recorded input price; one served by Fireworks costs about three
times it. OpenRouter may route a request to any of these upstreams, so the
actual charge can differ from this row; see the follow-up on provider pinning.

### The undated slug is not 1017

`deepseek/deepseek-v4.1-flash` is a separate listing with `created` 2026-09-10:
the September snapshot, not the October 17 one. It is therefore not an
equivalent alias of the 1017 row but an older generation of the same line on
the same route, and migration 020 deletes it. A request that names the undated
alias no longer resolves in the catalog.

## GLM 5.3

Routes to OpenRouter: `provider = 'openrouter'`,
`base_url = 'https://openrouter.ai/api/v1'`.

Source: `https://openrouter.ai/api/v1/models` and
`https://openrouter.ai/api/v1/models/z-ai/glm-5.3/endpoints`, captured
2026-10-28. The model-level listing gives `id` `z-ai/glm-5.3`, `created`
2026-08-18.

| field | source value | row |
| --- | --- | --- |
| `pricing.prompt` | 0.0000000699 per token | `cost_input` 0.069900 |
| `pricing.completion` | 0.0000014 per token | `cost_output` 1.400000 |
| `pricing.input_cache_read` | 0.0000000689 per token | `cost_cache_read` 0.068900 |
| `pricing.input_cache_write` | absent | `cost_cache_write` 0.000000 |
| `context_length` | 1,048,576 | `context_window` 1048576 |
| `top_provider.max_completion_tokens` | 943,718 | `max_output_tokens` 943718 |

`cost_cache_write` 0 means **not published**, not verified free.

The row records OpenRouter's model-level listing, as the `moonshotai/kimi-k3`
row does. OpenRouter serves GLM 5.3 from 49 upstream providers; the listing's
spread runs up to Alibaba at $2.80 in / $8.80 out, roughly 40 times the
recorded input price and six times the recorded output price. That is the
dearest upstream, not the model-level rate; the row records the model-level
figures, consistent with the DeepSeek 1017 row and with migration 015.

### Route

The catalog routes these models through OpenRouter. Z.ai direct is not a route
in the catalog, so no Z.ai page is a source here. The GLM 5.3 row copies its
route fields from the `z-ai/glm-5.2` row, which used the same provider through
the same base URL.

### Reasoning

The listing's description states that reasoning is always on and cannot be
disabled, with supported efforts `low`, `high` and `max` and `max` as the
default. OpenRouter bills reasoning tokens as completion tokens at the output
price ($1.40 per million), so a turn at the `max` default can spend more on
output than its visible reply suggests.

The row sets `reasoning` TRUE and `reasoning_effort_control` FALSE, copied from
`z-ai/glm-5.2`. The boolean cannot hold a default level, and the
OpenAI-compatible adapter sends `reasoning_effort` only when the provider is
`openai`, so a GLM 5.3 turn through this row always runs at the model default.

## Not added

### GLM 5.3 Prime

The catalog carries no Prime row. OpenRouter lists Prime as the same model with
faster inference at a higher price (the sibling listing on the GLM 5.3 page
shows in $2.80 / out $8.80 per million). No Prime figure is recorded as
verified.

### GPT-6.1 Terra (OpenAI direct)

Dropped from this change. OpenAI's model page
(`https://developers.openai.com/api/docs/models/gpt-6.1-terra`) states that
tool calling on GPT-6.1 requires the Responses API, and the `openai` rows here
use `api = 'openai-completions'`. A direct OpenAI row could therefore not carry
a tool call, so no row is added and the `gpt-5.6` rows stay.

The `codex-chatgpt` subscription route is **not verified here** for GPT-6.1
Terra. No subscription-route row is added.

## The trim

Migration 020 deletes 49 rows. Nothing in `schema/` declares a foreign key to
`models`, and events name a model by slug in a text column, so an older event
keeps naming a slug that is no longer in the catalog and the read paths
tolerate a missing slug. The groups:

- **provider = 'ollama' (15)**, active or not: `deepseek-r1:32b`, `gemma4`,
  `gemma4:26b`, `gemma4:e2b`, `gpt-oss-120b`, `laguna-xs-2.1`, `laguna-xs.2`,
  `mistral-small-4-119b-a6b`,
  `mistral-small:24b-instruct-2501-q4_K_M`, `muse-glimmer:30b`,
  `qwen3-coder-next-80b-a3b`, `qwen3:30b-a3b`, `qwen3:32b`,
  `qwen3.5-122b-a10b`, `qwen3.6:35b-a3b`.
- **already inactive, non-Ollama (21)**: `claude-acp/claude-fable-5`,
  `claude-opus-4-5`, `claude-opus-4-8`, `claude-sonnet-4-6`,
  `cursor-agent/composer-2.0`, `deepseek/deepseek-v4-flash`, `gemini-2.5-flash`,
  `gemini-2.5-pro`, `gemini-3.5-flash`, `gpt-5.3-codex`, `gpt-5.4`,
  `gpt-5.4-mini`, `gpt-5.5`, `grok-4.5`, `grok-build/grok-4.6`,
  `llama-cpp/deepseek-r1-32b`, `mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit`,
  `mlx-community/Qwen3.5-4B-8bit`, `nvidia/nemotron-3-ultra-550b-a55b`,
  `tencent/hy3`, `z-ai/glm-5.2`.
- **superseded generations still active (13)**: the 13 slugs listed in
  migration 020 under "superseded generations still active", each with the
  newer row that justifies it.

One inactive row is **kept**: `gemini-antigravity/gemini-3.7-flash`, because no
3.8 has shipped on that route. Every other row with a single generation on its
route stays, including all 33 active rows not named above.

## Inferred fields

These fields are copied from the closest existing row, not taken from a
provider statement:

| row | copied from | fields |
| --- | --- | --- |
| `deepseek/deepseek-v4.1-flash-1017` | `deepseek/deepseek-v4.1-flash` | `provider`, `api`, `base_url`, `tier`, `reasoning`, `capabilities`, `reasoning_effort_control` |
| `z-ai/glm-5.3` | `z-ai/glm-5.2` | `provider`, `api`, `base_url`, `tier`, `reasoning`, `capabilities`, `reasoning_effort_control` |

The architecture columns (`architecture`, `total_params_b`, `active_params_b`,
`recommended_quant`, `resident_ram_gib`) are NULL for both rows: no source
gives either model's active parameter count.

## What this does not establish

- No model was invoked while this file was written. The UAT turns on the
  tracked issue are the evidence that a turn routed to each slug succeeds.
- The figures are transcribed from OpenRouter's JSON listings, not archived
  verbatim.
- Prices and limits are point-in-time. This file is evidence for 2026-10-28.
