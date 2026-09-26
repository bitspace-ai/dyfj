# Phase-1 work orders

Each work order (WO) is sized for **one PR by one agent**. Hand an agent a
single WO. The WO, together with the specs it cites, is the complete instruction
set.

## Standing rules for every WO

Agents: read these before starting any WO.

1. **Read first.** Read `AGENTS.md`, README Section 1, `specs/README.md`, and
   every spec the WO cites.
2. **Behavior freeze** (`01-architecture.md` §1).
   - The golden suite must pass unchanged.
   - Snapshot diffs are allowed only when caused by an approved deletion that
     the PR names.
   - Bugs you find go into `specs/bug-log.md` as public-safe prose (symptom,
     location, suspected cause). Do not fix them in the WO.
3. **Strangler discipline.**
   - The old path is deleted in the same PR that replaces it.
   - Do not leave both an old and a new implementation, re-export shims, or
     `// TODO move` comments.
   - Update the `arch.imports` baseline only downward.
4. **Tests move with code** (`03-testing.md` §7).
   - Tests covering touched modules are rewritten to `Deno.test` with port
     fakes, and split to match the new module boundaries.
   - Any deleted test is either replaced or listed in the PR as redundant with a
     named golden or conformance case.
5. **Docs in the same PR** (AGENTS.md "Documentation Discipline").
   - Add a CHANGELOG `[Unreleased]` entry when anything observable changes. Pure
     internal moves need none.
   - Update any doc that describes a moved or renamed file.
   - Keep private tracker IDs out of commits, PRs, and files.
6. **Gate before push.**
   - `deno task test` is green locally.
   - The PR description lists the gate result, the `arch.imports` baseline
     delta, and the size report for touched modules.
7. **Stop and ask** if a WO step would require a behavior change, a DDL change,
   a Rust change, or an edit outside the WO's listed scope beyond mechanical
   import updates. Also stop and ask if a WO step would contradict its PRD, a
   spec, the AGENTS.md doctrine, or README Section 1. The higher document wins;
   see `specs/README.md` "Authority and precedence".

## Sequence and dependencies

```
Guardrails (PRD-10):  WO-00 -> WO-01  WO-02  WO-03  WO-04  ->  WO-05  ->  WO-06
Foundations:          WO-07 -> WO-08 -> WO-11
                      WO-07 -> WO-09
                      WO-07 -> WO-10 -> WO-12 -> WO-13
                                        WO-12 -> WO-22
Extensibility:        WO-08,WO-12 -> WO-14 ;  WO-09,WO-12 -> WO-15
Engine:               WO-14,WO-15,WO-22 -> WO-16 -> WO-17      (WO-18 withdrawn)
Surfaces:             WO-11,WO-15,WO-17 -> WO-19 -> WO-20 -> WO-21
Close-out:            all -> WO-23 -> WO-24
Phase 1b (PRD-15):    WO-24 -> WO-25 -> WO-26, WO-27 (parallel) -> WO-28
```

WO-00 goes first, alone. WO-01 through WO-04 can then run in parallel. After
WO-07, the chains led by WO-08, WO-09, and WO-10 can also run in parallel.

---

### WO-00 — Retire the ACP lane to the backlog

- **Decision:** D17. The external-agent (ACP) lane leaves the runtime; git
  history keeps it. **PRD:** 10.
- **Why first:** the golden suite (WO-01) must never pin ACP behavior, and
  retiring the lane removes an import cycle and the duplicated preflight before
  any structural work order touches them.
- **Scope:** delete, don't port:
  - **runtime:** `src/acp-client.ts`, `src/acp-session-map.ts`,
    `src/external-agent-runtime.ts`;
  - **tests:** the ACP tests (`acp-client`, `acp-session-map`,
    `external-agent-runtime`, `acp-runner.integration`) and ACP cases inside
    `cli`, `uds-server`, `workbench`, `turn-runner`, `provider` and
    `test-process-harness` tests;
  - **scripts:** `scripts/acp-fixture-agent.ts`,
    `scripts/codex-chatgpt-login.ts`, the `codex-chatgpt-login` task;
  - **surfaces:** the `--runner` flag and ACP permission prompts in `cli.ts`,
    the ACP verdict translation in `uds-server.ts`, the ACP dispatch branch and
    lazy `await import`s in `workbench.ts`, ACP-only items in
    `turn-contract.ts`;
  - **dependencies:** `@agentclientprotocol/*` import-map entries and lockfile
    entries, plus related dependency-policy and Dependabot entries;
  - **env vars:** `DYFJ_NODE_PATH`, `DYFJ_CODEX_TOOLCHAIN_PATH`,
    `DYFJ_CODEX_RUSTUP_HOME` in permission sets and `compile-cli`, where only
    ACP uses them. Verify each one.
