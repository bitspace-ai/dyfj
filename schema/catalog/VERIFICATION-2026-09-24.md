# Catalog revalidation — 2026-09-24

A one-time check of every active row in the model catalog against the live
model list of the provider it routes to. This is the same test that
`../history/021_models_validity_2026_06.sql` used: a slug counts as present
only if the provider's model-list endpoint returns it. Rows that fail are
deactivated in a forward migration, with the evidence written into its
comments.

**Result: no row was found missing, so no deactivation migration was written.**
15 hosted rows could not be checked at all. They are listed below and still
need checking.

The active set is the fresh-install state: `schema/current`, then
`schema/catalog`, then `schema/migrations`, applied to a disposable Dolt
repository. It has 49 active rows. It was not read from a running database.

## OpenRouter — 25 rows, all present

Source: `GET https://openrouter.ai/api/v1/models`, public, captured
2026-09-24T10:11:11Z. The response listed 458 models.

Present: `deepseek/deepseek-chat`, `deepseek/deepseek-v3.1-terminus`,
`deepseek/deepseek-v4.1-flash`, `meta-llama/llama-3.3-70b-instruct`,
`meta-llama/llama-4-maverick`, `meta-llama/llama-4-scout`,
`meta/muse-glimmer-30b`, `minimax/minimax-01`, `mistralai/codestral-2508`,
`mistralai/mistral-small-3.2-24b-instruct`, `qwen/qwen3-coder`,
`qwen/qwen3-coder-flash`, `qwen/qwen3-coder-plus`,
`qwen/qwen3-next-80b-a3b-instruct`, `tencent/hunyuan-a13b-instruct`,
`x-ai/grok-build-0.1`, `z-ai/glm-4.5`, `z-ai/glm-4.5-air`,
`deepseek/deepseek-r1`, `meta/muse-spark-1.2`, `minimax/minimax-m1`,
`moonshotai/kimi-k2-0905`, `qwen/qwen3-max`, `x-ai/grok-4.3`,
`x-ai/grok-4.6`.

Two of these rows have an announced end date. Both are still listed today, so
neither was deactivated:

| slug | `expiration_date` |
| --- | --- |
| `deepseek/deepseek-v3.1-terminus` | 2026-09-28 |
| `z-ai/glm-4.5` | 2026-12-31 |

After 2026-09-28, re-check `deepseek/deepseek-v3.1-terminus`. If it is gone
from the list, deactivate it.

This pass checked presence only. It did not compare catalog prices with the
listed prices.

## Local (Ollama) — 7 rows, installed on the checking machine

Source: the local Ollama model list (`GET /api/tags`), 2026-09-24. All seven
local catalog slugs resolve: `deepseek-r1:32b`, `gemma4:26b`, `gemma4:e2b`,
`laguna-xs-2.1` (installed as `laguna-xs-2.1:latest`), `mistral-small:24b-instruct-2501-q4_K_M`,
`muse-glimmer:30b`, `qwen3.6:35b-a3b`.

This list covers one machine only. It shows that the slugs resolve locally. It
does not test the rows against a provider-wide list.

## Subscription runners — 2 rows, not checkable

`codex-chatgpt/gpt-5.6-sol` and `codex-chatgpt/gpt-5.6-terra` route through a
subscription runner. That runner has no public model-list endpoint, so these
rows were not checked.

## Direct hosted providers — 15 rows, not verified

These rows were not checked, because no provider credential was available to
the checking session:

- Anthropic: `claude-haiku-4-5-20251001`, `claude-sonnet-5`, `claude-fable-5`,
  `claude-opus-5`
- OpenAI: `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`
- Google: `gemini-3.5-flash-lite`, `gemini-3.6-flash`, `gemini-3.7-flash`,
  `gemini-3.8-flash`, `gemini-3.1-pro-preview`
- xAI: `grok-4.3`, `grok-build-0.1`, `grok-4.6`

To finish this pass, run each provider's model-list call with its key set:

- Anthropic: `GET /v1/models`
- OpenAI: `GET /v1/models`
- Google: `GET /v1beta/models`
- xAI: `GET /v1/models`

For each slug that the list does not return, deactivate it in a forward
migration that follows the pattern of 021.
