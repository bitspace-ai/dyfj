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
  - Spying on an injected object (`@std/testing/mock` `spy`/`stub`) is allowed.
- **Fakes are proven against the real thing.**
  - Each fake that stands in for a real adapter (`MemoryStore`, the scripted
    `HttpTransport`) passes the same conformance suite as the real adapter.
  - A fake without a conformance suite is not allowed.
- **Real dependencies live in the integration tier.** This tier covers real
  Dolt, real child processes and real sockets.
  - Third-party network services are faked at the network boundary, using
    loopback servers from `testing/servers/`. That boundary is the stand-in for
    an external service, not for an internal module.
- **Local-model generation checks** and **evals for model-touching code**:
  carried over from README §4 unchanged.
- **Behavior is pinned by golden tests** (§4) for the whole of phase 1.

## 2. Framework

- **Framework: `Deno.test` with `@std/assert`, `@std/testing` (bdd, mock,
  snapshot, time).**
  - Vitest is retired at phase-1 exit.
  - This removes `npm:vitest` and `esbuild` resolution, and the Vitest-specific
    permission plumbing in `scripts/run-vitest.ts`.
- **Sanitizers stay on (Deno default).**
  - A test that leaks an op, resource or child process fails at the test that
    leaked it.
  - A test may disable a sanitizer only with a comment naming the leak and why
    it is unavoidable.
- **Supervisor (`run-vitest.ts`, `test-process-harness.ts`,
  `test-process-reaper.ts`, ~2.5k LOC)**
  - _Working thesis, not yet verified:_ per-test sanitizers plus process-group
    spawning in the integration tier make most of the supervisor unnecessary.
  - What survives is decided by WO-23 on evidence from the migrated suite.
  - Descendant (grandchild) processes are not covered by Deno's sanitizers.
    Whatever guards against them must remain.
- **Transition period.**
  - The Vitest lane and a new `Deno.test` lane run side by side in the gate.
  - Tests move to `Deno.test` with the module they cover (strangler).
  - The Vitest lane may only shrink.

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
  - `fakes/`: `MemoryStore`, `ScriptedHttpTransport`, `ManualClock`,
    `SequentialIds`, `MapEnv`, `ScriptedApprover`, `MapSecretResolver`, `FakeIo`
    (terminal I/O for `cli/`).
  - `servers/`: loopback OpenAI-compatible model server, MCP HTTP server, UDS
    peer.
  - `builders/`: event, session, model-row and turn-request builders, typed
    against generated rows.
  - `conformance/`: store, provider-adapter and tool suites.
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
    host (`provider.ts:1569`); the seeded port must also be inside the harness's
    net grant.
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
  4. `bash` always asks; approved via the scripted approver.
  5. Continue an existing session (history projection).
  6. A model with a pricing row crossing the session envelope, non-interactive.
     Expect fail-closed.
     - _Working thesis:_ a loopback model with a price row exercises the paid
       path. The WO must verify which predicate decides "paid" before relying on
       it.
  7. Anomaly hard stop at the configured multiple.
  8. _(Retired with the ACP lane, WO-00. The number is kept so references stay
     stable.)_
  9. `turn/cancel` mid-stream.
  10. Read methods: `runtime/status`, `runtime/liveness`, `surface/snapshot`,
      `models/list`, `sessions/list`, `sessions/inspect`, `events/query`,
      `tools/list`, `tools/inspect`.
  11. Extension methods with loopback fakes for third-party services: `ideas/*`,
      `packets/*`, `friction/post`.
  12. Transcript compression triggered by a small context profile.
- **Hosted adapters are outside the golden suite** (Anthropic, OpenAI,
  OpenRouter, Gemini, xAI). Their base URLs are pinned to real HTTPS hosts. They
  are pinned instead by the provider conformance kit (§5), using recorded
  request/response fixtures at the `HttpTransport` port.
- **Snapshot updates.**
  - Snapshots are committed.
  - In phase 1, updating one requires the PR to state the one approved deletion
    that caused the change.
  - Any other snapshot diff is a failed refactor.
  - In phase 1b (PRD-15), a diff that adds a new event type's rows is allowed
    when the PR names that event type. Projected-table contents must stay
    unchanged.

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
  - The kit asserts the adapter's `ProviderTurnResult` and emitted frames.
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
| `test.unit` (new)                            | `deno test --parallel` over unit + component files. No Dolt, no network, no child processes.                                                                                          |
| `test.integration`                           | Runs through the isolated Dolt fixture. Both frameworks during the transition; `Deno.test` only at exit.                                                                              |
| `test.golden` (new)                          | Golden suite.                                                                                                                                                                         |
| `arch.imports` (new)                         | `01-architecture.md` §4.                                                                                                                                                              |
| `schema.codegen`, `schema.equivalence` (new) | `02-data-layer.md`.                                                                                                                                                                   |
| `projections.replay` (new, PRD-15)           | `02-data-layer.md` §7. Added in phase 1b.                                                                                                                                             |
| typecheck lanes                              | One source of truth for the file list: derived by globbing, not hand-listed. This removes the current drift between `prototype/deno.json check` and `aggregate-test-gate.ts:438-456`. |
| `test:fast`                                  | Adds `test.unit`, so the fast loop exercises product behavior.                                                                                                                        |
| gate runner                                  | Runs every lane and reports all failures, instead of stopping at the first. The overall exit code is unchanged: any failure fails.                                                    |

`contracts/workbench/first-product/v1` lanes are unchanged (frozen until phase
2).

## 7. Migration rule for existing tests

- **What moves with a module.** When a work order moves or splits a module, the
  tests covering it move in the same PR:
  - rewritten to `Deno.test`;
  - using port fakes instead of module mocks;
  - split to match the new modules.
- **Coverage must not drop silently.** A test deleted in the move must be
  replaced, or listed in the PR as redundant with a golden or conformance case.
- **Final sweep.** WO-23 migrates whatever remains and removes Vitest.
