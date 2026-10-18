# Catalog verification — 2026-10-18

Sources and figures behind the `claude-sonnet-5-5` and `moonshotai/kimi-k3`
rows in `001_models.sql`, and the matching
`../migrations/015_models_claude_sonnet_5_5_and_kimi_k3.sql`.

This file records the source and capture date for each row's input, output,
cache-read and cache-write prices and its token limits, so a later reader can
re-check them against the same source. It does not cover every column in the
row; the fields copied from a sibling row are listed under "Inferred fields".

Each row is verified against the provider it routes to.

## Claude Sonnet 5.5

Routes to Anthropic directly: `provider = 'anthropic'`,
`api = 'anthropic-messages'`, `base_url = 'https://api.anthropic.com'`.

Source: `https://platform.claude.com/docs/en/models/sonnet-5-5/overview`,
captured 2026-10-18T10:20:52Z. The page names the Claude API model ID
`claude-sonnet-5-5`.

| field | source value | row |
| --- | --- | --- |
| input | $2 / MTok | `cost_input` 2.000000 |
| output | $10 / MTok | `cost_output` 10.000000 |
| cache read | $0.10 / MTok | `cost_cache_read` 0.100000 |
| 5-minute cache write | $2.50 / MTok | `cost_cache_write` 2.500000 |
| 1-hour cache write | $4 / MTok | not stored |
| context window | 1M tokens | `context_window` 1000000 |
| max output | 128K tokens | `max_output_tokens` 128000 |
| max output, Batch API (beta) | 300K tokens | not stored |

The row stores the 5-minute cache-write rate, as the `claude-sonnet-5` row
does. A consumer that writes 1-hour caches pays $4 per million, not the $2.50
the catalog records.

The Batch API's 50% discount on input and output and its 300,000-token output
limit are not modelled. This software does not use the Batch API.

The same page lists adaptive thinking, on by default, with default effort
`high`.

### Changes from Sonnet 5 that this software could meet

The page lists five breaking changes from Sonnet 5, and states that a
non-default `temperature`, `top_p` or `top_k` returns a 400 error. The
Anthropic adapter in `prototype/src/providers/anthropic/` sends none of
`temperature`, `top_p`, `top_k`, `tool_choice` or a thinking configuration,
so none of these is expected to fail a turn here. Nothing in this change
invokes the model; the UAT turn is the evidence.

## Kimi K3

Routes to OpenRouter: `provider = 'openrouter'`,
`base_url = 'https://openrouter.ai/api/v1'`.

Source: `https://openrouter.ai/api/v1/models`, captured 2026-10-18T10:20:45Z.
The listing gives `id` `moonshotai/kimi-k3`, `canonical_slug`
`moonshotai/kimi-k3-20260715`, and `created` 1784215858 (2026-07-16). The row
uses the `id`, which is the alias a request names.

| field | source value | row |
| --- | --- | --- |
| `pricing.prompt` | 0.000000304 per token | `cost_input` 0.304000 |
| `pricing.completion` | 0.000011936 per token | `cost_output` 11.936000 |
| `pricing.input_cache_read` | 0.00000021 per token | `cost_cache_read` 0.210000 |
| `pricing.input_cache_write` | absent | `cost_cache_write` 0.000000 |
| `context_length` | 1,048,576 | `context_window` 1048576 |
| `top_provider.max_completion_tokens` | 943,718 | `max_output_tokens` 943718 |

`cost_cache_write` 0 means **not published**, not verified free.

The listing also carries a `moonshotai/kimi-k3:batch` variant with different
prices and a 16,384-token output limit. The row does not describe it.

### Reasoning effort and cost

The listing's `reasoning` block gives `default_enabled: true`,
`supported_efforts: ["max", "high", "low", "none"]` and
`default_effort: "max"`.

OpenRouter bills reasoning tokens as completion tokens, at the output price.
With the default effort at `max`, a turn can spend much more on output than
its visible reply suggests.

This software does not lower that default. `reasoning_effort_control` is a
boolean, so it cannot hold a default level. Even when it is TRUE, the
OpenAI-compatible adapter (`prototype/src/providers/openai-compatible/adapter.ts`)
sends `reasoning_effort` only when the provider is `openai`. Every Kimi K3
turn through this row therefore runs at `max`.

### The listed price is one upstream's rate

OpenRouter serves Kimi K3 from many upstream providers. The endpoint list,
`https://openrouter.ai/api/v1/models/moonshotai/kimi-k3-20260715/endpoints`,
captured 2026-10-18T10:20:52Z, shows these per-million prices, among others:

| upstream | input | output | cache read |
| --- | --- | --- | --- |
| InferenceNet (fp4) | $0.304 | $11.936 | $0.21 |
| Relace (fp4) | $0.27 | $14.00 | $0.27 |
| Sail Research (fp4) | $0.504 | $8.10 | $0.18 |
| Moonshot AI | $3.00 | $15.00 | $0.30 |
| Fireworks (us, fast) | $4.50 | $22.50 | $0.45 |

The row records OpenRouter's model-level listing, which matched InferenceNet
at capture time. Other upstreams charge different rates: some are lower on
input or output, and others are much higher. Which one is cheapest depends on
the mix of input, output and cache tokens. Which upstream serves a request is
OpenRouter's choice unless the request pins one, and this software does not
pin one. A turn served by Moonshot AI's own endpoint costs about ten times the
recorded input price and about 1.26 times the recorded output price.

OpenRouter may route a request to any of these upstreams, so the actual
charge can differ from this row; see the follow-up on provider pinning.

The row records the model-level listing, as the `kimi-k2-0905` row does.
Whether the catalog should record the model-level listing, the highest
upstream rate, or the rate of a pinned upstream is open; this file records the
spread so that decision can be made on evidence.

## Inferred fields

These fields are copied from the closest existing row, not taken from a
provider statement:

| row | copied from | fields |
| --- | --- | --- |
| `claude-sonnet-5-5` | `claude-sonnet-5` | `provider`, `api`, `base_url`, `tier`, `reasoning`, `capabilities`, `reasoning_effort_control` |
| `moonshotai/kimi-k3` | `moonshotai/kimi-k2-0905` | `provider`, `api`, `base_url`, `tier`, `reasoning`, `capabilities`, `reasoning_effort_control` |

The Kimi K3 architecture columns (`architecture`, `total_params_b`,
`active_params_b`, `recommended_quant`, `resident_ram_gib`) are NULL. The
`kimi-k2-0905` row's values describe a different model, and the sources above
do not give K3's active parameter count.

The OpenRouter listing gives Kimi K3 input modalities of text, image and
video. The row omits `"vision"`, matching the `kimi-k2-0905` row it copies.
The OpenAI-compatible adapter sends text only.

## What this does not establish

- Neither model was invoked while this file was written. The UAT turns on the
  tracked issue are the evidence that a turn routed to either slug succeeds.
- Anthropic's page was captured as HTML and read as extracted text. The figures
  are transcribed, not archived verbatim.
- Prices and limits are point-in-time. This file is evidence for 2026-10-18.
