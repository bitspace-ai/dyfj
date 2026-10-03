# specs/ — restructuring specifications

This directory holds the specification set that turns the ad-hoc prototype into
a coherent architecture, executed by agents in small, gate-green PRs.

These specs are the engineering **enablers** beneath a product roadmap that is
tracked privately. They say how the codebase must be shaped; the roadmap says
what the product must do. Each work order states the capability it enables, and
the tracker records which roadmap work it unblocks.

README Section 1 (Decisions) still wins over anything here. These specs
restructure _how_ the system is built. They do not change what it does, and they
do not amend Section 1.

## Reading order

| File                           | Purpose                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `00-baseline-findings.md`      | Observed state at the start: defects, drift, what to keep                                         |
| `01-architecture.md`           | Target layers, directories, seams, ports, extension interface, approved deletions                 |
| `02-data-layer.md`             | Store port, DDL-generated types, schema equivalence                                               |
| `03-testing.md`                | Test doctrine, tiers, golden suite, conformance kits, gate lanes                                  |
| `runtime-consumer-contract.md` | Exploratory native-turn consumer contract: observed seam and open headless-host decisions         |
| `prd/PRD-10…14`                | Enabler requirements: problem, goals, requirements, metrics, risks                                |
| `work-orders.md`               | Sequenced, one-PR-each instructions for agents                                                    |
| `bug-log.md`                   | Bugs found during phase 1: logged, not fixed inline                                               |
| `recipes/`                     | Step-by-step extension recipes, each validated by following it (`add-provider.md`, `add-tool.md`) |
| `notes/`                       | Evidence behind a work order's decision (`test-supervision-evidence.md`)                          |

The structure, terminology and precedence rules are in _Structure and
terminology_ below.

An agent executing work should read `AGENTS.md`, README Section 1, this file,
and then the single work order it was handed, plus the specs that work order
cites.

## Structure and terminology

### Authority and precedence

```
README Section 1 (Decisions)          what DYFJ is; Layer 0 stances; non-negotiables
  └─ AGENTS.md Engineering Doctrine    how code must be shaped (four rules)
      └─ Specs  specs/00–03            the target design: what "good" looks like
          └─ PRDs  specs/prd/          scoped workstreams: why, goals, requirements, metrics
              └─ Work orders           one-PR executable instructions (work-orders.md)
                  └─ PR                the change itself, gate-green
```

- **Higher wins.** Each layer narrows the one above it and never overrides it.
  When two layers conflict, the higher one wins.
- **A work order never resolves a conflict itself.** If executing it would
  contradict its PRD, a spec, the doctrine, or Section 1, the agent stops and
  asks (standing rule 7). The fix is to amend the higher document through a
  recorded decision, or to correct the work order. The agent does not quietly
  deviate.
- **Side log:** `bug-log.md` sits outside the chain of authority. It records
  problems found and deferred.
- **Exploratory consumer contracts** sit outside the chain of authority. They
  record tested current seams and open decisions, without amending Section 1,
  the engineering doctrine, numbered specs, PRDs or work orders.

### Artifact types

| Term                                                           | What it is                                                                                          | Where                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Decision** (`D1`…)                                           | A maintainer choice and its consequence                                                             | Decision log below             |
| **Spec** (`00`–`03`)                                           | Normative design for one concern. `00` is observed facts, not decisions                             | `0N-*.md`                      |
| **PRD**                                                        | Requirements for one workstream: problem, goals, non-goals, requirements, success metrics, risks    | `prd/PRD-NN-*.md`              |
| **Requirement** (`R1`…)                                        | A checkable condition a PRD must meet; numbered within its PRD                                      | Inside each PRD                |
| **Work order** (`WO-NN`)                                       | One PR: scope, steps, acceptance, stop-and-ask triggers                                             | `work-orders.md`               |
| **Standing rules**                                             | Rules every work order inherits (behavior freeze, strangler discipline, tests move with code, etc.) | Top of `work-orders.md`        |
| **Golden scenario** (`1`–`12`)                                 | A black-box behavior snapshot that restructuring must not change                                    | `03-testing.md` §4             |
| **Gate lane** (`arch.imports`, `test.unit`, `schema.codegen`…) | One named, machine-enforced check in the CI gate                                                    | `03-testing.md` §6             |
| **Bug-log entry**                                              | A defect found during the work: logged, not fixed inline                                            | `bug-log.md`                   |
| **Exploratory consumer contract**                              | A non-normative inventory of an existing runtime seam and unresolved host decisions                 | `runtime-consumer-contract.md` |

