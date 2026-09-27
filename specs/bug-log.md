# Phase-1 bug log

Phase 1 freezes behavior, so bugs found during restructuring are recorded here
and not fixed inline. Each entry must be public-safe prose. Security-shaped
findings are never recorded here; they go to the private tracker (AGENTS.md).

Entry format: date, symptom, location (`file:line` at the time found), suspected
cause, and the work order that found it. Fixes land as separate, dedicated
changes with a CHANGELOG `Fixed` entry.

## Open

- 2026-09-27 — **Terminal escape sequences are recognized three different
  ways.**
  - **Location:** `prototype/src/kernel/ansi.ts` (`stripAnsiEscapes`, used by
    the idea/packet renderer and the RPC string sanitizer);
    `prototype/src/streaming-markdown.ts:39` (`visibleWidth`) with its paired
    scanner at `:308` (`ansiSequenceEnd`); and `prototype/src/cli.ts:254`
    (`sanitizeSpinnerLabel` and its `skip*` helpers at `:318`–`:361`).
  - **Symptom:** the same input is treated differently depending on where it
    is shown. `visibleWidth` removes only CSI and OSC sequences and accepts CSI
    parameter bytes (`<`, `=`, `>`, `:`) that `stripAnsiEscapes` does not. It
    counts character-set designations (`ESC ( B`) and two-byte `ESC` sequences
    as visible text, which `stripAnsiEscapes` removes. Model text that
    contains such a sequence therefore wraps at a different column in the
    streamed markdown than its width after stripping. The spinner label
    sanitizer is a separate state machine that also drops 8-bit C1
    introducers and unterminated sequences, which neither regex-based copy
    does.
  - **Suspected cause:** each surface grew its own recognizer. They cannot
    be merged without changing what at least one surface displays: the
    markdown wrap column or the spinner label.
  - **Found during:** WO-07. The kernel took the two identical copies; the
    other two keep their current behavior pending a decision on which
    recognizer the surfaces should share.

- 2026-09-26 — **Piped REPL input runs only its first line.**
  - **Location:** `prototype/src/cli.ts:4035` (`readLineOrNull`) and
    `prototype/src/cli.ts:813` (`runRepl`).
  - **Symptom:** when the REPL's stdin delivers several lines and then EOF in
    one go (for example `printf 'a\nb\n' | dyfj`), only the first line runs as
    a turn. The REPL then exits with status 0 without running the remaining
    lines. Input typed line by line, or written one line per prompt, works.
  - **Suspected cause:** readline emits the buffered lines and `close` while
    the first turn is still running. Lines that arrive with no pending
    `question()` are dropped, and the next `readLineOrNull` sees the stream
    already closed and returns end of input.
  - **Found during:** WO-01. The golden suite drives the REPL one line per
    prompt, so it does not pin this.
- 2026-09-26 — **Session and event timestamps reach RPC clients as
  second-precision, time-zone-dependent text.**
  - **Location:** `prototype/src/utils.ts:92` (`doltQuery` converts every
    column with `String(value)`), surfacing through
    `prototype/src/sessions.ts:140-141` (`sessions/inspect`) and
    `prototype/src/sessions.ts:716` (`events/query`).
  - **Symptom:** `sessions/inspect` and `events/query` return `createdAt` and
    `updatedAt` as `Date.prototype.toString()` text, for example
    `Sat Sep 26 2026 21:51:50 GMT+0000 (Coordinated Universal Time)`. The text
    depends on the server's time zone and drops the microseconds the columns
    store. `sessions/list` returns ISO 8601 for the same columns.
  - **Suspected cause:** mysql2 returns `TIMESTAMP` columns as `Date` objects;
    `doltQuery` stringifies them without a format, and only some readers
    re-normalize the result.
  - **Found during:** WO-01 (golden scenario 10 pins the current format).
- 2026-09-26 — **`sessions/list` can order a resumed session below older
  activity.**
  - **Location:** `prototype/src/sessions.ts:216` (`compareSessionActivity`),
    fed by the second-precision timestamps above.
  - **Symptom:** sessions whose last activity falls in the same wall-clock
    second compare equal and fall back to session-id order, which is creation
    order. A session resumed in the same second as another session's turn
    therefore sorts below it, although its activity is later. The result
    depends on timing, so repeated runs of the same sequence can list sessions
    in different orders.
  - **Suspected cause:** the comparison uses timestamps that have already lost
    their sub-second precision.
  - **Found during:** WO-01. Golden scenario 5 starts its resume on a fresh
    wall-clock second so that scenario 10's listing is deterministic.

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

## Fixed

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
  - **Fixed:** 2026-09-27. The test file no longer calls `Deno.env.set`. A
    helper overlays the values on the `Deno.env` reads of the test's own
    worker, so no other worker or child process sees them, and the
    assertions are unchanged. The code under test reads these values only
    through `Deno.env`, so no runtime change was needed. The same file's
    `DENO_DIR` and ambient-secret tests moved to the helper too. Reproduced
    beforehand by holding the swapped `PATH` for three seconds while
    `src/uds-server.test.ts` ran beside it (three of three runs failed as
    observed in CI), and absent with the same delay after the change (ten of
    ten runs passed).
