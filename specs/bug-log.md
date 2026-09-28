# Phase-1 bug log

Phase 1 freezes behavior, so bugs found during restructuring are recorded here
and not fixed inline. Each entry must be public-safe prose. Security-shaped
findings are never recorded here; they go to the private tracker (AGENTS.md).

Entry format: date, symptom, location (`file:line` at the time found), suspected
cause, and the work order that found it. Fixes land as separate, dedicated
changes with a CHANGELOG `Fixed` entry.

## Open

- 2026-09-28 — **`model_selected` names the environment's principal, not the
  turn's.**
  - **Location:** `prototype/src/utils.ts` (`writeModelSelectedEvent`, whose
    payload defaults `principal_id` to `resolvePrincipalId` over the process
    environment), called from `prototype/src/engine/budget-gate.ts`.
  - **Symptom:** every other event of a native turn carries the turn's
    `principalId`; `model_selected` carries `DYFJ_PRINCIPAL_ID`, else `USER`,
    else `user`. Through the served turn entry the two agree, because the
    boundary resolves the turn's principal from the same environment. They
    differ for a direct caller that passes its own `principalId`, or none (the
    turn then defaults to `user` while the event names `USER`), so one turn's
    audit rows can name two principals.
  - **Suspected cause:** the helper predates principals on the runtime input
    and was never given the turn's. The old runtime test mocked the helper, so
    the difference was not visible. WO-17 keeps the value and reads it through
    the engine's env port; the new component test pins it.
  - **Found during:** WO-17 (budgetGate extraction).
- 2026-09-28 — **Route resolution silently swallows a model-registry load
  failure.**
  - **Location:** `prototype/src/engine/route.ts:191-193` and `:224-233`
    (`selectedAcpRoute`, called by `resolveRoute`); before WO-16 this was the
    pre-dispatch block of `runWorkbenchRuntime` in `prototype/src/workbench.ts`.
  - **Symptom:** when the catalog cannot be loaded, route resolution falls back
    to the static local defaults without a log line, and any error that is not a
    domain or routing error is dropped. The turn then takes the native route,
    which loads the catalog a second time: a companion turn fails there, and an
    ask or next-work turn warns and runs on the local default. A registry outage
    is reported only by that second load, and a turn whose request named an ACP
    model takes the native path if the first load fails and the second
    succeeds, where it fails because no provider adapter serves that model.
  - **Suspected cause:** the pre-dispatch ACP check was added as a best-effort
    probe in front of the native path rather than as the one place the route is
    decided. Whether the failure should be logged, fail the turn, or be loaded
    once and shared with the native selection is a behavior question, so WO-16
    preserves it and pins it with
    `prototype/src/engine/route.component.test.ts`.
  - **Found during:** WO-16 (step 2).
- 2026-09-28 — **Compression `provider_call` rows omit the unparsed tool-call
  markup counts.**
  - **Location:** `prototype/src/engine/compression.ts:208`
    (`recordUnparsedToolCallMarkup: false` on the compression call) and
    `prototype/src/engine/observed-call.ts:152`.
  - **Symptom:** an agent-loop call whose text carries unmatched tool-call
    wrapper openings records `unparsed_tool_call_count` on its `provider_call`
    row; a compression call with the same text does not, so the event log cannot
    show that a summary was produced from degraded model output.
  - **Suspected cause:** the compression call was written as a separate copy of
    the agent-loop call before the counts existed and never gained them. WO-16
    unified the two copies and kept the difference behind a flag, since adding
    the columns changes event rows.
  - **Found during:** WO-16 (step 3).

- 2026-09-28 — **A command result of `undefined` is persisted as an undefined
  `tool_result`.**
  - **Location:** `prototype/src/tools/redaction.ts:102-104`
    (`formatCommandResult`).
  - **Symptom:** a non-string result is serialized with `JSON.stringify`,
    which returns `undefined` for `undefined`; the event then carries no
    `tool_result` text. Not reachable today: every builtin and MCP-derived
    command returns a string.
  - **Suspected cause:** the helper assumes a JSON-serializable result; it
    moved unchanged from `commands.ts`.
  - **Found during:** WO-15 (review of the shared redactor).
