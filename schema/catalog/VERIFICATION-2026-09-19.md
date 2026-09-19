# Catalog verification — 2026-09-19

Sources and figures behind the `deepseek/deepseek-v4.1-flash` and
`gemini-3.8-flash` rows in `001_models.sql`, and the matching
`../migrations/012_models_deepseek_v4_1_and_gemini_3_8.sql`.

Catalog rows record prices and limits as plain numbers, which read as permanent
and are not. This file records the source and date for the input, output,
cache-read and cache-write prices and the token limits, so a later reader can
re-check them against the same source rather than guess whether they were ever
right. It does not cover every column in the row.

Each row is verified against the provider it routes to, not against whichever
catalog is easiest to read. An aggregator's resale price is not evidence for a
row that reaches the vendor directly.

## DeepSeek V4.1 Flash

Routes to OpenRouter: `provider = 'openrouter'`,
`base_url = 'https://openrouter.ai/api/v1'`.

Source: `https://openrouter.ai/api/v1/models`, captured 2026-09-19T12:29:56Z.

### This model is priced by time of day

The provider publishes a base price and a set of overrides:

| when (UTC) | input | output | cache read |
| --- | --- | --- | --- |
| weekdays 01:00–04:00 | $0.30 | $1.20 | $0.006 |
| weekdays 06:00–10:00 | $0.30 | $1.20 | $0.006 |
| all other weekday hours | $0.15 | $0.60 | $0.003 |
| all weekend | $0.15 | $0.60 | $0.003 |

A row holds one number. **The row records the peak prices**: $0.30 / $1.20 /
$0.006. Seven hours of every weekday are priced correctly; outside them the
provider charges half what the catalog says.

Overstating is the safer error, not a harmless one. A consumer enforcing a
spending limit may refuse an off-peak request it could have afforded, so the
choice can cost availability. Refusing an affordable request is recoverable;
spending past a limit the operator set is not.

An earlier draft of the migration recorded $0.30 and $1.20 and was assumed to
be a transcription error, because a spot check at a different hour returned
$0.15 and $0.60. It was not an error. The draft was written at 01:21 UTC on a
weekday, inside the first peak window, and recorded what the provider was
charging at that moment. Both figures are real prices for the same model.

### Limits

| field | source value | row |
| --- | --- | --- |
| `context_length` | 1,048,576 | `context_window` 1048576 |
| `top_provider.max_completion_tokens` | 384,000 | `max_output_tokens` 384000 |

### Cache write

The source publishes no `input_cache_write` price for this model. The row
records `cost_cache_write` 0.000000, which therefore means "not published"
rather than "verified free".

## Gemini 3.8 Flash

Routes to Google directly: `provider = 'google'`,
`base_url = 'https://generativelanguage.googleapis.com'`.

Source for input, output and cache read:
`https://ai.google.dev/gemini-api/docs/pricing`, paid tier, read 2026-09-19.
Context window, output limit and cache write are not stated there; their
provenance is given below. Quoted:

- input: "$0.75 through December 31, 2026. $1.50 starting January 1, 2027."
- output: "$3.75 through December 31, 2026. $7.50 starting January 1, 2027."
- context caching read: "$0.075 through December 31, 2026. $0.15 starting January 1, 2027."

The row records the current period: `cost_input` 0.750000, `cost_output`
3.750000, `cost_cache_read` 0.075000.

**These prices expire.** From 2027-01-01 the row understates cost by half, and
the schema has no validity window to say so. The same figures appear on the
existing `gemini-3.6-flash` and `gemini-3.7-flash` rows, so they are likely
under the same promotion.

`cost_cache_write` is 0, meaning **not published in this form**, not verified
free. Google charges cache *storage* per hour — "$0.50 / 1,000,000 tokens per
hour through December 31, 2026" — which is duration-dependent and has no column
in this schema.

The aggregator does publish a per-token `input_cache_write` for this model, at
$0.0416667 per million. It was briefly written into this row and then removed:
a per-token write charge and an hourly storage charge are different kinds of
price, and this row bills against Google directly.

Their figure is one twelfth of Google's hourly rate. Whether that relationship
is deliberate is not established here — no provider statement was found
explaining how the aggregator derives it — and the decision to leave this field
at zero does not depend on the answer.

The sibling 3.6 and 3.7 Flash rows also carry zero here, which is right for the
same reason.

Google's pricing page did not state the context window or output limit. Those
come from OpenRouter's listing, which reports 1,048,576 and 65,536 and is
corroboration for limits only, not for the direct price.

### Prices the schema has no column for

The provider publishes separate per-million prices for audio input ($0.75),
image input ($0.75), internal reasoning ($3.75) and audio cache ($0.075), plus
web search at $14.00 per thousand calls. The row has no column for any of them.

Most of those rates equal the generic ones this row already records, so image
or audio input does not by itself cost more than the catalog predicts —
provided the consumer counts those tokens as input. Web search is a distinct
per-call charge with no analogue in this schema and is simply unpriced here.

## Capability fields

OpenRouter reports `input_modalities: ["text", "image"]` for DeepSeek V4.1
Flash, and lists `tools`, `tool_choice`, `reasoning` and `reasoning_effort`
among its supported parameters.

The row advertises reasoning — `reasoning = TRUE`, and `"reasoning"` appears in
`capabilities` — but omits image input, tools, and reasoning-effort control,
matching the sibling `deepseek/deepseek-v4-flash` row. That is deliberate.
Whether the catalog should record observed provider capability is a separate
question from whether its prices are right.

## What this does not establish

- Neither model was invoked. Nothing here shows that a turn routed to either
  slug succeeds. The fields listed above reproduce what the providers publish,
  with the substitutions and omissions this file names: a peak price standing
  for a varying one, limits corroborated from an aggregator, cache write left
  at zero for want of a column, and capabilities the provider advertises that
  the row does not claim.
- Google's pricing page was read through a fetch-and-summarize tool, so its
  figures are transcribed rather than archived verbatim.
- Prices and limits are point-in-time, and for DeepSeek also time-of-day. This
  file is evidence for 2026-09-19 and becomes a historical record the moment
  either provider changes anything.