### Scope

| Work                | Where                          | Behavior                      | Theme                                                     |
| ------------------- | ------------------------------ | ----------------------------- | --------------------------------------------------------- |
| **Phase 1**         | PRD-10 … PRD-14, WO-01 … WO-24 | Frozen                        | Enablers: restructure how the codebase is built           |
| **Product roadmap** | Private tracker                | Changes, per roadmap decision | Domain model, durable state, continuity, routes, surfaces |

### Numbering conventions

- **Specs:** `00`–`03`, in reading order.
- **PRDs:** `1x` for phase 1. PRD-15 and PRD-20 were withdrawn (D22); their
  numbers are not reused.
- **Work orders:** one global sequence (`WO-00`…) in execution order, not
  grouped by PRD. For example, WO-12 and WO-13 belong to PRD-13, while WO-14
  belongs to PRD-12. Each PRD header lists its work orders, and the dependency
  graph at the top of `work-orders.md` is the authority on order.
- **Withdrawn items keep their numbers** so references stay stable (WO-00 and
  WO-25 … WO-28).
- **Decisions are append-only.** A revised decision is marked superseded in its
  row and replaced by a new decision; it is never edited or renumbered in place.

### How a change flows

```
Decision → spec amended → PRD scopes it → work order written → agent executes
  → PR (gate + golden suite) → merge → CHANGELOG and/or README revision history
  → anything out of scope → bug-log or the tracker
```

- **`CHANGELOG.md`** records code and behavior changes.
- **The root README's revision history** records revisions to the operating
  context, including this directory.

## Decision log (maintainer interview, 2026-09-25)

| #   | Decision                                                                                                                    | Consequence                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| D1  | **Seams now, domain later.** Phase 1 restructures current behavior; phase 2 adopts the first-product contract model.        | Seams are named for their phase-2 landing spots; no new entities in phase 1       |
| D2  | **Ports and fakes.** Fakes only at declared ports; module mocking banned; fakes proven by conformance suites                | Replaces README §4 testing bullets (`03-testing.md` §1)                           |
| D3  | _(superseded by D25)_ **TypeScript only.** `core/` is unchanged.                                                            | Superseded in part by D15: the Rust boundary is the process seam                  |
| D4  | **Specs live in the public repo** under `specs/`.                                                                           | Everything here must be public-safe; private context stays in the private tracker |
| D5  | **Approved deletions:** standalone workbench CLI, schema-drift shims, dead exports, HTTP naming. `schema/history/` is kept. | `01-architecture.md` §8                                                           |
| D6  | **`Deno.test` + `@std`**; Vitest retired at phase-1 exit                                                                    | Supervisor kept or retired on evidence (WO-23)                                    |
| D7  | **Extension layer.** Ideas, packets, friction and Linear sit behind an Extension interface, enabled by default.             | `01-architecture.md` §6                                                           |
| D8  | **Strangler execution:** characterization first, one seam per PR, old path deleted in the same PR                           | `work-orders.md` standing rules                                                   |
| D9  | **Row types generated from the DDL**, with a gate freshness check                                                           | `02-data-layer.md` §3                                                             |
| D10 | _(superseded by D21)_ **`contracts/…/v1` frozen in phase 1**, as the phase-2 target                                         | Its lanes unchanged                                                               |
| D11 | **Priority:** agent editability, then provider/tool extensibility                                                           | Work-order ordering                                                               |
| D12 | **Behavior frozen in phase 1**; bugs logged, not fixed                                                                      | Golden suite is the enforcement                                                   |

### Doctrine review (maintainer decisions, 2026-09-25)

