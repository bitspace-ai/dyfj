# Workbench MVP Loop

Status: design note, initial implementation starting in `prototype/src/workbench.ts`.

Tracks: `dyfj-2fl` - Design Workbench MVP.

## Frame

The first Workbench slice is not a new platform surface. It is the smallest daily-work loop that proves the README Section 1 done-line:

> I am doing most of my daily work from the tool, with cost visibility up front from the beginning, with confidence I'm not ripping through obscene amounts of token burn.

The MVP therefore has to make the route, cost posture, and audit trail visible in the same path that does the work. A separate ledger or later dashboard does not satisfy the slice.

## Smallest loop

1. Start a Workbench session from the TypeScript prototype.
2. Load lightweight context from the Dolt-backed memory/session substrate.
3. Route locally by default through the existing model registry.
4. Before any paid inference runs, show the selected model, tier, routing reason, estimate, and budget headroom.
5. Require explicit consent for Tier 1 or Tier 2 inference.
6. Run one agentic work loop with memory tool calls available.
7. Append material operations to the immutable `events` log.
8. Print a session receipt with model, route, tokens, cost, session id, and trace id.

The loop is CLI-shaped first. A richer visual work surface can project from the same event and budget substrate later.

## Non-goals

- Full graphical Workbench UI.
- Multi-agent orchestration.
- Dynamic runtime registry service.
- Automatic paid fallback.
- Hosted or SaaS assumptions.
- Private operator-overlay integration.
- New Rust implementation for unstable prototype behavior.
- Replacing the memory model.
- A general task manager.
- Object graphs with back-references. Graph-shaped state should be represented as flat ID-keyed entities plus event rows, edge records, or adjacency projections.

## Acceptance criteria

- A daily-work prompt can run through `deno task workbench`.
- Tier 0 local inference remains the default route unless the caller explicitly selects another model or tier.
- Paid inference cannot run without explicit consent.
- The paid-escalation prompt shows cost posture before the call starts.
- Session events are written to Dolt: `session_start`, `model_selected`, `model_response` or `error`, `tool_call` where applicable, `session_end`, and `budget_summary`.
- The final receipt answers: what model ran, why it was selected, what it cost, how many tokens were used, and where the audit trail starts.
- Work stays in `prototype/` until a component stabilizes enough to earn a Rust boundary.
- Schema changes, if any, land in `schema/` first; TypeScript remains a consumer.

## Implementation sequence

1. Add `prototype/src/workbench.ts` as the new Workbench entrypoint.
2. Retire the legacy `prototype/src/index.ts` demo once the Workbench path owns `deno task start`.
3. Add `deno task workbench`.
4. Add a tested session receipt formatter.
5. Replace the current paid consent line with the fuller preflight banner from `notes/cost-visibility-surface.md`.
6. Add the per-turn paid-session tally.
7. Add an integration check that verifies the expected event sequence in Dolt.

## Legacy `index.ts`

`prototype/src/index.ts` was removed with the legacy router path. `deno task start` and `deno task workbench` now both point at the Workbench entrypoint.

## First beads

- Implement Workbench session receipt.
- Add paid-escalation preflight banner.
- Keep per-turn budget tally visible after paid escalation.
- Verify Workbench MVP event sequence in Dolt.

## Open questions

- What is the smallest hosted-provider path that preserves explicit paid escalation without reintroducing a generic provider framework?
