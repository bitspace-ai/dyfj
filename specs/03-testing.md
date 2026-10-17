# 03 — Test architecture

Status: normative for phase 1.

This spec replaces the testing bullets of README §4. Those bullets are revised
in the same change that lands this spec's first work order.

## 1. Doctrine (replaces README §4 testing bullets)

- **Tests land with the code.** This rule is unchanged.
- **Fakes live at declared ports only.**
  - The ports are listed in `01-architecture.md` §5.6.
  - A unit or component test replaces a port with its in-repo fake.
  - Module mocking is banned: no `vi.mock`, no import-map substitution, no
    monkey-patching another module's exports.
  - Spying on an injected object (`node:test` `mock.fn`/`mock.method`) is
    allowed.
- **Fakes are proven against the real thing.**
  - Each fake that stands in for a real adapter (`MemoryStore`, the scripted
    `HttpTransport`) passes the same conformance suite as the real adapter.
  - A fake without a conformance suite is not allowed once its port exists. A
    fake may land before its port (shared fakes arrive ahead of the seams that
    will use them); its conformance suite then lands in the same change that
    declares the port and its real adapter.
- **Real dependencies live in the integration tier.** This tier covers real
  Dolt, real child processes and real sockets.
  - Third-party network services are faked at the network boundary, using
    loopback servers from `testing/servers/`. That boundary is the stand-in for
    an external service, not for an internal module.
- **Local-model generation checks** and **evals for model-touching code**:
  carried over from README §4 unchanged.
- **Behavior is pinned by golden tests** (§4) for the whole of phase 1.
- **Leak checks: the per-file handle check** (decision D32).
  - Product tests run on `node:test` only, under `node --test`, one process per
    file. The unit, integration and golden lanes route each discovered file by
    its path and content (`prototype/scripts/test-files.ts`); no file is listed
    by hand:
    - a test file under `prototype/scripts/` that calls `Deno.test` or imports
      `@std/testing/bdd` is a gate-tooling test and runs under `deno test`,
      until the gate-tooling port;
    - every other test file runs under `node --test`, including a
      `prototype/scripts/` file that registers with `node:test` only;
    - a test file outside `prototype/scripts/` that calls `Deno.test` or
      imports `@std/testing/bdd` fails discovery, with its path in the message.
  - Each `node --test` file process preloads the per-file handle check
    (`prototype/testing/node-handle-check.ts`). It records the live resources at
    load, compares them with what is live after the file's last test, and fails
    the file and exits its process when anything beyond that baseline remains,
    so a leaked server, socket, timer or child process can neither pass nor hang
    the run.
  - Before each comparison the check waits for everything already written to
    the file's own stdout and stderr to flush. Stdout is the runner's channel
    to its parent `node --test`, and where pipe writes are asynchronous
    (macOS) a write still in flight on it is the runner's output, not a leak.
    A pending write to any other stream is still reported. A failing file sets
    its exit code and exits after a bounded grace period, once its output is
    flushed, so the runner's report of its tests is not cut off.
  - The check is per file, so it is coarser than a per-test sanitizer: it names
    the file that leaked, not the test, and does not see a resource one test
    leaves open and a later test in the same file closes.

## 2. Framework

- **Framework: `node:test`** (decision D32).
  - Product tests register with `node:test` (`test`, `describe`/`it`,
    `before`/`after` and the other hooks), take assertions from
    `node:assert/strict` and mocks from `node:test` (`mock`), and run under
    `node --test` with the per-file handle check (§1).
  - The gate and lane tooling tests under `scripts/` and `prototype/scripts/`
    may still use `Deno.test`, `@std/testing/bdd` and `@std/assert` until the
    gate-tooling port, which moves them with that tooling. The ported static
    checks' tests (subject, public-safety, range, retired-surface,
    dependency-policy, change-scope and `ratchet.base`) and the
    `runtime.neutral` test register with `node:test` and take assertions from
    `node:assert/strict`; until the orchestration lane moves to Node they run
    in its `deno test` invocation, which runs `node:test` registrations.
  - The end state under decision D32 is `node:test` as the only test
    framework, with `Deno.test`, `@std/testing` and `@std/assert` gone.
- **Sanitizers stay on for the gate-tooling `deno test` subset**, until the
  gate-tooling port.
  - They apply only to the `prototype/scripts/` files that `test.unit` and the
    integration lane run under `deno test` (§1). They do not see `node:`
    resources (a server, socket or child process from `node:net`, `node:http`
    or `node:child_process`); of the resources tests use, they catch only
    timers.
  - The pinned Deno (2.9.6) runs the op and resource sanitizers only when asked,
    so those lanes' `deno test` runs pass `--sanitize-ops --sanitize-resources`.
    The golden lane runs no `deno test`.
  - A test may disable a sanitizer only with a comment naming the leak and why
    it is unavoidable.
