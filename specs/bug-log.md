# Phase-1 bug log

Phase 1 freezes behavior, so bugs found during restructuring are recorded here
and not fixed inline. Each entry must be public-safe prose. Security-shaped
findings are never recorded here; they go to the private tracker (AGENTS.md).

Entry format: date, symptom, location (`file:line` at the time found), suspected
cause, and the work order that found it. Fixes land as separate, dedicated
changes with a CHANGELOG `Fixed` entry.

## Open

- 2026-09-25 — **Model-registry load errors are silently dropped on the ACP
  dispatch path.**
  - **Location:** `prototype/src/workbench.ts:1535-1543`.
  - **Symptom:** a catalog failure is swallowed rather than surfaced.
  - **Found during:** baseline analysis. WO-16 must preserve the current
    behavior.
- 2026-09-25 — **Ideas and packets are lost on server restart.**
  - **Location:** `prototype/src/idea-packet.ts:809`
    (`defaultIdeaPacketRegistry`, a module-level in-memory singleton).
  - **Symptom:** marked ideas and drafted packets disappear when the engine
    server restarts. They never reach the event log.
  - **Status:** scheduled in roadmap durable-state work. Phase 1 only moves
    ownership (WO-20).
  - **Found during:** doctrine review.
- 2026-09-26 — **A test swaps the process-wide `PATH`, racing tests that spawn
  commands by name.**
  - **Location:** `prototype/src/external-agent-runtime.test.ts:699`, which sets
    `PATH` through `Deno.env.set` and restores it in a `finally` after an
    `await`. The test at `:812` swaps `HOME`, `DENO_DIR`, and `DYFJ_*` keys the
    same way.
  - **Symptom:** under the parallel Vitest run (`--pool=threads`), a test in
    another file intermittently fails to spawn a command by name. Observed:
    `src/uds-server.test.ts` "clears a genuinely stale socket and binds" failed
    with `Failed to spawn 'bash': entity not found`, while earlier commits with
    identical prototype code passed.
  - **Suspected cause:** `Deno.env` is shared by every worker thread in the
    process, so the temporary `PATH` is visible to tests running concurrently in
    other files. The code under test should take the ambient `PATH` as an input
    rather than having the test mutate the process environment.
  - **Found during:** WO-02 (seen in CI; not caused by that change).
