# DYFJ

A sovereign personal AI stack. Modular, vendor-loose, local-first by default, with cost visibility as a design primitive rather than a billing afterthought.

This README is the *operating context* for the project. Decisions up front. How-to-run-it in the middle. Rationale below. If you're acting on this work — as me, or as an agent — read §1 in 60 seconds and you'll know the rules. If you want the why, keep reading past §4. If you want to run it, jump to §5.

## Repo layout

- `core/` — Rust substrate. Today a compiling placeholder; the first meaningful code is the schema-tracer-bullet binary. Where stabilized components live.
- `prototype/` — TypeScript on Bun. Real working code (router, memory, budget, MCP server, tests). The active prototyping surface. Components either move down into `core/` as they stabilize or get retired here.
- `schema/` — Dolt DDL. Canonical data model. Language-agnostic source of truth.
- `LICENSE` — MIT.

The split between `core/` and `prototype/` is not a phase boundary. It's a permanent two-tier structure where the Rust line is a moving boundary that advances downward as components stabilize. See Layer 0 stance #3 below.

## Status

Early and active. The prototype is functional — three-tier model router, Dolt-backed memory, MCP server, basic budget tracking. The Rust core is a compiling placeholder waiting on its tracer-bullet commit. Schema is canonical and stable. Building in public; the commit history reflects real decisions, including wrong ones.

## How to use this document

Two audiences, one source of truth.

- **An agent picking up work on DYFJ** should be able to read §1–§4 in about 60 seconds and know the rules of engagement: what's decided, what's out of scope, what "done" looks like, which stances are non-negotiable, and how the work itself happens. Stop reading there unless you need the why.
- **A human reader (including future-me)** should read the whole document. §6 onward carries the rationale, the goal-traceability matrix, and the publishable opinion seeds — the *why* behind §1–§4.

If something in §1–§4 contradicts prose later in the doc, §1–§4 wins. The front matter is authoritative; the rationale exists to explain it, not amend it.

---

## 1. Decisions

### Non-goals

DYFJ is **not**:

- A hosted SaaS.
- A multi-tenant platform.
- A model-agnostic abstraction over every provider — only the ones actually in use, with strong defaults.
- A productized stack for *other people*. Generalization is a future question, not a Day-1 constraint.

### Layer 0 stances (operative everywhere)

All five are public from Day-1.

1. **Swappable with strong defaults.** Components are modular and replaceable behind stable interop contracts; the system ships with opinionated defaults (Claude for hard reasoning, local for everything else). Optionality, not performative vendor-neutrality.
2. **Local-first by default; paid inference is explicit escalation.** Inference, memory, and tools default to local execution. Calling out to a hosted model is a deliberate, logged decision — never the default path.
3. **Rust for the autonomous core; TypeScript for prototyping.** The Rust line is a moving boundary that advances downward as components stabilize — Rust where its compile/build cycle does not interfere with active prototyping.
4. **Schema lives in the data layer, not in language types.** Data contracts are defined in the durable store (Dolt DDL today). Language bindings are derived consumers, not the source of truth.
5. **Cost visibility as a default, not an add-on.** Token spend, model selection, and budget posture are surfaced before the work runs and tracked while it runs. Cost is a *design* concern, not a billing concern.

### Goal 1 done-line

> *I am doing most of my daily work from the tool, with cost visibility up front from the beginning, with confidence I'm not ripping through obscene amounts of token burn.*

Working-system criterion. Cost visibility is part of the done-line itself, not a deferrable enhancement.

### Inter-agent contracts — Day-1 posture

- **Event schema carries capability/discovery metadata Day-1.** Locked into the Dolt DDL alongside OTel and security fields. Cheap now; expensive to retrofit.
- **Runtime registry is interface-only Day-1.** `register()` and `lookup()` exist as a stubbed interface backed by static config. Real registration/leasing service deferred until there are actual consumers.

### Authority and policy

- **Permissions reason about call shape, not the model's justification.** Model-supplied arguments are ignored during permission checks.
- **Immutable message log is ground truth.** Memory is a derived view; the log is the audit trail.

---

## 2. Goals