- **Steps:**
  1. **Record the last SHA.** Record the last commit that contains the lane in
     `specs/backlog/acp-lane.md`.
  2. **Classify everything that touches ACP.** Search for every reference and
     classify each one as ACP-only (delete) or shared (keep). The
     history-omission notices in `turn-contract.ts` are the likely shared case.
     Stop and ask if something is ambiguous.
  3. **Delete the ACP-only code and surfaces** listed above.
  4. **Schema:** no DDL change. The `runner_selected`, `agent_permission` and
     `agent_response` enum values stay, because existing databases hold those
     rows. Add a catalog migration that deactivates every model reachable only
     through an ACP route, so selecting one fails closed with the existing
     not-routable error.
  5. **Historical sessions:** `sessions/list`, `sessions/inspect` and
     `events/query` must still read sessions that contain ACP events. If
     continuing such a session natively needs a new behavior decision (skip,
     summarize or refuse the ACP events), stop and ask. Don't pick one.
  6. **Retired surfaces:** add the retired names (`--runner`,
     `codex-chatgpt-login`, `acp-client`, `external-agent-runtime`) to the
     deny-list in `scripts/retired-surface-scan.ts`. `specs/` describes the
     retired lane historically (baseline findings, this work order, the backlog
     note), so extend the scan's allow rules to cover those files explicitly
     rather than weakening the needles.
  7. **Docs:**
     - Remove the README external-agent section and the ACP claims in
       Status/Repo layout, and do the same in `prototype/README.md`.
     - Add a CHANGELOG `Removed` entry that says the lane is retired and names
       the files.
     - Add a README revision-history line.
     - Point `notes/` mentions at the backlog note.
- **Acceptance:**
  - No ACP runtime code or dependency remains: `deno.lock` has no
    `@agentclientprotocol` or `@openai/codex`.
  - The `workbench ↔ external-agent-runtime` cycle is gone.
  - The retired-surface scan passes and is enforcing the new needles.
  - The gate is green.
  - A session recorded with ACP events still lists and inspects.

### WO-01 — Golden characterization suite

- **Spec:** `03-testing.md` §4. **PRD:** 10.
- **Scope:** `prototype/testing/golden/`,
  `prototype/testing/servers/model-server.ts`, a new gate lane `test.golden` in
  `scripts/aggregate-test-gate.ts`, plus a test for that lane.
- **Steps:**
  1. **Verify the paid-path predicate for scenario 6 before writing anything.**
     Read how the runtime decides "paid" for a catalog model, then record in the
     PR whether a loopback model with a pricing row takes the envelope path.
  2. **Build the harness.** Reuse `scripts/isolated-dolt-fixture.ts`, seed a
     loopback model row, and start `src/uds-serve.ts` on a temp socket with the
     test permission set. Drive the server two ways: through the CLI
     (`exec --json`, scripted REPL) and through a raw JSON-RPC client.
  3. **Implement scenarios 1–12**, including the normalizer. Normalize only the
     listed volatile fields.
  4. **Prove determinism.** Run the suite 20 times with identical snapshots.
     Commit the snapshots.
- **Acceptance:**
  - The lane is green in CI on both Linux and macOS.
  - A deliberately altered receipt string fails the lane; show this in the PR.
- **Out of scope:** any `src/` change. If a scenario is unreachable without one,
  log it in the bug log and skip the scenario with a written reason.

### WO-02 — `arch.imports` lane (ratchet) and size report

- **Spec:** `01-architecture.md` §3–4. **PRD:** 10.
- **Scope:** `scripts/arch-imports.ts` plus its test,
  `scripts/arch-imports-baseline.json`, `scripts/arch-cycles.json` (the
  named-cycle allow-list, starting empty), and a gate lane.
