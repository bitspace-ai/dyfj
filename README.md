# DYFJ

A sovereign personal AI stack. Modular, vendor-loose, local-first by default, with cost visibility as a design primitive rather than a billing afterthought.

This README is the *operating context* for the project. Decisions up front. How-to-run-it in the middle. Rationale below. If you're acting on this work - as me, or as an agent - read Section 1 in 60 seconds and you'll know the rules. If you want the why, keep reading past Section 4. If you want to run it, jump to Section 5.

## Repo layout

- `core/` - Rust substrate. Today a compiling placeholder; the first meaningful code is the schema-tracer-bullet binary. Where stabilized components live.
- `prototype/` - TypeScript on Deno. Real working code (memory, budget, MCP server, tests, and the Workbench tracer bullet). The active prototyping surface. Components either move down into `core/` as they stabilize or get retired here.
- `schema/` - Dolt DDL. Canonical data model. Language-agnostic source of truth.
- `LICENSE` - MIT.

The split between `core/` and `prototype/` is not a phase boundary. It's a permanent two-tier structure where the Rust line is a moving boundary that advances downward as components stabilize. See Layer 0 stance #3 below.

## Status

Early and active. The prototype is functional - three-tier model router, Dolt-backed memory, MCP server, basic budget tracking. The Rust core is a compiling placeholder waiting on its tracer-bullet commit. Schema is canonical and stable. Building in public; the commit history reflects real decisions, including wrong ones.

## How to use this document

Two audiences, one source of truth.

- **An agent picking up work on DYFJ** should be able to read Section 1–Section 4 in about 60 seconds and know the rules of engagement: what's decided, what's out of scope, what "done" looks like, which stances are non-negotiable, and how the work itself happens. Stop reading there unless you need the why.
- **A human reader (including future-me)** should read the whole document. Section 6 onward carries the rationale, the goal-traceability matrix, and the publishable opinion seeds - the *why* behind Section 1–Section 4.

If something in Section 1–Section 4 contradicts prose later in the doc, Section 1–Section 4 wins. The front matter is authoritative; the rationale exists to explain it, not amend it.

---

## 1. Decisions

### Non-goals

DYFJ is **not**:

- A hosted SaaS.
- A multi-tenant platform.
- A model-agnostic abstraction over every provider - only the ones actually in use, with strong defaults.
- A productized stack for *other people*. Generalization is a future question, not a Day-1 constraint.

### Layer 0 stances (operative everywhere)

All five are public from Day-1.

1. **Swappable with strong defaults.** Components are modular and replaceable behind stable interop contracts. The system ships with strong local defaults; paid escalation is configurable per principal - no provider holds a privileged position in the architecture. Optionality, not performative vendor-neutrality.
2. **Local-first by default; paid inference is explicit escalation.** Inference, memory, and tools default to local execution. Calling out to a hosted model is a deliberate, logged decision - never the default path.
3. **Rust for the autonomous core; TypeScript for prototyping.** The Rust line is a moving boundary that advances downward as components stabilize - Rust where its compile/build cycle does not interfere with active prototyping.
4. **Schema lives in the data layer, not in language types.** Data contracts are defined in the durable store (Dolt DDL today). Language bindings are derived consumers, not the source of truth.
5. **Cost visibility as a default, not an add-on.** Token spend, model selection, and budget posture are surfaced before the work runs and tracked while it runs. Cost is a *design* concern, not a billing concern.

### Goal done-line

> *I am doing most of my daily work from the tool, with cost visibility up front from the beginning, with confidence I'm not ripping through obscene amounts of token burn.*

Working-system criterion. Cost visibility is part of the done-line itself, not a deferrable enhancement.

### Inter-agent contracts - Day-1 posture

- **Event schema carries capability/discovery metadata Day-1.** Locked into the Dolt DDL alongside OTel and security fields. Cheap now; expensive to retrofit.
- **Runtime registry is interface-only Day-1.** `register()` and `lookup()` exist as a stubbed interface backed by static config. Real registration/leasing service deferred until there are actual consumers.

### Authority and policy

- **Permissions reason about call shape, not the model's justification.** Model-supplied arguments are ignored during permission checks.
- **Immutable message log is ground truth.** Memory is a derived view; the log is the audit trail.

---

## 2. Goal

A first-class personal AI stack with vendor coupling loosened at the core - any single harness, runtime, or model is one option among several rather than the foundation.

## 3. Audience and operating cadence

- **Primary canonical reader** of this document and most artifacts is future-me.
- The doc lives in public alongside the code; written for full-context readers, but with no internal-only language or private references that wouldn't survive a stranger reading over my shoulder.
- **Working agents** (current and future, including any model in any harness) read Section 1 to operate; they do not need the rationale unless asked to revisit a decision.

