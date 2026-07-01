# DYFJ

A local-first AI workbench and automation framework built for optionality — you choose where each task runs, local or hosted, with cost visible before work runs. Modular, vendor-loose, and explicit about model cost.

This README is the _operating context_ for the project. Decisions up front. How-to-run-it in the middle. Rationale below. If you're acting on this work - as me, or as an agent - read Section 1 in 60 seconds and you'll know the rules. If you want the why, keep reading past Section 4. If you want to run it, jump to Section 5.

## Repo layout

- `core/` - Rust substrate. Contains the first schema tracer bullet: a small event read/write library plus a demo binary that round-trips an event through Dolt. Where stabilized components live.
- `prototype/` - TypeScript on Deno. Real working code (Workbench CLI/shell, local HTTP veneer, the JSON-RPC/UDS transport seam, memory, budget, MCP server, tests, and provider diagnostics). The active prototyping surface. Components either move down into `core/` as they stabilize or stay here as fast-moving prototype code.
- `schema/` - Dolt DDL. Canonical data model. Language-agnostic source of truth.
- `CHANGELOG.md` - dated change tracking in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style.
- `LICENSE` - MIT.

The split between `core/` and `prototype/` is a permanent two-tier structure where the Rust line advances downward as components stabilize. See Layer 0 stance #3 below.

## Status

Early and active. The prototype is functional - Workbench CLI/shell plus a thin engine-free `dyfj` CLI client over the REST and Unix-socket seams, HTTP veneer (loopback by default, with optional authenticated remote interfaces), SSE streaming on the turn path, a duplex JSON-RPC 2.0 seam over a Unix domain socket (the canonical loopback transport, sharing one turn core with the HTTP/SSE path), shared single-turn runtime boundary, a multi-step agent loop (iterating model↔tools with read-only workspace file tools), local-first provider path with hosted providers (Anthropic, OpenAI, and Google Gemini) behind the paid-escalation path, a Dolt-backed model registry, Dolt-backed memory with privacy-class scoping, system prompts persisted in a Dolt prompts table, MCP server, budget tracking, paid-escalation preflight, session receipts with prompt-cache telemetry, event-sequence verification, and identity/authn metadata recorded on every runtime event. The Rust core has its first schema tracer bullet: write one event, read it back, and prove the DDL-backed contract from Rust. Schema is canonical and stable.

Dated change tracking lives in [CHANGELOG.md](CHANGELOG.md).

## How to use this document

Two audiences, one source of truth.

- **An agent picking up work on DYFJ** should be able to read Section 1–Section 4 in about 60 seconds and know the operating rules: what's decided, what "done" looks like, which constraints are settled, and how the work itself happens. Stop reading there unless you need the why.
- **A human reader (including future maintainers)** should read the whole document. Section 6 onward carries the rationale and goal-traceability notes - the _why_ behind Section 1–Section 4.

If something in Section 1–Section 4 contradicts prose later in the doc, Section 1–Section 4 wins. The front matter is authoritative; the rationale exists to explain it, not amend it.

---

## 1. Decisions

### Boundaries

DYFJ starts as:

- A local-first, operator-owned workbench and automation substrate.
- A single-operator system with a clear path to stronger multi-principal boundaries as real use demands them.
- A provider-loose framework for the models and runtimes actually in use, with strong defaults instead of universal abstraction.
- An OSS substrate first; hosted/self-serve generalization is a later product question.

### Layer 0 stances (operative everywhere)

All five apply from Day-1.

1. **Swappable with strong defaults.** Components are modular and replaceable behind stable interop contracts. The system ships with strong local defaults; paid escalation is configurable per principal - no provider holds a privileged position in the architecture. Optionality, not performative vendor-neutrality.
2. **Local-first by default; paid inference is explicit escalation.** Inference, memory, and tools default to local execution. Calling out to a hosted model is a deliberate, logged decision - never the default path.
3. **Rust for the autonomous core; TypeScript for prototyping.** The Rust line is a moving boundary that advances downward as components stabilize - Rust where its compile/build cycle does not interfere with active prototyping.
4. **Data-layer schema is canonical.** Event and memory contracts live in Dolt DDL. TypeScript and Rust types are consumers of that schema, not sources of truth.
5. **Cost visibility as a default, not an add-on.** Token spend, model selection, and budget posture are surfaced before the work runs and tracked while it runs. Cost is a _design_ concern, not a billing concern.