- **Supervision.**
  - Per-test sanitizers and a process group per gate lane replace most of the
    former test supervisor. What remains of it (a wall-clock bound and cleanup
    of same-group descendants when a lane or the gate itself dies) was decided
    by WO-23 on evidence from the migrated suite, recorded in
    `specs/notes/test-supervision-evidence.md`. It lives in the aggregate gate
    (per-lane deadlines, recovery of an orphaned lane group) and in the
    test-lane runners (`prototype/scripts/lane-supervision.ts`: a backstop and
    a stop of the runner's own process group). `node --test` and its per-file
    processes stay in the lane's process group, so both cover them.
  - The runners (`node scripts/run-unit-tests.ts`,
    `node scripts/isolated-dolt-integration.ts`, `node testing/golden/run.ts`)
    and their helpers (the lane token carrier and the group stop, `node`
    children of the runner) run on Node and use `node:` builtins only. The
    gate driver stays on Deno until the gate-tooling port. Decision D32.
  - **Lane helpers exit when their parent dies.** A gate lane's runner checks
    its parent, the gate, every 200 ms; once the gate is gone it ends its
    current step and stops its group, and exits. The token carrier checks its
    parent, the runner, the same way; once the runner is gone it stops the
    group itself (TERM, the 2 s grace, then KILL to what is left) and exits.
    The group stop is bounded on its own. So a gate, or a gate and its runner,
    killed outright leave no helper or lane process running, which
    `scripts/lane-supervision.test.ts` pins by pid. Recovery of an orphaned
    group at the next gate start stays as the fallback for a group whose
    carrier still holds its token.
  - Descendant (grandchild) processes are not covered by the per-file handle
    check or by Deno's sanitizers. Whatever guards against them must remain.

## 3. Tiers and layout

| Tier        | What                                                                | Allowed                                          | File pattern                           | Lane               |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------- | ------------------ |
| unit        | one module                                                          | fakes of ports, temp dirs                        | `src/<dir>/<module>.test.ts`           | `test.unit`        |
| component   | a directory or the engine pipeline wired with fakes                 | fakes of ports, temp dirs                        | `src/<dir>/<name>.component.test.ts`   | `test.unit`        |
| conformance | a shared suite run against both fake and real adapters              | fake run in `test.unit`; real run in integration | `testing/conformance/*.ts` (suites)    | both               |
| integration | real Dolt, real processes, real sockets, loopback third-party fakes | isolated Dolt fixture                            | `src/<dir>/<name>.integration.test.ts` | `test.integration` |
| golden      | whole system, process level (§4)                                    | isolated Dolt, loopback model server             | `testing/golden/`                      | `test.golden`      |

- **Colocation.** Test files are colocated with the module they test and named
  after it. `cli.test.ts`-style catch-alls are split along the module split.
- **Size guidance.** Soft limit of 800 LOC per test file. The size report flags
  anything over it.
- **Shared test support** lives in `prototype/testing/`. It is not in `src/`,
  and runtime code never imports it.
  - `fakes/`: `ScriptedHttpTransport`, `ManualClock`, `SequentialIds`,
    `MapEnv`, `ScriptedDnsResolver` and `fakeIo`. The `Store` fake,
    `MemoryStore`, lives in `src/store/`.
    - The list names only fakes that exist. `Approver` and `FrameSink` have no
      shared fake: their tests pass small inline doubles, and a shared fake for
      either lands with its conformance suite when tests first need one.
    - `SequentialIds` is a fake that landed before its port. It needs no suite
      until an `IdSource` port exists in code.
    - `fakeIo` stands in for the CLI's `Io` port (`src/cli/io.ts`), a client
      port outside the runtime list in `01-architecture.md` §5.6. Its real
      adapter is the process's terminal, which the unit lane cannot open, so
      it has no conformance suite yet; that suite stays deferred under D28.
  - `servers/`: loopback OpenAI-compatible model server, MCP HTTP server,
    scripted HTTP server, UDS peer, and raw listeners (one that never answers,
    a stale socket file).
  - `builders/`: event, session, model-row and turn-request builders, typed
    against generated rows.
  - `conformance/`: store, provider-adapter and tool suites, and the `Env` port
    suite (`env.ts`) and `DnsResolver` port suite (`dns-resolver.ts`).
  - `golden/`: the harness and scenarios.
- **Integration assignment.** The hand-maintained
  `integration-test-assignment.ts` is deleted. The tier is decided by file name,
  and the lanes glob on it.

## 4. Golden (characterization) suite

**Purpose:** pin today's observable behavior before any structural change, and
keep it unchanged through phase 1. It must be black-box, so it survives every
internal move.

- **Harness**
  - Starts the isolated Dolt fixture.
  - Seeds a catalog row for a local OpenAI-compatible model whose `base_url` is
    a loopback fake model server. Local-provider base URLs accept any loopback
    host (`providers/shared/base-url.ts`); the seeded port must also be inside
    the harness's net grant.
  - Starts the engine server on a temp socket.
  - Drives it two ways: (a) the `dyfj` CLI (`exec --json` and scripted REPL
    stdin), and (b) a raw JSON-RPC client.
- **Captured per scenario**
  - Stream frames and RPC responses.
  - The rendered CLI output.
  - `events` and `sessions` rows (all columns).
- **Normalization.** ULIDs, trace IDs, timestamps, durations, temp paths and
  PIDs are replaced by stable placeholders. Nothing else is normalized.
- **Minimum scenario set**
  1. One-shot text turn, local model.
  2. Multi-step turn with `read_file` then an answer (`operator` permission
     level).
  3. Mutating tool under `strict`, with the non-interactive client rejecting.
     The refusal reaches the model as an `approval_denied:` message and the
     turn's second provider call is a forced conclusion; scenario 03 was
     re-snapshotted under that decision (below, scenario 13).
  4. `bash` always asks; approved via the scripted approver.
  5. Continue an existing session (history projection). The resumed turn
     names no model, so it runs on the session's recorded model and reports
     the route reason `session_model`; scenarios 05, 10 (whose
     `sessions/inspect` also reports the recorded model and runner) and 11 (which shares
     scenario 05's session row) were re-snapshotted under that decision.
  6. A model with a pricing row crossing the session envelope, non-interactive.
     Expect fail-closed.
     - _Working thesis:_ a loopback model with a price row exercises the paid
       path. The WO must verify which predicate decides "paid" before relying on
       it.
  7. Anomaly hard stop at the configured multiple.
  8. `--runner fixture` ACP turn against `scripts/acp-fixture-agent.ts`.
  9. `turn/cancel` mid-stream.
  10. Read methods: `runtime/status`, `runtime/liveness`, `surface/snapshot`,
      `models/list`, `sessions/list`, `sessions/inspect`, `events/query`,
      `tools/list`, `tools/inspect`.
  11. Extension methods with loopback fakes for third-party services: `ideas/*`,
      `packets/*`, `friction/post`.
  12. Transcript compression triggered by a small context profile. The
      fixture window must hold the fixed request prefix (system prompt plus
      tool definitions): the engine fits every request to the window before
      it is sent, so a window under the prefix fails every turn before the
      model sees it. The window was raised from 2,000 to 12,000 tokens, and
      the padding sized to cross the trigger on the fourth turn, when
      request fitting landed; scenarios 10 and 12 were re-snapshotted under
      that decision.
  13. `bash` denied by the scripted approver: the model receives an
      `approval_denied:` refusal, the `toolCallCompleted` frame carries
      `verdict: "approval_denied"`, the `tool_call` event keeps its `deny`
      action, and tool use ends for the turn (the second provider call is a
      forced conclusion). Added with the decision that a refused approval
      hands control back to the operator; scenario 03 goes through the same
      path and was re-snapshotted under it.
- **Hosted adapters are outside the golden suite** (Anthropic, OpenAI,
  OpenRouter, Gemini, xAI). Their base URLs are pinned to real HTTPS hosts. They
  are pinned instead by the provider conformance kit (§5), using recorded
  request/response fixtures at the `HttpTransport` port.
- **Snapshot updates.**
  - Snapshots are committed.
  - In phase 1, updating one requires the PR to state the one approved deletion
    that caused the change.
  - Any other snapshot diff is a failed refactor.
  - Roadmap work that intentionally changes behavior updates snapshots under its
    own recorded decision, naming each changed scenario.
  - Only an explicit update writes a snapshot. The suite runs under
    `node --test`, which has no permission sandbox and passes a test file no
    arguments, so the rule is enforced in code. The runner turns
    `deno task test:golden --update` into `DYFJ_GOLDEN_UPDATE=1` for the test
    process. Every write under `testing/golden/snapshots/` goes through one
    function (`testing/golden/snapshots.ts`), and that function throws unless
    the variable is `1`. A plain run fails on a missing or changed snapshot
    and writes nothing. Tests in `snapshots.test.ts` pin both cases and the
    update path. Decision D32.

## 5. Conformance kits

- **Store**
  - Every reader method has a behavioral case: commit → read round-trip, filter
    semantics, ordering, visibility scoping, and spend baseline sums.
  - Journal cases:
    - atomicity: a failing projector leaves neither the event nor the projection
      changed;
    - no update or delete path exists for events;
    - every `UnjournaledMutation` kind in use is declared in
      `store/unjournaled.ts`;
    - projector determinism: the same events give the same rows.
  - The suite runs against `MemoryStore` (unit lane) and `DoltStore`
    (integration lane).
- **Provider adapter**
  - Each adapter has recorded fixtures of
    `{request expectations, response stream}` for:
    - plain text
    - tool calls (native and text-markup)
    - usage/cost extraction
    - stop reasons including length
    - mid-stream error
    - header deadline
    - abort
    - base-URL rejection
    - off-host https base-URL rejection
    - redirect response
  - Every request an adapter sends refuses redirects.
  - The kit asserts the adapter's `ProviderTurnResult` and emitted frames.
  - Request building and stream parsing beyond the required cases are further
    named recorded cases run by the same kit, not unit tests of the builder
    or parser.
  - A new adapter is mergeable only when it passes the kit.
- **Tool**
  - Every `CommandDefinition` must meet all of the following:
    - Its schema is valid, and invalid arguments are rejected before the
      executor runs.
    - Its effect classification is declared.
    - Its policy verdict under `strict` and `operator` matches its effect.
    - Its redaction is applied to the event payload.
    - Exactly one `tool_call` event is written per invocation.
  - The kit is parameterized over the catalog, so a new tool is covered by
    registration alone.

## 6. Gate lane changes

| Lane                                         | Change                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test.unit` (new)                            | Unit + component files. Product tests run under `node --test` (below); no Dolt, no network, no child processes is a rule the tests keep, not a grant. Until the gate-tooling port, its `prototype/scripts/` files on `Deno.test` run first with `deno test --parallel`, whose grants enforce that rule for them. |
| Node subset of `test.unit`, `test.integration`, `test.golden` (new) | Every product test file, and every `prototype/scripts/` test file that registers with `node:test` only (§1), runs under `node --test --import <handle check> --test-concurrency=<the lane's jobs> --test-reporter=tap`, with default process isolation and the lane's environment, plus `DENO_BIN` in `test.unit` and `test.integration`. In `test.unit` and `test.integration` it runs after the gate-tooling `deno test` subset; an empty subset is reported as `0 files`. The runner fails unless `node` is Node 26. The lane prints a count line for its Node files, parsed from the TAP summary; a run with no summary fails. `node --test` and its per-file processes stay in the lane's process group, so the deadline and group stop reach them. Decision D32. |
| `test.integration`                           | Runs through the isolated Dolt fixture. Product files on `node:test` only; the `prototype/scripts/` files on `Deno.test` stay under `deno test` until the gate-tooling port. |
| `test.golden` (new)                          | Golden suite. Its tests register with `node:test` and run under `node --test` only; the runner spawns no `deno test`. `--update` reaches them as `DYFJ_GOLDEN_UPDATE=1`, and a code guard refuses every snapshot write without it (§4). |
| `arch.imports` (new)                         | `01-architecture.md` §4. Runs on Node as `node scripts/arch-imports.ts`: Node's `module.stripTypeScriptTypes` (strip mode, offsets kept) and `acorn`, an exact-pinned root devDependency, with its own specifier resolution in place of `deno info` and `deno lint`. Its tests (`scripts/arch-imports.test.ts`) register with `node:test` and run in the "Architecture import rules tests" lane through `scripts/run-node-test-files.ts`. Decision D32. |
| `runtime.neutral` (new)                      | Exact ratchet on whole-word `Deno` references in tracked `.ts` files against `scripts/runtime-neutral-exceptions.json`; reported under `test.aggregate`. Decision D32.                    |
| `ratchet.base` (new)                         | `node scripts/ratchet-base.ts`: compares `scripts/runtime-neutral-exceptions.json`, `scripts/arch-size-exceptions.json` and `scripts/arch-imports-baseline.json` with the same files at the merge base of HEAD and `DYFJ_GATE_RANGE_BASE` (locally, of HEAD and `origin/main`, reported as the fallback). An entry of the first two that rose or is new fails unless it carries a `growth_reason` added in the same change, which the lane prints; a new arch-imports baseline entry always fails. With no base to compare against it fails closed in CI and reports a skip locally. Reported under `test.aggregate`; in the full gate and `test:fast`, and skipped by a docs-only pull-request run, which cannot change a list. |
| `typecheck.tsc` (new)                        | `tsc --noEmit` from the root npm workspace's `typescript` devDependency (7.0.2, the native compiler, whose binary comes from per-platform optional packages; with `@types/node`) over the root `tsconfig.json`, which covers `src`, `testing`, `examples`, `mcp`, `diagnostics` and `scripts` under `prototype/`, plus the root `schema/`, `contracts/` and `scripts/`, with `strict`, `nodenext`, `verbatimModuleSyntax`, `allowImportingTsExtensions` and `erasableSyntaxOnly`. `erasableSyntaxOnly` rejects a constructor parameter property and every other construct Node's type stripping cannot erase, which replaces the former `erasable.syntax` lint lane; `scripts/typecheck-tsc.test.ts` pins that with a fixture. Files that still use the `Deno` global or `@std/*`, and every file that imports one, are on the tsconfig's `exclude` list, which only shrinks and goes when the last of them ports; they keep their `deno check` coverage meanwhile. Runs in the full gate and `test:fast`, alongside the `deno check` lanes until the gate-tooling port; reported under `test.aggregate`. The Node load probe (`scripts/node-load-probe.ts`) is a manual check of non-test modules under `prototype/src`, `prototype/testing` and `contracts/` only. Decision D32. |
| npm install precondition (new)               | First lane of the full gate and `test:fast`: fails with `` run `npm ci` at the repository root `` when the root `node_modules` is missing or does not match the root `package-lock.json` of the one npm workspace (npm's `node_modules/.package-lock.json` against the lockfile, by package and version, and each recorded package's `package.json` present on disk; absent optional packages allowed; the workspace member's link must be a symlink resolving to exactly the member directory the lockfile names, inside the repository). Read-only: the gate never runs npm. Reported under `test.aggregate`, because it judges the checkout's install, not the committed tree. Decision D32. |
| `schema.codegen`, `schema.equivalence` (new) | `02-data-layer.md`.                                                                                                                                                                   |
| Schema unit tests                            | `schema/validate-schema.test.ts`, `codegen.test.ts` and `equivalence.test.ts` register with `node:test` and run under `node --test` with the per-file handle check and a count line, through the shared Node runner (`scripts/run-node-test-files.ts`), one file at a time. The "Local model catalog data validation" lane (`schema/model-catalog.test.ts`), the contract package tests lane (the three `contracts/workbench/first-product/v1` tests) and the root `deno task test:schema` (all four schema test files) run the same way. The contract closure-report comparison stays a `deno run` with write denied: the generator is written to `node:` builtins and runs on either runtime, and the sandbox keeps its comparison from writing. Decision D32. |
| `projections.replay` (roadmap)               | `02-data-layer.md` §7. Added by roadmap durable-state work.                                                                                                                           |
| typecheck lanes                              | One source of truth for the file list: derived by globbing, not hand-listed. This removes the current drift between `prototype/deno.json check` and `aggregate-test-gate.ts:438-456`. The `deno check` source lane walks `prototype/src`, `mcp`, `scripts`, `testing`, `diagnostics` and `examples`. |
| `test:fast`                                  | Adds `test.unit`, so the fast loop exercises product behavior.                                                                                                                        |
| gate runner                                  | Runs every lane and reports all failures, instead of stopping at the first. The overall exit code is unchanged: any failure fails.                                                    |

`contracts/workbench/first-product/v1` lanes are unchanged (frozen until phase
2), apart from the runner its tests run on (above). The package is frozen in meaning: its semantics, schemas, fixtures and
report content do not change, and ports of its runtime API calls onto `node:`
builtins under decision D32 are permitted. Such a port changes the closure
report's `contract_source_manifest` (its `sha256` and `line_count`) only,
because the report hashes the package's own source, and no contract content
changes.

## 7. Migration rule for existing tests

- **What moves with a module.** When a work order moves or splits a module, the
  tests covering it move in the same PR:
  - registered with `node:test`;
  - using port fakes instead of module mocks;
  - split to match the new modules.
- **Coverage must not drop silently.** A test deleted in the move must be
  replaced, or listed in the PR as redundant with a golden or conformance case.
- **Final sweep.** WO-23 migrates whatever remains and removes Vitest.