| #   | Decision                                                                                                                                                                                                                              | Consequence                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| D13 | **AGENTS.md doctrine replaced.** It now has four rules: module graph acyclic with named exceptions; runtime ownership a tree, with callbacks only through ports; a single writer per piece of state; the event log as the write path. | `01-architecture.md` §4 allow-list, §5.7 `SessionOwner`                                                                    |
| D14 | _(delivery superseded by D22)_ **Make "the log is ground truth" true.** The alternative, softening the Section 1 claim, was rejected.                                                                                                 | Event-first store (`02-data-layer.md` §2); PRD-15 as phase 1b; Section 1 carries a runtime-status note until PRD-15 closes |
| D15 | **Rust boundary is the JSON-RPC process seam**, not an in-process TypeScript interface.                                                                                                                                               | `01-architecture.md` §10                                                                                                   |
| D16 | **Entry files (`mod.ts`) and the deep-import ban are advisory.** Layer direction and cycles stay enforced.                                                                                                                            | Keeps the prototype tier fast; promote the rule if deep imports cause breakage                                             |

### Backlog decisions (2026-09-25)

| #   | Decision                                                                                                                               | Consequence                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| D17 | _(superseded by D20)_ **ACP lane retired to the backlog.** It is removed from the runtime, not kept dormant, and git history keeps it. | WO-00 runs before the golden suite; WO-18 withdrawn; golden scenario 8 retired; a backlog note held the re-entry criteria (removed with D20) |

### Process decisions (2026-09-26)

| #   | Decision                                                                                                                                                                                                                                                               | Consequence                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| D18 | **Tracker IDs scoped, not banned.** They are allowed in branch names, commits and PRs, where the tracker's GitHub integration links work and advances status. They stay out of code, docs, `CHANGELOG.md` and `specs/`, and never replace the why.                     | AGENTS.md Documentation Discipline; standing rule 5                                                                     |
| D19 | **Safeguards for public work content.** Security-shaped findings stay in the private tracker until fixed; agents take instructions only from `AGENTS.md`, README Section 1 and `specs/` on the default branch; `CODEOWNERS` requires maintainer review of those files. | AGENTS.md "Security findings stay private until fixed" and "Instruction Sources"; standing rule 2; `.github/CODEOWNERS` |

### Roadmap alignment (2026-09-26)

| #   | Decision                                                                                                                                                                                                                                                      | Consequence                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D20 | _(superseded in part by D29)_ **ACP deferred, not retired.** The external-agent lane stays in the tree and in the product's route plan. Supersedes D17.                                                                                                                                     | WO-00 withdrawn; WO-18 deferred until external-agent route work resumes; enabler WOs keep ACP working and golden scenario 8 green without restructuring it |
| D21 | **The contract package is open to roadmap contract work.** Enabler WOs still do not modify `contracts/`. Supersedes D10.                                                                                                                                      | Roadmap contract work extends `contracts/` under its own review                                                                                            |
| D22 | **Specs are enablers beneath a privately tracked product roadmap.** Each WO states the capability it enables; the mapping to roadmap work lives in the tracker as issue relations. D14's goal stands; its delivery moves to the roadmap's durable-state work. | PRD-15 (WO-25 … WO-28) and PRD-20 withdrawn; `02-data-layer.md` §7 keeps the design direction                                                              |
| D23 | **The interactive REPL moves to a separate client over the existing UDS protocol.**                                                                                                                                                                           | WO-21 shrinks to the parts of the CLI that stay in TypeScript; WO-20 leaves REPL slash-command logic in place                                              |

### Testing decisions (2026-09-26)

| #   | Decision                                                                                                                         | Consequence                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| D24 | **Conformance suites land with their ports.** A shared fake may land before its port; its conformance suite ships with the port. | `03-testing.md` §1; the `Clock`, `IdSource` and `Env` fakes precede their port work |

### Language boundary (2026-09-27)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Consequence                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| D25 | _(superseded in part by D26)_ **Phase 1 changes only the TypeScript tier, and TypeScript is the temporary tier.** `core/` is untouched during phase 1. TypeScript stays only while a component's shape is still moving (Layer 0 stance #3); stable components move to Rust behind the JSON-RPC process seam (D15). No enabler may make that move harder. Supersedes D3, whose "TypeScript only" wording read as a language stance rather than a phase-1 scope. | `01-architecture.md` §1 and §10; §10 lists the Rust candidates |

### Roadmap exceptions (2026-09-27)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                       | Consequence                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| D26 | **The D23 REPL client is the one addition to `core/` during phase 1.** The existing `dyfj-core` source stays untouched in phase 1. `core/dyfj-repl` joins as a new workspace member; its only effect on `dyfj-core` is the workspace settings in `core/Cargo.toml`. It speaks the existing UDS protocol and changes no engine code. D25's "TypeScript is the temporary tier" and "no enabler may make that move harder" stand. | `01-architecture.md` §1; `core/README.md` |