Two interdependent, parallel goals.

1. **Sovereign personal AI stack.** A first-class personal AI stack with vendor coupling loosened at the core — any single harness, runtime, or model is one option among several rather than the foundation.
2. **Public credibility through working in public.** The mode is *learning in public* — veteran builder figures out the new layer, anchored by a 50-year computing arc (TRS-80 1977 → l0pht → 20 years senior at Liberty Mutual → now).

**Framing constraint.** Goal 2 is *necessary*, not *load-bearing*. Goal 1 progresses without an audience; it just generates no inbound. Publishing is the natural artifact of how I already work — currently 80/20 build/publish, expected to slide toward more publish as the substrate stabilizes.

## 3. Audience and operating cadence

- **Primary canonical reader** of this document and most artifacts is future-me.
- The doc lives in public alongside the code; written for full-context readers, but with no internal-only language or private references that wouldn't survive a stranger reading over my shoulder.
- **Working agents** (current and future, including any model in any harness) read §1 to operate; they do not need the rationale unless asked to revisit a decision.
- **Build/publish split:** 80% build / 20% publish today. Publishing is extraction from work-in-flight, not standalone content production.

---

## 4. Engineering posture

How the work actually happens, separate from what gets built.

- **Tests land with the code, not after it.** Any commit that adds a function adds a test for it. PRs without tests are not "ready except for tests" — they're not yet ready. Integration tests run against real dependencies (a real Dolt instance, real model APIs in CI when relevant), not mocks. Mocks are reserved for things that don't exist yet (failure modes we haven't observed, third-party services we haven't integrated).
- **Evals for model-touching code, from when it's introduced.** Anything that calls a model carries eval coverage from the first commit it lives in: comparing across models, catching regressions when prompts change, making model selection a measured decision rather than a gut call. Eval results are part of the work product, not a side artifact.
- **The bar for "done" includes tests passing.** Not as a CI rubber-stamp, but as a statement of what "I shipped a thing" means. If the test suite doesn't cover what changed, the suite gets extended in the same commit. This is non-negotiable enough to belong here, in writing, rather than in someone's head.

---

## 5. Run it

### Prerequisites

