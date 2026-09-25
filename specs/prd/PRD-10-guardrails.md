# PRD-10 — Guardrails before restructuring

**Phase:** 1 (first). **Work orders:** WO-00 … WO-06.

## Problem

The code is about to be restructured by agents, one seam per PR. Today nothing
detects an unintended behavior change at the system boundary:

- the unit suite mocks the internals it is supposed to protect;
- nothing detects a new import cycle or layer violation;
- the docs already contradict the code in places.

A strangler refactor without these guardrails turns into a rewrite with extra
steps.

## Goals

0. Retire the ACP lane to the backlog before anything pins its behavior (WO-00,
   decision D17).
1. Pin current observable behavior with a black-box golden suite
   (`03-testing.md` §4).
2. Make architecture rules machine-checked, in ratchet mode: violations may only
   go down.
3. Stand up the `Deno.test` lane and `prototype/testing/` next to Vitest, so
   later work orders have somewhere to move tests.
4. Remove the approved vestigial surfaces and the `--sloppy-imports` dependency,
   so later file moves are mechanical and grep-safe.
5. Make the docs stop lying before the refactor starts, so agents are not
   steered by stale claims.

## Non-goals

- Moving runtime modules.
- Changing behavior beyond the deletions approved in `01-architecture.md` §8.

## Requirements

- **R0.** WO-00 has landed: no ACP runtime code, dependency or surface remains,
  and the retired-surface scan enforces it.
- **R1.** The golden scenarios 1–12 exist and pass on `main` before any
  structural work order merges.
- **R2.** The `arch.imports` lane runs in the gate. It has a committed baseline
  file and fails on any new violation.
- **R3.** The `test.unit` lane runs `Deno.test` files, even if it starts with
  only a handful of tests.
- **R4.** No `--sloppy-imports` flag in any task. Every local import carries an
  explicit `.ts` extension.
- **R5.** `deno task start` / `workbench` and the standalone CLI code are gone.
  - `README.md`, `prototype/README.md`, and `CHANGELOG.md` (under `Removed`) say
    so.
- **R6.** The docs drift listed in `00-baseline-findings.md` ("Docs drift") is
  corrected, covering:
  - HTTP/SSE leftovers;
  - provider count;
  - local default model;
  - schema apply order;
  - §6 aspirational features marked as not implemented;
  - undocumented RPC methods, tools, and REPL commands;
  - the stale `.d2` diagram, either regenerated or removed.
  - A README revision-history line is added.

## Success metrics

- The golden suite is green and deterministic: 20 consecutive local runs with
  identical snapshots.
- `arch.imports` baseline count is recorded. It becomes the number that PRD-11
  must drive to 0.
- Gate wall-clock grows by no more than ~2 min on the Linux runner (today it is
  ~4 min).

## Risks

- **Nondeterminism in golden captures** (timing, ordering of concurrent events).
  Mitigation: normalize only the listed volatile fields. If ordering is
  genuinely nondeterministic, log it as a bug and don't mask it.
- **Paid-path predicate for scenario 6 may not be reachable with a loopback
  model.** Mitigation: WO-01 verifies this first. If it isn't reachable, the
  paid envelope path is covered by budget component tests plus a bug-log entry,
  not by modifying runtime code.
