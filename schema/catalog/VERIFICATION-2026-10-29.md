# Catalog verification — 2026-10-29

Sources and figures behind the four Anthropic rows in `001_models.sql`:
`claude-fable-5`, `claude-haiku-5-5`, `claude-opus-5`, `claude-sonnet-5-5`.
All four route to Anthropic directly (`provider = 'anthropic'`,
`api = 'anthropic-messages'`, `base_url = 'https://api.anthropic.com'`), so
each is verified against Anthropic's own pricing page rather than a reseller.

## Source

Price list: `https://docs.anthropic.com/en/docs/about-claude/pricing`,
fetched 2026-10-29T23:01Z. The URL served the pricing page directly; it did
not redirect.

The page's model table has five price columns per model: input, output,
5-minute cache write, 1-hour cache write, cache read. Every figure below is
per million tokens (MTok), in USD.

Two per-model pages were also read on the same date and agree with the price
list for the fields they list:

- `https://platform.claude.com/docs/en/models/sonnet-5-5/overview`
- `https://platform.claude.com/docs/en/models/haiku-5-5/overview`
- `https://platform.claude.com/docs/en/models/opus-5/overview`
- `https://platform.claude.com/docs/en/models/fable-5/overview`

## The cache multipliers the page states

The page states prompt-cache pricing as multipliers of the base input price,
and the cache-read multiplier is not uniform across models:

| Cache operation | Multiplier |
| --- | --- |
| 5-minute cache write | 1.25x base input price |
| 1-hour cache write | 2x base input price |
| Cache read (hit) | 0.1x base input (0.025x on Claude Fable 5.1 and Claude Mythos 5.1; 0.05x on Claude Opus 5.5 and Claude Sonnet 5.5) |

The page adds that "all other models use the standard 0.1x multiplier" for
cache reads, and gives worked figures: a cache hit costs $0.25/MTok on Fable
5.1 and Mythos 5.1, $0.20/MTok on Opus 5.5 and $0.10/MTok on Sonnet 5.5.

## Claude Fable 5

| field | source value | row |
| --- | --- | --- |
| input | $10 / MTok | `cost_input` 10.000000 |
| output | $50 / MTok | `cost_output` 50.000000 |
| 5-minute cache write | $12.50 / MTok | `cost_cache_write` 12.500000 |
| 1-hour cache write | $20 / MTok | not stored |
| cache read | $1 / MTok | `cost_cache_read` 1.000000 |

Cache read is 0.1x of $10. The `claude-fable-5` row carries the standard
cache-read multiplier.

## Claude Opus 5

| field | source value | row |
| --- | --- | --- |
| input | $5 / MTok | `cost_input` 5.000000 |
| output | $25 / MTok | `cost_output` 25.000000 |
| 5-minute cache write | $6.25 / MTok | `cost_cache_write` 6.250000 |
| 1-hour cache write | $10 / MTok | not stored |
| cache read | $0.50 / MTok | `cost_cache_read` 0.500000 |

Cache read is 0.1x of $5. The page lists the 0.05x cache-read multiplier for
Opus 5.5, a different model that the catalog does not carry.

## Claude Sonnet 5.5

| field | source value | row |
| --- | --- | --- |
| input | $2 / MTok | `cost_input` 2.000000 |
| output | $10 / MTok | `cost_output` 10.000000 |
| 5-minute cache write | $2.50 / MTok | `cost_cache_write` 2.500000 |
| 1-hour cache write | $4 / MTok | not stored |
| cache read | $0.10 / MTok | `cost_cache_read` 0.100000 |

Cache read here is 0.05x of $2, the lower multiplier the page names for
Sonnet 5.5, and the price list's own worked example gives $0.10/MTok for
Sonnet 5.5. The Sonnet 5.5 model page states the same figure: cache read
$0.10 / MTok.

The $0.20/MTok cache-read figure on the same page belongs to Claude Opus 5.5
($4 input, 0.05x), which the catalog does not carry.

## Claude Haiku 5.5

Haiku 5.5 is priced by prompt length: a request whose prompt is over 100,000
tokens pays the higher set of prices. The page states that a request's prompt
length counts all of its input tokens, including cache reads and cache writes,
and that each request is priced on its own.

| field | up to 100,000 tokens | over 100,000 tokens | row |
| --- | --- | --- | --- |
| input | $0.10 / MTok | $0.50 / MTok | `cost_input` 0.500000 |
| output | $0.50 / MTok | $2.50 / MTok | `cost_output` 2.500000 |
| 5-minute cache write | $0.125 / MTok | $0.625 / MTok | `cost_cache_write` 0.625000 |
| 1-hour cache write | $0.20 / MTok | $1 / MTok | not stored |
| cache read | $0.01 / MTok | $0.05 / MTok | `cost_cache_read` 0.050000 |

The row stores one number per field, and those numbers are the
over-100,000-token set. Both sets are 0.1x and 1.25x of their own input price:
$0.01 and $0.125 below the threshold, $0.05 and $0.625 above it.

A single number per field cannot express both sets. The row holds the higher
set; a request below the threshold is billed at a fifth of the recorded
rates.

## Not stored

Both cache-write durations are published separately ($12.50 and $20 for Fable
5, $6.25 and $10 for Opus 5, $2.50 and $4 for Sonnet 5.5, the Haiku figures
above). Each row stores the 5-minute rate only. A consumer writing 1-hour
caches pays more than the catalog records.

The Batch API's 50% discount on input and output is not modelled.

## What this does not establish

- No model was invoked. These are transcribed published prices, not invoices.
- Prices are point-in-time. This file is evidence for 2026-10-29.
- Haiku 5.5's two price sets are recorded here and not modelled in the row;
  that gap is unchanged by this note.