- **Steps:**
  1. **Parse imports.** Parse static and dynamic local imports under
     `prototype/src`, `prototype/mcp`, and `prototype/scripts`.
  2. **Encode the rules.** Encode the layer table and allowed edges as data,
     keeping the "today" file→layer mapping in the same data file. Files not yet
     moved are mapped to their target layer by name.
  3. **Detect violations.** Detect cycles (Tarjan's algorithm), upward edges,
     `cli/` allow-list breaches, and dynamic local imports. Subtract anything
     covered by an allow-list entry. Report deep imports without failing.
  4. **Validate the allow-list.** Each entry in `arch-cycles.json` has a name,
     exact edges, a justification, and a test path. The lane fails when an
     entry's edges no longer occur or its test path does not exist.
  5. **Ratchet.** Write the baseline. The lane fails on any violation not in the
     baseline, and on any baseline entry that no longer occurs; the latter
     forces the baseline to shrink.
  6. **Size report.** Emit a non-failing report of modules over 600 LOC and
     functions over 150 lines.
- **Acceptance:**
  - The baseline contains exactly the cycles documented in
    `00-baseline-findings.md` that are still present after WO-00 (expected:
    `mcp-tools ⇄ web-tools` and `sessions ⇄ idea-packet`), plus upward edges.
  - The unit tests cover each rule type, including an allow-listed cycle that
    passes, one whose cited test file is missing (fails), and a stale entry
    (fails).

### WO-03 — `testing/` skeleton and `Deno.test` lane

- **Spec:** `03-testing.md` §2–3, §6. **PRD:** 14.
- **Scope:**
  - `prototype/testing/`: fakes for `ManualClock`, `SequentialIds`, `MapEnv`,
    and `FakeIo`, with their tests.
  - The `test.unit` lane, and a `test:unit` task in `prototype/deno.json`.
  - A glob-derived typecheck list, which replaces both hand-maintained lists.
- **Steps:**
  1. **Add std imports.** Add `@std/assert` and `@std/testing` to the import
     map, with pinned versions.
  2. **Consolidate duplicate helpers.** Replace the three copies each of
     `fakeIo` and `buildClock` in existing tests with imports from `testing/`.
     This is allowed across frameworks during the transition.
  3. **Derive the typecheck file list** in one place. Both the `check` task and
     the gate use it.
- **Acceptance:**
  - `test.unit` runs, with sanitizers on.
  - The two typecheck lists are gone.
  - There are zero duplicate `fakeIo` or `buildClock` definitions.

### WO-04 — Explicit import extensions; drop `--sloppy-imports`

- **PRD:** 10.
- **Scope:** every local import under `prototype/`, plus every `deno.json` task
  and `compile-cli`.
- **Steps:**
  1. **Add extensions.** Add `.ts` to every extensionless local import. Script
     it, and commit the script only if it is reusable.
  2. **Move inline specifiers.** Move the inline `npm:` specifiers in
     `mcp/server.ts`, `mcp-tools.ts`, and `memory-search.ts` into the import
     map.
  3. **Remove the flag.** Remove `--sloppy-imports` everywhere.
- **Acceptance:**
  - `grep -r sloppy-imports` finds nothing.
  - The gate and the golden suite are green.

### WO-05 — Approved deletions

- **Spec:** `01-architecture.md` §8 items 1, 3, and 4. Item 2 is done in WO-13.
  **PRD:** 10.
- **Steps:**
  1. **Delete the standalone CLI.** Delete the standalone argv CLI from
     `workbench.ts`, and the `start`/`workbench` tasks from both `deno.json`
     files.
  2. **Delete dead exports.** First re-verify each one is unused; the check must
     include `scripts/`, `examples/`, `mcp/`, and tests.
  3. **Rename the runtime type.** Rename `WorkbenchHttpRuntime` to
     `TurnRuntime`.
  4. **Record it.** Add a CHANGELOG entry under `Removed`, and update the
     READMEs that mention those tasks.
- **Acceptance:**
  - The golden suite is unchanged.
  - The `arch.imports` baseline has not grown.

### WO-06 — Docs drift correction

- **Spec:** `00-baseline-findings.md` "Docs drift". **PRD:** 10.
- **Scope:** `README.md`, `prototype/README.md`, `prototype/mcp/README.md`,
  `schema/README.md`, `schema/migrations/README.md`,
  `prototype/config.example.toml`, `diagrams/`, and `notes/` (add status banners
  only).
- **Steps:**
  1. **Correct each drift item against the code.** For §6 aspirational features,
     mark each one "not implemented" in place. Keep them; they are intent.
  2. **Fix the diagram.** Regenerate the `.d2` diagram from current reality, or
     delete it if the `.dsl` already covers the view.
  3. **Record it.** Add a README revision-history line.
- **Acceptance:** each drift bullet in `00-baseline-findings.md` is cited in the
  PR as fixed, with its file:line.
- **Constraint:** preserve maintainer-authored prose. The README "Human-written
  preface" is not edited.

### WO-07 — `kernel/`

- **Spec:** `01-architecture.md` §3 (L0). **PRD:** 11.
- **Steps:**
  1. **Create the module.** Create `src/kernel/` with `mod.ts`.
  2. **Consolidate duplicates.** Each group below becomes one implementation.
     Where the current copies differ, pick the one whose behavior the golden
     suite exercises, and list the differences in the PR:
     - UTF-8 byte bounding (×7) and code-point prefix;
     - ANSI stripping (×4);
     - boundary-text sanitizing;
     - ULID and trace IDs;
     - canonical JSON;
     - `bounded-regex`;
     - `lexical-path`;
     - `summarizeError`.
  3. **Unit-test** each helper in `Deno.test`.
- **Acceptance:**
  - No duplicate implementations remain; grep patterns are listed in the PR.
  - The golden suite is unchanged.
- **Stop-and-ask trigger:** if two copies differ in a way that is user-visible
  (for example, bounding limits in receipts), log it and ask.

### WO-08 — `contract/` and the engine back-edges

- **Spec:** §3 (L1), §5.1. **PRD:** 11.
- **Steps:**
  1. **Move the contract types.** Move `turn-contract.ts` and the runtime
     input/event/auth/result types (`workbench.ts:95-573`) into `src/contract/`.
  2. **Relocate `workspaceRootForTransport`** and `resolveRuntimeEnvDefaults`
     into their target layers.
  3. **Remove the upward import.** `turn-runner` must no longer import
     `workbench`.
- **Acceptance:** no module imports `workbench.ts` except the entrypoint wiring,
  and the upward edges are gone from the baseline.

### WO-09 — MCP transport module

- **Spec:** §5.5. **PRD:** 11/12.
- **Steps:**
  1. **Create the module.** Create `src/tools/mcp/transport.ts` with
     `boundedMcpFetch`, the untrusted-result formatter, the bearer header, and
     the SDK client factory. Pin the SDK version in the import map.
  2. **Point the consumers at it.** `mcp-tools`, `web-tools`, and
     `memory-search` consume the new module.
  3. **Move tests.** Move the MCP tests. The loopback MCP server goes into
     `testing/servers/`.
- **Acceptance:** the `mcp-tools ⇄ web-tools` cycle is gone, and a single MCP
  client factory remains.

### WO-10 — `config/` with `Env` port

- **Spec:** §3 (L1). **PRD:** 11.
- **Steps:**
  1. **Split the config module.** Split `config.ts` into `config/` submodules:
     env schema, TOML, secrets config, MCP server config, budget/agent/anomaly
     resolvers.
  2. **Route all env reads through `Env`.** Add the port, then remove:
     - the `process.env` adapters in `workbench`, `budget`, and `provider`;
     - the undeclared `DYFJ_*` reads in `repo-context` (declare those keys);
     - the `.env` parser in `cli.ts`. `cli/` uses a shared parser from
       `config/`.
- **Acceptance:**
  - Every `DYFJ_*` key read anywhere is declared in the schema, enforced by an
    `arch.imports` rule: `Deno.env` and `process.env` are allowed only in
    `config/` and the entrypoints.
  - Env var names are unchanged.

### WO-11 — `transport/`

- **Spec:** §3 (L2), §7. **PRD:** 11.
- **Steps:**
  1. **Move the transport modules.** Move `jsonrpc`, `jsonrpc-peer` (making it
     use the codec helpers instead of building literal frames), `uds-path`, and
     `uds-client` into `transport/`.
  2. **Split out socket code.** Move the socket bind/serve code out of
     `uds-server.ts` into `transport/`.
  3. **Add tests.** Add tests for `uds-client`, which currently has none.
- **Acceptance:** `cli/` reaches the server only through `transport/`.

### WO-12 — Store port, `DoltStore`, `MemoryStore`

- **Spec:** `02-data-layer.md` §2. **PRD:** 13.
- **Steps:**
  1. **Inventory the SQL call sites** (`utils`, `sessions`, `memory`,
     `provider`, `prompts`, `budget`, `mcp/server.ts`, `mcp/memory-tools.ts`).
     Classify each one:
     - reads map to a reader method;
     - event appends map to `journal.commit`;
     - every other write becomes a declared `UnjournaledMutation` kind in
       `store/unjournaled.ts`, with the reason it has no event yet.

     The expected kinds come from `00-baseline-findings.md` defect 10: session
     insert (the second path), session update, and memory upsert. Report any
     others you find.
  2. **Implement the store.** Implement `journal.commit` (atomic: events plus
     projection updates plus declared mutations in one transaction), the
     read-only readers, `DoltStore` with a single pool passed in by the caller,
     and `MemoryStore`.
  3. **Write the conformance suite.** Include:
     - visibility-clearance cases for loopback, non-loopback, and MCP stdio;
     - the journal cases in `03-testing.md` §5.
  4. **Migrate all callers.** The MCP server uses the same journal and readers.
     Delete `mcp/dolt-config.ts`, the MCP pool, and the `utils.ts` pool
     singleton.
  5. **Add import rules.** `mysql2` only in `store/`, and no direct writes
     outside `journal.commit`.
- **Acceptance:**
  - All SQL lives under `store/`, and every mutation goes through
    `journal.commit`.
  - The unjournaled list is committed and matches the inventory.
  - The conformance suite is green against both adapters.
  - The golden suite is unchanged.

### WO-13 — Codegen, typed events, schema equivalence, shim removal

- **Spec:** `02-data-layer.md` §3–5. **PRD:** 13.
- **Steps:**
  1. **Generate row types.** Write `schema/codegen.ts` and commit
     `store/generated/rows.ts`. Add the `schema.codegen` lane.
  2. **Type the event writes.** Add typed builders per event type and migrate
     all `writeEvent` call sites to `journal.commit` with typed `EventInsert`
     values.
  3. **Check schema equivalence.** Add the `schema.equivalence` lane. For both
     lanes, demonstrate in the PR that a deliberately broken branch fails.
  4. **Remove the drift shims.** Delete the five drift shims and the legacy
     models query. Add the boot-time column check.
  5. **Fix the apply-order docs** in `schema/README.md`,
     `schema/migrations/README.md`, and README §5.
- **Acceptance:**
  - No untyped event writes remain.
  - Both lanes are green.
  - The golden suite is unchanged.

### WO-14 — Provider adapters and conformance kit

- **Spec:** `01-architecture.md` §5.2; `03-testing.md` §5. **PRD:** 12.
- **Steps:**
  1. **Split `provider.ts`.** Split it into `providers/` as follows:
     - `registry` (catalog load through `store.models`, routing, local
       defaults);
     - `http` (deadline fetch behind `HttpTransport`);
     - `shared/` (canonical JSON, SSE/NDJSON readers, text tool-call extraction,
       token estimates);
     - `openai-compatible/`, `anthropic/`, `gemini/`.
  2. **Move tool-call extraction verbatim.** Do not refactor it in this WO.
  3. **Build the conformance kit.** Convert existing request/stream tests into
     kit fixtures per adapter.
  4. **Write the recipe.** Write `specs/recipes/add-provider.md`. Validate it by
     adding a test-only synthetic adapter under `testing/` that passes the kit.
- **Acceptance:**
  - `runWorkbenchTurn` is a registry dispatch.
  - All three adapters pass the kit.
  - `provider.test.ts` is gone, replaced by per-adapter kits and unit tests.
  - The golden suite is unchanged.

### WO-15 — Tool unification, catalog builder, redactor, conformance kit

- **Spec:** `01-architecture.md` §5.4; `03-testing.md` §5. **PRD:** 12.
- **Steps:**
  1. **Split the command core.** Split `commands.ts` into `tools/` core:
     definition, registry, policy, validate, invoke, and redaction.
  2. **Move the builtin tools.** Move `file`, `exec`, `git`, and `memory` into
     `tools/builtin/`, each with a colocated `define*`. Move `web` into
     `tools/web/`.
  3. **Delete the legacy shapes.** Remove the `ToolDefinition` shapes in
     `memory.ts`.
  4. **Build one catalog.** Implement `buildToolCatalog` and replace all three
     assembly sites.
  5. **Add the shared redactor** for schema-declared redaction. The ACP-only
     secret-shape scrub was deleted in WO-00. Whether native results need one
     stays an open bug-log decision.
  6. **Build the tool conformance kit** and write `specs/recipes/add-tool.md`.
     Validate the recipe with a test-only tool.
- **Acceptance:**
  - One tool shape.
  - One catalog builder.
  - The kit covers every registered tool.
  - The golden suite is unchanged, including `tools/list` and `tools/inspect`.

### WO-16 — `resolveRoute` and `observedProviderCall`

- **Spec:** §5.1. **PRD:** 11.
- **Steps:**
  1. **Extract `resolveRoute`.** Extract model selection and paid preflight into
     `engine/route.ts`. The ACP duplicate is already gone (WO-00).
  2. **Extract `observedProviderCall`.** Extract it into
     `engine/observed-call.ts`. Both `compressTranscript` and the agent loop use
     it.
  3. **Add component tests** for both, using `MemoryStore`,
     `ScriptedHttpTransport`, and the budget tracker.
- **Acceptance:**
  - Each sequence has exactly one implementation.
  - Golden scenarios 1, 6, 7, and 12 are unchanged.

### WO-17 — Engine pipeline

- **Spec:** §5.1. **PRD:** 11.
- **Steps:**
  1. **Split the runtime into stages.** Split `runNativeWorkbenchRuntime` into
     the stages `openSession`, `buildContext`, `budgetGate`, `loadTranscript`,
     `agentLoop`, and `finalize`, over `TurnState`.
  2. **Fold in the turn runner.** Fold `turn-runner.ts` into `engine/` as the
     turn entry.
  3. **Introduce `SessionOwner`** (`01-architecture.md` §5.7). It is the single
     writer for the session's turn lock, budget scope, and cancel signal. Busy
     and concurrency semantics stay identical: golden scenarios 5 and 9 must not
     change.
  4. **Remove the old runtime.** Delete `workbench.ts`.
  5. **Replace the old tests.** Replace the 5,916-line `workbench.test.ts` with
     per-stage unit tests plus a `engine.component.test.ts` wired with fakes.
     This WO carries the most test-migration weight.
- **Acceptance:**
  - `workbench.ts` no longer exists.
  - No engine function exceeds 150 lines.
  - Zero `vi.mock` in `engine/`.
  - The only callbacks in `engine/` are the `Approver` and `onFrame` ports, and
    a component test proves an approval verdict cannot start a new turn.
  - The golden suite is unchanged.
- **Size note:** if the PR exceeds roughly 3k changed lines, split it one stage
  at a time. Keep the not-yet-extracted remainder in `engine/native-runner.ts`
  so that each step stays gate-green.

### WO-18 — _(withdrawn)_

Withdrawn: the ACP lane was retired to the backlog in WO-00 (decision D17). The
number is kept so references stay stable.

### WO-19 — `server/` composition root and RPC modules

- **Spec:** §7. **PRD:** 11.
- **Steps:**
  1. **Create the composition root.** Create `server/main.ts` (replaces
     `uds-serve.ts`) as the only place that constructs adapters and ports.
  2. **Split the handlers.** Split `buildWorkbenchHandlers` and
     `buildTurnHandlers` into `server/rpc/<namespace>.ts` modules.
  3. **Leave extension methods in place.** `friction`, `ideas`, and `packets`
     stay where they are until WO-20, in `server/rpc/legacy-extensions.ts`,
     which is deleted by WO-20.
  4. **Update the entrypoint.** Update the `serve-unix` task and the launcher to
     the new entrypoint.
- **Acceptance:**
  - `uds-server.ts` and `uds-serve.ts` no longer exist.
  - The golden scenario 10 method set is unchanged.

### WO-20 — Extension interface and moves

- **Spec:** §6. **PRD:** 12.
- **Steps:**
  1. **Define the interface.** Define `Extension` in `server/extensions.ts` and
     `ExtensionDeps`.
  2. **Move the features.** Move `ideas`, `packets` (from `idea-packet.ts`),
     `friction`, and `linear` into `extensions/<id>/`. Each gets:
     - a server side with commands and RPC;
     - a `client.ts` holding the REPL slash-command logic currently in
       `cli.ts:2014-2792`.
  3. **Remove the re-export.** Delete `export * from "./idea-packet"` from
     `sessions`.
  4. **Reuse the Linear command.** Friction receives the Linear command through
     `ExtensionDeps`, not by building its own registry.
  5. **Remove the singleton.** Delete `defaultIdeaPacketRegistry`. The registry
     is owned by the ideas/packets extension instance built in the composition
     root. It stays in memory; PRD-15 makes it durable.
- **Acceptance:**
  - The `sessions ⇄ idea-packet` cycle is gone.
  - Core never imports `extensions/`.
  - Golden scenario 11 and the REPL commands are unchanged.

### WO-21 — `cli/` split

- **Spec:** §3 (L5). **PRD:** 11.
- **Steps:** split `cli.ts` into the following modules:
  - `cli/args.ts` (parse, resolve config, help);
  - `cli/render/` (spinner, ANSI sanitize via kernel, streaming markdown,
    receipt/posture formatting);
  - `cli/turn-client.ts` (socket turn, cancellation, approval prompts);
  - `cli/repl/` (loop plus core slash commands: session, model, fast; extension
    commands come from `extensions/*/client.ts`);
  - `cli/commands/` (models, sessions, status, stop, start);
  - `cli/launcher/` (permission-grant computation, runtime autostart);
  - `cli/main.ts`.
- **Update the build.** Update `compile-cli` and the launcher script.
- **Split the tests.** Split `cli.test.ts` along the same lines, using `FakeIo`.
- **Acceptance:**
  - `cli.ts` no longer exists.
  - The client allow-list rule is green.
  - The golden CLI scenarios are unchanged.
  - A `compile-cli` smoke build succeeds.

### WO-22 — `budget/` and `context/`

- **Spec:** §3 (L2). **PRD:** 11.
- **Steps:**
  1. **Split budget.** Split `budget.ts` into tracker, envelope gates,
     confirmation store, and anomaly gate. Spend baselines come through
     `store.spend`.
  2. **Build `context/`.** Move `repo-context`, `prompts` composition,
     `context-compression`, `length-recovery`, and the conversation projection
     (`sessions.ts:732-1025`) into `context/`.
  3. **Retire `sessions.ts`.** Its persistence half is already in `store/` via
     WO-12.
- **Acceptance:**
  - `sessions.ts` and `budget.ts` no longer exist.
  - Budget component tests cover envelope warn-then-confirm and the anomaly hard
    stop, using `ManualClock` and `MemoryStore`.
  - Golden scenarios 6 and 7 are unchanged.

### WO-23 — Test sweep, Vitest removal, supervisor decision

- **Spec:** `03-testing.md` §2, §7. **PRD:** 14.
- **Steps:**
  1. **Migrate the remaining tests.** Move every remaining Vitest file to
     `Deno.test`.
  2. **Remove Vitest.** Delete `npm:vitest`, `vitest.config.ts`, the Vitest
     lanes, `integration-test-assignment.ts`, and the esbuild resolution.
  3. **Write the evidence note.** Write
     `specs/notes/test-supervision-evidence.md`. For each supervisor function
     (lock, reaper, manifest sweep, wall-clock bound), record whether it is
     retained or removed and why, backed by an induced-leak experiment per leak
     class.
  4. **Apply the decision.** Retain or remove each supervisor function
     accordingly.
- **Acceptance:**
  - Zero Vitest references remain.
  - `test.unit` runs in under 60 s on CI.
  - The evidence note is committed.
  - 20 consecutive gate runs show no timeout-class failures. Report the actual
    count honestly if this cannot be met.

### WO-24 — Gate reporting, fast loop, phase-1 exit audit

- **PRD:** 10–14 exit.
- **Steps:**
  1. **Report every lane.** The aggregate gate runs all lanes and reports every
     failure. The overall exit code is unchanged.
  2. **Speed up the fast loop.** `test:fast` includes `test.unit`.
  3. **Enforce the size limits.** Promote the size report to failing at the
     PRD-11 R2 hard limits.
  4. **Update the README.** Rewrite README §6.2 "Workbench runtime boundary" and
     the Repo layout to describe the new directory architecture. Add a
     revision-history line.
  5. **Audit.** Write the audit into `specs/README.md` "Phase-1 exit": every PRD
     success metric, with its measured value.
- **Acceptance:**
  - The `arch.imports` baseline is empty. Any remaining cycle is a named
    allow-list entry, reported in the audit.
  - No module-level mutable state in `src/`.
  - Every PRD requirement is checked off with evidence, or explicitly deferred
    with a reason.

---

## Phase 1b — log as ground truth (PRD-15)

The phase-1 behavior freeze is relaxed **only** as PRD-15 "Allowed behavior
change" states. All other standing rules apply.

### WO-25 — Event-type design and DDL

- **Spec:** `02-data-layer.md` §7. **PRD:** 15.
- **Steps:**
  1. **Design one event per mutation kind.** For each kind in
     `store/unjournaled.ts`, design the event type (name, payload columns) and
     the projector that reproduces today's row exactly. That includes
     last-writer-wins for the memory upsert by slug.
  2. **Design the ideas/packets events** and their projection, which makes them
     durable.
  3. **Write the migration.** Forward migration plus `current/` baseline update.
     Drop `ON UPDATE CURRENT_TIMESTAMP` where a projector must set `updated_at`
     from the event. Regenerate with `schema.codegen`; the `schema.equivalence`
     lane must pass.
- **Stop and ask:** this WO changes the canonical DDL. Put the event names,
  payloads and the timestamp change in the PR description for maintainer
  approval before any runtime code uses them.
- **Acceptance:** migration applied in both schema lanes; the generated types
  include the new event types; no runtime changes.

### WO-26 — Journal session and memory writes

- **PRD:** 15.
- **Steps:**
  1. **Session writes.** Replace the session unjournaled kinds with their events
     and projectors, in both the runtime and the MCP server.
  2. **Memory writes.** Replace the memory upsert with `memory_written` (or its
     approved name) plus a projector.
  3. **Shrink the list.** Remove each kind from `store/unjournaled.ts` as it is
     replaced.
  4. **Snapshots.** Update golden snapshots for the new event rows only. The PR
     names each new event type, and projected tables must be byte-identical.
- **Acceptance:** those kinds are gone from the list; conformance green on both
  adapters; golden diffs limited to new event rows.

### WO-27 — Durable ideas and packets

- **PRD:** 15.
- **Steps:**
  1. **Events for mark and draft.** The extension's registry becomes a
     projection built from its events, with no in-memory-only state.
  2. **Restart scenario.** Add a golden scenario: mark an idea and draft a
     packet, restart the server, then `ideas/list` and `packets/list` return
     them.
  3. **Docs.** CHANGELOG `Changed`: ideas and packets now persist across
     restarts.
- **Acceptance:** the restart scenario passes; RPC payloads are otherwise
  unchanged.

### WO-28 — Replay lane and ground-truth closure

- **Spec:** `02-data-layer.md` §7. **PRD:** 15.
- **Steps:**
  1. **Add the replay lane.** Add `projections.replay`: after the golden
     scenarios, truncate the projected tables, rebuild them from `events`, and
     require them to be identical.
  2. **Enforce an empty list.** Assert `store/unjournaled.ts` is empty and make
     the conformance suite reject any addition.
  3. **Docs.** Remove the "Runtime status" note under README Section 1's
     ground-truth decision, add a README revision-history line, and write the
     PRD-15 audit into `specs/README.md`.
- **Acceptance:** replay lane green on every golden scenario; unjournaled list
  empty; Section 1 note removed.
