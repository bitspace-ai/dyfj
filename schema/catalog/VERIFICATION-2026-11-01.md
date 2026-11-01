# Catalog verification — 2026-11-01

OpenRouter API capture: **2026-11-01T01:01:07Z** (UTC). This note records
observed model-level prices and limits for `001_models.sql` and
`../migrations/023_models_openrouter_refresh.sql`. Source files are named below;
the captured JSON is not committed. No model invocation or eval result is
established by these listings.

Prices in the rows are USD per million tokens. The observed source values are
per token. An absent cache-write price is stored as 0, meaning **not published**,
not verified free. Endpoint spreads count endpoint entries, which may share a
provider name, and show independent minima and maxima for each price field.
The runtime caps OpenRouter input/output prices at the catalog rates. These
rows do not encode endpoint-specific limits, price overrides or search fees.

## Kimi K3.1 Pro

**Observed.** Source file: `models.json`, entry `moonshotai/kimi-k3.1-pro`; source API:
`https://openrouter.ai/api/v1/models`. Captured at the UTC time above.

| Field | Captured value | Catalog value |
| --- | --- | --- |
| `pricing.prompt` | 0.000002 per token | `cost_input` 2.000000 |
| `pricing.completion` | 0.00001 per token | `cost_output` 10.000000 |
| `pricing.input_cache_read` | 0.0000002 per token | `cost_cache_read` 0.200000 |
| `pricing.input_cache_write` | absent | `cost_cache_write` 0.000000 |
| `context_length` | 1048576 | `context_window` 1048576 |
| `top_provider.max_completion_tokens` | 943718 | `max_output_tokens` 943718 |

**Observed upstream spread.** Source file: `moonshotai_kimi-k3.1-pro-endpoints.json`; source API:
`https://openrouter.ai/api/v1/models/moonshotai/kimi-k3.1-pro/endpoints`.
2 endpoint entries, captured at the same time. Prices below are per million.

| Price | Minimum (provider) | Maximum (provider) |
| --- | --- | --- |
| `prompt` | $2.000000 (Moonshot AI) | $4.000000 (Moonshot AI) |
| `completion` | $10.000000 (Moonshot AI) | $20.000000 (Moonshot AI) |
| `input_cache_read` | $0.200000 (Moonshot AI) | $0.200000 (Moonshot AI) |

No endpoint publishes a cache-write price. Endpoint `context_length` ranges from 1048576 to 1048576. Endpoint `max_completion_tokens` ranges from 943718 to 943718.

**Inferred.** `provider`, `api`, `base_url`, `tier`, `reasoning`,
`capabilities` and `reasoning_effort_control` are copied from `moonshotai/kimi-k3`.
Architecture, parameter counts, quantization and resident RAM are NULL because
this capture does not establish those values.

## DeepSeek V4 Pro 0813

**Observed.** Source file: `models.json`, entry `deepseek/deepseek-v4-pro-0813`; source API:
`https://openrouter.ai/api/v1/models`. Captured at the UTC time above.

| Field | Captured value | Catalog value |
| --- | --- | --- |
| `pricing.prompt` | 0.000000115 per token | `cost_input` 0.115000 |
| `pricing.completion` | 0.000004 per token | `cost_output` 4.000000 |
| `pricing.input_cache_read` | 0.00000011 per token | `cost_cache_read` 0.110000 |
| `pricing.input_cache_write` | absent | `cost_cache_write` 0.000000 |
| `context_length` | 1048576 | `context_window` 1048576 |
| `top_provider.max_completion_tokens` | 943718 | `max_output_tokens` 943718 |

**Observed upstream spread.** Source file: `deepseek_deepseek-v4-pro-0813-endpoints.json`; source API:
`https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-pro-0813/endpoints`.
26 endpoint entries, captured at the same time. Prices below are per million.

| Price | Minimum (provider) | Maximum (provider) |
| --- | --- | --- |
| `prompt` | $0.103500 (Relace) | $1.650000 (Venice) |
| `completion` | $0.851400 (Baidu) | $8.000000 (Relace) |
| `input_cache_read` | $0.009030 (Baidu) | $0.284000 (Wafer) |

No endpoint publishes a cache-write price. Endpoint `context_length` ranges from 1000000 to 1048576. Endpoint `max_completion_tokens` ranges from 16384 to 943718.

**Inferred.** `provider`, `api`, `base_url`, `tier`, `reasoning`,
`capabilities` and `reasoning_effort_control` are copied from `deepseek/deepseek-r1`.
Architecture, parameter counts, quantization and resident RAM are NULL because
this capture does not establish those values.

## Grok 4.7 (OpenRouter)

**Observed.** Source file: `models.json`, entry `x-ai/grok-4.7`; source API:
`https://openrouter.ai/api/v1/models`. Captured at the UTC time above.