- [Bun](https://bun.sh)
- [Dolt](https://docs.dolthub.com/introduction/installation)
- [Ollama](https://ollama.com) with at least one model pulled (e.g. `ollama pull gemma3`)
- *(Optional, for `core/`)* [`rustup`](https://rustup.rs/) — the toolchain pin in `core/rust-toolchain.toml` will install the right Rust automatically when you `cargo build` there.

### Set up the prototype

```sh
git clone https://github.com/bitspace-ai/dyfj
cd dyfj/prototype
bun install
cp .env.example .env
cp settings.example.json settings.json
```

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
bun run start
```

### Build the core

```sh
cd core
cp .env.example .env       # set DATABASE_URL for local dev
cargo build
cargo run
```

Today the binary is a connection spike — confirms sqlx talks to Dolt and prints `SELECT 1`'s result. The tracer-bullet library + integration test land in subsequent commits; see `notes/tracer-bullet.md`.

### Walk the router tiers

```sh
cd prototype
bun run examples/router-tour.ts
```

Walks all three router tiers (local, API-light, API-heavy), the consent flow, and verifies events landed in Dolt.

### MCP integration

The prototype exposes its memory substrate over MCP via `prototype/mcp/server.ts`. Point your agent at it. Replace `/path/to/bun` with `which bun` and `/path/to/dyfj` with the absolute path of your clone.

```json
{
  "mcpServers": {
    "dyfj-memory": {
      "command": "/path/to/bun",
      "args": ["run", "/path/to/dyfj/prototype/mcp/server.ts"]
    }
  }
}
```

See `prototype/mcp/README.md` for per-client examples.

---

## 6. Architecture — tiered primitives

The architectural surface, sorted by altitude. §1 already states the *decisions*; this section carries the *boxes on the diagram* and their rationale.

### 5.1 Layer 0 — stances

The five Layer 0 stances are stated in §1. Each has its own publishable angle (see §8). They are repeated here only when expansion is useful; the canonical statement is in §1.

### 5.2 Layer 1 — core subsystems

Things that exist as boxes on a diagram.

- **Immutable message log.** Append-only record of every turn, tool call, and result. Ground truth from which other views derive. The log is the audit trail; memory is the working set.
- **Conversation/Agent Loop.** The orchestrator that drives turn → tool call → result → next turn.
  - Tool call mechanism (typed, validated, observable)
  - Context engineering pipeline: token counting / auto-compaction, incremental diffs (only changes since last turn), layered prompt composition (system + skills/tools + workspace anchors + retrieved context), retrieval tools (grep, LSP, AST, glob)
- **Memory abstraction.** First-class subsystem, not a bolt-on. Distinct from the immutable log. Queryable, evictable, scoped, explicitly reasoned about.
- **Tool Registry & Dynamic Dispatch.** MCP-native. Tools are discoverable, versioned, addressable.
- **Session/State Persistence & Lifecycle.** Full thread storage (messages, tool results, artifacts) with resume, rewind, fork. Sessions outlive harnesses.
- **Inter-Agent Contracts & Capability Discovery.** Bilateral registration: agents advertise capabilities, agents declare needs, the substrate matches them. Per §1: schema carries the metadata Day-1; runtime registry is stubbed Day-1, deferred to real implementation later.

### 5.3 Layer 2 — cross-cutting concerns

Touch every subsystem.

- **Observability.** OpenTelemetry metadata is mandatory on the event/message schema. Every step (context build → LLM call → tool exec → result injection) gets automatic spans plus full transcript. Sampling controls volume.
- **Permissions / Policy Engine.** Identity and authz metadata mandatory on the core event schema. Dedicated policy engine intercepts every tool call before execution. Tiered rules (allow / ask / deny) keyed on tool, pattern, or risk. Sandboxing plus explicit human friction for high-risk actions. Per §1: model-supplied arguments are ignored during permission checks.
- **Cost & Budget Awareness.** First-class. Budgets per session, per task, per user. Cost-aware model routing (default local, escalate explicitly). Hard stops and soft warnings. Already promoted to a Layer 0 stance (§1); the cross-cutting machinery here is what makes the stance real at runtime.
- **Eval & Regression.** Built-in benchmark harness. Capability tests, regression catches, model-comparison and prompt-comparison runs. Shipping measurement publicly is a credibility moat.
- **Self-reflection / planning / review loops.** Built-in mechanisms for the agent to critique its own output, decompose subtasks, verify results, and recover from errors.

### 5.4 Layer 3 — runtime mechanisms

How things actually execute.

- **Streaming + interruptability + partial result handling.** Output streams. Users (and other agents) can interrupt mid-stream. Partial results are first-class.
- **Checkpointing + transactional state.** Every meaningful state transition is checkpointed. Rollback is real, not aspirational. *Almost everyone claims this; almost no one builds it. Building it real is one of the strongest available signals.*
- **Time / async / scheduled action.** Cron-ness as a primitive: agents can take action on a schedule, watch for change, return async results, and reason about asymmetric time between themselves and the world.

---

## 7. Goal-traceability matrix

● = primary serve · ○ = indirect / downstream

| Primitive | Goal 1 (Sovereign) | Goal 2 (Public) |
|---|---|---|
| Swappable w/ strong defaults | ● | ● |
| Local-first default | ● | ● |
| Rust core | ● | ● |
| Schema in data layer | ● | ● |
| Cost visibility as default | ● | ● |
| Immutable message log | ● | ○ |
| Conversation loop | ● | ○ |
| Memory abstraction | ● | ○ |
| Tool registry / MCP | ● | ○ |
| Session persistence | ● | ○ |
| Inter-agent contracts | ○ | ● |
| Observability | ● | ○ |
| Policy engine | ● | ○ |
| Cost & budget machinery | ● | ● |
| Eval & regression | ○ | ● |
| Self-reflection loops | ● | ○ |
| Streaming / interrupt | ● | ○ |
| Checkpointing | ● | ● |
| Time / scheduling | ● | ○ |

The ●● rows — the five Layer 0 stances, cost machinery, inter-agent contracts, and checkpointing — carry the publishable angles.

---

## 8. Publishable opinion seeds

Each is a candidate standalone essay, extracted from work-in-flight rather than written cold.

- *Rust as agent superpower.* Why the strict feedback loop that frustrates humans is adrenaline for agents.
- *Local-first sovereign AI.* Why default-to-cloud is a category error for personal/organizational stacks.
- *Cost visibility as a Layer 0 stance.* Why cost has to be a design concern, not a billing concern — and what the $200/day lesson implies for default routing and orchestrator design.
- *Bilateral capability discovery.* Why agents need lookup-and-leasing-style discovery, not static service registries.
- *Immutable log vs. memory.* Why conflating them is the most common architectural mistake.
- *Schema lives in the data layer.* Why making language types the source of truth keeps biting multi-runtime systems.
- *Eval in public.* What it looks like to ship measurement, not vibes.
- *Swappable with strong defaults, not vendor-neutral.* Why performative neutrality is a worse stance than honest defaults.

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
- Pick one of the Layer 0 stances and draft the standalone essay — first Goal 3 artifact, pressure-tests the primitive at the same time. Strongest candidates: Rust-for-agents (most contestable, most conversation-generating) or cost-visibility-as-Layer-0 (most underappropriated take in the field).
- First meaningful Rust commit: schema-tracer-bullet binary in `core/` that writes one event to Dolt and reads it back through `schema/001_events.sql`.

---

## 11. Open items

Reserved space for new questions as they accumulate.

- Whether implementation-specific schema (e.g. tasks-synced-from-an-issue-tracker) should ever live in this canonical schema directory, or always stay in implementation overlays only.

---

## 12. Revision history

- 2026-04-26 — Draft 1 created from the original `dyfj-arch-primitives` brain dump.
- 2026-04-26 evening — second-pass critique captured as parallel addendum.
- 2026-04-27 — Draft 2: addendum integrated into body. Non-goals section added; Layer 0 optionality restated as "swappable with strong defaults"; immutable history demoted from Layer 0 to Layer 1 and "schema in data layer" promoted into Layer 0; traceability matrix recalibrated; inter-agent-contract question split into schema-Day-1 and registry-Day-1; publishable seeds expanded.
- 2026-04-27 — Draft 3: stripped lineage framing — removed direct references to the prior personal AI stack, its harness, and Jini; added Influences (not lineage) section.
- 2026-04-27 — Open questions closed: audience = future-me-in-public; build/publish 80/20 sliding; event schema carries discovery metadata Day-1; runtime registry stubbed Day-1; Rust scope bounded by prototyping cost (moving boundary); Goal 1 done-line is daily-driver use with cost visibility from the start; all five Layer 0 stances public from Day-1; cost visibility promoted from cross-cutting concern to fifth Layer 0 stance.
- 2026-04-27 — Restructured the draft into an operating-context document. Decisions block (§1) promoted to the front as authoritative. "Spec" reframed as "operating context" — single source of truth for both future-me and any agent working on the project.
- 2026-04-27 — Naming convention established: **DYFJ** (umbrella), **DYFJ Project** (this OSS repo, `bitspace-ai/dyfj`), **DYFJ Workbench** (private overlay, `bitspace/dyfj`).
- 2026-04-27 — Promoted to `README.md` of `bitspace-ai/dyfj` and merged with the prior README's practical `Run it` and `MCP integration` content. Repo restructured: TypeScript prototype moved into `prototype/`; Rust substrate scaffolding added at `core/`; schema/ stays at root as canonical, language-agnostic substrate; AGENTS.md replaced with thin pointer to this file.
- 2026-04-27 — Added §4 "Engineering posture" between Audience and Run it. Tests + evals are now stated practice, not implicit. Existing §4–§11 renumbered to §5–§12; cross-references updated.
- 2026-04-29 — "Customer Zero" / Bitspace-commercial framing scrubbed. Goal 2 ("Bitspace Customer Zero artifact") dropped; goals collapsed from three to two; traceability matrix re-keyed; inter-agent contracts no longer pitched as a Bitspace offering.