### Goal done-line

> _I am doing most of my daily work from the tool, with cost visibility up front from the beginning, with confidence I'm not ripping through obscene amounts of token burn._

Working-system criterion. Cost visibility is part of the done-line itself, not a deferrable enhancement.

### Inter-agent contracts - Day-1 posture

- **Event schema is the inter-agent contract.** Runtime events carry the audit, trace, identity, and cost fields that agents and tools share. Discovery-specific schema should be shaped by real producers and consumers.
- **Runtime registry is interface-only Day-1.** `register()` and `lookup()` exist as a stubbed interface backed by static config. The first real registration/leasing behavior should be driven by an observed consumer.

### Authority and policy

- **Permissions reason about call shape, not the model's justification.** Model-supplied arguments are ignored during permission checks.
- **Immutable message log is ground truth.** Memory is a derived view; the log is the audit trail.

---

## 2. Goal

A first-class AI workbench and automation substrate with vendor coupling loosened at the core - any single harness, runtime, or model is one option among several rather than the foundation.

## 3. Audience and operating cadence

- **Primary canonical reader** of this document and most artifacts is the project maintainer.
- This document is written as repo-local operating context, with no internal-only language or private references that would not belong in the repository.
- **Working agents** (current and future, including any model in any harness) read Section 1 to operate; they do not need the rationale unless asked to revisit a decision.

---

## 4. Engineering posture

How the work actually happens, separate from what gets built.

- **Tests land with the code, not after it.** Any commit that adds a function adds a test for it. PRs without tests are not "ready except for tests" - they're not yet ready. Integration tests run against real dependencies (a real Dolt instance, real model APIs in CI when relevant), not mocks. Mocks are reserved for things that don't exist yet (failure modes we haven't observed, third-party services we haven't integrated).
- **Model integration tests validate generation, not just service health.** Ollama `/api/version`, `/api/tags`, and `/api/ps` only prove the server process is answering. Workbench integration checks that depend on local inference must exercise a real `/api/generate` or OpenAI-compatible chat completion with a small `num_predict`/token cap so missing runner binaries, broken model loading, and backend packaging failures are caught before the Workbench path is blamed.
- **Evals for model-touching code, from when it's introduced.** Anything that calls a model carries eval coverage from the first commit it lives in: comparing across models, catching regressions when prompts change, making model selection a measured decision rather than a gut call. Eval results are part of the work product, not a side artifact.
- **The bar for "done" includes tests passing.** Not as a CI rubber-stamp, but as a statement of what "I shipped a thing" means. If the test suite does not cover what changed, extend it in the same commit.

---

## 5. Run it

### Prerequisites

