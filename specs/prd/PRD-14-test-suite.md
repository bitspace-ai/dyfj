# PRD-14 — Test suite rebuild

**Phase:** 1, running continuously alongside PRD-11/12/13. **Work orders:**
WO-03, WO-23, WO-24 (plus the per-PR migration rule inside every structural WO).

## Problem

The suite has ~49k lines of tests, and they don't fit the rules the project
states for itself:

- **Mocks where the doctrine forbids them.** The central runtime test replaces
  10 internal modules with mocks. Dolt is faked almost everywhere. Several
  "integration" tests run against in-test fakes.
- **Two frameworks, one tier.** Integration tests are split across two
  frameworks, with a hand-maintained assignment list.
- **No shared support.** Helpers are copy-pasted across files.
- **Heavy supervision.** About 2.5k LOC of supervisor, lock, and reaper code
  exists to contain process leaks from unit tests.
- **Unexplained timeouts.** Parallel-run timeouts have an open root cause.
- **No fast loop.** The fast lane runs no product behavior tests.

## Goals

1. **Doctrine.** Enforce the doctrine in `03-testing.md` §1. Revise README §4 to
   match.
2. **Tiers and support.** Build the tier layout and `prototype/testing/` support
   package (§3).
3. **Conformance kits.** Build the store, provider, and tool conformance kits
   (§5).
4. **Framework.** Retire Vitest, and decide on evidence which parts of the
   supervisor survive.
5. **Fast lane and gate reporting.** Make `test:fast` a real inner loop, and
   have the gate report every failing lane.

## Non-goals

- Coverage percentage targets.
- Changing the contracts-package tests.
- Hosted-model CI.

## Requirements

- **R1. Unit/component tier is hermetic.** Zero `vi.mock`, zero Vitest, zero
  module-mocking in the tree. Unit and component tests spawn no processes and
  open no sockets outside the integration tier. Sanitizers catch violations of
  both rules.
- **R2. Every fake has a conformance suite.** Each fake in `testing/fakes/` that
  replaces a real adapter runs a conformance suite against both implementations.
- **R3. Tier is decided by file name.** The `integration-test-assignment.ts`
  list is deleted.
- **R4. One typecheck file list.** It is derived by globbing, so the gate and
  local tasks cannot diverge.
- **R5. Supervisor fate is decided on evidence.** WO-23 produces a written,
  public-safe evidence note:
  - which process-leak classes Deno sanitizers catch;
  - which leaks they miss;
  - which supervisor functions are therefore retained or removed.
- **R6. Fast unit lane.** `test.unit` completes in under 60 s on the Linux CI
  runner.

## Success metrics

- Flaky reruns: target zero timeout-class failures across 20 consecutive gate
  runs at phase-1 exit.
- Unit-tier wall-clock under 60 s.
- Test support duplication: zero copies of `fakeIo`, `buildClock`, fake fetch
  builders, or inline loopback servers outside `testing/`.

## Risks

- **Coverage quietly lost in translation.** Mitigation: the per-PR rule in
  `03-testing.md` §7 (replaced or declared redundant), plus the golden suite as
  a backstop.
- **Deno parallel test isolation differs from Vitest threads.** Tests that
  relied on per-worker module state may break. That breakage is desired: it
  exposes hidden global state, which should be removed rather than worked
  around.
