# 01 — Target architecture (phase 1)

Status: normative for phase-1 work orders. `README.md` Section 1 still wins over
this document. This spec restructures _how_ the prototype is built, not _what_
it does.

## 1. Constraints this spec inherits

- **Behavior freeze.** The following stay identical through phase 1:
  - CLI surface, JSON-RPC methods and payloads, stream frames
  - event rows, config/env keys, receipts

  The only exceptions are the approved deletions in §8.
- **TypeScript only.** `core/` (Rust) is unchanged. A later Rust component
  arrives behind the JSON-RPC process seam, not behind an in-process TypeScript
  interface (§10).
- **Schema stays canonical** (Layer 0 #4). TypeScript row types are _generated_
  from it (see `02-data-layer.md`).
- **AGENTS.md engineering doctrine**, all four rules:
  - module graph acyclic, with named exceptions (§4);
  - runtime ownership a tree, with callbacks only through ports (§5.7);
  - a single writer per piece of state (§5.7);
  - the event log as the write path (`02-data-layer.md`).
- **Seams now, domain later.** Seams are named and shaped so that
  `contracts/workbench/first-product/v1` concepts (Run, Route, Receipt, Grant,
  ContextPacket) have an obvious landing spot in phase 2. Phase 1 introduces
  none of those entities.

## 2. Two-process shape (kept)

```
dyfj (cli/)  --JSON-RPC 2.0 over UDS-->  engine server (server/)
   client only                              composition root + runtime
```

The client never imports runtime modules. This already holds today and becomes a
checked rule.

## 3. Directory layout and layers

`prototype/src/` is reorganized into directories.

- **Layer direction is enforced.** A module may import from a strictly lower
  layer, or from the same layer when listed under _Same-layer edges_.
- **Entry files are advisory.** A directory may expose a `mod.ts` with a header
  comment stating its responsibility and allowed dependencies. Deep imports that
  bypass it are reported, not failed. This keeps prototyping fast; promote the
  rule to failing only if deep imports become a real source of breakage.

| Layer | Directory          | Responsibility                                                                                                                                                                                                         | Replaces (today)                                                                                                                                                               |
| ----- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L0    | `kernel/`          | Pure helpers: UTF-8 byte bounding, code-point prefix, ANSI stripping, boundary-text sanitizing, ULID/trace IDs, canonical JSON, bounded regex, lexical path checks, error summarizing                                  | scattered copies in `utils`, `commands`, `file-tools`, `mcp-tools`, `turn-contract`, `idea-packet`, `uds-server`, `cli`, `streaming-markdown`; `bounded-regex`, `lexical-path` |
| L1    | `contract/`        | Runtime contract types, no I/O: turn request/result, stream-frame union, receipt types, history-omission notices, `DomainError`, runtime input/event/auth types, stop-reason enum                                      | `turn-contract.ts` + runtime types currently in `workbench.ts:95-573`                                                                                                          |
| L1    | `config/`          | Env-key schema (every `DYFJ_*` key declared), TOML load, secrets/MCP/budget/agent config parsing. Reads the environment only through an `Env` port                                                                     | `config.ts`, env adapters in `workbench`/`budget`/`provider`, undeclared reads in `repo-context`, the `.env` parser in `cli`                                                   |
| L2    | `store/`           | Store port + Dolt adapter + generated row types. **The only directory that issues SQL**                                                                                                                                | SQL in `utils`, `sessions`, `memory`, `provider`, `prompts`, `budget`, `mcp/`                                                                                                  |
| L2    | `providers/`       | `ProviderAdapter` interface, adapters (openai-compatible, anthropic, gemini), model registry and routing, HTTP-with-deadline transport, text tool-call extraction, token estimates                                     | `provider.ts`                                                                                                                                                                  |
| L2    | `tools/`           | Command primitive: definition type, registry, call-shape policy, argument validation, redaction, invoke-with-event. Subdirs: `builtin/` (memory, file, exec, git), `mcp/` (transport, client factory, adapter), `web/` | `commands`, `file-tools`, `exec-tools`, `git-tools`, `mcp-tools`, `mcp-conformance`, `mcp-net-grants`, `web-tools`, `memory-search`, tool parts of `memory`                    |
| L2    | `budget/`          | Tracker, envelope gates, anomaly gate. Writes events through the store port                                                                                                                                            | `budget.ts`                                                                                                                                                                    |
| L2    | `context/`         | Workspace/repo context packing, prompt composition, transcript compression, length recovery, conversation projection from events                                                                                       | `repo-context`, `prompts`, `context-compression`, `length-recovery`, projection half of `sessions`                                                                             |
| L2    | `transport/`       | JSON-RPC codec, framing, dispatcher, duplex peer, UDS path/bind/connect                                                                                                                                                | `jsonrpc`, `jsonrpc-peer`, `uds-path`, `uds-client`, socket half of `uds-server`                                                                                               |
| L3    | `engine/`          | Turn pipeline (§5.1), agent loop, route resolution, observed provider call, session turn lock                                                                                                                          | `workbench.ts` runtime, `turn-runner.ts`                                                                                                                                       |
| L4    | `extensions/<id>/` | Optional features behind the Extension interface (§6): `ideas`, `packets`, `friction`, `linear`                                                                                                                        | `idea-packet`, `friction`, `linear-tools`, and their RPC/REPL pieces                                                                                                           |
| L5    | `server/`          | Composition root: builds ports and adapters, the tool catalog, extensions, and RPC handler modules (one per namespace); binds the socket                                                                               | `uds-serve`, `uds-server` handlers                                                                                                                                             |
| L5    | `cli/`             | Client: args, config resolution, launcher/permission grants, REPL, subcommands, rendering (spinner, streaming markdown, receipts)                                                                                      | `cli.ts`, `busy-spinner`, `streaming-markdown`, `runtime-sigint`                                                                                                               |

**Same-layer edges allowed:**

- `context/ → providers/` (types only)
- `budget/ → store/`
- `tools/ → store/`
- `context/ → store/`

**Client restriction.** `cli/` may import only:

- `kernel/`, `contract/`, `config/`
- `transport/` (client side)
- `extensions/*/client.ts`

This is the existing client/server split made explicit.

**Also moved:**

- **Diagnostics** (`model-response-modes`, `context-size-response`,
  `structured-output`, `workbench-events`) move to `prototype/diagnostics/`.
  They are not part of the runtime graph.
- **`prototype/mcp/`** (the stdio memory MCP server) stays a separate entrypoint
  but must use `store/` and `config/`. It gets no private pool or SQL.

## 4. Enforcement

A new gate lane, `arch.imports`, runs a repository-owned script that parses
static and dynamic local imports.

**Fails on:**

- an import cycle (including type-only cycles through barrels) that is not in
  the named-cycle allow-list;
- an upward-layer import or a non-listed same-layer edge;
- a `cli/` import outside its allow-list;
- a dynamic `import()` of a local module that is not in the allow-list. Today
  these exist only to hide cycles;
- `mysql2` imported outside `store/`, and `Deno.env`/`process.env` read outside
  `config/` and the entrypoints.

**Reports, without failing:** deep imports that bypass a `mod.ts`.

**Named-cycle allow-list** (`scripts/arch-cycles.json`). This implements
AGENTS.md rule 1. Each entry must carry:

- a name;
- the exact module edges it permits;
- a justification;
- the path of a test that exercises the cycle.

The lane fails if an entry's edges no longer occur, or if its cited test file
does not exist. Import cycles are not the same thing as protocol round trips: a
server→client approval request is a runtime round trip over ports, not an import
cycle, and it needs no entry here. Those round trips are documented in §5.7.

Rollout:

- **Before the move.** The lane starts in ratchet mode, with a committed
  baseline of current violations that may only shrink.
- **Phase-1 exit.** The baseline is empty.

A companion size report (non-failing) lists modules over 600 LOC and functions
over 150 lines. The phase-1 exit bar is in PRD-11.

## 5. Seams

### 5.1 Engine turn pipeline

`runNativeWorkbenchRuntime` (~2,200 lines) becomes a pipeline of named stages
over an engine-owned `TurnState`.

- **Rules for stages:**
  - A stage takes `(state, ports)` and returns a new state or a typed outcome
    (`continue | halt(reason) | error`).
  - Stages hold no module-level state.
  - Side effects go through ports only.
- **Pipeline order:**
  1. `resolveRoute`: model selection and paid-escalation preflight. The
     duplicate preflight in `workbench.ts:1456-1491`/`1545-1589` exists only for
     the ACP dispatch and goes away with its retirement (WO-00). _Phase-2
     landing spot for RouteSpec._
  2. `openSession`: create or continue a session, integrity checks,
     `session_start`.
  3. `buildContext`: workspace root, repo context, memory injection, system
     prompt. _Phase-2 landing spot for ContextPacket._
  4. `budgetGate`: envelope and anomaly checks before any spend.
  5. `loadTranscript`: project events into a conversation; proactive
     compression.
  6. `agentLoop`: steps up to `max_tool_steps`. Each step is an
     `observedProviderCall` (below), then tool dispatch via `tools/`
     invoke-with-event. _Phase-2 landing spot for Run._
  7. `finalize`: receipt, `session_end`/summary events, error classification.
     _Phase-2 landing spot for receipt reconciliation._
- **`observedProviderCall`** is the single implementation of "call provider →
  write `provider_call`/`model_response` events → `budget.record`". Today that
  sequence is duplicated in `compressTranscript` (`workbench.ts:2354-2431`) and
  `runObservedTurn` (`2620-2710`); after this change both call it.
- **One runner.** The native loop is the only runner. There is no `Runner`
  interface; with a single implementation it would be speculative abstraction.
  The ACP lane is retired to the backlog (`specs/backlog/acp-lane.md`); if it
  re-enters, the interface is introduced then, behind `resolveRoute`.
- **Turn entry.** `turn-runner` logic (request resolution, session lock,
  `executeTurn`) folds into `engine/` as its entry.

### 5.2 Provider adapters

```ts
interface ProviderAdapter {
  api: WorkbenchModel["api"]; // "openai-compatible" | "anthropic" | "gemini"
  validateBaseUrl(model): Result; // local-loopback vs hosted-pinned rules move here
  run(params: ProviderTurnParams, io: ProviderIO): Promise<ProviderTurnResult>;
}
// ProviderIO = { fetch: HttpTransport; clock: Clock; onFrame(frame): void; signal }
```

- **Adapter layout:** each adapter is one directory (`request.ts`, `stream.ts`,
  `usage.ts`, `stop-reason.ts`).
- **Shared code:** text tool-call extraction, canonical JSON and SSE/NDJSON
  readers are shared modules.
- **Dispatch:** `runWorkbenchTurn` becomes a registry lookup by `api`.
- **Adding a provider on an existing API family** costs a catalog/pricing
  migration plus, when needed, a host pin. It needs no code in `engine/`.
- **Adding a new API family** costs:
  - one adapter directory;
  - one registry line;
  - passing the provider conformance kit (`03-testing.md` §5).

### 5.3 Store port (event-first)

This seam is specified in `02-data-layer.md`. In short:

- **One write path.** `journal.commit(batch)` appends events and applies their
  projection updates in one transaction. Nothing else mutates state.
- **Read-only repositories** over the projections and reference data: `events`,
  `sessions`, `memories`, `models`, `prompts`, `spend`.
- **Two adapters:** `DoltStore` and `MemoryStore`, proven equal by one
  conformance suite.
- **One connection pool** per process, owned by the composition root. It is not
  a module-level singleton.

### 5.4 Tool definition

There is exactly one tool shape, `CommandDefinition`. `WorkbenchToolDefinition`
is its projection and the legacy `ToolDefinition` is deleted.

- **One module per tool.** Each tool module exports
  `define<Name>(deps): CommandDefinition`, with its executor colocated. Today
  the builders for file, exec and git tools live in `commands.ts`; they move
  next to their executors.
- **One catalog builder.** A single
  `buildToolCatalog(ports, config, extensions)` replaces the three separate
  registry assemblies (`workbench.ts:2026-2065`, `uds-server.ts:449`,
  `uds-server.ts:796`).
- **Adding a tool** means one module plus one catalog line, and passing the tool
  conformance kit.
- **Redaction** goes through one shared redactor in `tools/`. It covers both
  schema-declared redaction. The secret-shape scrub that existed only for ACP
  history is deleted with that lane (WO-00). Whether native tool results should
  get a secret-shape scrub is a behavior change, so it is **logged for decision,
  not done** in phase 1.

### 5.5 MCP client

One `tools/mcp/transport` module owns `boundedMcpFetch`, the untrusted-result
formatter, bearer-header construction and the SDK client factory, with the SDK
version pinned in the import map. `mcp-tools`, `web/` and memory recall all
consume it. This breaks the `mcp-tools ⇄ web-tools` cycle.

### 5.6 Ports (complete list)

| Port             | Real adapter                   | Test fake                                                    |
| ---------------- | ------------------------------ | ------------------------------------------------------------ |
| `Store`          | Dolt (mysql2)                  | `MemoryStore`                                                |
| `HttpTransport`  | `fetch` with header deadline   | scripted transport (request assertions + recorded responses) |
| `Clock`          | system                         | manual clock                                                 |
| `IdSource`       | ULID                           | sequential                                                   |
| `Env`            | `Deno.env`                     | map                                                          |
| `Approver`       | JSON-RPC server→client request | scripted verdicts                                            |
| `ProcessSpawner` | `Deno.Command`                 | not faked. Tests that spawn processes are integration tier   |
| `SecretResolver` | resolver command               | map                                                          |

The filesystem is **not** a port: tests use real temp directories.

### 5.7 Ownership and state

This section implements AGENTS.md rules 2 and 3.

- **Session owner.** One `SessionOwner` per active session, created and held by
  `engine/`. It is the single writer for that session's:
  - turn lock (replaces the lock in `turn-runner.ts`);
  - budget scope (session-envelope accumulation);
  - cancel signal for the in-flight turn.

  Other code sends it messages (`startTurn`, `cancel`, `release`); nothing else
  mutates these. Behavior is frozen: busy/concurrency semantics stay identical,
  and the golden suite pins them.
- **Upward communication.** Stages return outcomes. Events go through the
  journal. The only callbacks are the declared ports `Approver` and `onFrame`,
  and neither may re-enter the engine. An approval answer resumes the waiting
  stage; it never starts a new turn or reaches another session.
- **Named protocol round trips** (runtime cycles over ports, documented here,
  each with a golden or integration test):
  1. **approval:** engine → `Approver` → JSON-RPC server→client request →
     verdict. Golden scenarios 3–4.
  2. **cancel:** client `turn/cancel` → session owner → in-flight signal. Golden
     scenario 9.
- **No module-level mutable state.** Process-global state has to move under an
  owner constructed in the composition root. Known cases:
  - the Dolt pool (moves to `DoltStore`);
  - `defaultIdeaPacketRegistry` (moves to the ideas/packets extension instance).

## 6. Extension interface

```ts
interface Extension {
  id: string; // "ideas" | "packets" | "friction" | "linear"
  commands?(deps: ExtensionDeps): CommandDefinition[];
  rpc?(deps: ExtensionDeps): RpcMethodModule; // method descriptors + handlers
}
// client side, separate module: extensions/<id>/client.ts exports REPL slash-command handlers
// that talk to the server only over JSON-RPC.
```

- **Static registration.** The server composition root holds a static list of
  extensions, consistent with Section 1: "registry is interface-only Day-1".
  There is no dynamic loading.
- **Behavior freeze.** All four extensions stay enabled by default, so method
  names and REPL commands are unchanged.
- **Boundaries.** Extensions may depend on L0–L3 `mod.ts` APIs. Core may not
  import extensions; only `server/` and `cli/` do.
- **Ownership fix.** `sessions ⇄ idea-packet` is resolved by moving ideas and
  packets into `extensions/`, where they read sessions through `store/`. The
  registry becomes state owned by the extension instance. It stays in-memory in
  phase 1 (behavior freeze); PRD-15 makes it durable through the journal.

## 7. Composition root

`server/main.ts` (was `uds-serve.ts`) is the only place that:

- constructs adapters;
- reads resolved config;
- resolves secrets;
- assembles the tool catalog and extensions;
- wires RPC method modules (`server/rpc/runtime.ts`, `models.ts`, `sessions.ts`,
  `events.ts`, `tools.ts`, `turn.ts`, plus extension modules);
- binds the socket.

No other module reads process-global state.

## 8. Approved deletions (the only surface removals in phase 1)

1. **The standalone argv CLI in `workbench.ts`:** `resolveWorkbenchInvocation`,
   `runWorkbench`, `promptPaidEscalationTty`, `main`. Also the `start` and
   `workbench` Deno tasks in both `deno.json` files, plus the root `workbench`
   task.
2. **The schema-drift fallbacks** (`sessions.ts:457-553`, `provider.ts:584`).
   The runtime then requires an up-to-date schema and fails with a clear error
   naming the missing migration.
3. **Dead exports:**
   - `parseCSVRows`, `parseCsvRow`, `extractText`, `extractThinking`,
     `normaliseStopReason`, `buildModelSelectedEventPayload`, `MessageContent`
     (`utils.ts`);
   - `buildReadMemoryTool`, `buildToolResult`, `getMemoryBySlug`,
     `loadMemoriesByType`, `loadMemoryIndex` (`memory.ts`);
   - `createProjectWorkbenchSession` (`sessions.ts`).

   Each must be re-verified as unused, including by tests and scripts, before
   deletion.
4. **The `WorkbenchHttpRuntime` type name,** renamed to `TurnRuntime` (an
   internal type, not a surface).

`schema/history/` is **kept**.

## 9. Out of scope for phase 1

- New entities or DDL for Room/Task/Run/Grant/Lease/ContextPacket.
- New event types and converting in-place mutations to events. That is PRD-15
  (phase 1b), which runs after the phase-1 exit because it changes the rows that
  get written.
- Any Rust change.
- New transports.
- Normalizing env var, RPC, or event names.
- Fixing bugs found during the work. They are recorded in `specs/bug-log.md`
  (public-safe prose) and fixed in separate, dedicated changes after phase 1 or
  with explicit approval.

## 10. Rust boundary

Stance #3 moves stabilized components into Rust. The boundary for that move is
the **process seam that already exists**: JSON-RPC 2.0 over the Unix socket. It
is not an in-process TypeScript interface backed by FFI or a hidden sidecar.

- **What this means for a component moving to Rust:** it becomes a process that
  speaks the existing (or an equally framed) JSON-RPC protocol. Candidates, in
  likely order:
  1. an event-journal service that owns `journal.commit` and replay;
  2. the engine server itself.
- **What phase 1 must do to keep that open:** keep every cross-component
  contract in `contract/` as plain data (JSON-serializable, with no functions or
  class instances crossing the seam). Keep `store/` behind a port so the
  TypeScript adapter can later become a JSON-RPC client of a Rust journal.
- **`core/events.rs` today** writes events straight to Dolt. That makes it a
  second writer to the log, acceptable only as the schema tracer bullet. It must
  not grow into a runtime writer except as (or through) the single journal.