| Field | Captured value | Catalog value |
| --- | --- | --- |
| `pricing.prompt` | 0.000002 per token | `cost_input` 2.000000 |
| `pricing.completion` | 0.000006 per token | `cost_output` 6.000000 |
| `pricing.input_cache_read` | 0.0000005 per token | `cost_cache_read` 0.500000 |
| `pricing.input_cache_write` | absent | `cost_cache_write` 0.000000 |
| `context_length` | 500000 | `context_window` 500000 |
| `top_provider.max_completion_tokens` | 450000 | `max_output_tokens` 450000 |

**Observed upstream spread.** Source file: `x-ai_grok-4.7-endpoints.json`; source API:
`https://openrouter.ai/api/v1/models/x-ai/grok-4.7/endpoints`.
5 endpoint entries, captured at the same time. Prices below are per million.

| Price | Minimum (provider) | Maximum (provider) |
| --- | --- | --- |
| `prompt` | $2.000000 (xAI) | $4.000000 (xAI) |
| `completion` | $6.000000 (xAI) | $12.000000 (xAI) |
| `input_cache_read` | $0.500000 (xAI) | $1.000000 (xAI) |

No endpoint publishes a cache-write price. Endpoint `context_length` ranges from 500000 to 500000. Endpoint `max_completion_tokens` ranges from 450000 to 450000.

The model-level listing also publishes an override at 200,000 prompt tokens:
$4 input / $12 output / $1 cache read per million. Endpoint overrides at that
threshold range from $4–$8 input, $12–$24 output and $1–$2 cache read.
The catalog stores the base listing ($2 / $6 / $0.50).

**Inferred.** `provider`, `api`, `base_url`, `tier`, `reasoning`,
`capabilities` and `reasoning_effort_control` are copied from `x-ai/grok-4.6`.
Architecture, parameter counts, quantization and resident RAM are NULL because
this capture does not establish those values.

## Meta Muse Spark 1.3

**Observed.** Source file: `models.json`, entry `meta/muse-spark-1.3`; source API:
`https://openrouter.ai/api/v1/models`. Captured at the UTC time above.

| Field | Captured value | Catalog value |
| --- | --- | --- |
| `pricing.prompt` | 0.00000125 per token | `cost_input` 1.250000 |
| `pricing.completion` | 0.00000425 per token | `cost_output` 4.250000 |
| `pricing.input_cache_read` | 0.00000015 per token | `cost_cache_read` 0.150000 |
| `pricing.input_cache_write` | absent | `cost_cache_write` 0.000000 |
| `context_length` | 1048576 | `context_window` 1048576 |
| `top_provider.max_completion_tokens` | 943718 | `max_output_tokens` 943718 |

**Observed upstream spread.** Source file: `meta_muse-spark-1.3-endpoints.json`; source API:
`https://openrouter.ai/api/v1/models/meta/muse-spark-1.3/endpoints`.
1 endpoint entries, captured at the same time. Prices below are per million.

| Price | Minimum (provider) | Maximum (provider) |
| --- | --- | --- |
| `prompt` | $1.250000 (Meta) | $1.250000 (Meta) |
| `completion` | $4.250000 (Meta) | $4.250000 (Meta) |
| `input_cache_read` | $0.150000 (Meta) | $0.150000 (Meta) |

No endpoint publishes a cache-write price. Endpoint `context_length` ranges from 1048576 to 1048576. Endpoint `max_completion_tokens` ranges from 943718 to 943718.

**Inferred.** `provider`, `api`, `base_url`, `tier`, `reasoning`,
`capabilities` and `reasoning_effort_control` are copied from `meta/muse-spark-1.2`.
Architecture, parameter counts, quantization and resident RAM are NULL because
this capture does not establish those values.

## MiniMax M3

**Observed.** Source file: `models.json`, entry `minimax/minimax-m3`; source API:
`https://openrouter.ai/api/v1/models`. Captured at the UTC time above.

| Field | Captured value | Catalog value |
| --- | --- | --- |
| `pricing.prompt` | 0.0000003 per token | `cost_input` 0.300000 |
| `pricing.completion` | 0.0000012 per token | `cost_output` 1.200000 |
| `pricing.input_cache_read` | 0.00000006 per token | `cost_cache_read` 0.060000 |
| `pricing.input_cache_write` | absent | `cost_cache_write` 0.000000 |
| `context_length` | 1048576 | `context_window` 1048576 |
| `top_provider.max_completion_tokens` | 512000 | `max_output_tokens` 512000 |

**Observed upstream spread.** Source file: `minimax_minimax-m3-endpoints.json`; source API:
`https://openrouter.ai/api/v1/models/minimax/minimax-m3/endpoints`.
13 endpoint entries, captured at the same time. Prices below are per million.

| Price | Minimum (provider) | Maximum (provider) |
| --- | --- | --- |
| `prompt` | $0.224000 (DeepInfra) | $0.600000 (Mara) |
| `completion` | $0.880000 (DeepInfra) | $2.400000 (Mara) |
| `input_cache_read` | $0.044800 (DeepInfra) | $0.060000 (Venice) |

No endpoint publishes a cache-write price. Endpoint `context_length` ranges from 262144 to 1048576. Endpoint `max_completion_tokens` ranges from 65536 to 943718.

