# PRD-13 — Typed data layer

**Phase:** 1. **Work orders:** WO-12, WO-13.

## Problem

The canonical DDL has no enforced connection to the TypeScript that writes to
it. SQL is spread across eight modules plus the MCP server, which has its own
connection pool. Event writes are untyped maps. Two schema build paths can drift
apart without anyone noticing. Five runtime shims paper over schema drift.

## Goals

1. **Store port.** One `Store` port with a `DoltStore` adapter and a
   `MemoryStore` fake, both passing one conformance suite. See
   `02-data-layer.md` §2.
2. **Generated types.** Row types, insert types, and enums are generated from
   the DDL, and typed event builders exist per event type (§3).
3. **Schema checks.** Add the `schema.codegen` and `schema.equivalence` gate
   lanes (§3–4).
4. **Shims out.** Delete the drift shims and replace them with a fail-loud boot
   check (§5).
5. **MCP server alignment.** The stdio MCP server uses the same store and
   config.

## Non-goals

- Changing the DDL.
- New tables.
- Rust changes.
- Phase-2 domain entities.

## Requirements

- **R1.** All SQL lives under `src/store/`. `arch.imports` gains a rule:
  `mysql2` is imported only by `store/`.
- **R2.** No `Record<string, unknown>` event writes remain.
- **R3.** Both schema lanes are green, and a deliberately broken branch shows
  each one failing. Record the demonstration in the PR description.
- **R4.** The golden suite is unchanged, with one exception: removing the shims
  changes nothing observable against an up-to-date schema.
- **R5.** Doc updates: `schema/README.md`, `schema/migrations/README.md`, and
  README §5 state a single apply-order rule.

## Success metrics

- Modules issuing SQL: 1 (down from 9).
- Connection pools: 1 per process (down from 3 implementations).
- A DDL change that is not regenerated fails the gate.

## Risks

- **Type differences.** `information_schema` type mapping (JSON, DATETIME
  precision, enums) may differ between Dolt versions. Mitigation: pin the Dolt
  version the generator runs under, reusing the gate's pinned 2.3.1, and record
  it in the generated file header.
- **Visibility scoping could weaken.** Merging memory access from the runtime
  and the MCP server could weaken privacy scoping. Mitigation: the store
  conformance suite includes explicit visibility-clearance cases for loopback,
  non-loopback, and MCP stdio callers.