---

## 4. Engineering posture

How the work actually happens, separate from what gets built.

- **Tests land with the code, not after it.** Any commit that adds a function adds a test for it. PRs without tests are not "ready except for tests" - they're not yet ready. Integration tests run against real dependencies (a real Dolt instance, real model APIs in CI when relevant), not mocks. Mocks are reserved for things that don't exist yet (failure modes we haven't observed, third-party services we haven't integrated).
- **Evals for model-touching code, from when it's introduced.** Anything that calls a model carries eval coverage from the first commit it lives in: comparing across models, catching regressions when prompts change, making model selection a measured decision rather than a gut call. Eval results are part of the work product, not a side artifact.
- **The bar for "done" includes tests passing.** Not as a CI rubber-stamp, but as a statement of what "I shipped a thing" means. If the test suite doesn't cover what changed, the suite gets extended in the same commit. This is non-negotiable enough to belong here, in writing, rather than in someone's head.

---

## 5. Run it

### Prerequisites

- [Deno](https://deno.com) 2.7+
- [Dolt](https://docs.dolthub.com/introduction/installation)
- [Ollama](https://ollama.com) with at least one model pulled (e.g. `ollama pull gemma3`)
- *(Optional, for `core/`)* [`rustup`](https://rustup.rs/) - the toolchain pin in `core/rust-toolchain.toml` will install the right Rust automatically when you `cargo build` there.

### Set up the prototype

```sh
git clone https://github.com/bitspace-ai/dyfj
cd dyfj/prototype
deno install
cp .env.example .env
cp settings.example.json settings.json
```

The prototype uses Deno tasks defined in `deno.json`. See `deno task` for the list of entry points.

Edit `.env` and `settings.json` for your local config.

### Initialize Dolt and apply the schema

From the repo root:

```sh
mkdir -p data/dolt && cd data/dolt
dolt init
dolt sql-server &     # localhost:3306 by default
cd ../..
for f in schema/*.sql; do
    dolt --data-dir data/dolt sql < "$f"
done
```

The `data/` directory is gitignored.

### Run the prototype

```sh
cd prototype
deno task start
```

### Build the core

```sh
cd core
cp .env.example .env       # set DATABASE_URL for local dev
cargo build
cargo run
```

Today the binary is a connection spike - confirms sqlx talks to Dolt and prints `SELECT 1`'s result. The tracer-bullet library + integration test land in subsequent commits; see `notes/tracer-bullet.md`.

### MCP integration

The prototype exposes its memory substrate over MCP via `prototype/mcp/server.ts`. Point your agent at it. Replace `/path/to/deno` with `which deno` and `/path/to/dyfj` with the absolute path of your clone.

```json
{
  "mcpServers": {
    "dyfj-memory": {
      "command": "/path/to/deno",
      "args": ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "/path/to/dyfj/prototype/mcp/server.ts"]
    }
  }
}
```

See `prototype/mcp/README.md` for per-client examples.

---

## 6. Architecture - tiered primitives

The architectural surface, sorted by altitude. Section 1 already states the *decisions*; this section carries the *boxes on the diagram* and their rationale.

### 5.1 Layer 0 - stances

The five Layer 0 stances are stated in Section 1. They are repeated here only when expansion is useful; the canonical statement is in Section 1.

### 5.2 Layer 1 - core subsystems

Things that exist as boxes on a diagram.

- **Immutable message log.** Append-only record of every turn, tool call, and result. Ground truth from which other views derive. The log is the audit trail; memory is the working set.
- **Conversation/Agent Loop.** The orchestrator that drives turn → tool call → result → next turn.
  - Tool call mechanism (typed, validated, observable)
  - Context engineering pipeline: token counting / auto-compaction, incremental diffs (only changes since last turn), layered prompt composition (system + skills/tools + workspace anchors + retrieved context), retrieval tools (grep, LSP, AST, glob)
- **Memory abstraction.** First-class subsystem, not a bolt-on. Distinct from the immutable log. Queryable, evictable, scoped, explicitly reasoned about.
- **Tool Registry & Dynamic Dispatch.** MCP-native. Tools are discoverable, versioned, addressable.
- **Session/State Persistence & Lifecycle.** Full thread storage (messages, tool results, artifacts) with resume, rewind, fork. Sessions outlive harnesses.
- **Inter-Agent Contracts & Capability Discovery.** Bilateral registration: agents advertise capabilities, agents declare needs, the substrate matches them. Per Section 1: schema carries the metadata Day-1; runtime registry is stubbed Day-1, deferred to real implementation later.

### 5.3 Layer 2 - cross-cutting concerns

Touch every subsystem.

- **Observability.** OpenTelemetry metadata is mandatory on the event/message schema. Every step (context build → LLM call → tool exec → result injection) gets automatic spans plus full transcript. Sampling controls volume.
- **Permissions / Policy Engine.** Identity and authz metadata mandatory on the core event schema. Dedicated policy engine intercepts every tool call before execution. Tiered rules (allow / ask / deny) keyed on tool, pattern, or risk. Sandboxing plus explicit human friction for high-risk actions. Per Section 1: model-supplied arguments are ignored during permission checks.
- **Cost & Budget Awareness.** First-class. Budgets per session, per task, per user. Cost-aware model routing (default local, escalate explicitly). Hard stops and soft warnings. Already promoted to a Layer 0 stance (Section 1); the cross-cutting machinery here is what makes the stance real at runtime.
- **Eval & Regression.** Built-in benchmark harness. Capability tests, regression catches, model-comparison and prompt-comparison runs. Shipping measurement publicly is a credibility moat.
- **Self-reflection / planning / review loops.** Built-in mechanisms for the agent to critique its own output, decompose subtasks, verify results, and recover from errors.

### 5.4 Layer 3 - runtime mechanisms

How things actually execute.

- **Streaming + interruptability + partial result handling.** Output streams. Users (and other agents) can interrupt mid-stream. Partial results are first-class.
- **Checkpointing + transactional state.** Every meaningful state transition is checkpointed. Rollback is real, not aspirational. *Almost everyone claims this; almost no one builds it. Building it real is one of the strongest available signals.*
- **Time / async / scheduled action.** Cron-ness as a primitive: agents can take action on a schedule, watch for change, return async results, and reason about asymmetric time between themselves and the world.

---

## 7. How the primitives serve the goal

Every Layer 0 stance, every Layer 1 subsystem, and every Layer 2 cross-cutting concern named above exists to make the personal AI stack vendor-loose, locally-defaultable, and cost-aware. The five Layer 0 stances carry the most concentrated weight - they're public from Day-1 because they have the highest leverage on whether the substrate works.

---

## 8. Topics worth longer treatment

A handful of the stances above carry enough weight to merit dedicated treatment when the time is right: Rust as a substrate for agent code, local-first as a category claim rather than a deployment choice, cost visibility as a Layer 0 stance rather than a billing afterthought, the immutable-log-vs.-memory distinction, and schema-in-the-data-layer as a multi-runtime invariant. Naming them here so the work doesn't re-derive the framing every time one of them surfaces.

---

## 9. Influences (not lineage)

Two systems shaped the *thinking* behind this stack without being inherited from in code or architecture:

- A pre-existing personal AI stack first showed me what an end-user-owned AI stack could feel like in daily use. DYFJ is not a successor to it and shares no implementation lineage.
- Sun's Jini introduced the concept of bilateral lookup, leasing, and capability/need matching as a substrate primitive. DYFJ borrows the *shape of the question*, not the protocol.

Called out so neither shows up downstream as an implied dependency.

---

## 10. Active commitments

Things agreed to but not yet done. Updated as work progresses.

- Lock the Day-1 event-schema fields for capability/discovery into the Dolt DDL alongside OTel and security metadata.
- Stub `register()` / `lookup()` interface in the codebase with static-config backing.
- Define the cost-visibility surface: per-session running tally, pre-flight estimate on escalation to paid inference, hard/soft budget thresholds.
- First meaningful Rust commit: schema-tracer-bullet binary in `core/` that writes one event to Dolt and reads it back through `schema/001_events.sql`.

---

## 11. Open items

Reserved space for new questions as they accumulate.

- Whether implementation-specific schema (e.g. tasks-synced-from-an-issue-tracker) should ever live in this canonical schema directory, or always stay in implementation overlays only.

---

## 12. Revision history

- 2026-04-26 - Draft 1 from initial brain dump.
- 2026-04-27 - Draft 2: Non-goals added; Layer 0 stances stabilized at five; "schema in data layer" promoted into Layer 0; cost visibility promoted from cross-cutting concern to Layer 0 stance.
- 2026-04-27 - Draft 3: lineage framing stripped; Influences section added.
- 2026-04-27 - Restructured into an operating-context document; Decisions block (Section 1) authoritative.
- 2026-04-27 - Repo structured: TypeScript prototype in `prototype/`; Rust substrate at `core/`; schema/ at root as canonical, language-agnostic source of truth.
- 2026-04-27 - Section 4 Engineering posture added - tests + evals as stated practice.