- [Deno](https://deno.com) 2.7+
- [Dolt](https://docs.dolthub.com/introduction/installation)
- [MLX-LM](https://github.com/ml-explore/mlx-lm) for the Apple silicon local default, or [Ollama](https://ollama.com) as a supported local fallback
- _(Optional, for `core/`)_ [`rustup`](https://rustup.rs/) - the toolchain pin in `core/rust-toolchain.toml` will install the right Rust automatically when you `cargo build` there.

### Set up the prototype

```sh
git clone https://github.com/bitspace-ai/dyfj
cd dyfj/prototype
deno install
cp .env.example .env
```

The prototype uses Deno tasks defined in `deno.json`. See `deno task` for the list of entry points.

Edit `.env` for your local config. The prototype reads Dolt connection settings from environment variables; for the default local SQL server, export:

```sh
export DOLT_HOST=127.0.0.1
export DOLT_PORT=3306
export DOLT_USER=root
export DOLT_PASSWORD=<your-local-dolt-password>
export DOLT_DATABASE=dolt
```

For the Apple silicon local default, run an OpenAI-compatible MLX-LM Server:

```sh
mlx_lm.server \
  --model mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit \
  --host 127.0.0.1 \
  --port 18080
```

Workbench uses `http://127.0.0.1:18080/v1` for that local MLX endpoint. Ollama remains a supported local fallback; pass `--model laguna-xs.2` or set `DYFJ_WORKBENCH_MODEL=laguna-xs.2` to select the Ollama fallback explicitly.

### Hosted inference (explicit escalation)

Hosted models are never the default path. Selecting one (for example `--model claude-haiku-4-5`) goes through the budget preflight and an interactive consent prompt before any tokens are spent, and the call is receipted with cost and prompt-cache telemetry.

Each hosted provider reads its key from the process environment and fails closed when absent — Anthropic (`ANTHROPIC_API_KEY`), OpenAI (`OPENAI_API_KEY`), and Google Gemini (`GEMINI_API_KEY`). Project the key at process start from your secret manager rather than exporting it ambiently or committing it to `.env`:

```sh
ANTHROPIC_API_KEY="op://<vault>/<item>/credential" \
  op run -- deno task workbench --model claude-haiku-4-5 --prompt "..."
```

Which models exist, what they cost, and which tier they sit in is registry data, not code - see the current catalog in `schema/catalog/001_models.sql`. Catalog pricing and availability rows are operator-curated seed values, not authoritative provider price sheets. Historical catalog changes are preserved under `schema/history/`. Repricing or adding a model is a Dolt commit.

### Initialize Dolt and apply the schema

From the repo root:

```sh
mkdir -p data/dolt
cd data/dolt
dolt init
for dir in ../../schema/current ../../schema/catalog ../../schema/migrations; do
    find "$dir" -maxdepth 1 -name '*.sql' | sort | while read -r f; do
        dolt sql < "$f"
    done
done
dolt sql-server --host 127.0.0.1 --port 3306 &
cd ../..
```

The `data/` directory is gitignored.

### Run the prototype

```sh
deno task workbench
```

For the interactive shell:

```sh
deno task workbench shell
```

For the local HTTP veneer:

```sh
deno task workbench-http
```

The HTTP veneer listens on `http://127.0.0.1:8787/` by default and exposes `POST /api/turn` for JSON turn requests (pass a `sessionId` to resume a conversation), `GET /api/models` for the model registry (active registry rows plus the local defaults), and a session surface: `GET /api/sessions` (grouped by project), `POST /api/sessions`, and `GET /api/sessions/{id}/events` with an optional `asOf` Dolt time-travel parameter.

#### Remote access (optional, authenticated)

Loopback is the default and needs no credentials. To reach the veneer from another machine - say, over a private overlay network such as WireGuard, Tailscale, or NetBird - bind additional interfaces and require a bearer key:

```sh
DYFJ_WORKBENCH_HTTP_HOST=127.0.0.1,<remote-interface-ip> \
DYFJ_WORKBENCH_API_KEY="op://<vault>/<item>/credential" \
  op run -- deno task workbench-http
```

- `DYFJ_WORKBENCH_HTTP_HOST` takes a comma-separated host list; each bound interface that is not loopback requires every request to present `Authorization: Bearer <key>`.
- `DYFJ_WORKBENCH_ALLOWED_HOSTS` optionally allows extra non-loopback hostnames (an overlay-network FQDN, for example) beyond the bind list.
- The server fails closed: non-loopback binds are refused when no API key is configured, unknown hostnames are rejected regardless of credentials, and a wrong bearer is rejected even on loopback.
- Requests arriving with a valid bearer are recorded on the event log with `authn_mechanism = api_key`; keyless loopback requests record the local-policy basis. Identity is audit data, not an afterthought - see `schema/current/001_structure.sql` and the historical authn migration in `schema/history/011_events_authn.sql`.
- The HTML surface prompts for the key on first remote use and keeps it in browser `localStorage`.

Project the key from your secret manager at process start, as with provider keys. Do not put it in `.env`, and do not expose these ports publicly - this is an authenticated private-network posture, not an internet-facing one.

#### JSON-RPC seam over a Unix domain socket

Alongside the HTTP veneer, the workbench speaks a duplex JSON-RPC 2.0 protocol over a Unix domain socket — the canonical `loopback` transport (no TCP port; gated by filesystem permissions; full local clearance). It is the seam the terminal clients use instead of HTTP, and both transports run the same shared turn core, so a turn behaves identically over HTTP/SSE and the socket.

```sh
deno task serve-unix      # serve the JSON-RPC seam on the Unix socket
```

The socket path resolves from `DYFJ_SOCKET`, else `$XDG_RUNTIME_DIR/dyfj/workbench.sock`, else `~/.dyfj/run/workbench.sock` (the parent directory is created mode 0700). The engine-free `dyfj` CLI reaches the read methods over the socket:

```sh
deno task cli models --socket "$DYFJ_SOCKET"
deno task cli sessions --socket "$DYFJ_SOCKET"
```

For a compiled daily-driver binary under Deno 2.9+, run `deno task compile-cli` in `prototype/` and put `dist/` on your `PATH`. The shipped `dist/dyfj` launcher execs the compiled binary on the default socket path and falls back to `deno run` with a runtime-resolved `unix:` grant when `DYFJ_SOCKET` or `XDG_RUNTIME_DIR` shifts the path.

The seam exposes read methods for `runtime/status`, `surface/snapshot`, `models/list`, `sessions/list`, `events/query`, `tools/list`, and `tools/inspect`, plus the streaming `turn` method (intermediate text deltas and runtime events arrive as `stream` notifications; the receipt is the result). `runtime/status` returns both the simple method id list and grouped method catalog metadata for CLI/TUI/GUI surfaces. The `dyfj` CLI drives turns over this seam (and over HTTP/SSE when `--server` is set), renders companion markdown line-by-line with ANSI styling (headers, emphasis, lists, code) while streaming, and handles the mid-turn approval round-trip on stderr; `--json` stays buffered/raw. Remote reach can layer on the same contract through a tailnet transport.

#### Active work coordination

Workbench owns delegated agent coordination from inside the operator surface. The session coordination prototype keeps the underlying primitive small: coordination claims, launch packets, exit receipts, scope paths, heartbeats, stale-base warnings, deterministic path overlap, and registry/git drift checks. The normal command-line entrypoints remain `dyfj` for the CLI/TUI client and, eventually, `dyfj workbench` for the GUI.

The coordination primitive is visibility-first and intended to make concurrent agent work observable before richer orchestration grows around it.

Useful validation tasks:

```sh
deno task test            # runs deno task check first
deno task check           # strict typecheck of the non-test import graph
deno task test:schema
deno task validate-schema
deno task verify-workbench-events
```

Before treating a Workbench model failure as a DYFJ problem, validate that the selected local provider can actually generate, not just report health. For MLX-LM Server:

```sh
curl -sS http://127.0.0.1:18080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit","messages":[{"role":"user","content":"pong"}],"max_tokens":1}'
```

For Ollama:

```sh
curl -sS http://127.0.0.1:11434/api/generate \
  -H 'content-type: application/json' \
  -d '{"model":"gemma4:e2b","prompt":"pong","stream":false,"options":{"num_predict":1}}'
```

This should return generated text. `/api/version`, `/api/tags`, and `/api/ps` are useful diagnostics, but they do not prove the model runner can load.

To inspect the running Dolt SQL server without installing `mysql`, use Dolt as the client:

```sh
dolt --host 127.0.0.1 --port 3306 --no-tls \
  --user root --password "$DOLT_PASSWORD" --use-db dolt \
  sql -q "SELECT event_type, session_id, trace_id FROM events ORDER BY created_at DESC LIMIT 5;"
```

### Build the core

```sh
cd core
cp .env.example .env       # set DATABASE_URL for local dev
cargo build
cargo run
```

Today the binary is the Rust schema tracer bullet: it inserts a `session_start` event through `dyfj_core::events::write()`, reads it back with `events::read_by_id()`, and verifies equality. The ignored integration tests exercise the same path when a live Dolt server is available:

```sh
cargo test -- --ignored
```

For a DB-free Rust compile/test pass using the committed `.sqlx/` cache:

```sh
SQLX_OFFLINE=true cargo test
```

### MCP integration

The prototype exposes its memory substrate over MCP via `prototype/mcp/server.ts`. Point your agent at it. Replace `/path/to/deno` with `which deno` and `/path/to/dyfj` with the absolute path of your clone.

```json
{
  "mcpServers": {
    "dyfj-memory": {
      "command": "/path/to/deno",
      "args": [
        "run",
        "--allow-net=127.0.0.1:3306",
        "--allow-env=HOME,DOLT_HOST,DOLT_PORT,DOLT_USER,DOLT_PASSWORD,DOLT_DATABASE",
        "/path/to/dyfj/prototype/mcp/server.ts"
      ]
    }
  }
}
```

See `prototype/mcp/README.md` for per-client examples.

---

## 6. Architecture - tiered primitives

The architectural surface, sorted by altitude. Section 1 already states the _decisions_; this section carries the _boxes on the diagram_ and their rationale.

### 6.1 Layer 0 - stances

The five Layer 0 stances are stated in Section 1. They are repeated here only when expansion is useful; the canonical statement is in Section 1.

### 6.2 Layer 1 - core subsystems

Things that exist as boxes on a diagram.

- **Immutable message log.** Append-only record of every turn, tool call, and result. Ground truth from which other views derive. The log is the audit trail; memory is the working set.
- **Conversation/Agent Loop.** The orchestrator that drives turn → tool call → result → next turn.
  - Tool call mechanism (typed, validated, observable)
  - Context engineering pipeline: token counting / auto-compaction, incremental diffs (only changes since last turn), layered prompt composition (system + skills/tools + workspace anchors + retrieved context), retrieval tools (grep, LSP, AST, glob)
- **Memory abstraction.** First-class subsystem, not a bolt-on. Distinct from the immutable log. Queryable, evictable, scoped, explicitly reasoned about.
- **Workbench runtime boundary.** Shared single-turn runtime invoked by CLI/shell, the local HTTP/SSE veneer, and the JSON-RPC/UDS seam — every transport runs the identical turn through one shared core (`turn-runner`), not a per-transport copy. Presentation layers pass inputs and render results; the runtime owns model routing, command/tool execution, session/event writes, budget tracking, and receipt facts.
- **Tool Registry & Dynamic Dispatch.** MCP-native. Tools are discoverable, versioned, addressable.
- **Session/State Persistence & Lifecycle.** Full thread storage (messages, tool results, artifacts) with resume, rewind, fork. Sessions outlive harnesses.
- **Inter-Agent Contracts & Capability Discovery.** Bilateral registration: agents advertise capabilities, agents declare needs, the substrate matches them. Per Section 1: the shared runtime event schema carries the audit and trace substrate; concrete discovery schema follows real producers and consumers.

### 6.3 Layer 2 - cross-cutting concerns

Touch every subsystem.

- **Observability.** OpenTelemetry metadata is mandatory on the event/message schema. Every step (context build → LLM call → tool exec → result injection) gets automatic spans plus full transcript. Sampling controls volume.
- **Permissions / Policy Engine.** Identity and authz metadata mandatory on the core event schema. Dedicated policy engine intercepts every tool call before execution. Tiered rules (allow / ask / deny) keyed on tool, pattern, or risk. Sandboxing plus explicit human friction for high-risk actions. Per Section 1: model-supplied arguments are ignored during permission checks.
- **Cost & Budget Awareness.** First-class. Budgets per session, per task, per user. Cost-aware model routing (default local, escalate explicitly). Hard stops and soft warnings. Already promoted to a Layer 0 stance (Section 1); the cross-cutting machinery here is what makes the stance real at runtime.
- **Eval & Regression.** Built-in benchmark harness. Capability tests, regression catches, model-comparison and prompt-comparison runs. Measurement is part of the work product, not a side artifact.
- **Self-reflection / planning / review loops.** Built-in mechanisms for the agent to critique its own output, decompose subtasks, verify results, and recover from errors.

### 6.4 Layer 3 - runtime mechanisms

How things actually execute.

- **Streaming + interruptability + partial result handling.** Output streams. Users (and other agents) can interrupt mid-stream. Partial results are represented explicitly and can be resumed, inspected, or discarded.
- **Checkpointing + transactional state.** Every meaningful state transition is checkpointed. Rollback is real, not aspirational.
- **Time / async / scheduled action.** Cron-ness as a primitive: agents can take action on a schedule, watch for change, return async results, and reason about asymmetric time between themselves and the world.

---

## 7. How the primitives serve the goal

Every Layer 0 stance, every Layer 1 subsystem, and every Layer 2 cross-cutting concern named above exists to make the automation substrate vendor-loose, locally-defaultable, and cost-aware. The five Layer 0 stances carry the most concentrated weight because they have the highest leverage on whether the substrate works.

---

## 8. Topics worth longer treatment

Topics worth separate notes: Rust boundary, local-first defaults, cost visibility, immutable log vs. memory, and schema/data-layer ownership.

---

## 9. Influences

Two systems shaped the _thinking_ behind this stack:

- A pre-existing end-user-owned AI stack first showed what a locally-owned AI stack could feel like in daily use.
- Sun's Jini introduced the concept of bilateral lookup, leasing, and capability/need matching as a substrate primitive. DYFJ borrows the _shape of the question_, not the protocol.

Called out as conceptual influences rather than implementation dependencies.

---

## 10. Near-term commitments

Things agreed to and evolving as work progresses.

- Extend the current static command registry toward the `register()` / `lookup()` runtime shape when real consumers need it.
- Extend Workbench veneer validation beyond the current CLI/shell and local HTTP smoke paths as the surface grows.
- Continue the cost-visibility surface beyond the shipped preflight/receipt path: soft/hard budget UX and later daily-scope budget projection.
- Grow the Rust core only where components have stabilized enough to earn the boundary; the first schema tracer bullet is shipped.

---

## 11. Open items

Reserved space for new questions as they accumulate.

- Whether implementation-specific schema (e.g. tasks-synced-from-an-issue-tracker) should ever live in this canonical schema directory, or always stay in implementation overlays only.

---

## 12. Revision history

Document revisions only. Code and behavior changes are tracked in [CHANGELOG.md](CHANGELOG.md).

- 2026-04-26 - Draft 1 from initial brain dump.
- 2026-04-27 - Draft 2: Non-goals added; Layer 0 stances stabilized at five; "schema in data layer" promoted into Layer 0; cost visibility promoted from cross-cutting concern to Layer 0 stance.
- 2026-04-27 - Draft 3: lineage framing stripped; Influences section added.
- 2026-04-27 - Restructured into an operating-context document; Decisions block (Section 1) authoritative.
- 2026-04-27 - Repo structured: TypeScript prototype in `prototype/`; Rust substrate at `core/`; schema/ at root as canonical, language-agnostic source of truth.
- 2026-04-27 - Section 4 Engineering posture added - tests + evals as stated practice.
- 2026-05-25 - Runtime clarified as Deno; Workbench tracer bullet owns the Deno task entrypoint; legacy router path closed; paid preflight, receipts, and event-sequence verification added.
- 2026-05-25 - Rust core tracer bullet shipped: `dyfj_core::events::{write, read_by_id}` plus demo and ignored live-Dolt integration tests.
- 2026-05-30 - Event authn metadata shipped; repo-native schema validation added with `deno task validate-schema` and `deno task test:schema`.
- 2026-06-04 - Workbench runtime split into a shared single-turn boundary with CLI/shell and local HTTP veneers; C4/D2 runtime diagrams added.
- 2026-06-12 - Remote-access posture documented (authenticated non-loopback interfaces); change tracking split out into CHANGELOG.md, leaving this section to document revisions.
- 2026-06-16 - Freshness pass: tagline reframed to optionality; Status updated for the `dyfj` CLI client, SSE streaming, the multi-step agent loop with read-only file tools, three hosted providers (Anthropic/OpenAI/Gemini), memory privacy-class scoping, and the prompts table; local default corrected to Qwen3-Coder-30B-A3B; hosted-inference section generalized across providers.
- 2026-06-30 - Schema refactored into a readable current baseline (`schema/current/`), mutable catalog seeds (`schema/catalog/`), forward migrations (`schema/migrations/`), and preserved replay history (`schema/history/`).
- 2026-06-21 - Transport seam documented: a duplex JSON-RPC 2.0 protocol over a Unix domain socket as the canonical loopback transport, the shared `turn-runner` core both transports run, and the `serve-unix` launcher + engine-free CLI-over-socket; Status, Repo layout, the Layer 1 runtime boundary, and Run-it updated to match (per the transport-seam decision, 2026-06-21).
