# Contract Signatures, Routing Metrics, and Authz

Status: design influence note. Date: 2026-05-29.

## Frame

Workbench routing should optimize for successful work, not cheap attempts.

A tiny model can look attractive on raw latency or raw cost while still being a
bad route if it fails validation often enough to require retries, repair, or
human review. The router therefore needs performance metrics grouped by task
contract shape, not only by model.

## Contract signature

A task contract signature is a stable bucket for model-facing work. It groups
similar tasks without hashing raw prompt text or creating one metric series per
exact schema.

Initial dimensions:

- `functional_intent_tag` - broad operational intent, such as
  `entity_extraction`, `summarization`, `text_to_sql`, `routing_decision`, or
  `policy_check`.
- `output_contract_shape` - structural output difficulty, such as `loose_text`,
  `flat_object`, `nested_arrays`, `strict_regex_constraints`, or `tool_call`.
- `context_volume_bucket` - input pressure bucket, such as `<4k`, `4k-16k`, or
  `16k+`.

Example:

```text
entity_extraction:nested_arrays:4k-16k
```

This is the routing bucket. Exact schema hashes may still be useful as secondary
diagnostic metadata, but should not be the primary aggregation key.

## Declared vs observed contract

The developer should explicitly declare the intended contract parameters when
configuring an agent or worklet. Runtime inference should measure what actually
happened.

Rule:

```text
Developer declares intent.
Harness measures shape.
Validator decides success.
Router learns from observed outcomes grouped under the declared contract.
```

Events should eventually carry both:

```text
declared_contract:
  intent
  output_contract_shape
  expected_context_bucket

observed_contract:
  context_bucket
  schema_complexity
  output_tokens
  validation_result
```

If declared and observed contracts drift, the event should make that visible.
The drift is routing evidence and may also be security evidence.

## Router metrics

The router should use expected cost and expected latency per valid result, not
raw cost or latency per attempt.

```text
expected_cost_per_valid_result =
  average_cost_per_attempt / validation_pass_rate

expected_latency_per_valid_result =
  average_latency_per_attempt / validation_pass_rate
```

For each `(model, provider, contract_signature, decoding_profile)` bucket, track
at least:

- attempts
- validation passes
- validation pass rate
- retry rate
- average and percentile latency
- average cost
- input and output token counts
- TPOT when streaming timing is available
- last seen timestamp
- sample count / confidence

Low-sample buckets should use pessimistic pass-rate estimates. A model that
passes one hard structured task once should not be treated as reliable for that
contract class.

## Cost primitive implication

Rigid structure is not free reliability.

The local structured-output streaming diagnostic showed that rigid JSON improved
validation success but increased token mass for that prompt shape. The cost
primitive should account for both sides:

- additional input tokens from stricter instructions or schema description
- additional output tokens from braces, keys, quotes, field names, enum labels,
  and required structure
- reduced retry/repair cost when validation pass rate improves

The routing question is therefore not "which model is cheapest per call?" It is
"which model is cheapest per accepted result for this contract signature?"

## Authz mismatch handling

The authz primitive should fail secure on material contract-signature mismatch.

Declared contract grants authority. Runtime inference may reduce authority. It
must not expand authority.

If a request declared as one contract appears at runtime to be another contract,
especially one involving tool use, credential access, policy override, paid
escalation, file/network/database access, or actor-boundary changes, the
authorized execution path should stop or downgrade.

Pattern:

```text
1. Detect contract mismatch.
2. Freeze or drop privileged execution.
3. Emit an authz/security event.
4. Optionally classify the mismatch.
5. Route to safe handling: reject, ask for restatement, downgrade to
   read-only/no-tool/no-write, or require operator approval.
```

A safety classifier may annotate the event and help route the response. It is
evidence, not authority. A classifier should not restore privileges unless an
explicit policy path allows that.

## Design decisions

- Do not maintain one global model pass rate for routing.
- Group model performance by task contract signature.
- Use developer-declared intent as the authority-bearing contract.
- Use runtime inference as observed evidence and drift detection.
- Treat validation pass rate as part of both latency and cost calculation.
- Fail secure or downgrade on material declared-vs-observed contract mismatch.
- Let safety classification annotate or triage mismatches, not authorize the
  original privileged action.

## See also

- `notes/workbench-model-routing-mvp.md` - current Workbench routing posture.
- `notes/cost-visibility-surface.md` - cost as a design primitive.
- `notes/events-as-substrate.md` - events as the shared substrate for
  observability, authz, discovery, and cost.
- `prototype/src/provider.ts` - provider timing, usage, and cost calculation.
- `prototype/examples/structured-output-streaming.ts` - current local diagnostic
  for structured output, validation, token counts, and TPOT.
