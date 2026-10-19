# Catalog verification — 2026-10-18

Sources and figures behind the `claude-sonnet-5-5`, `moonshotai/kimi-k3` and
`claude-haiku-5-5` rows in `001_models.sql`, and the matching
`../migrations/015_models_claude_sonnet_5_5_and_kimi_k3.sql` and
`../migrations/018_models_claude_haiku_5_5.sql`.

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
`temperature`, `top_p`, `top_k` or `tool_choice`, so those are not expected
to fail a turn here.

Thinking is the open risk. The page says adaptive thinking is on by default,
that thinking blocks are tied to the model and the conversation, and that text
between tool calls comes back in thinking blocks. The adapter keeps only
`text` and `tool_use` blocks from a response (`stream.ts`) and sends no
thinking configuration. A turn that takes two or more tool steps may
therefore fail when the conversation is replayed, and text the model writes
between tool calls is dropped. A single turn with no tool call is not
affected. Preserving and replaying thinking blocks, or turning off up-front
thinking with `between_tools`, is a follow-up; this change does not alter the
adapter.

Nothing in this change invokes the model; the UAT turns are the evidence.

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

Later the same day, the runtime began sending every OpenRouter request the
row's prices as `provider.max_price`, so a request runs only on an upstream
at or below $0.304 / $11.936, which at capture time was InferenceNet (fp4)
alone, or fails. It also records the cost OpenRouter reports billing in
place of this row's estimate. The paragraph above describes the routing
before that change.

The row records the model-level listing, as the `kimi-k2-0905` row does.
Whether the catalog should record the model-level listing, the highest
upstream rate, or the rate of a pinned upstream is open; this file records the
spread so that decision can be made on evidence.

## Claude Haiku 5.5

Routes to Anthropic directly: `provider = 'anthropic'`,
`api = 'anthropic-messages'`, `base_url = 'https://api.anthropic.com'`.

Source: `https://platform.claude.com/docs/en/models/haiku-5-5/overview`,
captured 2026-10-18. The page names the Claude API model ID
`claude-haiku-5-5`, released 2026-10-07.

The price is tiered by prompt size:

| field | prompts up to 100K tokens | prompts over 100K tokens | row |
| --- | --- | --- | --- |
| input | $0.10 / MTok | $0.50 / MTok | `cost_input` 0.500000 |
| output | $0.50 / MTok | $2.50 / MTok | `cost_output` 2.500000 |
| 5-minute cache write | $0.125 / MTok | $0.625 / MTok | `cost_cache_write` 0.625000 |
| 1-hour cache write | $0.20 / MTok | $1 / MTok | not stored |
| cache read | $0.01 / MTok | $0.05 / MTok | `cost_cache_read` 0.050000 |

| field | source value | row |
| --- | --- | --- |
| context window | 1M tokens | `context_window` 1000000 |
| max output | 128K tokens | `max_output_tokens` 128000 |
| max output, Batch API (beta) | 300K tokens | not stored |

A row holds one number per field, so it records the over-100K tier. As in
migration 012, the higher figure wins, because spending past a limit cannot be
undone. Prompts up to 100,000 tokens are billed at a fifth of the recorded
rates, so the catalog overestimates the cost of a short turn by five times. A
long agent session passes 100,000 tokens of prompt quickly, and there the
recorded rate is the one billed.

The row stores the 5-minute cache-write rate, as the `claude-sonnet-5-5` row
does. The Batch API's 50% discount and its 300,000-token output limit are not
modelled.

### Thinking

The page lists adaptive thinking, on by default, with default effort `medium`.
It does not mention `display: "updates"`. Anthropic's thinking guide
(`https://platform.claude.com/docs/en/build-with-claude/thinking`, read
2026-10-18) lists progress updates between tool calls for Claude Fable 5.1,
Claude Mythos 5.1, Claude Opus 5.5, Claude Sonnet 5.5 and Claude Fable 5, and
not for Haiku 5.5. The row therefore omits `thinking-progress-updates`, and
the Anthropic adapter sends Haiku 5.5 no thinking configuration. The model's
default `display: "omitted"` applies; the adapter preserves and replays its
thinking blocks, as it does for Sonnet 5.5.

The page and the guide also state that a non-default `temperature`, `top_p`
or `top_k` returns a 400 error. The adapter sends none of them.

## Inferred fields

These fields are copied from the closest existing row, not taken from a
provider statement:

| row | copied from | fields |
| --- | --- | --- |
| `claude-sonnet-5-5` | `claude-sonnet-5` | `provider`, `api`, `base_url`, `tier`, `reasoning`, `capabilities`, `reasoning_effort_control` |
| `moonshotai/kimi-k3` | `moonshotai/kimi-k2-0905` | `provider`, `api`, `base_url`, `tier`, `reasoning`, `capabilities`, `reasoning_effort_control` |
| `claude-haiku-5-5` | `claude-sonnet-5-5` | `provider`, `api`, `base_url`, `tier`, `reasoning`, `reasoning_effort_control`, and `capabilities` without `thinking-progress-updates` |

The Kimi K3 architecture columns (`architecture`, `total_params_b`,
`active_params_b`, `recommended_quant`, `resident_ram_gib`) are NULL. The
`kimi-k2-0905` row's values describe a different model, and the sources above
do not give K3's active parameter count.

The OpenRouter listing gives Kimi K3 input modalities of text, image and
video. The row omits `"vision"`, matching the `kimi-k2-0905` row it copies.
The OpenAI-compatible adapter sends text only.

## What this does not establish

- No model was invoked while this file was written. The UAT turns on the
  tracked issues are the evidence that a turn routed to each slug succeeds.
- Anthropic's page was captured as HTML and read as extracted text. The figures
  are transcribed, not archived verbatim.
- Prices and limits are point-in-time. This file is evidence for 2026-10-18.