### Provider adapters (2026-09-27)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Consequence                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| D27 | **Provider dispatch keys on the catalog `provider` column; `ProviderIO` carries `env` and a monotonic clock.** Each `ProviderAdapter` declares its API family (`api`) and the catalog `provider` values it serves; the registry looks adapters up by `provider`, as the runtime always has. Keying on the catalog `api` column would reroute any row whose two columns disagree, a behavior change; moving to it needs its own decision. `ProviderIO` adds `env` (hosted adapters read credentials through the `Env` port) and uses a `MonotonicClock` for request timings, separate from the wall-clock `Clock` port in `kernel/`. Supersedes the §5.2 sketch's lookup by `api` and its `ProviderIO` shape. | `01-architecture.md` §5.2; `recipes/add-provider.md` |

### Phase-1 exit (2026-09-30)

| #   | Decision | Consequence |
| --- | -------- | ----------- |
| D28 | **Phase 1 exits with named deferrals, not unfinished work counted as a pass.** The `arch.imports` lane enforces the PRD-11 R2 hard limits (1,000 LOC per runtime module, 200 lines per function) with a committed exceptions list: each entry names its reason and a size it may only shrink from, and an entry no longer needed fails the lane. An excepted module or function is an R2 deferral, not R2 met. Deferred past phase 1: splitting the oversized tool, web, idea/packet, provider-stream, config-parser, external-MCP and memory-MCP code not already covered by D20 (ACP) or D23 (REPL); moving the remaining top-level modules and creating `prototype/diagnostics/`; folding the per-adapter provider tests into the conformance fixtures (PRD-12 R3); conformance suites for the remaining fakes (PRD-14 R2); and moving the remaining inline test support into `prototype/testing/` (PRD-14 duplication metric). Since exit, the oversized-code splits have landed: no D28 entry remains in the exceptions list, and the remaining entries are D20 and D23. The fake list in `03-testing.md` now names only fakes that exist and exempts `SequentialIds` until its port lands; a conformance suite for `FakeIo` (the CLI's `Io` port) stays deferred. | `scripts/arch-size-exceptions.json`; the Phase-1 exit audit below records each deferral with its measured state |

### Daily-driver route (2026-10-02)

| #   | Decision | Consequence |
| --- | -------- | ----------- |
| D29 | **Daily use runs on one route: the native model loop with hosted inference over an OpenAI-compatible provider, with OpenRouter as its default provider.** The route is selected by configuration, not by the runtime's bare default: an unconfigured bare turn still uses the local tier-0 model, so the operator sets `DYFJ_WORKBENCH_MODEL` (or the configured companion default) to a hosted slug, or passes `--model`. The OpenAI-compatible adapter keeps the provider pluggable: a provider that serves the OpenAI chat-completions shape joins as a catalog row, a provider-contract entry, a `secret-pointer` declaration for its key in `CONFIG_SCHEMA`, and the key and its host in the `serve-unix` permission profile, not as a new route. The external-agent (ACP) routes are deferred from the route plan, because an external agent brings its own harness, tools and environment, which Workbench would have to contain rather than run. Local models, the other native adapters and the external-agent lane stay in the tree and keep working; readiness for daily use is measured on the one route. Supersedes D20's "and in the product's route plan"; D20's "stays in the tree" stands. | WO-18 stays deferred; the external-agent modules keep their D20 size exceptions; `prototype/src/providers/openai-compatible/providers.ts` is where a provider joins, `prototype/src/config/schema.ts` declares its key so `[secrets.pointers]` can resolve it, and `prototype/deno.json` grants the key and the host (`specs/recipes/add-provider.md`) |

## Phase-1 exit

Phase 1 exits at `572ecce` (2026-09-30), measured on that tree. Each row gives
the measured value and a verdict: **met**, **not met** or **partly met**.
Anything not met is either deferred under a named decision (D20, D23 or D28)
or recorded as a finding at the end; nothing is rounded up to a pass.

### WO-24 acceptance

| Check | Measured | Verdict |
| ----- | -------- | ------- |
| `arch.imports` baseline is empty | 0 entries in every category of `scripts/arch-imports-baseline.json`, down from 29 at WO-02 | Met |
| Any remaining cycle is a named allow-list entry | `scripts/arch-cycles.json` is `[]`; the lane finds no cycle and no dynamic local import | Met (none needed) |
| No module-level mutable state in `src/` | No runtime (non-test) module holds any. The last two, the file tools' root anchors and the regex worker's memoized URL, moved under an owner and became a constant. The one top-level `let` a scan finds is inside the regex worker's source string | Met |
| Every PRD requirement checked or deferred | The tables below | Met |

### PRD-10 Guardrails

| Item | Measured | Verdict |
| ---- | -------- | ------- |
| R1. Golden scenarios 1–12 exist and pass | 12 snapshots; all pass; snapshots unchanged since WO-01 | Met |
| R2. `arch.imports` lane with a baseline that fails on new violations | In the gate; ratchet baseline; stale entries also fail | Met |
| R3. `test.unit` runs `Deno.test` files | 1,259 tests | Met |
| R4. No `--sloppy-imports`; explicit `.ts` extensions | None in any task; no extensionless local import | Met |
| R5. Standalone CLI and `start` / `workbench` tasks gone, and said so | Code and tasks gone; CHANGELOG `Removed`; README Status and `prototype/README.md` state it | Met |
| R6. Docs drift corrected | Every listed item corrected; one stale leftover found at exit (see Findings) | Met |
| Metric: golden suite deterministic over 20 runs | 20 of 20 local runs at `572ecce`, identical to the committed snapshots | Met |
| Metric: baseline count recorded | 29 at WO-02, 0 at exit | Met |
| Metric: gate wall-clock grows by no more than about 2 min on Linux | "Run the full deterministic gate" step, median of 5 push runs on `main`: 163 s before WO-01, 199 s at the end of WO-23 (+36 s; slowest +86 s) | Met |

### PRD-11 Runtime decomposition

| Item | Measured | Verdict |
| ---- | -------- | ------- |
| R1. `arch.imports` baseline reaches 0; only named cycles | 0; no named cycles needed | Met |
| R1b. No module-level mutable state in `src/` | None in runtime modules | Met |
| R2. No runtime module over 1,000 LOC, no function over 200 lines | 6 modules and 16 functions over, each in `scripts/arch-size-exceptions.json` (22 entries): 5 ACP (D20), 5 REPL (D23), 12 deferred under D28. The lane fails on anything new, on growth, and on a stale entry. Since exit, the D28 splits have cleared their 12 entries; 10 remain, all D20 or D23 | Not met; deferred (D20, D23, D28). Since exit, met outside D20 and D23 |
| R3. `mod.ts` headers state responsibility and allowed dependencies | All 13 do | Met |
| R4. Golden suite unchanged | Unchanged | Met |
| R5. Tests migrate with moved modules | No Vitest or module mocks remain; moved modules' tests moved with them | Met |
| Goal 1. Directory layout of `01-architecture.md` §3 | Layers in place and enforced; 14 top-level modules still mapped by name in `scripts/arch-layers.json` (ACP runner deferred with WO-18, the REPL under D23, the rest under D28); `prototype/diagnostics/` not created | Partly met; deferred (D20, D23, D28) |
| Metric: median lines read to change one engine stage, < 800 | Stage file plus its direct local imports, over the seven stage modules: median 1,548 (1,255 counting value imports only). The stage files alone: median 347 | Not met by this method |
| Metric: zero unjustified cycles and upward imports | 0 of each, enforced | Met |
| Metric: largest runtime file ≤ 1,000 LOC (from 4,149) | 2,302 (`acp-client.ts`, D20); largest outside D20/D23: 1,929 (`tools/builtin/file.ts`, D28). Since exit, largest outside D20/D23: 891 (`store/generated/rows.ts`) | Not met; deferred. Since exit, met outside D20 and D23 |

### PRD-12 Extensibility

| Item | Measured | Verdict |
| ---- | -------- | ------- |
| R1. Test-only adapter from `add-provider.md` passes the kit, touching one directory, one registry line and fixtures | `testing/providers/synthetic/` passes the provider conformance kit | Met |
| R2. Test-only tool from `add-tool.md`: one module and one catalog line | `testing/tools/text-stats/`; the tool conformance kit covers it | Met |
| R3. Existing adapters pass the kit with recorded fixtures; older request and stream tests folded in | All three pass the kit; the separate per-adapter request, stream and usage tests remain beside it | Partly met; deferred (D28) |
| R4. Nothing outside `extensions/`, `server/` and `cli/` imports an extension | Enforced by `importOnlyFrom`; no violation | Met |
| R5. Surfaces unchanged | Golden suite unchanged | Met |
| Metric: add an API-family adapter = one directory + one line | As R1 | Met |
| Metric: add a tool = 1 file + 1 line | As R2 | Met |
| Metric: registry assembly sites 3 → 1 | One builder, `buildToolCatalog`, which three callers use | Met |

### PRD-13 Typed data layer

| Item | Measured | Verdict |
| ---- | -------- | ------- |
| R1. All SQL under `src/store/`; `mysql2` only in `store/` | `mysql2` imported only by `store/dolt-pool.ts` (plus the named test-fixture tooling); SQL write literals only in the journal; both enforced | Met |
| R2. No untyped event writes; every write through `journal.commit`; the rest listed | Events are generated `EventInsert` values; 3 unjournaled kinds (`session_insert`, `session_update`, `memory_upsert`) | Met |
| R3. Both schema lanes green, each shown failing on a broken branch | Both in the gate and green; the demonstrations are in the WO-13 PR | Met |
| R4. Golden suite unchanged | Unchanged | Met |
| R5. One apply-order rule in the schema docs and README §5 | Stated in all three | Met |
| Metric: modules issuing SQL 9 → 1 | 1 (`store/`) | Met |
| Metric: one pool per process, owned by the composition root | One `createDoltPool` implementation; one pool per entrypoint | Met |
| Metric: one mutation path | `journal.commit`; baseline of 3 unjournaled kinds recorded | Met |
| Metric: an unregenerated DDL change fails the gate | `schema.codegen` | Met |

### PRD-14 Test suite

| Item | Measured | Verdict |
| ---- | -------- | ------- |
| R1. Unit and component tiers hermetic; no Vitest or module mocks | 0 Vitest or `vi.*` references; the unit lane runs with op and resource sanitizers and no run, net or env grant | Met |
| R2. Every fake has a conformance suite against both implementations | Clock, Env, DNS resolver, HTTP transport and Store fakes do; `SequentialIds` (no port) and `FakeIo` do not, two fakes the spec lists (`ScriptedApprover`, `MapSecretResolver`) do not exist, and a third (`MemoryStore`) is listed under `testing/fakes/` but lives in `src/store/`. Since exit, `03-testing.md` lists only fakes that exist and exempts `SequentialIds` until its port lands; `FakeIo` still has no suite | Partly met; deferred (D28). Since exit, met except `FakeIo` (deferred, D28) |
| R3. Tier decided by file name | The assignment list is gone; `prototype/scripts/test-files.ts` decides by name | Met |
| R4. One glob-derived typecheck file list | `test-files.ts` feeds the typecheck, the unit runner and both gate typecheck lanes | Met; one gap in its roots (see Findings) |
| R5. Supervisor fate decided on evidence | `specs/notes/test-supervision-evidence.md`; per-lane deadlines, runner backstop, own-group stop and saved-group recovery kept; lock, detached reaper and manifest sweep removed | Met |
| R6. `test.unit` under 60 s on the Linux runner | Median 16.4 s over 20 CI runs at the end of WO-23; 11 s locally at exit | Met |
| Metric: zero timeout-class failures across 20 consecutive gate runs | 20 consecutive dispatched gate runs on `main` at the exit commit (runs 504–523): 20 passed on the first attempt, 0 timeout-class failures | Met |
| Metric: unit tier under 60 s | As R6 | Met |
| Metric: no copies of test support outside `testing/` | No `fakeIo` or `buildClock` copies; 17 inline fake-fetch definitions and 12 inline loopback servers remain | Not met; deferred (D28) |

### Findings at exit

Each is recorded in `specs/bug-log.md`.

- `prototype/examples/` is outside the typecheck file list, so an example
  can drift from an API unnoticed; review caught one such break during WO-24.
- `prototype/VERIFICATION-2026-09-22.md` still describes the retired
  `vitest.config.ts`.
- `specs/03-testing.md` says the size report flags test files over 800 LOC;
  the report excludes test files.
- The isolated-Dolt lane's ACP test "signals a stubborn descendant that
  remains in the ACP process group" fails in one build container on
  unchanged code and passes on CI; its process-group assumptions depend on
  the host.