The model-level `context_length` is 1048576 even though
`top_provider.context_length` is 524288; the row uses the former as instructed.

**Inferred.** `provider`, `api`, `base_url`, `tier`, `reasoning`,
`capabilities` and `reasoning_effort_control` are copied from `minimax/minimax-m1`.
Architecture, parameter counts, quantization and resident RAM are NULL because
this capture does not establish those values.

## Mistral Small 2603

**Observed.** Source file: `models.json`, entry `mistralai/mistral-small-2603`; source API:
`https://openrouter.ai/api/v1/models`. Captured at the UTC time above.

| Field | Captured value | Catalog value |
| --- | --- | --- |
| `pricing.prompt` | 0.00000015 per token | `cost_input` 0.150000 |
| `pricing.completion` | 0.0000006 per token | `cost_output` 0.600000 |
| `pricing.input_cache_read` | 0.000000015 per token | `cost_cache_read` 0.015000 |
| `pricing.input_cache_write` | absent | `cost_cache_write` 0.000000 |
| `context_length` | 262144 | `context_window` 262144 |
| `top_provider.max_completion_tokens` | 209715 | `max_output_tokens` 209715 |

**Observed upstream spread.** Source file: `mistralai_mistral-small-2603-endpoints.json`; source API:
`https://openrouter.ai/api/v1/models/mistralai/mistral-small-2603/endpoints`.
4 endpoint entries, captured at the same time. Prices below are per million.

| Price | Minimum (provider) | Maximum (provider) |
| --- | --- | --- |
| `prompt` | $0.150000 (Mistral) | $0.165000 (Mistral) |
| `completion` | $0.600000 (Mistral) | $0.660000 (Mistral) |
| `input_cache_read` | $0.015000 (Mistral) | $0.016500 (Mistral) |

No endpoint publishes a cache-write price. Endpoint `context_length` ranges from 262144 to 262144. Endpoint `max_completion_tokens` ranges from 209715 to 209715.

**Inferred.** `provider`, `api`, `base_url`, `tier`, `reasoning`,
`capabilities` and `reasoning_effort_control` are copied from `mistralai/mistral-small-3.2-24b-instruct`.
Architecture, parameter counts, quantization and resident RAM are NULL because
this capture does not establish those values.

## Qwen3 Coder Next

**Observed.** Source file: `models.json`, entry `qwen/qwen3-coder-next`; source API:
`https://openrouter.ai/api/v1/models`. Captured at the UTC time above.

| Field | Captured value | Catalog value |
| --- | --- | --- |
| `pricing.prompt` | 0.00000012 per token | `cost_input` 0.120000 |
| `pricing.completion` | 0.0000008 per token | `cost_output` 0.800000 |
| `pricing.input_cache_read` | 0.00000007 per token | `cost_cache_read` 0.070000 |
| `pricing.input_cache_write` | absent | `cost_cache_write` 0.000000 |
| `context_length` | 262144 | `context_window` 262144 |
| `top_provider.max_completion_tokens` | 235929 | `max_output_tokens` 235929 |

**Observed upstream spread.** Source file: `qwen_qwen3-coder-next-endpoints.json`; source API:
`https://openrouter.ai/api/v1/models/qwen/qwen3-coder-next/endpoints`.
1 endpoint entries, captured at the same time. Prices below are per million.

| Price | Minimum (provider) | Maximum (provider) |
| --- | --- | --- |
| `prompt` | $0.120000 (Parasail) | $0.120000 (Parasail) |
| `completion` | $0.800000 (Parasail) | $0.800000 (Parasail) |
| `input_cache_read` | $0.070000 (Parasail) | $0.070000 (Parasail) |

No endpoint publishes a cache-write price. Endpoint `context_length` ranges from 262144 to 262144. Endpoint `max_completion_tokens` ranges from 235929 to 235929.

**Inferred.** `provider`, `api`, `base_url`, `tier`, `reasoning`,
`capabilities` and `reasoning_effort_control` are copied from `qwen/qwen3-coder`.
Architecture, parameter counts, quantization and resident RAM are NULL because
this capture does not establish those values.

## Conversion check

DeepSeek input: 0.000000115 USD/token × 1,000,000 tokens = 0.115000 USD.
Its output is 0.000004 × 1,000,000 = 4.000000 USD; cache read is
0.00000011 × 1,000,000 = 0.110000 USD. Cache write is absent, stored as 0.

## Trim and retained row

Migration 023 deletes the seven replaced rows named above, plus
`qwen/qwen3-coder-plus` and `qwen/qwen3-max` (no longer listed),
`minimax/minimax-01` (superseded by the M line), and
`tencent/hunyuan-a13b-instruct` (renamed hy3 with unclear lineage).
`qwen/qwen3-next-80b-a3b-instruct` is retained in the fresh catalog: still listed
with no clear successor. Migration 023 leaves that row as it is, present or absent;
no earlier migration seeds it.
These availability and lineage decisions are the catalog refresh's supplied
rationale; the seven-entry model capture does not independently establish them.
Historical events retain their slug text when a catalog row is removed.
