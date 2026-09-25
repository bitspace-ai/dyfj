# PRD-11 — Runtime decomposition

**Phase:** 1. **Priority driver:** agents struggle to change the code. **Work
orders:** WO-07 … WO-11, WO-16 … WO-19, WO-21, WO-22.

## Problem

An agent asked to change one behavior has to load 4k-line files, and the central
turn function is roughly 2,200 lines long. Four import cycles hide ownership,
including one held together by a lazy `await import`. Engine helpers live in the
top-level orchestrator. Utility logic is copy-pasted between four and seven
times. Every change is expensive in context and risky in blast radius.

## Goals

1. Adopt the directory/layer layout in `01-architecture.md` §3, enforced by
   `arch.imports`.
2. Break every import cycle and upward import.
3. Replace `runNativeWorkbenchRuntime` with the staged pipeline in
   `01-architecture.md` §5.1. Native and ACP runners share `resolveRoute`, and
   there is a single `observedProviderCall`.
4. Split `cli.ts`, `uds-server.ts`, `acp-client.ts`,
   `external-agent-runtime.ts`, `config.ts`, `commands.ts`, `budget.ts`, and
   `sessions.ts` along the responsibility lines recorded in
   `00-baseline-findings.md` and the architecture spec.
5. Deduplicate kernel helpers into `kernel/` with one tested implementation
   each.
6. Introduce the `SessionOwner` as the single writer for per-session turn lock,
   ACP handle, budget scope, and cancel signal (`01-architecture.md` §5.7), and
   remove module-level mutable state.
7. Make the server a single composition root, with RPC handlers in one module
   per namespace.

## Non-goals

- Behavior changes of any kind.
- Provider and tool extensibility, which is PRD-12. This PRD only makes room for
  it.
- The data layer, which is PRD-13.

## Requirements

- **R1.** The `arch.imports` baseline reaches 0. After that the only import
  cycles and dynamic local imports are named entries in
  `scripts/arch-cycles.json` (the target is none). Deep imports are reported,
  not failed.
- **R1b.** No module-level mutable state in `src/`. The pool, the idea/packet
  registry and any similar state are owned by instances built in the composition
  root.
- **R2.** No runtime module exceeds 1,000 LOC, and no function exceeds 200
  lines.
  - Target: modules ≤ 600 LOC, functions ≤ 150 lines.
  - Measured by the size report, and listed in the PR when exceeded with a
    reason.
- **R3.** Directories that expose a `mod.ts` state their responsibility and
  allowed dependencies in its header (advisory; `01-architecture.md` §3).
- **R4.** The golden suite is unchanged across every PR in this PRD.
- **R5.** Tests covering moved modules migrate in the same PR (`03-testing.md`
  §7).

## Success metrics

- Median lines an agent must read to change one engine stage: < 800, down from >
  4,000.
- Zero unjustified cycles and zero upward imports, enforced by the gate.
- The largest runtime file drops from 4,149 LOC to ≤ 1,000.

## Risks

- **The pipeline split hides a subtle ordering dependency** between integrity
  checks, event writes, and budget recording. Mitigation: golden scenarios 1–7
  and 12 cover this. Split `observedProviderCall` first (WO-16), before stage
  extraction (WO-17).
- **The CLI split breaks launcher permission-grant computation.** Mitigation:
  keep the existing grant-computation tests, and move them with the code into
  `cli/launcher/`.