- 2026-09-28 — **`read_file` declares `offset` and `limit` as `number`, not
  `integer`.**
  - **Location:** `prototype/src/tools/builtin/file.ts:1661` and `:1667`
    (`defineReadFile` input schema); the executor check is at `:193-200`.
  - **Symptom:** a fractional `offset` or `limit` (for example `1.5`) passes
    schema validation and reaches `executeReadFile`, which rejects it with an
    `error:` result the model can recover from. The schema should reject it
    before execution, as the `git` tool's integer `limit` does.
  - **Suspected cause:** the schema predates the `integer` type in the
    validator. Changing it changes the schema sent to providers and listed by
    `tools/list`, so it waits for a change that updates the golden snapshots.
  - **Found during:** WO-15 (review of the moved builder).
- 2026-09-28 — **`memory.read` built without a reader throws a plain `Error`
  out of the invoke path.**
  - **Location:** `prototype/src/tools/builtin/memory.ts:45-47`
    (`defineMemoryRead`'s fallback reader).
  - **Symptom:** invoking `memory.read` from a catalog built without
    `readMemory` rejects out of `invokeCommandWithEvent` instead of returning
    an error result, so no `tool_call` event is written for that call.
    `invokeCommand` converts only `CommandExecutionError`. Not reachable
    today: the runtime always supplies `readMemory`, and the catalogs built
    without it (`tools/list`, `tools/inspect`, friction) never invoke it.
  - **Suspected cause:** the fallback predates `CommandExecutionError`; it
    moved unchanged from `commands.ts`.
  - **Found during:** WO-15 (review of the moved builder).
- 2026-09-28 — **A bounded regex's first match pays for the matcher worker's
  startup out of its matching budget.**
  - **Location:** `prototype/src/kernel/bounded-regex.ts:161-163`
    (`BoundedMatcher`: `#ensureWorker()` then `started = performance.now()`).
  - **Symptom:** `grep_files` can report a harmless pattern as too expensive
    when the worker boots slowly, because the first call's elapsed time includes
    the worker loading its module. Conversely, a test that relies on the budget
    firing can pass on a slow worker start rather than on the pattern (seen
    while migrating the `grep_files` resource-bounds test, whose fixture line
    was too long to reach the matcher at all).
  - **Suspected cause:** the budget clock starts when the match is posted, not
    when the worker is ready to match.
  - **Found during:** WO-15 (test migration of the file tools).
- 2026-09-28 — **The file tools keep workspace-root anchors in module-level
  mutable state.**
  - **Location:** `prototype/src/tools/builtin/file.ts:93` (`rootAnchors`, with
    `resetRootAnchor` as its test hook).
  - **Symptom:** the anchors are a process-global `Map`, not state owned by an
    object the composition root constructs; tests share it across cases and must
    reset it by hand.
  - **Suspected cause:** predates the doctrine; `01-architecture.md` §5.7 lists
    the known module-level state (the Dolt pool, the idea/packet registry), and
    this map is not on that list.
  - **Found during:** WO-15 (moving `file-tools.ts`, unchanged).
- 2026-09-27 — **An Anthropic forced-conclusion turn sends historical tool
  calls under their registry names, not their wire names.**
  - **Location:** `prototype/src/providers/anthropic/adapter.ts` (the
    `buildAnthropicMessagesRequest` call) and `anthropic/request.ts`
    (`toAnthropicWireMessages`); the call site is
    `prototype/src/engine/agent-loop.ts`, which sets `historyTools` when a
    forced conclusion drops `tools`.
  - **Symptom:** when the agent loop forces a no-tools conclusion, the
    Anthropic request's history maps prior `tool_use` names through `tools`,
    which is now empty, so dotted command ids (`memory.read`) go out unmapped
    instead of as the wire names (`memory_read`) the earlier requests used.
    The provider may reject the replay before it produces the conclusion. The
    OpenAI-compatible builder takes `historyTools ?? tools` for this mapping;
    the Anthropic builder has no `historyTools` input.
  - **Suspected cause:** `historyTools` was added to the OpenAI-compatible
    path only; the Anthropic adapter never received it (identical before the
    provider split, which moved the code without change).
  - **Found during:** WO-14 (from review of the moved adapter).
- 2026-09-27 — **The memory MCP server accepts four of the five memory types
  the DDL allows.**
  - **Location:** `prototype/mcp/server.ts:80` and `:99` (the `write_memory`
    and `list_memories` input schemas) against `schema/current/001_structure.sql`
    (`memories.type`).
  - **Symptom:** the DDL's `memories.type` enum is `user`, `feedback`,
    `environment`, `project`, `reference`, but both MCP tools validate `type`
    against `user`, `feedback`, `project`, `reference`. An `environment` memory
    can be read and injected, but cannot be written or filtered for through the
    MCP server.
  - **Suspected cause:** the tool schemas were written by hand and the
    hand-written `MemoryType` union matched them, so nothing compared either
    with the DDL. `MemoryType` is now generated from the DDL and includes
    `environment`; the tool schemas are unchanged, since widening them changes
    what the server accepts.
  - **Found during:** WO-13.
- 2026-09-27 — **The memory MCP server does not exit when its client closes
  stdin after a database call.**
  - **Location:** `prototype/mcp/server.ts` (the `serveStdio` start at the end
    of the file) with `StdioServerTransport` from
    `@modelcontextprotocol/server/stdio`.
  - **Symptom:** after any tool call that reaches Dolt, closing the server's
    stdin leaves the process running until it is killed. Reproduced by piping
    an initialize request and a few tool calls into the server and then ending
    input: the process was still alive 20 seconds later, identically before and
    after the store port.
  - **Suspected cause:** the SDK transport stops reading on end of input but
    does not close, so its close handler never runs, and the Dolt pool's open
    connection keeps the process alive. The server now closes its store when
    the transport closes, which does not happen on end of input.
  - **Found during:** WO-12 (present before it; it did not change).
- 2026-09-27 — **The two UDS clients resolve the socket path differently when
  `HOME` is unset.**
  - **Location:** `prototype/src/uds-path.ts:14` (`resolveSocketPath`) against
    `core/dyfj-repl/src/main.rs:75` (`resolve_socket_path`).
  - **Symptom:** with `DYFJ_SOCKET` and `XDG_RUNTIME_DIR` unset or empty and
    `HOME` unset, the TypeScript CLI and engine fall back to the relative path
    `./.dyfj/run/workbench.sock`, while the Rust REPL client exits with an
    error. Launched from different working directories, the TypeScript side can
    also bind or dial different sockets.
  - **Suspected cause:** the Rust client mirrors the TypeScript precedence
    (`DYFJ_SOCKET`, then `XDG_RUNTIME_DIR`, then `HOME`) but chose to fail
    instead of copying the `"."` fallback, and nothing checks that the two stay
    in step.
  - **Found during:** WO-10 (present before it; neither side changed).
- 2026-09-27 — **`deno task verify-workbench-events` cannot read `DYFJ_ROOT`.**
  - **Location:** `prototype/src/config/defaults.ts:198`
    (`resolveRuntimeEnvDefaults` reads `DYFJ_ROOT`) against the
    `verify-workbench-events` permission profile in `prototype/deno.json:160`,
    which does not grant it.
  - **Symptom:** the in-process check spreads `resolveRuntimeEnvDefaults()` into
    its runtime input, and that read of an ungranted variable throws
    `NotCapable`, so the task fails before its first turn.
  - **Suspected cause:** the profile's env list was not updated when the root
    override joined the runtime env defaults. The parity test covers only the
    `serve-unix` profile and checks this one for `DYFJ_MAX_TOOL_STEPS` alone.
  - **Found during:** WO-10 (present on `main` before it; the move kept the read
    unchanged).
- 2026-09-27 — **Budget env values accept a numeric prefix.**
  - **Location:** `prototype/src/config/values.ts:91` (`readPositiveUsd`, used
    for `DYFJ_BUDGET_SESSION_USD`, `DYFJ_BUDGET_PER_CALL_USD` and
    `DYFJ_BUDGET_DAILY_USD`).
  - **Symptom:** a value such as `1oops` or `2x` is read as `1` or `2` instead of
    failing the boot, so a mistyped envelope silently applies a different limit.
    The anomaly multiples already reject trailing junk.
  - **Suspected cause:** the reader uses `Number.parseFloat`, which accepts a
    valid numeric prefix, where the multiples use a strict `Number()`
    conversion.
  - **Found during:** WO-10 (present on `main` before it; the move kept the
    parsing unchanged).
- 2026-09-27 — **An upgraded database keeps a local model row active that a
  fresh install ships inactive.**
  - **Location:** `schema/migrations/008_models_execution_profile.sql:14` (sets
    `active = TRUE` on the `mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit`
    row) against `schema/catalog/001_models.sql:1296` (the same row, shipped
    with `active = FALSE`).
  - **Symptom:** a database brought forward through `history/` and `migrations/`
    lists the MLX Qwen3-Coder row in `dyfj models` and accepts it for `--model`,
    while a fresh `current/` + `catalog/` install does not. The default local
    route is unaffected on both paths, because `qwen3.6:35b-a3b` is active on
    both and comes first in the local preference order.
  - **Suspected cause:** the catalog change that retired the MLX coder as the
    local default updated `catalog/` but added no forward migration, so the
    upgrade path still ends in the older catalog state. The schema validator
    checks that both sequences apply, not that they agree, and the planned
    `schema.equivalence` lane compares structure only, not catalog data. Other
    catalog rows may diverge the same way; this is the one observed.
  - **Found during:** WO-06.
- 2026-09-27 — **`dyfj --help` omits several working REPL commands.**
  - **Location:** `prototype/src/cli.ts:3962` (the `REPL commands:` block of
    `HELP`), against the dispatch at `prototype/src/cli.ts:863` and `:869`.
  - **Symptom:** the help text lists `/model`, `/fast`, `/session`, `/friction`,
    and `/exit`/`/quit`, but not `/idea mark|list|show`,
    `/packet draft|list|show`, the `/session list` and `/session switch`
    subcommands, or `/friction last`. All of these run in the REPL.
  - **Suspected cause:** the commands were added without updating the static
    help string; nothing checks the help against the dispatcher.
  - **Found during:** WO-06.

- 2026-09-27 — **`buildTurnHandlers` ignores its `acpSessions` option.**
  - **Location:** `prototype/src/uds-server.ts:1248` (`buildTurnHandlers`),
    with the option declared at `:213`.
  - **Symptom:** when `buildTurnHandlers` is called without `runRuntime`, its
    default runtime runs ACP turns with no session map, even if the caller
    passed `acpSessions`. Sequential ACP turns through that path therefore
    cannot reuse warm session handles. `serveWorkbenchUnix`, the only
    production caller, always supplies `runRuntime` bound to its map, so the
    served runtime is unaffected.
  - **Suspected cause:** the default runtime is not bound to the option; only
    `serveWorkbenchUnix` passes its map into the runtime.
  - **Found during:** WO-08 (review). The move kept the existing behavior.

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
  - **Location:** `prototype/src/store/dolt-readers.ts:35` (`textRow`
    converts every column with `String(value)`; before the store port this
    was `doltQuery` in `utils.ts`, and `MemoryStore` reproduces it), surfacing
    through `prototype/src/store/sessions.ts:118-119` (`sessions/inspect`) and
    `prototype/src/store/sessions.ts:365` (`events/query`).
  - **Symptom:** `sessions/inspect` and `events/query` return `createdAt` and
    `updatedAt` as `Date.prototype.toString()` text, for example
    `Sat Sep 26 2026 21:51:50 GMT+0000 (Coordinated Universal Time)`. The text
    depends on the server's time zone and drops the microseconds the columns
    store. `sessions/list` returns ISO 8601 for the same columns.
  - **Suspected cause:** mysql2 returns `TIMESTAMP` columns as `Date` objects;
    the store's readers stringify them without a format, and only some
    callers re-normalize the result.
  - **Found during:** WO-01 (golden scenario 10 pins the current format).
- 2026-09-26 — **`sessions/list` can order a resumed session below older
  activity.**
  - **Location:** `prototype/src/store/sessions.ts:184`
    (`compareSessionActivity`),
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
