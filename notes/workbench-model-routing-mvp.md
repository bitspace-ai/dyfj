# Workbench Model Routing MVP

Status: design note, partially implemented in `prototype/src/workbench.ts`.

Tracks: `dyfj-2fl.8` - Design worklet-based model routing MVP.

## Frame

Workbench routing is not a generic provider abstraction. It is a small decision
loop for choosing the cheapest adequate model path for a bounded unit of work,
then making the route visible in the receipt.

The MVP starts with one worklet: `next-work.v0`. It proves the shape before
generalizing it.

## Worklet

A worklet is a named unit of model-facing work with:

- a stable id
- a brief
- a context profile
- a routing posture
- an expected output shape
- validation rules
- receipt fields

`next-work.v0` answers one repo-local question: what should happen next in this
repository from the supplied public context.

Non-goals for the MVP:

- dynamic worklet registry
- hosted fallback
- multi-agent routing
- private operator context
- broad model marketplace support
- autonomous mutation

## Brief

The brief is the prompt contract for the worklet. It should be short, explicit,
and public-safe.

For `next-work.v0`, the brief includes:

- `worklet_id`
- `context_profile`
- the operator prompt
- a strict JSON-only instruction
- a public-safety boundary: use only supplied repo-local context
- a required JSON schema written as prompt text

The current implementation lives in `buildNextWorkBrief()` in
`prototype/src/workbench.ts`.

## Context Profiles

Context profile is a routing input, not just prompt decoration. It decides how
much context the model receives and which buckets get priority.

Current profiles:

- `compact` - default for repo-local next-work; small budget weighted to repo
  context (AGENTS/README excerpts + workbench notes), fast enough for daily use
- `full` - larger diagnostic profile for comparison and failure analysis

The default next-work path uses `compact` because prior measurements showed
that more context can add latency and can make the answer worse for this narrow
question.

`DYFJ_WORKBENCH_CONTEXT_PROFILE=full` remains a debugging override.

## Model Tiers

The MVP keeps the README Section 1 tier posture:

- Tier 0 - local, zero paid inference, default route
- Tier 1 - paid escalation, explicit consent required
- Tier 2 - paid escalation, explicit consent required

Routing may consider hosted tiers later, but the first route must remain local
unless the operator explicitly selects another model or tier. Non-TTY paid
inference fails closed.

## Routing Inputs

The first routing decision uses only cheap, inspectable inputs:

- explicit CLI/env model override
- explicit CLI/env tier override
- hint (`code`, `chat`, `reasoning`)
- worklet id
- context profile
- model registry tier/capabilities/cost

The first implementation does not ask a model to choose the model. The routing
decision is code, and the receipt records the reason.

## Validation

The `next-work.v0` worklet requires strict JSON before trusting model output.
Validation checks:

- parseable JSON object
- required fields present
- expected string fields are strings
- list fields are arrays of strings
- `context_profile` is one of the known profiles
- `confidence` is `low`, `medium`, or `high`

If validation fails, Workbench prints the raw model output and records the
validation failure in the receipt instead of silently trusting prose.

## Receipt

The receipt is the routing artifact. It should answer:

- which worklet ran
- which provider/model/tier ran
- why that route was selected
- whether paid inference was used
- estimated and actual cost
- token counts
- timing fields
- context profile and budget
- validation status
- context sources
- session and trace ids

This keeps routing observable without requiring a separate dashboard.

## First Experiment

`dyfj-2fl.8.2` implemented the first experiment:

- `deno task workbench next-work`
- local Tier 0 default route
- `next-work.v0` brief
- strict JSON request
- `validateNextWorkJson()` before trusted display
- receipt fields for worklet, context profile, route, cost, timing, and
  validation
- generic `ask` remains prose-shaped and separate from `next-work`

The experiment is intentionally CLI-shaped. A future Workbench UI should project
from the same worklet, provider, context, validation, and receipt primitives.

## Deferred

- persisted JSONL experiment rows
- hosted provider execution
- model-selected routing
- multi-run quality evals
- dynamic worklet registry
- capability-backed route lookup

Those become real only when a second worklet or a hosted escalation path needs
them.
