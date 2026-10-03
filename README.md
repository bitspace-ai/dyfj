# DYFJ

An operator-owned AI workbench and automation framework built for optionality —
you choose your intelligence, local or hosted, with cost visible while work
runs. Modular, vendor-loose, and explicit about model cost.

## Human-written preface

This is my free-form workspace for learning about this new world we work in. I
love the possibilities, and I've done and experienced a lot of "WOW" magical
moments starting with Claude Code over a year ago, then Gemini CLI, and Codex
CLI, and then the GUI oriented versions of these.

I've always pushed against proprietary lock-in, and always tried to optimize for
optionality; Claude, Codex/ChatGPT are effectively hard proprietary lock-in on
the largest technological advance since something like the wheel or fire.

Before I started this project I experimented with some open source harnesses.
That's when I accidentally blew through $600 in an afternoon of API tokens using
pi (operator error, _not_ anything wrong with pi; I was holding it wrong) and
became super gun-shy and started building with extreme cost awareness
front-and-center.

**Virtually none of this project** has been coded by hand. This is all coming
out of my interactions with the various harnesses, to a point of dogfooding. I
am doing this in my personal time - evenings, weekends, vacations.

It's not vibe-coded; I'm applying over 30 years of field experience to the same
field at a higher level of abstraction.

The other half of this project is a private corpus of data, scripts, utilities,
and media; the context in which this system operates.

## Almost Everything Else is AI Generated

This README is the _operating context_ for the project. Decisions up front.
How-to-run-it in the middle. Rationale below. If you're acting on this work - as
me, or as an agent - read Section 1 in 60 seconds and you'll know the rules. If
you want the why, keep reading past Section 4. If you want to run it, jump to
Section 5.

## Repo layout

- `core/` - Rust substrate, a Cargo workspace. Contains the first schema tracer
  bullet: a small event read/write library plus a demo binary that round-trips
  an event through Dolt. Also holds `dyfj-repl`, an interactive REPL front-end
  that owns the terminal and is a second client of the prototype's UDS protocol;
  the agent loop stays in `prototype/`. Where stabilized components live.
- `prototype/` - TypeScript on Deno. Real working code and the active
  prototyping surface. Components either move down into `core/` as they
  stabilize or stay here as fast-moving prototype code. `prototype/src/` is
  organized by layer (`specs/01-architecture.md` §3); a module imports only
  from lower layers or listed same-layer edges, which the `arch.imports` gate
  lane enforces:
  - L0 `kernel/`: pure shared helpers, one implementation each.
  - L1 `contract/`: the runtime contract (turn, frame, receipt and error
    types). L1 `config/`: the declared configuration surface and the `Env`
    port, the only runtime reader of the environment.
  - L2 `store/`: the store port, the only code that issues SQL, with one
    mutation path (`journal.commit`). L2 `providers/`: model adapters behind
    one `ProviderAdapter` interface. L2 `tools/`: the one tool shape and
    catalog. L2 `budget/`: spend tracking and gates. L2 `context/`: what the
    model sees on a turn. L2 `transport/`: the JSON-RPC/UDS seam.
  - L3 `engine/`: the turn pipeline.
  - L4 `extensions/`: ideas, packets, friction and Linear behind the Extension
    interface.
  - L5 `server/`: the engine's composition root and one RPC module per
    namespace. L5 `cli/`: the `dyfj` client.

  Modules not yet moved sit at the top of `prototype/src/`, each mapped to
  its target layer by name in `scripts/arch-layers.json` (`files`), which is
  the authoritative list. They are:
  - the ACP runner (`acp-client.ts`, `acp-session-map.ts`,
    `external-agent-runtime.ts`), whose move is deferred;
  - the interactive REPL (`cli.ts`), which the Rust client in
    `core/dyfj-repl` replaces.

  `prototype/diagnostics/` holds the manual diagnostic helpers, outside the
  runtime graph.

  `prototype/mcp/` is the stdio memory MCP server over the same store.
  `prototype/testing/` holds the shared fakes, builders, conformance kits
  and the golden characterization suite.
  `prototype/README.md` describes each directory in full.
- `specs/` - the phase-1 restructuring specifications: architecture, data
  layer, testing, PRDs, work orders, extension recipes, and the bug log.
- `scripts/` - the repository-owned aggregate gate (`deno task test`) and its
  policy checks.
- `schema/` - Dolt DDL. Canonical data model. Language-agnostic source of truth.
- `contracts/` - versioned semantic contract packages: JSON Schema plus
  repository-owned validators and synthetic fixtures that state domain,
  lifecycle, label, and authority semantics. A validation boundary, not a
  runtime, and not a replacement for the canonical `schema/` DDL. See
  [`contracts/workbench/first-product/v1/README.md`](contracts/workbench/first-product/v1/README.md).
- `CHANGELOG.md` - dated change tracking in
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style.
- `LICENSE` - MIT.

The split between `core/` and `prototype/` is a permanent two-tier structure
where the Rust line advances downward as components stabilize. See Layer 0
stance #3 below.

## Status

Early and active. The prototype is functional - the `dyfj` CLI (REPL and
one-shot; the earlier standalone in-process workbench CLI and its
`deno task start` / `deno task workbench` tasks are removed) over a duplex
JSON-RPC 2.0 Unix-socket seam (the canonical loopback
transport), shared single-turn runtime boundary, a multi-step agent loop
(iterating model↔tools with workspace file tools, an approval-gated `bash`
escape hatch, and a bounded `git` tool), an operator-routed
provider path with local models plus hosted providers (Anthropic, OpenAI,
OpenRouter, Google Gemini, and xAI) behind paid-approval and budget controls, and a
local ACP-client foundation verified against a deterministic fixture agent. The
ACP runner is distinct from the native model/provider loop and records outer
protocol evidence while treating agent-internal state as opaque. The prototype
also includes a Dolt-backed model registry, Dolt-backed memory with
privacy-class scoping, system prompts persisted in a Dolt prompts table, MCP
server, budget tracking, paid-escalation preflight, session receipts with
prompt-cache telemetry, event-sequence verification, and identity/authn metadata
recorded on every runtime event. The Rust core has its first schema tracer
bullet: write one event, read it back, and prove the DDL-backed contract from
Rust. Schema is canonical and stable.

Dated change tracking lives in [CHANGELOG.md](CHANGELOG.md).

## How to use this document

Two audiences, one source of truth.

- **An agent picking up work on DYFJ** should be able to read Section 1–Section
  4 in about 60 seconds and know the operating rules: what's decided, what
  "done" looks like, which constraints are settled, and how the work itself
  happens. Stop reading there unless you need the why.
- **A human reader (including future maintainers)** should read the whole
  document. Section 6 onward carries the rationale and goal-traceability notes -
  the _why_ behind Section 1–Section 4.

If something in Section 1–Section 4 contradicts prose later in the doc, Section
1–Section 4 wins. The front matter is authoritative; the rationale exists to
explain it, not amend it.

---

## 1. Decisions

### Boundaries

DYFJ starts as:

- An operator-owned, cost-aware workbench and automation substrate.
- A single-operator system with a clear path to stronger multi-principal
  boundaries as real use demands them.
- A provider-loose framework for the models and runtimes actually in use, with
  strong defaults instead of universal abstraction.
- An OSS substrate first; hosted/self-serve generalization is a later product
  question.

### Layer 0 stances (operative everywhere)

All five apply from Day-1.

1. **Swappable with strong defaults.** Components are modular and replaceable
   behind stable interop contracts. The system ships with strong defaults; model
   routing and spend posture are configurable per principal - no provider holds
   a privileged position in the architecture. Optionality, not performative
   vendor-neutrality.
2. **Operator-routed inference inside cost envelopes.** The operator sets the
   default model; hosted frontier models are a normal choice, and local models
   are a first-class option (evals, privacy-scoped work, offline) rather than a
   privileged default. Paid spend runs inside operator-configured budget
   envelopes (per session and per day): within an envelope, calls run without
   ceremony and every call is receipted; crossing an envelope requires one
   explicit confirmation, which raises the envelope for that scope; runaway
   spend (actual recorded spend crossing hard multiples of the per-call limit or
   an envelope) halts for confirmation. Non-loopback transports never inherit
   the standing paid posture and fail closed, and a model is not routable
   without a catalog pricing row. _Runtime status: envelope enforcement
   (session/day/per-call, warn-then-confirm) and a deterministic runaway-anomaly
   hard stop are live; the hard stop halts on actual recorded spend at
   configurable multiples of the per-call limit (turn accumulation) and of the
   session/daily envelopes, its confirmations never persist, and non-interactive
   callers fail closed. Trailing-pattern anomaly detection is future work._
3. **Rust for the autonomous core; TypeScript for prototyping.** The Rust line
   is a moving boundary that advances downward as components stabilize - Rust
   where its compile/build cycle does not interfere with active prototyping.
4. **Data-layer schema is canonical.** Event and memory contracts live in Dolt
   DDL. TypeScript and Rust types are consumers of that schema, not sources of
   truth.
5. **Cost visibility as a default, not an add-on.** Token spend, model
   selection, and budget posture are surfaced before the work runs and tracked
   while it runs. Cost is a _design_ concern, not a billing concern.

### Goal done-line

> _I am doing most of my daily work from the tool, with cost visibility up front
> from the beginning, with confidence I'm not ripping through obscene amounts of
> token burn._

Working-system criterion. Cost visibility is part of the done-line itself, not a
deferrable enhancement.

Daily use is measured on one route: the native model loop with hosted
inference over an OpenAI-compatible provider, with OpenRouter as the default
provider and others pluggable behind that adapter. The route is opt-in, not the
runtime's bare default: an unconfigured bare turn still uses the local tier-0
model, so the operator selects a hosted model with `DYFJ_WORKBENCH_MODEL` (or
the configured companion default) or `--model`. External-agent (ACP) routes stay
in the tree but are deferred from the route plan (`specs/README.md`, decision
D29).

### Inter-agent contracts - Day-1 posture

- **Event schema is the inter-agent contract.** Runtime events carry the audit,
  trace, identity, and cost fields that agents and tools share.
  Discovery-specific schema should be shaped by real producers and consumers.
- **Runtime registry is interface-only Day-1.** `register()` and `lookup()`
  exist as a stubbed interface backed by static config. The first real
  registration/leasing behavior should be driven by an observed consumer.

### Authority and policy

- **Permissions reason about call shape, not the model's justification.**
  Model-supplied arguments are ignored during permission checks.
- **Immutable message log is ground truth.** Memory is a derived view; the log
  is the audit trail.
  _Runtime status: not yet true in full. Events are append-only, but session
  rows are updated in place, memories are written directly by the MCP server
  without an event, and ideas/packets live only in process memory. Closing this
  gap is roadmap durable-state work; the design direction is in
  `specs/02-data-layer.md` §7._

---

## 2. Goal

A first-class AI workbench and automation substrate with vendor coupling
loosened at the core - any single harness, runtime, or model is one option among
several rather than the foundation.

## 3. Audience and operating cadence

- **Primary canonical reader** of this document and most artifacts is the
  project maintainer.
- This document is written as repo-local operating context, with no
  internal-only language or private references that would not belong in the
  repository.
- **Working agents** (current and future, including any model in any harness)
  read Section 1 to operate; they do not need the rationale unless asked to
  revisit a decision.

---

## 4. Engineering posture

How the work actually happens, separate from what gets built.

- **Tests land with the code, not after it.** Any commit that adds a function
  adds a test for it. PRs without tests are not "ready except for tests" -
  they're not yet ready.
- **Fakes live at declared ports only, and are proven against the real
  thing.** A unit or component test replaces a declared port with its in-repo
  fake; module mocking is banned. Each fake that stands in for a real adapter
  passes the same conformance suite as that adapter. Real dependencies (a real
  Dolt instance, real processes, real sockets) belong to the integration tier;
  third-party network services are faked at the network boundary with loopback
  servers. The full doctrine is [`specs/03-testing.md`](specs/03-testing.md) §1.
  Shared fakes live in `prototype/testing/fakes/`. Tests use `Deno.test` with
  `@std/assert` and `@std/testing`, the only test framework.
- **Behavior is pinned by golden tests.** Throughout the phase-1 restructuring,
  a black-box golden suite (`prototype/testing/golden/`, gate lane
  `test.golden`) snapshots the engine server and CLI at process level. A
  snapshot changes only with a stated reason, as `specs/03-testing.md` §4 sets
  out.
- **Model integration tests validate generation, not just service health.**
  Ollama `/api/version`, `/api/tags`, and `/api/ps` only prove the server
  process is answering. Workbench integration checks that depend on local
  inference must exercise a real `/api/generate` or OpenAI-compatible chat
  completion with a small `num_predict`/token cap so missing runner binaries,
  broken model loading, and backend packaging failures are caught before the
  Workbench path is blamed.
- **Evals for model-touching code, from when it's introduced.** Anything that
  calls a model carries eval coverage from the first commit it lives in:
  comparing across models, catching regressions when prompts change, making
  model selection a measured decision rather than a gut call. Eval results are
  part of the work product, not a side artifact.
- **The bar for "done" includes tests passing.** Not as a CI rubber-stamp, but
  as a statement of what "I shipped a thing" means. If the test suite does not
  cover what changed, extend it in the same commit.

---

## 5. Run it

### Prerequisites

- [Deno](https://deno.com) 2.9+
- [Dolt](https://docs.dolthub.com/introduction/installation)
- [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server` for the
  local default model; [Ollama](https://ollama.com) and
  [MLX-LM](https://github.com/ml-explore/mlx-lm) remain supported local
  providers, and the MLX-LM catalog rows ship inactive
- _(Optional, for `core/`)_ [`rustup`](https://rustup.rs/) - the toolchain pin
  in `core/rust-toolchain.toml` will install the right Rust automatically when
  you `cargo build` there.

### Set up the prototype

```sh
git clone https://github.com/bitspace-ai/dyfj
cd dyfj/prototype
deno install
cp .env.example .env
git config core.hooksPath .githooks
```

The last line enables the repository's git hooks, which keep AI-tool
attribution out of history (see `AGENTS.md`, Documentation Discipline):
`commit-msg` refuses a commit authored or committed under an AI tool's identity
and strips tool-attribution trailers from its message, and `pre-push` refuses
to publish commits that still carry either.

The prototype uses Deno tasks defined in `deno.json`. See `deno task` for the
list of entry points.

Edit `.env` for your local config. The prototype reads Dolt connection settings
from environment variables; for the default local SQL server, export:

```sh
export DOLT_HOST=127.0.0.1
export DOLT_PORT=3306
export DOLT_USER=root
export DOLT_PASSWORD=<your-local-dolt-password>
export DOLT_DATABASE=dolt
```

The local default is DeepSeek-R1 Distill 32B served by llama.cpp, catalog slug
`llama-cpp/deepseek-r1-32b`, the first active Tier 0 row in the registry's
local preference order. Start `llama-server` with a GGUF of that model on its
default port, aliased to the slug:

```sh
llama-server -m /path/to/DeepSeek-R1-Distill-Qwen-32B-Q4_K_M.gguf \
  --port 8080 --alias llama-cpp/deepseek-r1-32b --jinja
```

Workbench reaches it through llama-server's OpenAI-compatible endpoint,
`http://localhost:8080/v1`; `--jinja` applies the model's own chat template.
Ollama stays supported: the Ollama row `qwen3.6:35b-a3b` on
`http://localhost:11434/v1` is next in the preference order. A bare turn picks
by that order, not by which server is running, so an Ollama user selects that
row with `--model` or a companion default. The catalog also carries MLX-LM
Server rows (`mlx_lm.server` on `http://127.0.0.1:18080/v1`); they ship
inactive, so set a row's `active` flag in the `models` table before selecting
it with `--model`.

Workbench also carries built-in rows for the local models above and adds them
when the catalog has no row for them. A catalog row set inactive stays out of
routing and the model picker; the built-in row does not replace it.

Agent-tool turns default to 32 steps. Every entrypoint accepts
`DYFJ_MAX_TOOL_STEPS`; the UDS engine also loads
`[agent].max_tool_steps` from `~/.dyfj/config.toml`. Values are integers from 1
through 64, and the environment value takes precedence for the engine. The
final receipt reports `Tool steps: used/limit` and marks when the configured
limit ended tool use.

The REPL's `/friction <sev> [--escaped] <text...>` command posts one numbered
entry to the daily-driver checkpoint through the configured Linear MCP read and
write tools. The narrow UDS `friction/post` method retains their existing
authorization: the read follows configured-external read policy and the comment
write still asks for operator approval. Each posted `Context:` line contains
exactly the model slug, workspace basename, and previous slash command when one
exists; the slash command is capped at 120 characters with a visible `…` marker,
and free-text prompts and absolute workspace paths are never posted. Set
`DYFJ_FRICTION_ISSUE_ID` on the runtime to identify the operator's
friction-checkpoint issue; `/friction` fails at the `configuration` stage when
the variable is unset or blank.

### Hosted inference (paid approval)

With no configured companion default, a bare turn uses the registry's local
default. The operator can instead configure a hosted companion default or select
a hosted model from `dyfj models`. Paid inference requires approval on a
loopback session: use `--approve-paid`, `/model <slug> --approve-paid`, or the
standing `[paid].approve_paid_default` posture. Once approved, ordinary calls
inside the configured budget envelopes run without another budget prompt and are
receipted with cost and prompt-cache telemetry; crossing a ceiling requires
explicit confirmation, and the runaway-anomaly hard stops remain separate.
Non-loopback callers cannot inherit or assert paid approval and fail closed.

Each hosted provider reads its key from the process environment and fails closed
when absent — Anthropic (`ANTHROPIC_API_KEY`), OpenAI (`OPENAI_API_KEY`),
OpenRouter (`OPENROUTER_API_KEY`), Google Gemini (`GEMINI_API_KEY`), and xAI
(`XAI_API_KEY`). Each key is sent only to its provider's own https host, with
redirects refused; a catalog row that pairs one of these providers with any
other base URL fails closed before a request is made. The **pointer** mechanism
keeps secret values off the config file: for a declared secret env var you write
a `[secrets.pointers]` _pointer_ (an `op://` ref, etc.), never the value, and it
is resolved at process start.
(The separate `[secrets.env]` map, below, is a plaintext surface for
_non-secret_ resolver env — do not put a credential there.)

**Recommended: declare secret pointers in `~/.dyfj/config.toml`.** With a
`[secrets]` section, `dyfj start` alone yields a fully capable runtime — the
engine resolves each declared pointer at boot by invoking a vendor-neutral
resolver command, so hosted turns work without a separate wrapper:

```toml
[secrets]
# The resolver command is vendor-neutral: `op read` is one choice; any command
# that prints the secret to stdout works. The pointer is passed as the final arg.
# NOTE: this is a trusted executable, not inert data — the engine grants it
# --allow-run and executes it at boot. See the trust-boundary note below.
command = ["op", "read"]
# The command runs with stdin closed (no terminal prompt) and a timeout that
# SIGKILLs the immediate resolver process, so a stalled/locked resolver degrades
# fail-closed rather than hanging (a descendant it spawned may outlive the kill).
# NOTE: closing stdin does not stop a GUI-integrated manager (e.g. the 1Password
# app) from raising a biometric prompt out-of-band — see session-first below.
# Milliseconds; default 10000.
timeout_ms = 10000

# Pointers keyed by the declared secret env var (only secret-pointer keys are accepted).
[secrets.pointers]
ANTHROPIC_API_KEY  = "op://<vault>/<item>/credential"
OPENAI_API_KEY     = "op://<vault>/<item>/credential"
OPENROUTER_API_KEY = "op://<vault>/<item>/credential"
GEMINI_API_KEY     = "op://<vault>/<item>/credential"
XAI_API_KEY        = "op://<vault>/<item>/credential"
# Also resolvable this way: DYFJ_MEMORY_MCP_TOKEN, DOLT_PASSWORD.
```

**`config.toml` is a trust boundary.** `[secrets].command` is trusted executable
configuration, not inert data: the launcher grants that binary `--allow-run` and
the engine runs it automatically at boot. A shell or interpreter there
(`["bash", "-c", …]`) runs arbitrary code. So protect `~/.dyfj/config.toml` with
the same care as executable policy — restrictive file permissions, no untrusted
writers. Pointer strings are passed to the command as process arguments, so
vault/item identifiers may be visible to local process inspection (`ps`); that's
metadata, not the secret value — prefer opaque vault/item names if that matters
to you.

**The resolver runs in an isolated environment.** It is spawned with a cleared
environment, receiving only a minimal non-secret base (`PATH`, `HOME`, `USER`,
`XDG_RUNTIME_DIR`), plus `[secrets.env]`, plus whatever you name in
`[secrets].inherit_env`. It does **not** inherit the runtime's other secrets —
provider keys, `DOLT_PASSWORD`, the memory token — so trusting a command to
resolve one pointer does not hand it every credential the runtime holds; a
compromised or misconfigured resolver's blast radius is bounded to what you
forward. If your resolver needs a launch-scope secret to authenticate (e.g. a
service-account token exported into the runtime's environment), forward it by
name: `inherit_env = ["OP_SERVICE_ACCOUNT_TOKEN"]` (declared secret env vars and
`PATH`/`HOME`/linker names are rejected there).

Resolution is presence-only: the boot log reports
`secret <NAME>: resolved | already-set | unavailable (<reason>)` and never
echoes a value, a captured output, or the resolver's path. An already-set env
var wins and its pointer is not consulted, so projecting a key ambiently still
works and overrides the pointer. Blast radius follows the session-first order: a
_non-probe_ pointer's failure leaves only its own provider unavailable, whereas
failure of the _session probe_ (the first pending pointer) also skips every
remaining unresolved pointer for that boot (see below). Either way it fails
closed with a clear message at point of use; local-first inference is
unaffected. Pointers resolve only at boot, so fixing the cause afterwards
(unlocking the vault, or correcting the resolver command or pointer) does not
repair a runtime that started degraded: restart it (`dyfj stop`, then start it
again). Until then `runtime/status` lists each failed pointer as
`unavailableSecrets` (the env var, or the `[secrets.named]` name, and the
reason, never a value), and
`dyfj status` and the Rust REPL's startup lines print them with that advice.

The resolver is **session-first**: the first declared pointer is resolved alone
to warm the resolver command's auth session, then — _only if that probe
succeeds_ — the rest resolve concurrently. If the probe fails (timeout, a
declined unlock, or a bad first pointer), the remaining pointers are skipped
fail-closed, bounded by a single timeout. This is a **best-effort** measure, not
a guarantee the generic command protocol can enforce: for a resolver whose auth
caches after the first unlock, it reduces the interactive unlocks toward one
rather than one per pointer; a resolver that re-authenticates per invocation
could still prompt more than once. The hard guarantees are the ones the engine
controls: no unbounded hang, and per-provider fail-closed degradation.

**What "fail-closed on timeout" guarantees — precisely.** It is _result-level_:
on a timeout the engine guarantees the env var is **never set**, so the provider
gets no key and fails closed, and it sends `SIGKILL` to the _immediate_ resolver
process. It does **not** reap the resolver's process _tree_ — Deno exposes no
process-group primitive — so a resolver configured as a **shell wrapper** can
leave a descendant running past the timeout. That descendant **cannot inject
into the runtime** (the env var is never set and the output pipe is abandoned),
but it could keep a vault session unlocked or write bytes to a pipe no one
reads. **Prefer a direct-binary resolver** — `op read` is a single process with
no descendant tree; a shell-wrapper resolver is responsible for cleaning up its
own children.

**Unattended deployments.** App-biometric unlock is fine for interactive daily
driving, but a headless surface (a launchd agent, a scheduled runner) must never
block on a GUI unlock. For those, use a non-interactive resolver auth — e.g. a
**1Password service account**. Its _token_ is a secret and must not go in the
config file: export it into the runtime's launch environment (prefer a
**keychain-backed** source; a launchd plist's `EnvironmentVariables` stores it
as **plaintext** in that file, weaker and a deliberate last resort; a
shell-profile export is weaker still) and forward it to the resolver by name
with **`inherit_env = ["OP_SERVICE_ACCOUNT_TOKEN"]`** — the resolver runs with a
cleared environment, so it only receives what you forward. Any _non-secret_
resolver knobs (an account name, a `--flag`, a non-interactive toggle) go in
`[secrets.env]`, a **plaintext** surface (declared secret env vars are rejected
there; keep other credentials out of it too — the engine can't know an arbitrary
name is secret). With a service-account token the resolver authenticates
non-interactively — it never touches the desktop app, so there is no biometric
prompt to raise — and a missing or revoked token fails fast → fail-closed. (The
engine itself only closes stdin and bounds the wait with a timeout; whether an
out-of-band GUI prompt appears, and whether a spawned descendant survives the
kill, depend on the resolver you configure — a non-interactive auth like a
service account is what actually avoids the prompt.)

**Alternative: project the key ambiently at process start**, without a
`[secrets]` section:

```sh
ANTHROPIC_API_KEY="op://<vault>/<item>/credential" \
  op run -- dyfj start
```

### Configured external MCP tools

The daily-driver runtime can expose an exact allowlist of tools from configured
MCP Streamable HTTP servers. This first client surface pins MCP revision
`2026-07-28`; it does not add stdio servers, OAuth, resources, or prompts. Use
HTTPS endpoints. Cleartext HTTP is accepted only for loopback IP literals, and
URL-embedded credentials are refused; `localhost` is not address-pinned and
therefore still requires HTTPS.

Declare a dedicated bearer credential by logical name under `[secrets.named]`.
The resolver returns that credential to an in-memory map; Workbench does not add
it to the runtime environment. The table accepts at most 64 entries; after one
successful session probe, at most eight follower resolver subprocesses run at
once. Then declare the server and each tool by its exact server-reported name:

```toml
[secrets]
command = ["op", "read"]

[secrets.named]
records_mcp = "op://<vault>/<item>/credential"

[[mcp.servers]]
id = "records"
transport = "streamable_http"
url = "https://mcp.example.com/mcp"
minimum_clearance = "loopback"
auth = { type = "bearer", secret = "records_mcp" }
tools = [
  { name = "read_record", effect = "read", approval = "allow" },
  { name = "create_record_comment", effect = "write_external", approval = "ask" },
]
```

The native runner exposes a configured `save_issue` (or legacy `create_issue`)
as the local, create-only `mcp.<server>.create_issue` tool. The binding fixes one team ID and maps exact
model-visible project names to stable project IDs; neither ID is model input:

```toml
[[mcp.servers]]
id = "linear"
transport = "streamable_http"
url = "https://mcp.example.com/mcp"
minimum_clearance = "loopback"
auth = { type = "bearer", secret = "linear_mcp" }
tools = [
  { name = "get_issue", effect = "read", approval = "allow" },
  { name = "save_issue", effect = "write_external", approval = "ask" },
]

[mcp.servers.linear_issue_creation]
team_id = "team_stable_id"
projects = { "Synthetic Project" = "project_stable_id" }
```

Both `save_issue` and `create_issue` are reserved across configured MCP servers:
without `linear_issue_creation`, neither is exposed as a generic tool. Configure
exactly one with the binding; neither may be a search/fetch capability. For
`save_issue`, Workbench omits `id` and all update/template fields, selecting the
connector's creation operation. The model cannot supply those fields. A malformed
binding fails configuration, and an upstream
schema that cannot accept `title`, `description`, `team`, `project`, `priority`,
and `relatedTo` with the required types withholds the bounded tool. The creation
projection permits nullable upstream strings by sending only strings, ignores
unselected optional fields, and rejects unsupported constraints on the root or
selected fields. Generic MCP schema handling is unchanged. Boot diagnostics
identify a missing binding, missing discovered tool, or unsupported schema using
fixed reasons without echoing upstream schema content. The local model input
requires `title`, `description`, `project`, and `priority`, with optional
`relatedTo`: titles are 1–200 UTF-16 code units and not whitespace-only,
descriptions are at most 16,000 UTF-16 code units, projects are exact configured
names of 1–200,
priorities are integers 0–4, and `relatedTo` contains at most 10 distinct
uppercase issue identifiers of at most 64 code units. These are Workbench
limits, not claims about Linear's service limits.

Each connector write requires operator approval, including under the operator
permission profile, and the tool is registered only for loopback native-runner
turns. Schema validation runs before approval, with relation count checked before
individual items. Relation distinctness is checked after approval and before any
connector call. Duplicate relations produce a local error without creating an
issue. Workbench injects the configured team and project IDs before the one create
attempt. It does not automatically retry a transport failure. Success requires a
syntactically valid issue identifier plus matching team/project ID evidence in the
connector response. Missing required ID evidence or an invalid issue identifier
makes the outcome indeterminate and requires reconciliation in Linear before
retrying. Malformed or conflicting values in explicit `teamId`, `team_id`,
`projectId`, `project_id`, `team.id`, or `project.id` fields also make the outcome
indeterminate, even when another ID matches. The model receives only the
validated identifier. Durable events keep generic MCP arguments/results redacted
and add only that identifier to the bounded success metadata. This does not add
the tool to bare ACP-backed sessions or add a REPL command or `/idea` workflow.

Start this surface through `dyfj start`; the launcher derives the narrow Deno
network grants from the configured hosts. At boot, Workbench discovers the
server tools once and registers only the intersection with the configured
allowlist. A missing credential or failed discovery disables every server that
depends on it without disabling unrelated runtime capabilities. The shared
resolver uses its first pending credential as a session probe; if that probe
fails, later credentials are marked unavailable without spawning, so multiple
configured servers may be withheld. Invalid configuration fails boot.

`minimum_clearance = "loopback"` withholds the tools from remote-clearance
turns. `minimum_clearance = "remote"` declares eligibility for both remote and
loopback turns. The current boot integration is the UDS daily-driver runtime. A
read tool can run without a per-call prompt only when its configured approval is
`allow`. Every `write_external` tool must use `ask`, and Workbench still
requires approval when the operator permission profile is active.

Server descriptions and result text are untrusted data. Workbench supplies the
model-facing tool description, caps cumulatively consumed response bodies on a
discovery connection at 4 MiB total and on a tool-call connection at 256 KiB
total before MCP body parsing, retains at most 64 KiB of sanitized discovered
input schema, refuses redirects, and frames returned content as untrusted.
Durable events redact all argument values and the result while retaining bounded
server, tool, revision, and outcome metadata. Use a dedicated, minimally scoped
server credential; the bearer token grants whatever authority the MCP server
assigns to it.

A configured server can also back the native runner's `web_search` and
`web_fetch` tools. Name the upstream tools under `capabilities`; each named tool
must also appear in the server's `tools` allowlist, and at least one of the two
keys is required:

```toml
[[mcp.servers]]
id = "web"
transport = "streamable_http"
url = "https://mcp.example.com/mcp"
auth = { type = "bearer", secret = "web_mcp" }
tools = [
  { name = "search", effect = "read", approval = "allow" },
  { name = "fetch", effect = "read", approval = "allow" },
]
capabilities = { search_tool = "search", fetch_tool = "fetch" }
```

The first ready server that declares a discovered search tool supplies
`web_search`, and likewise for `web_fetch`. `web_search` takes a query and an
optional limit (1–10, default 5) and returns bounded snippets, each with a
source ID (`s1`, `s2`, …) when it carries a URL. `web_fetch` takes either an
HTTPS URL or a source ID from the current turn's latest search, refuses any
target it cannot verify as public, and passes the canonical URL to the upstream
fetch tool. A hostname passes only when its A and AAAA lookups both answer
(either may have no records), together they return at least one address, and
none of those is private, loopback or internal; a public IP literal needs no
lookup. Both `dyfj start` and `deno task serve-unix` grant the engine DNS
access to the nameservers in `/etc/resolv.conf` for these lookups. Per turn, at
most 3 searches and 5 fetches run, returned text is capped at 40,000 characters
per fetch and 100,000 per turn, and results are framed as untrusted external
data.

Which models exist, what they cost, and which tier they sit in is registry data,
not code - see the current catalog in `schema/catalog/001_models.sql`. Catalog
pricing and availability rows are operator-curated seed values, not
authoritative provider price sheets. Historical catalog changes are preserved
under `schema/history/`. Repricing or adding a model is a Dolt commit.

### Initialize Dolt and apply the schema

From the repo root:

```sh
mkdir -p data/dolt
cd data/dolt
dolt init
for dir in ../../schema/current ../../schema/catalog; do
    find "$dir" -maxdepth 1 -name '*.sql' | sort | while read -r f; do
        dolt sql < "$f"
    done
done
dolt sql-server --host 127.0.0.1 --port 3306 &
cd ../..
```

The `data/` directory is gitignored. One rule decides what to apply (see
[`schema/README.md`](schema/README.md)):

- **Fresh install:** `schema/current/` then `schema/catalog/`, as above. The
  forward migrations are already folded into that baseline and are never
  applied on top of it.
- **Existing database:** replay forward. A database created before the baseline
  cut has the structure `schema/history/` ends with; apply the files in
  `schema/migrations/` it has not yet applied, in order.

The gate's `schema.equivalence` lane proves both paths end at the same
structure. The engine checks its database at boot: when Dolt is reachable and a
canonical table lacks a column, `serve-unix` refuses to start, names the missing
columns and points at `schema/migrations/`. It has no fallback for an
un-migrated database, including for `events/query` reads `AS OF` a snapshot that
predates a migration.

### Run Workbench

```sh
deno task --cwd prototype compile-cli
./prototype/dist/dyfj
```

The bare launcher is the daily-driver path: it connects to the local UDS runtime
and opens the streaming REPL, starting a background runtime first when none
answers. Put `prototype/dist/` on your `PATH` to use `dyfj` without the path
prefix. Common commands are:

```sh
./prototype/dist/dyfj exec "Summarize this repository"
./prototype/dist/dyfj --runner fixture exec "Exercise the local ACP fixture"
./prototype/dist/dyfj --runner codex-chatgpt exec "Inspect this repository"
./prototype/dist/dyfj status
./prototype/dist/dyfj models
./prototype/dist/dyfj sessions
./prototype/dist/dyfj start   # explicitly foreground the runtime; Ctrl-C stops it
./prototype/dist/dyfj stop    # stop the running runtime at the socket
```

The HTTP peer server is retired. UDS JSON-RPC is the only seam
(`deno task serve-unix` / `dyfj`); a remote or browser surface returns later as
a thin gateway client of that seam.

#### JSON-RPC seam over a Unix domain socket

The workbench speaks a duplex JSON-RPC 2.0 protocol over a Unix domain socket —
the canonical `loopback` transport (no TCP port; gated by filesystem
permissions; full local clearance). It is the seam the terminal clients use. The
bare `dyfj` launcher starts this runtime automatically when needed; the direct
engine task remains available for development:

```sh
deno task serve-unix      # serve the JSON-RPC seam on the Unix socket
```

The socket path resolves from `DYFJ_SOCKET`, else
`$XDG_RUNTIME_DIR/dyfj/workbench.sock`, else `~/.dyfj/run/workbench.sock` (the
parent directory is created mode 0700). The engine-free `dyfj` CLI reaches the
read methods over the socket:

```sh
./prototype/dist/dyfj models
./prototype/dist/dyfj sessions
```

For a compiled daily-driver binary under Deno 2.9+, run `deno task compile-cli`
in `prototype/` and put `dist/` on your `PATH`. The shipped `dist/dyfj` launcher
execs the compiled binary on the default socket path and falls back to
`deno run` with a runtime-resolved `unix:` grant when `DYFJ_SOCKET` or
`XDG_RUNTIME_DIR` shifts the path.

The seam exposes read methods for `runtime/liveness`, `runtime/status`,
`surface/snapshot`, `models/list`, `sessions/list`, `sessions/inspect`,
`events/query`, `ideas/list`, `ideas/get`, `packets/list`, `packets/get`,
`tools/list`, and `tools/inspect`; `runtime/stop`, which shuts the runtime down
for `dyfj stop`; the narrow operator-approved `friction/post` method;
`ideas/mark` and `packets/draft`; plus streaming `turn` and cancellation
`turn/cancel` methods
(intermediate text deltas and runtime events arrive as `stream` notifications;
the receipt is the result). `runtime/liveness` is the cheap probe `dyfj status`
(and so the launcher's autostart check) sends first; it loads no models and
queries no Dolt state.
`sessions/inspect` returns one session's record, workspace, and event count.
`ideas/mark` records a candidate idea against a session, optionally anchored to
one of its events, and `packets/draft` drafts a work packet (title, source
context, operator intent, proposed acceptance criteria, verifier provenance)
from an idea or event. Ideas and packets are held in the runtime's process
memory only: they are not written to Dolt and do not survive a restart. The REPL
drives them with `/idea mark [--event <event-id>] <label...>`, `/idea list`,
`/idea show <idea-id>`, `/packet draft [<idea-id>] [--idea <id>] [--event <id>]
[--issue <id>] [--title <title>]`, `/packet list`, and `/packet show
<packet-id>`. `runtime/status` returns both the simple method id
list and grouped method catalog metadata for CLI/TUI/GUI surfaces. The `dyfj`
CLI drives turns over this seam, renders companion markdown line-by-line while
streaming, wraps prose toward a 100-column maximum without splitting words,
styles headers/emphasis/lists/quotes/code, and renders safe web, mail, and
absolute local links as labeled terminal hyperlinks. On an interactive TTY, the
ACP activity indicator remains available for the full turn: it yields while
text, status, or an approval prompt owns the terminal, then resumes as
`thinking…`, a bounded sanitized tool title, or the truthful generic `working…`
with the original elapsed timer until completion. The client handles the
mid-turn approval round-trip on stderr and sends one bounded `turn/cancel`
request when Ctrl-C interrupts a connected TTY-backed UDS turn, whether REPL or
one-shot. Raw ACP thought text is not rendered, persisted, or replayed. Before
connection, and for non-TTY input, the client retains its normal SIGINT
behavior. After an autostarted server installs its SIGINT handler, when
cancellation is the terminal outcome after the active provider or tool operation
settles, the turn stops without stopping the runtime; a REPL allows another turn
on the same session, while a one-shot exits with its interrupted receipt. An
independent provider or protocol error that settles first remains an error
rather than being masked. `--json` stays buffered/raw. Remote reach can layer on
the same contract through a tailnet transport.

`--runner fixture` selects the deterministic external-agent test path instead of
the native model loop. Workbench launches the local fixture directly over ACP v1
stdio with a cleared, profile-selected environment and the resolved workspace,
bridges permission requests through the existing approval channel, applies
deadlines to protocol waits and child cleanup operations, and records
runner-specific events and a runner receipt. Sequential turns that share a
Workbench session, workspace, and execution profile reuse one live ACP worker
and session; a concurrent turn for that same key fails as busy instead of
queueing. Turn cancellation keeps a healthy handle; a protocol or process
failure removes it so the next turn can create a replacement. A warm handle is a
resource cache, not the evidence of continuity: when the keyed handle is gone
but the Workbench session has prior turns, the replacement session is not
prompted with the bare follow-up. Workbench projects a bounded transcript of
that session's own earlier turns into the replacement prompt and labels the turn
`reconstructed`; a live handle is `warm-reused` and receives no replay; a
session without prior turns is `new`; and `durably-resumed` is claimed only when
the runner advertises ACP `session/load` and Workbench can verify the resumed
external session identity, which no currently pinned adapter provides. The
runner receipt records that state, the durable-resume status, the count of
projected messages and tool exchanges, and the prior and new external session
identifiers. The terminal client also prints the continuity state, whether the
native session was new, reused, or replaced, and the ACP tool-evidence count in
each external-agent footer. Workbench merges each real ACP `tool_call` with its
`tool_call_update` patches and persists a tool request/result pair only when the
adapter supplies bounded terminal input and output that pass the credential-
shape gate. Otherwise it records a fixed value-free gap marker, reports tool
evidence as unavailable. On later turns, Workbench recomputes persisted-history
omissions from the immutable event log, withholds each malformed tool record or
gap marker from the projected transcript, and retains valid pairs, empty valid
results, operator prompts, prose, and stored summaries. Whole-history record
counts remain separate from selected-window counts and from the actual delivery
mode; a gap marker means the number of missing calls is unknown and possibly
zero, never a positive lower bound. Every affected continuing native companion
or ACP request carries a Workbench-generated notice outside compressible
transcript messages, and operator receipts expose the same counts. One-shot
native `ask` and `next-work` requests remain transcript-free and omit this
notice and receipt. The notice states that retained prose and summaries may
depend on unavailable evidence; it neither identifies each omission site nor
authorizes replay of a historical effect.

Persisted prior tool work is carried as historical evidence, not as a tool
grant: each request and its persisted result are quoted line by line under
labelled headers that keep their pairing, ordering, and outcome status
(including failures and denials); identifiers and names are restricted to an
inert ASCII metadata grammar, and the header tells the receiving agent that the
records are Workbench's history of an expired session, not actions it took or
may repeat. Quotation prevents historical content from forging the record
structure; it is not a semantic prompt-injection boundary, so ordinary tool
permission policy remains authoritative for anything the receiving agent may
propose. History reconstruction refuses when withholding leaves nothing to
project or when a retained request/result pairing is unrepresentable. Existing
downstream bounds remain unchanged: a reconstruction is also refused before any
prompt reaches the agent when it exceeds the ACP prompt limit, the 32-message
projection bound, a per-message bound, a per-field tool bound, or the
tool-argument depth/node limit, or when retained history carries one of the
explicitly checked credential shapes. The notice is included in the final ACP
prompt-size check. Its overhead can therefore refuse a near-limit turn; for an
acquired handle, the existing error lifecycle closes and removes that handle
without deleting persisted events. Idle handles retire on a TTL, a small
resident-session bound fails closed without eviction, and UDS close, a
foreground SIGINT, or `dyfj stop` wait for in-flight creation and for every
started close to settle, then surface a retained close failure rather than
reporting success. A shutdown failure exits with status 1. On an interactive
Unix-socket client, every accepted ACP option (up to 16) is rendered as a
numbered choice and the exact selected option identifier is returned to the
agent; invalid input re-prompts within that same exchange up to three times
before failing closed. Empty or closed input, a non-interactive client, or an
unavailable approval handler selects the request's rejection option when one
exists, otherwise the request is cancelled. Empty option lists and empty or
duplicate identifiers fail at protocol ingress. This selection contract is
common to every ACP profile. Transport (`local_stdio`) remains distinct from the
selected access route (`local_sidecar`) and its cost basis (`local_free`). The
fixture is protocol coverage, not evidence for a vendor agent or subscription
route.

`--runner codex-chatgpt` is an experimental ACP route on supported non-Windows
systems where `/bin/kill` supports negative process-group signaling and the
operator home is absolute and contains neither comma nor colon, through a local
stdio child using the community-maintained `@agentclientprotocol/codex-acp`
adapter; subscription inference may use remote services. Sequential Workbench
turns reuse the same live adapter process and ACP session under the same
session/workspace/profile rule as the fixture. Commas cannot be represented
safely in this integration's comma-separated Deno grants, and colons would split
the child's `PATH`, so the login task and runtime reject either delimiter. The
route is separate from native model routing and does not accept `--model`,
`--tier`, `--hint`, or remote callers. It also requires the standing
trusted-workspace posture because the Codex agent can inspect workspace
configuration. Workbench invokes the adapter with a dedicated home beneath
`~/.dyfj/runner-homes/codex-chatgpt/`; it rejects a symlinked, non-owned, or
group/other-writable operator home and rejects non-owned or group/other-writable
existing `.dyfj` and runner-home directories without changing safe parent modes.
It sets the runner-root, dedicated HOME, Codex-home, and Cargo-home directories
to mode `0700`. The child receives a cleared environment; ambient API keys,
credential-agent socket variables, and other unselected environment variables do
not cross that boundary. ACP session updates remain finite per prompt: ordinary
profiles allow 1,024 updates and this long-running profile allows 8,192, with
the same resolved allowance enforced at protocol ingress and by the SDK
consumer. Under a warm session those ingress counters reset at each prompt, so
sequential turns do not inherit the previous exchange's budget.
Newline-delimited protocol messages are bounded separately: ordinary profiles
retain the 384 KiB ceiling, while this long-running profile permits
newline-delimited messages up to 1 MiB each. The selected message ceiling is
resolved once before stream construction and enforced before the SDK consumes
the frame. Exceeding either update or message ceiling fails closed with a
specific client diagnostic; the 16 MiB protocol-input and 60,000-byte
agent-response caps apply per prompt/exchange; permission, timeout,
cancellation, and process-cleanup bounds remain independent. This integration
does not claim OpenAI support or endorsement, and it does not expand or
interpret subscription terms. Use the `dyfj` launcher for this route; the
generic direct engine tasks remain cross-platform and do not project its
optional executable grant.

An operator may set `DYFJ_CODEX_TOOLCHAIN_PATH` to one absolute executable
directory and `DYFJ_CODEX_RUSTUP_HOME` to one absolute Rustup state directory
before starting the runtime. The launcher and CLI reject delimiter-bearing or
missing paths, slash-only root spellings, whole `.` or `..` components, and a
symlink at either path's final component before start, including a final symlink
spelled with trailing slashes. During profile construction, the Codex runtime
canonicalizes and restats each directory, compares the selected and canonical
device/inode identities where the platform reports them, and rejects a
mismatched UID or group/other write mode bits. The executable directory must
grant owner search permission; the Rustup state directory must grant owner read,
write, and search permissions. The later child access is still by pathname:
ancestor ownership and ACLs are not validated, and the selected inode is not
pinned against replacement after profile construction. Workbench places a
private Node shim first in the child `PATH`, then the optional executable
directory, `/usr/bin`, and `/bin`; it also writes that exact path to the
dedicated home's private `.zprofile` and `.bash_profile` so those macOS login
shells reset earlier `path_helper` changes. It does not dynamically derive and
add an arbitrary parent directory from the selected Node executable; the fixed
`/usr/bin` and `/bin` entries remain, and an operator may explicitly select
another directory as the toolchain. It sets `RUSTUP_HOME` to the selected state
directory and gives the child a separate persistent `CARGO_HOME` inside its
private runner home. It does not project the operator's Cargo home or attest
binaries; the existing Workbench ACP action-approval plumbing is unchanged. The
dedicated receipt evidence fields disclose only how many distinct canonical
operator directories were projected; agent-produced text is not a redaction
boundary.

The project configuration pins adapter version `1.11.0` exactly, and the Deno
lockfile records its transitive graph and registry integrity. The runtime reads
the installed package metadata and rejects metadata that does not declare
version `1.11.0`.

On start and autostart routes, the launcher considers `DYFJ_NODE_PATH` first and
otherwise asks ambient `PATH` for Node. It projects the optional executable
grant only when that candidate is already an absolute, delimiter-safe regular
file that the invoking account can execute; launcher-level rejection leaves the
Codex route unavailable. At profile construction for a Codex turn, the runtime
separately checks the selected path's file mode and canonical delimiter safety;
these checks are non-atomic, the selected path remains unpinned, and a
validation failure rejects that turn. Workbench trusts the explicitly supplied
or implicitly discovered executable but does not execute an identity probe or
attest that the binary is Node.js. Workbench then invokes that selected path
with the pinned adapter entry path.

Authenticate the dedicated home once before using the route:

```sh
cd prototype
deno task codex-chatgpt-login
```

After ACP initialization and before `session/new`, Workbench asks the adapter
for `authentication/status`. The response must be an object whose top-level
`type` is exactly `chat-gpt`; a missing response or any other top-level type
fails closed. Workbench supplies no API-key or metered-provider fallback. Only
after that check succeeds does Workbench persist the profile-declared
`subscription_oauth` and `subscription_quota` labels, with
`runner_route_source=profile_declared` and the adapter-reported
`runner_auth_type=chat-gpt`. Those fields describe the external agent's access
route; the existing `authn_*` fields continue to describe the caller. Workbench
carries ACP's optional, unstable prompt-response usage and latest context-window
snapshot as separately labeled ACP evidence; it does not reinterpret those
values as native accounting or attest a model identity. ACP may also report
cumulative session cost, which remains distinct from native per-turn cost. The
pinned Codex adapter currently reports token/context usage on this subscription
route but no currency cost, so the terminal receipt says
`subscription quota (USD not reported)`. Workbench starts the adapter as a
dedicated process group after verifying the exact negative-PGID signal syntax
against an inert process group. If the adapter leader is still active,
completion, error, timeout, and cancellation cleanup attempt to signal that
group. Signal subprocesses, process-group polling, child-status waits, and
stream-drain waits each have deadlines. A process-group termination failure is
thrown directly when no earlier primary failure exists; otherwise it is attached
as that primary error's cause. Stderr-drain cancellation destroys the owned
stream and suppresses late stream errors.

Useful validation tasks:

```sh
deno task test            # repository aggregate gate (full green bar)
deno task test:fast       # policy checks, source typecheck, Deno.test unit lane
deno task check           # strict typecheck of production and test import graphs
deno task test:schema
deno task validate-schema
deno task schema:equivalence  # fresh-install and upgrade paths match
deno task schema:codegen      # regenerate the DDL-derived row types
deno task verify-workbench-events
(cd prototype && deno task test:golden)  # golden characterization suite alone
```

`deno task test` runs a set of deterministic policy checks, each reported under
a stable check id, ahead of the test suites. `subject.resolve` and
`subject.digest` bind the run to one immutable commit: in CI the workflow
supplies the exact commit and release-range base through `DYFJ_GATE_SUBJECT` and
`DYFJ_GATE_RANGE_BASE`, HEAD must match, the commit digest is recomputed from
the object bytes, and a missing or mismatched binding (or a dirty subject tree)
fails closed; a local run without the binding labels those checks explicitly
non-authoritative. `secret.tree` and `public.boundary` scan every tracked file —
tests, binary-looking payloads, and the scanner's own source included; there is
no allowlist and no path exemption — for secret-shaped values and for
operator-identifying material (non-example email addresses, absolute
home-directory paths). A tracked symlink is scanned as its link-target text,
never followed outside the repository. `secret.diff` separately scans what the
release range adds. `diff.whitespace` runs the `git diff --check` equivalent for
the range, `markdown.links` validates changed Markdown structure and
repository-relative links (external reachability is not checked), `shell.parse`
parses changed shell files with `bash -n` and fails closed if the parser is
unavailable, and `dependency.policy` rejects mutable dependency shapes: unpinned
workflow actions, `latest` installer URLs, scripts piped from the network into a
shell, and a floating Rust toolchain. `receipt.schema` runs the
`dyfj.assurance.receipt/v1` validator's tests (`scripts/assurance-receipt.ts`),
the fail-closed schema for the public v1 assurance evidence envelope contract.
Every scan diagnostic is value-free — rule id, path, and line only, never the
matched content — and the gate ends with one bounded machine-readable
`gate-status` JSON line listing each check id and result; a required check that
failed, was unavailable, or did not run can never compose into a passing status,
and interruption is reported distinctly from failure. A failing lane does not
stop the gate: every lane still runs, the gate lists each lane that failed
before the `gate-status` line, and it exits with the first failing lane's code;
only an interruption stops it early, and a run it stops reads `interrupted`
even after a failure. The `gate-status` line is
a bounded diagnostic of this run's checks, not an assurance receipt, and
validating the receipt schema generates no receipt. These are pipeline assurance
checks for this repository only: a green gate grants no Workbench runtime
capability and claims no remote review, acceptance testing, or publication —
private gates (disclosure review, independent model review, operator acceptance)
remain outside this repository.

After the policy checks, the gate runs the retired-surface scan, the
`arch.imports` module-boundary check, the source and test-file typechecks (both
file lists derived by walking the tree in `prototype/scripts/test-files.ts`,
never hand-listed), the prototype `Deno.test` unit lane (`test.unit`: every
non-integration, non-golden `Deno.test` file, run in parallel with the op and
resource sanitizers enabled and no run, net, or env grant), current and
historical schema checks, `schema.codegen` (the row types in
`prototype/src/store/generated/rows.ts` regenerated from the DDL must match the
committed file) and `schema.equivalence` (`current/` + `catalog/` and
`history/` + `migrations/` must produce the same structure), non-ignored Rust
tests using offline SQLx metadata and
no inherited `DATABASE_URL`, an isolated-Dolt integration lane (every
`*.integration.test.ts`, found by file name, with the op and resource sanitizers
enabled; including UDS and MCP round trips), and the golden characterization lane (`test.golden`). The
golden lane starts its own isolated Dolt fixture, a loopback OpenAI-compatible
model server and a loopback Linear MCP server, runs the engine server and the
`dyfj` CLI as child processes, and compares normalized captures (stream frames,
RPC responses, rendered CLI output, and every `events` and `sessions` row a
scenario writes) with the snapshots committed under
`prototype/testing/golden/snapshots/`. Its tests get loopback TCP and the exact
Unix socket of each engine server they start, and cannot write the snapshot
directory unless run with `--update`. The task resolves the Deno executable selected for the
invocation and uses that same absolute command identity for each nested Deno
lane and permission grant. Outside Windows, each lane runs in a process group
of its own, which the gate tears down (TERM, a short grace, then KILL) when the
lane ends or the gate is interrupted, so a test's same-group child processes do
not outlive its lane. Windows has no POSIX process groups, so there the gate
signals only the lane leader and a lane's descendants are not covered. The
three test lanes (`test.unit`, the isolated-Dolt integration lane and
`test.golden`) are also supervised, as `specs/notes/test-supervision-evidence.md`
decides. Each has a deadline (120 s, 900 s and 900 s; `DYFJ_TEST_BOUND_SEC`
overrides all three in whole seconds, up to 2147423): past it the gate tears
the lane down as on an interruption and fails it with a message naming the
deadline. The gate starts each test-lane runner directly as its group's leader
and hands it a backstop 60 s past that deadline and a lane token, which an idle
same-group token carrier holds on its command line for the whole run. When all
of its work is done, the runner stops its own process group (TERM, then KILL to
whatever is left), so a same-group descendant does not outlive the lane even if
the gate was killed. If the gate is gone and a test hangs, the runner's
backstop kills the child it is waiting on and then stops its group; a runner
still running 30 s past its backstop stops its group and exits regardless. The
gate records each running test lane's group and token under
`$HOME/.dyfj/run/gate-lanes/`; at its next start it stops a group left behind
by a gate that is no longer running, but only when a live member of that group
still carries the lane token on its command line, so a reused process or group
id is never signalled. The integration lane owns a
temporary Dolt repository and SQL server, with cleanup on normal completion and
handled failure. SIGINT and SIGTERM request cooperative cancellation; the direct
lane process receives SIGTERM followed by a bounded wait and possible SIGKILL.
The Rust tracer test retains its manual-run `.env` loader, but the fixture's
explicit `DATABASE_URL` takes precedence, so the lane does not use the
operator's Dolt database. It requires Deno, Dolt, and the pinned Rust toolchain.

`arch.imports` (`scripts/arch-imports.ts`, reported under `test.aggregate`)
builds the module graph of every module under `prototype/src`,
`prototype/mcp`, `prototype/scripts`, and `prototype/diagnostics` with `deno info --json` (`scripts/arch-imports-graph.ts`, offline and
config-free): static imports, re-exports, and dynamic `import()`, with
type-only edges (`import type`, `export type`, `typeof import()`) marked.
Because deno's graph merges a dynamic import into a static import of the same
module and has no entry for a non-literal `import()`, every `import()`
expression is also collected with `deno lint` and a repository-owned plugin
(`scripts/arch-imports-lint-plugin.ts`, configured by
`scripts/arch-imports-lint.json`). It maps each module to the target layer in
`specs/01-architecture.md` §3 (modules not yet moved are mapped by name in
`scripts/arch-layers.json`) and checks import cycles, upward and non-listed
same-layer edges, the `cli/` allow-list, and dynamic local imports, literal or
not. It confines environment access to the declared configuration surface:
`Deno.env` and `process.env` may be read only in `prototype/src/config/`
(through its `Env` port) and in the `prototype/scripts/` tooling, a legacy
module mapped into `config` by name gets no exemption, and every `DYFJ_*` key
named anywhere under the lane's roots must be declared in `CONFIG_SCHEMA`. It
also confines the Dolt driver and SQL writes to the store port
(`specs/02-data-layer.md` §2): `mysql2` may be imported only from
`prototype/src/store/`, and a string literal that begins with an SQL write
statement may appear only in the store's journal; the isolated-Dolt test
fixture under `prototype/scripts/` is the one justified exemption from each.
The write rule sees statements written as literals. The `mysql2` confinement
keeps any other SQL inside `store/`, and inside it the readers get only a
handle that runs a single `SELECT`, so only the journal can write. Each
exemption is named, with its justification, in `scripts/arch-layers.json`. A
module that fails to load or a local import that does not resolve fails the
lane. It runs in ratchet mode: current violations are recorded in
`scripts/arch-imports-baseline.json`, and the lane fails on any violation not in
that baseline and on any baseline entry that no longer occurs, so the baseline
can only shrink. An intentional cycle is allowed only by a named entry in
`scripts/arch-cycles.json` (empty today) that lists its exact edges, each of
which must lie inside an import cycle, a justification, and an existing test
file; an entry exempts its edges from the cycle and dynamic-import rules only,
never from layer direction or the `cli/` allow-list. Deep imports that bypass a
`mod.ts`, modules over 600 lines, and functions over 150 lines are reported
without failing. The size limits of `specs/prd/PRD-11-runtime-decomposition.md`
R2 fail the lane: a runtime module (any unit not marked `outside`, so not
`prototype/scripts/` or the diagnostics) over 1,000 lines, or a function in one
over 200 lines, unless `scripts/arch-size-exceptions.json` names it with its
reason and the size it may not exceed. An excepted module or function may
shrink but not grow, and an entry for one back under its limit fails the lane
until it is removed (`scripts/arch-imports-size.ts`; its function spans come
from a small best-effort tokenizer, and a function is matched by its file and
reported name). After an intended reduction, regenerate the
baseline with
`deno run --allow-read=. --allow-run=deno --allow-write=scripts/arch-imports-baseline.json scripts/arch-imports.ts --write-baseline`.

The same aggregate command runs remotely: a GitHub Actions workflow
(`.github/workflows/gate.yml`) executes `deno task test` from a clean checkout
on pull requests and pushes to `main`, with a read-only token, no secrets, and
the subject/range binding described above. It can also be dispatched manually
on any branch (`workflow_dispatch`) with the same token and no secrets; a
manual run has no push or pull-request base, so the caller supplies the
release-range base as the required `range_base` input. Its stable check name, `full-gate`,
is the intended branch-protection required check. On a pull request whose
release range changes Markdown files only (every changed path, deletions
included, ends in `.md`; rename detection is off, so a file renamed to a `.md`
name does not count), the gate runs only the policy lanes — `subject.resolve`,
`subject.digest`, the retired-surface scan, both public-safety tree scans,
`secret.diff`, `diff.whitespace`, `markdown.links`, `shell.parse`,
`dependency.policy` and `receipt.schema` — and the two contract lanes, whose
closure report reads the `closure-claim` markers in the Markdown. It names
every lane it skips before it starts, and its `gate-status` line reads
`"mode":"docs-only"`. The
classification (`scripts/change-scope.ts`, keyed on `GITHUB_EVENT_NAME`) runs
inside the repository-owned command rather than as a workflow path filter, so
both jobs still report a status and the required checks can pass. A push to
`main`, a manual dispatch and every local run keep the full gate, so anything a
docs-only pull request skipped is still checked on `main`. A second job,
`macos-portability`, runs the same command on a macOS runner so process,
filesystem, and runtime portability are observable. The workflow pins its one
third-party action by full commit digest (watched by Dependabot), installs Deno
2.9.6 and Dolt 2.3.1 from exact-version release URLs — never a `latest` URL,
never a script piped into a shell — and checks each downloaded archive against a
SHA-256 digest committed in the workflow before it is unpacked or executed.
Those digests are repository-owned and never fetched at run time: a checksum
file served by the same origin as the archive proves nothing against an attacker
who controls that origin. The exact-version URL and the reported tool version
remain as secondary evidence, not as the integrity control. Release signatures
are still not verified, and the dependency manifest declares that gap. The Rust
toolchain is installed from the exact pin in `core/rust-toolchain.toml`.
Workflow-hygiene tests inside the gate assert those properties — including that
every downloaded archive has a committed-digest check between its download and
its unpack — so a drift in the workflow fails the gate itself.
`deno task test:fast` runs every deterministic policy check (including
`arch.imports`) plus the contract package checks, the source typecheck, and the
`test.unit` lane, reusing the production lane definitions verbatim for quick local
feedback; it is a convenience, not the green bar — `deno task test`, locally or
in CI, remains the single full gate. Remote CI is authoritative only for the
public deterministic checks it runs.

### Dependency updates

Dependabot proposes weekly update PRs for three surfaces, configured in
`.github/dependabot.yml`: the Deno workspace under `prototype/` (its `deno.json`
imports and `deno.lock`), the Rust crate set under `core/` (`Cargo.toml` and
`Cargo.lock`), and the digest-pinned workflow actions under
`.github/workflows/`.

The pins Dependabot does not cover are the Rust toolchain channel in
`core/rust-toolchain.toml`, and the exact Deno/Dolt archive versions plus their
committed SHA-256 digests in `.github/workflows/gate.yml`. Applying a change to
those is intended to be a manual, operator-inspected step; the configuration
enforces neither the inspection nor who may change them. No gate check flags
them when they age, so keeping them fresh is a manual cadence. The
`dependency.policy` check enforces
pin discipline — exact versions, digests, and a declared 72-hour minimum
release-age floor for registry-published dependencies — but it detects no
staleness: freshness is the
operator's responsibility, not the gate's.

Before treating a Workbench model failure as a DYFJ problem, validate that the
selected local provider can actually generate, not just report health. For
MLX-LM Server:

```sh
curl -sS http://127.0.0.1:18080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit","messages":[{"role":"user","content":"pong"}],"max_tokens":1}'
```

For llama.cpp:

```sh
curl -sS http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"llama-cpp/deepseek-r1-32b","messages":[{"role":"user","content":"pong"}],"max_tokens":1}'
```

For Ollama:

```sh
curl -sS http://127.0.0.1:11434/api/generate \
  -H 'content-type: application/json' \
  -d '{"model":"gemma4:e2b","prompt":"pong","stream":false,"options":{"num_predict":1}}'
```

This should return generated text. `/api/version`, `/api/tags`, and `/api/ps`
are useful diagnostics, but they do not prove the model runner can load.

To inspect the running Dolt SQL server without installing `mysql`, use Dolt as
the client:

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

A bare `cargo run` runs the Rust schema tracer bullet: it inserts a
`session_start` event through `dyfj_core::events::write()`, reads it back with
`events::read_by_id()`, and verifies equality. The ignored integration tests
exercise the same path when a live Dolt server is available:

```sh
cargo test -- --ignored
```

For a DB-free Rust compile/test pass using the committed `.sqlx/` cache:

```sh
SQLX_OFFLINE=true cargo test
```

`cargo build` and `cargo test` cover both workspace members. The REPL
front-end runs against a live Workbench runtime:

```sh
cargo run -p dyfj-repl
```

It resolves the socket as the runtime does (`DYFJ_SOCKET`, else
`$XDG_RUNTIME_DIR/dyfj`, else `~/.dyfj/run`). A multi-line paste arrives as one
prompt, which the TypeScript REPL cannot do. It covers turns, approvals,
Ctrl-C cancellation, a per-turn receipt line with cost and prompt-cache tokens,
and the daily-driver commands `/model`, `/fast`, `/session`, `/friction` and
`/idea`, and it refuses an unknown or unroutable `--model` before the first
prompt. A bare interactive `dyfj` opens the Rust REPL when a `dyfj-repl` binary is
available (`DYFJ_REPL_BIN`, else `core/target/release/dyfj-repl` beside the
prototype, else `dyfj-repl` on `PATH`; build it with
`cargo build --release -p dyfj-repl`), both stdin and stdout are a terminal,
every argument is one it takes (`--model`, `--approve-paid`, `--fast`,
`--session`, `--workspace`, `--socket`), and neither `DYFJ_WORKBENCH_TIER` nor
`DYFJ_WORKBENCH_HINT` holds a value the TypeScript client applies (a tier of
0, 1 or 2; a hint of `code`, `chat` or `reasoning`), since only it reads them.
Otherwise, and with `DYFJ_REPL=ts`,
the TypeScript REPL opens as before. `DYFJ_REPL=rust` requires the Rust REPL
for an interactive session on a terminal and fails if it cannot run there;
piped or redirected input, subcommands, `-p` prompts and `--help` are
unaffected by `DYFJ_REPL`.
See [`core/README.md`](core/README.md).

### MCP integration

The prototype exposes its memory substrate over MCP via
`prototype/mcp/server.ts`. Point your agent at it. Replace `/path/to/deno` with
`which deno` and `/path/to/dyfj` with the absolute path of your clone.

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

The architectural surface, sorted by altitude. Section 1 already states the
_decisions_; this section carries the _boxes on the diagram_ and their
rationale.

### 6.1 Layer 0 - stances

The five Layer 0 stances are stated in Section 1. They are repeated here only
when expansion is useful; the canonical statement is in Section 1.

### 6.2 Layer 1 - core subsystems

Things that exist as boxes on a diagram.

- **Immutable message log.** Append-only record of every turn, tool call, and
  result. Ground truth from which other views derive. The log is the audit
  trail; memory is the working set.
- **Conversation/Agent Loop.** The orchestrator that drives turn → tool call →
  result → next turn.
  - Tool call mechanism (typed, validated, observable)
  - Context engineering pipeline: token counting / auto-compaction, incremental
    diffs (only changes since last turn), layered prompt composition (system +
    skills/tools + workspace anchors + retrieved context), retrieval tools
    (grep, LSP, AST, glob)
- **Memory abstraction.** First-class subsystem, not a bolt-on. Distinct from
  the immutable log. Queryable, evictable, scoped, explicitly reasoned about.
- **Workbench runtime boundary.** One engine process runs every turn through
  one pipeline. Clients reach it only over the JSON-RPC/UDS seam
  (`prototype/src/transport/`): the `dyfj` CLI (`prototype/src/cli/`) and the
  Rust REPL in `core/dyfj-repl`. Every transport runs the identical turn
  through the engine's turn entry (`prototype/src/engine/turn.ts`), not a
  per-transport copy. `prototype/src/server/main.ts` is the single
  composition root. It builds the store, the external MCP commands, the
  session owners, the workspace-root anchors, the turn runtime (binding the
  ACP runner) and the extensions, and wires one RPC module per namespace
  (`server/rpc/`); each turn assembles its tool catalog from these. A native
  turn runs as staged steps over an
  engine-owned turn state: `openSession`, `buildContext`, `budgetGate`,
  `loadTranscript`, `agentLoop`, `finalize`. Each session's turn lock, budget
  scope and cancel signal have one writer (`SessionOwners`). A turn calls
  back to its caller only through declared ports: the approver, the frame
  sink and its cancellation window. Durable writes go through the store's
  one mutation path, `journal.commit`. Optional features (ideas, packets,
  friction, Linear) sit behind the Extension interface, and nothing below
  `server/` and `cli/` imports them. Presentation layers pass inputs and
  render results; the runtime owns model routing, command/tool execution,
  session/event writes, budget tracking, and receipt facts. The layers, from
  L0 `kernel/` up to L5 `server/` and `cli/`, and their allowed edges are in
  `specs/01-architecture.md` §3; the `arch.imports` gate lane enforces them.
  `specs/runtime-consumer-contract.md` records the existing in-process native
  turn ports and the additional decisions a separate headless host needs.
- **Tool Registry & Dynamic Dispatch.** MCP-native. Tools are discoverable,
  versioned, addressable.
- **Session/State Persistence & Lifecycle.** Full thread storage (messages, tool
  results, artifacts) with resume, rewind, fork. Sessions outlive harnesses.
  _Runtime status: partly implemented. Sessions and their events persist in
  Dolt, and `--session` resumes a session; rewind and fork are not
  implemented, and artifacts are not stored._
- **Inter-Agent Contracts & Capability Discovery.** Bilateral registration:
  agents advertise capabilities, agents declare needs, the substrate matches
  them. Per Section 1: the shared runtime event schema carries the audit and
  trace substrate; concrete discovery schema follows real producers and
  consumers.
- <!-- closure-claim: semantic-contract-behavior --> **Semantic contract
  packages.** Versioned, machine-readable statements of domain semantics under
  `contracts/`, validated by repository-owned code against synthetic fixtures.
  The first package (`contracts/workbench/first-product/v1/`) freezes
  first-product room, participant, agent, task, run, route, context, grant,
  lease, event, projection, receipt, label, claim-source, and authority
  semantics, and records what is explicitly deferred. Authorization is checked
  as effective rather than
  <!-- closure-claim: effective-event-authority --> declared — a named grant
  must resolve to its own author, a denied policy basis carries no authority, a
  conditional approval must be recorded no later than its first reliance, and a
  machine-authored `operator-direct` event resolves to a preceding human
  authorizing event for the same Task or Room. The validator rejects a false
  Task-envelope approval flag but does not yet attribute that flag to an
  approval event. <!-- closure-claim: receipt-reconciliation --> receipt fields
  are reconciled against the entities and transition history they describe,
  including that no receipt evidence may postdate the receipt's own commit
  sequence. A deterministic policy rejects an egress-capable grant acting
  through a Run on private, untrusted ContextPacket content without specific
  authorization. Within a declared event family, the first inline writer a
  corpus names establishes the package's cutover convention; later omitted or
  competing writers are rejected, but no separate writer-authority record is
  modeled. Run grants explicitly scope Task, Room, route, and any named
  provider; omitted grant scopes and RouteSpec components carry an explicit
  `not-applicable` or `opaque` disposition.
  <!-- closure-claim: closure-report-evidence --> Its generated closure report
  computes the 24-target, 61-invariant, and 31-probe evidence denominator from
  validator observations inside the aggregate gate.
  <!-- closure-claim: semantic-package-boundary --> These packages are a
  validation boundary: they define the contract later data-layer work consumes,
  they do not displace the canonical Dolt DDL (Layer 0 stance #4), and
  validating a document proves the document only. It grants no runtime authority
  and says nothing about how an implemented Workbench behaves.

### 6.3 Layer 2 - cross-cutting concerns

Touch every subsystem.

- **Observability.** OpenTelemetry metadata is mandatory on the event/message
  schema. Every step (context build → LLM call → tool exec → result injection)
  gets automatic spans plus full transcript. Sampling controls volume.
  _Runtime status: partly implemented. Every event row carries trace and span
  IDs, and MCP calls propagate W3C trace context; there is no OpenTelemetry
  SDK, span export, or sampling control._
- **Permissions / Policy Engine.** Identity and authz metadata mandatory on the
  core event schema. Dedicated policy engine intercepts every tool call before
  execution. Tiered rules (allow / ask / deny) keyed on tool, pattern, or risk.
  Sandboxing plus explicit human friction for high-risk actions. Per Section 1:
  model-supplied arguments are ignored during permission checks.
- **Cost & Budget Awareness.** First-class. Budgets per session, per day, per
  task, per user. Cost-aware model routing (operator-set default,
  envelope-governed spend). Hard stops for anomalies, soft confirmations at
  envelope boundaries. Already promoted to a Layer 0 stance (Section 1); the
  cross-cutting machinery here is what makes the stance real at runtime.
- **Eval & Regression.** Built-in benchmark harness. Capability tests,
  regression catches, model-comparison and prompt-comparison runs. Measurement
  is part of the work product, not a side artifact.
  _Runtime status: not implemented. The prototype has manual local-provider
  diagnostics (`deno task model-response-modes` and similar), not an eval
  harness._
- **Self-reflection / planning / review loops.** Built-in mechanisms for the
  agent to critique its own output, decompose subtasks, verify results, and
  recover from errors. _Runtime status: not implemented._

### 6.4 Layer 3 - runtime mechanisms

How things actually execute.

- **Streaming + interruptability + partial result handling.** Output streams.
  Users (and other agents) can interrupt mid-stream. Partial results are
  represented explicitly and can be resumed, inspected, or discarded.
  _Runtime status: partly implemented. Turns stream over the UDS seam and
  `turn/cancel` interrupts one; resuming a partial result is not implemented._
- **Checkpointing + transactional state.** Every meaningful state transition is
  checkpointed. Rollback is real, not aspirational. _Runtime status: not
  implemented; there is no checkpoint or rollback mechanism._
- **Time / async / scheduled action.** Cron-ness as a primitive: agents can take
  action on a schedule, watch for change, return async results, and reason about
  asymmetric time between themselves and the world. _Runtime status: not
  implemented; there is no scheduler or cron primitive._

---

## 7. How the primitives serve the goal

Every Layer 0 stance, every Layer 1 subsystem, and every Layer 2 cross-cutting
concern named above exists to make the automation substrate vendor-loose,
locally-capable, and cost-aware. The five Layer 0 stances carry the most
concentrated weight because they have the highest leverage on whether the
substrate works.

---

## 8. Topics worth longer treatment

Topics worth separate notes: Rust boundary, local inference and routing
defaults, cost visibility, immutable log vs. memory, and schema/data-layer
ownership.

---

## 9. Influences

Two systems shaped the _thinking_ behind this stack:

- A pre-existing end-user-owned AI stack first showed what a locally-owned AI
  stack could feel like in daily use.
- Sun's Jini introduced the concept of bilateral lookup, leasing, and
  capability/need matching as a substrate primitive. DYFJ borrows the _shape of
  the question_, not the protocol.

Called out as conceptual influences rather than implementation dependencies.

---

## 10. Near-term commitments

Things agreed to and evolving as work progresses.

- Extend the current static command registry toward the `register()` /
  `lookup()` runtime shape when real consumers need it.
- Extend Workbench veneer validation beyond the current CLI/UDS smoke paths as
  the surface grows.
- Continue the cost-visibility surface beyond the shipped preflight/receipt
  path: soft/hard budget UX and later daily-scope budget projection.
- Grow the Rust core only where components have stabilized enough to earn the
  boundary; the first schema tracer bullet is shipped.

---

## 11. Open items

Reserved space for new questions as they accumulate.

- Whether implementation-specific schema (e.g.
  tasks-synced-from-an-issue-tracker) should ever live in this canonical schema
  directory, or always stay in implementation overlays only.

---

## 12. Revision history

Document revisions only. Code and behavior changes are tracked in
[CHANGELOG.md](CHANGELOG.md).

- 2026-04-26 - Draft 1 from initial brain dump.
- 2026-04-27 - Draft 2: Non-goals added; Layer 0 stances stabilized at five;
  "schema in data layer" promoted into Layer 0; cost visibility promoted from
  cross-cutting concern to Layer 0 stance.
- 2026-04-27 - Draft 3: lineage framing stripped; Influences section added.
- 2026-04-27 - Restructured into an operating-context document; Decisions block
  (Section 1) authoritative.
- 2026-04-27 - Repo structured: TypeScript prototype in `prototype/`; Rust
  substrate at `core/`; schema/ at root as canonical, language-agnostic source
  of truth.
- 2026-04-27 - Section 4 Engineering posture added - tests + evals as stated
  practice.
- 2026-05-25 - Runtime clarified as Deno; Workbench tracer bullet owns the Deno
  task entrypoint; legacy router path closed; paid preflight, receipts, and
  event-sequence verification added.
- 2026-05-25 - Rust core tracer bullet shipped:
  `dyfj_core::events::{write, read_by_id}` plus demo and ignored live-Dolt
  integration tests.
- 2026-05-30 - Event authn metadata shipped; repo-native schema validation added
  with `deno task validate-schema` and `deno task test:schema`.
- 2026-06-04 - Workbench runtime split into a shared single-turn boundary with
  CLI/shell and local HTTP veneers; C4/D2 runtime diagrams added.
- 2026-06-12 - Remote-access posture documented (authenticated non-loopback
  interfaces); change tracking split out into CHANGELOG.md, leaving this section
  to document revisions.
- 2026-06-16 - Freshness pass: tagline reframed to optionality; Status updated
  for the `dyfj` CLI client, SSE streaming, the multi-step agent loop with
  read-only file tools, three hosted providers (Anthropic/OpenAI/Gemini), memory
  privacy-class scoping, and the prompts table; local default corrected to
  Qwen3-Coder-30B-A3B; hosted-inference section generalized across providers.
- 2026-06-21 - Transport seam documented: a duplex JSON-RPC 2.0 protocol over a
  Unix domain socket as the canonical loopback transport, the shared
  `turn-runner` core both transports run, and the `serve-unix` launcher +
  engine-free CLI-over-socket; Status, Repo layout, the Layer 1 runtime
  boundary, and Run-it updated to match (per the transport-seam decision,
  2026-06-21).
- 2026-06-30 - Schema refactored into a readable current baseline
  (`schema/current/`), mutable catalog seeds (`schema/catalog/`), forward
  migrations (`schema/migrations/`), and preserved replay history
  (`schema/history/`).
- 2026-07-03 - Cost posture revised: Layer 0 stance #2 rewritten from
  local-first-by-default with per-call paid escalation to operator-routed
  inference inside budget envelopes (per-session and per-day) with a
  runaway-anomaly hard stop; stance #1, Boundaries, the tagline, and the Layer 2
  cost/budget entry aligned. Local inference remains first-class and
  fail-closed; non-loopback transports remain fail-closed; unpriced models are
  not routable. Cost visibility is unchanged as a Layer 0 stance — the consent
  ceremony is demoted, not the accounting. Envelope enforcement is marked as
  in-progress runtime work.
- 2026-08-02 - Run-it configuration now documents the bounded Workbench
  tool-step limit and receipt visibility.
- 2026-08-03 - Validation commands now state that the default check covers both
  production and test import graphs.
- 2026-08-02 - Operator guidance now leads with the autostarting `dyfj`/UDS
  path, retains HTTP as an explicit supported server, and distinguishes
  boot-time secret pointers from standalone-process key projection.
- 2026-08-06 - The external-agent section now documents the bounded Codex ACP
  route requiring adapter-reported ChatGPT authentication, its profile-declared
  subscription classification, dedicated authentication home, fail-closed
  pre-session authentication-type verification, trust requirement, and evidence
  limits.
- 2026-08-08 - The external-agent section now documents profile-aware ACP
  session-update ceilings and the shared ingress/consumer enforcement boundary.
- 2026-08-09 - The external-agent section now documents the optional,
  operator-authorized Codex toolchain-directory projection and its count-only
  evidence.
- 2026-08-10 - The external-agent section now documents profile-aware ACP
  protocol-message ceilings and their independent containment boundaries.
- 2026-08-12 - Validation guidance now documents the aggregate gate's
  selected-Deno executable authority.
- 2026-08-12 - The external-agent section now documents exact operator selection
  from bounded ACP permission options and its fail-closed terminal defaults.
- 2026-08-20 - Sequential ACP turns that share a Workbench session, workspace,
  and execution profile reuse one live worker and ACP session. Concurrent
  same-session work fails as busy. Turn cancellation keeps a healthy handle;
  protocol or process failure replaces it. Idle sessions retire on a TTL and
  capacity fails closed without eviction. UDS close, SIGINT, and `dyfj stop`
  wait for in-flight creation and for every started close to settle, then
  surface a retained close failure. A shutdown failure exits with status 1.
  Standalone HTTP has no close hook; idle TTL and process exit retire those
  handles.
- 2026-08-22 - The terminal client now keeps ACP activity visible through
  completion, renders bounded richer streaming Markdown, and displays optional
  ACP token/context/cumulative-cost evidence without treating it as native
  accounting.
- 2026-08-19 - Validation guidance now says survivor discovery is not matched by
  generic process name.
- 2026-08-19 - Validation guidance now documents required run-generation for
  saved Vitest group signaling, spawn-manifest identity before PID kill
  authority, and malformed-lock recovery that does not signal saved groups.
- 2026-08-19 - Validation guidance now documents fail-closed Vitest group
  recovery when the saved leader is gone or identity metadata does not match the
  recovering run.
- 2026-08-19 - Validation guidance now documents operator-scoped exclusive
  Vitest locking, run-scoped survivor cleanup, and next-run recovery of a saved
  Vitest process group.
- 2026-08-18 - The CLI/UDS turn path now documents ephemeral ACP progress
  indication on an interactive TTY spinner. Raw thought text is not a display or
  history surface.
- 2026-08-18 - Validation guidance now documents exclusive, wall-clock-bounded
  prototype Vitest runs and zero-survivor reaping of test runtimes.
- 2026-08-27 - Dropped remaining current-state HTTP server, Workbench shell, and
  workbench API-key claims from operating docs. MCP
  `minimum_clearance = "remote"` remains a policy value reserved for a future
  gateway client, not a shipped remote transport.
- 2026-08-29 - Validation guidance now documents the stable deterministic policy
  checks (subject binding and digest recomputation, tree/diff secret scans,
  public-boundary scan, whitespace/Markdown/shell range checks, dependency
  policy, receipt-schema validator), the value-free `gate-status` line, the
  `test:fast` local-feedback subset, the pinned-toolchain clean-checkout CI run
  under the stable `full-gate` check name, and the boundary that a green
  pipeline gate grants no runtime capability and claims nothing about private
  gates.
- 2026-08-31 - The external-agent section now documents ACP turn continuity:
  bounded reconstruction of a session's own prior turns into a replacement
  native session, prior tool work carried as labelled non-executable historical
  evidence with its pairing and outcome status, the `new` / `warm-reused` /
  `durably-resumed` / `reconstructed` states recorded on the runner receipt with
  projection counts and prior and new external session identifiers, and the
  fail-closed limits on what a reconstruction may carry.
- 2026-08-29 - Validation guidance now documents that the tree scans carry no
  allowlist and no path exemption (tests, binary-looking payloads, and the
  scanner source included), that tracked symlinks are scanned as link-target
  text rather than followed, and that the `gate-status` line is a bounded
  diagnostic, not an assurance receipt.
- 2026-08-30 - Repo layout and Layer 1 now describe `contracts/`: versioned
  semantic contract packages that state domain and authority semantics and are
  validated by repository-owned code, without displacing the canonical Dolt DDL
  or granting runtime authority. Layer 1 records that authorization in those
  packages is checked as effective rather than declared, and that receipt fields
  are reconciled against the history they describe.
- 2026-08-30 - Layer 1's contract-package entry now names the agent surface
  explicitly and records the corrected boundary: approval ordering before
  reliance, receipt evidence that may never postdate its own commit, the
  deterministic private-and-untrusted-and-egress grant policy, and sole-writer
  authority per event family and cutover.
- 2026-09-03 - The first-product semantic-package boundary, effective event
  authority, and receipt reconciliation claims were brought current with the
  executable closure evidence surface.
- 2026-09-03 - The run-it and transport sections now document the REPL friction
  capture command, its narrow UDS method, configurable checkpoint, and retained
  external-MCP authorization boundary.
- 2026-09-08 - The external-agent continuation section now documents per-record
  persisted tool-evidence withholding, immutable-event omission notices,
  whole-history and selected-window counts, native companion and ACP notice
  scope, the narrowed syntactic refusal conditions, and the unchanged final
  prompt-size and acquired-handle lifecycle.
- 2026-09-08 - The configured external-MCP section now documents native-runner
  bounded Linear issue creation: fixed team/project IDs, local input limits,
  per-call approval, schema/response validation, identifier-only receipts,
  reconciliation-required ambiguity, and the ACP and `/idea` deferrals.
- 2026-09-12 - Clarified approval and relation-validation ordering and rejection
  of malformed association ID evidence for native Linear issue creation.
- 2026-09-15 - Status corrected: the agent loop's workspace file tools are no
  longer read-only, and the loop now carries an approval-gated `bash` escape
  hatch and a bounded `git` tool limited to status, diff, log, add and commit.
- 2026-09-25 - Restructuring specifications added under `specs/`: baseline
  findings, target architecture, data layer, test architecture, phase-1 PRDs,
  and sequenced agent work orders. README §4 testing bullets are superseded by
  `specs/03-testing.md` §1 once its first work order lands.
- 2026-09-25 - AGENTS.md engineering doctrine replaced (module graph acyclic
  with named exceptions, runtime ownership as a tree, single writer per piece of
  state, the event log as the write path); Section 1 now marks the
  log-as-ground-truth decision with its current runtime status; specs updated
  to match, including an event-first data layer and the Rust boundary at the
  JSON-RPC seam.
- 2026-09-26 - `specs/README.md` gains a structure-and-terminology section:
  the authority chain from Section 1 down to work orders, artifact types,
  phases, numbering conventions, and the rule that a work order conflicting
  with a higher document stops for a recorded decision rather than deviating.
- 2026-09-26 - AGENTS.md tracker-ID rule scoped rather than absolute: IDs are
  allowed in branch names, commits, and PRs so the tracker's GitHub integration
  can link work, stay out of code, docs, `CHANGELOG.md`, and `specs/`, and
  never replace a public-safe explanation of the why.
- 2026-09-26 - AGENTS.md adds two safeguards: security-shaped findings stay in
  the private tracker until fixed, and agents take instructions only from
  AGENTS.md, README Section 1, and `specs/` on the default branch, with
  `.github/CODEOWNERS` requiring maintainer review of those files.
- 2026-09-26 - Specs aligned with the privately tracked product roadmap: work
  orders are enablers that state the capability they enable; the ACP lane is
  deferred rather than retired; the log-as-ground-truth PRD and the phase-2
  outline are withdrawn in favor of roadmap work; the contract package is open
  to roadmap contract work; the interactive REPL moves to a separate client.
- 2026-09-26 - Section 4 testing bullets revised to the doctrine in
  `specs/03-testing.md` §1 (fakes at declared ports, conformance-proven fakes,
  loopback fakes for third-party services, golden tests pinning behavior);
  validation guidance documents the golden characterization lane.
- 2026-09-26 - Section 4 notes where shared fakes live and that new tests use
  `Deno.test`; the validation notes describe the glob-derived typecheck lists
  and the `test.unit` lane.
- 2026-09-26 - Test spec freshened: conformance suites land with their ports
  (decision D24), and the sanitizer rule names the explicit flags the pinned
  Deno requires instead of calling them the default.
- 2026-09-26 - Validation guidance now documents the `arch.imports` gate lane:
  the layer mapping, the ratchet baseline that may only shrink, the named-cycle
  allow-list, and the non-failing deep-import and size reports.
- 2026-09-26 - WO-02's acceptance now counts three baseline cycles, matching the
  three listed in `specs/00-baseline-findings.md` and the tree; "four" was a
  miscount introduced when the ACP cycle was reinstated.
- 2026-09-27 - Specs decision D25 replaces D3's "TypeScript only" wording: phase
  1 changes only the TypeScript tier, TypeScript is the temporary tier under
  Layer 0 stance #3, and no enabler may make moving a stabilized component to
  Rust harder.
- 2026-09-27 - `specs/01-architecture.md` §3 names `workspaceRootForTransport`
  in the `contract/` row, where WO-08 placed it as trust-boundary policy.
- 2026-09-27 - Docs drift corrected against the code: Ollama `qwen3.6:35b-a3b`
  is the local default and xAI is listed among hosted providers; the retired
  HTTP engine is gone from the tool-step and config text; a fresh database
  applies the baseline and catalogs only; the UDS method list, `/idea` and
  `/packet`, and `web_search`/`web_fetch` are documented; the macOS gate job is
  named; Section 6 items carry runtime-status notes; the stale D2 flow diagram
  is removed in favor of the C4 workspace.
- 2026-09-27 - Architecture spec §3 moves error summarizing from the `kernel/`
  (L0) row to the `contract/` (L1) row: deciding which error messages cross the
  wire as trusted is trust-boundary policy, not a policy-free helper.
- 2026-09-27 - Repo layout and Build the core describe `core/` as a Cargo
  workspace with the `dyfj-repl` front-end, and how to run it.
- 2026-09-27 - Specs decision D26 records the REPL-client exception to D25:
  the existing `dyfj-core` source stays untouched in phase 1, and the D23 REPL
  client `core/dyfj-repl` is the one phase-1 addition to `core/`. D25 is marked
  superseded in part; architecture §1 cites both.
- 2026-09-27 - Validation guidance now documents the `arch.imports` rules that
  confine `mysql2` to `prototype/src/store/` and SQL write statements to the
  store's journal, and the existing environment rules: direct environment
  access only in `config/` and the tooling, and every `DYFJ_*` key declared.
- 2026-09-27 - Schema apply order stated as one rule in §5 and the schema
  READMEs: a fresh install applies `current/` then `catalog/`; an existing
  database replays forward through `migrations/` on top of `history/`. The
  validation guidance documents the `schema.codegen` and `schema.equivalence`
  gate lanes, and §5 the engine's boot-time column check.
- 2026-09-27 - `specs/recipes/add-provider.md` added: adding a provider on an
  existing API family is a catalog/pricing migration plus, for a hosted one, a
  host pin; a new API family is one adapter directory, one registry line, and
  the provider conformance kit. `specs/03-testing.md` §4 points the loopback
  base-URL rule at its new home in `prototype/src/providers/`.
- 2026-09-27 - Specs decision D27 records the provider-dispatch contract as
  built: the registry looks adapters up by the catalog `provider` column, and
  `ProviderIO` carries `env` and a monotonic clock. Architecture §5.2 and the
  add-provider recipe updated to match.
- 2026-09-28 - `specs/recipes/add-tool.md` added: a tool served by an MCP
  server needs only configuration; a builtin tool is one module exporting its
  `define<Name>` beside its executor, one `BUILTIN_TOOLS` line, and the tool
  conformance kit. `specs/01-architecture.md` §5.4 now names where the tool
  builders and the catalog builder live, and `specs/bug-log.md` records five
  findings from the move and its review.
- 2026-09-28 - `specs/bug-log.md` records two findings from extracting route
  resolution and the observed provider call into `prototype/src/engine/`: the
  swallowed model-registry load failure in route resolution, and the unparsed
  tool-call markup counts missing from compression `provider_call` rows.
- 2026-09-28 - Hosted-provider keys: §5 states that each key is sent only to
  its provider's own https host with redirects refused.
  `specs/recipes/add-provider.md` documents the Anthropic and Gemini host and
  path contracts and the rule to encode catalog values placed in a request
  URL, and it and `specs/03-testing.md` §5 add the off-host base-URL and
  redirect-response cases to the provider conformance kit.
- 2026-09-28 - `specs/01-architecture.md` §5.6 adds the `DnsResolver` port and
  `specs/03-testing.md` §3 its `ScriptedDnsResolver` fake and conformance
  suite. The web tools section now states that `web_fetch` refuses a target
  it cannot verify as public, and that `dyfj start` and `deno task serve-unix`
  grant the engine the system nameservers for the lookups.
- 2026-09-28 - Layer 1 runtime boundary names the engine's turn entry
  (`prototype/src/engine/turn.ts`), which replaces `turn-runner`.
- 2026-09-28 - `specs/bug-log.md` records that `model_selected` names the
  environment's principal rather than the turn's, found extracting the
  `budgetGate` stage.
- 2026-09-29 - Prototype setup enables the repository's git hooks
  (`git config core.hooksPath .githooks`).
- 2026-09-29 - `specs/01-architecture.md` §6 settles the Extension interface's
  `rpc` return type (`RpcHandlers`), that no extension imports another or
  `server/`, and that `ideas` and `packets` share `extensions/ideas/` and one
  factory because they share one registry; §3 places the RPC parameter
  sanitizers in `transport/`. The bug-log entry on ideas and packets being
  lost on restart points at their new location.
- 2026-09-29 - `specs/01-architecture.md` §6 records what `ExtensionDeps`
  carries (the session readers, the Linear commands, the tool approver), that
  Linear issue creation enters through the MCP discovery port rather than
  `commands`, and that the `arch.imports` lane now enforces that only
  `server/` and `cli/` import `extensions/`.
- 2026-09-29 - The remote-gate description covers manual `workflow_dispatch`
  runs and their required `range_base` input.
- 2026-09-30 - `specs/notes/test-supervision-evidence.md` records, per leak
  class, what the `Deno.test` suite catches without the Vitest supervisor, and
  the approved decision: keep the wall-clock bound, as a per-lane deadline in
  the gate with a backstop in each test-lane runner; move the end-of-run
  process-group stop into those runners and saved-group recovery into the gate;
  and remove the lock, the detached reaper and the manifest sweep.
- 2026-09-30 - `specs/notes/test-supervision-evidence.md` corrects its list of
  what integration-lane sanitizers flag: the Unix-connection leaks were a product
  leak, since fixed, and the secrets-resolver timeout case, which leaks by
  design, was missing.
- 2026-09-30 - Engineering posture names `Deno.test` as the only test
  framework, and the gate description drops the retired unit-suite lane and its
  supervisor, finds integration files by name with sanitizers on, and states
  that the lanes have no wall-clock bound yet.
- 2026-09-30 - The gate description covers the test lanes' deadlines, the
  runners' token carrier, own-group stop and backstop, and the gate's recovery of an orphaned
  lane group, replacing the note that the lanes had no bound yet.
- 2026-09-30 - The gate description states that a failing lane no longer stops
  the gate: every lane runs, the failed lanes are listed, and the exit code is
  the first failing lane's; a run interrupted after a failure reads
  `interrupted`.
- 2026-09-30 - `specs/01-architecture.md` §5.7 lists the file tools' root
  anchors and the regex worker's URL among the module-level state moved under
  an owner, and `specs/bug-log.md` records the root-anchor entry as fixed.
- 2026-09-30 - The `arch.imports` description and `specs/01-architecture.md` §4
  state that the PRD-11 R2 size limits now fail the lane, with the committed
  exceptions file and its only-shrink rule; `specs/README.md` records decision
  D28, the phase-1 exit deferrals those exceptions and the exit audit cite.
- 2026-09-30 - Repo layout and §6.2 "Workbench runtime boundary" describe the
  layered `prototype/src/` directory architecture: the layers and what each
  holds, the modules not yet moved, the single composition root, the staged
  turn pipeline, single-writer session ownership, the one store mutation path
  and the Extension boundary. Repo layout adds `specs/` and `scripts/`, and
  Status (with `prototype/README.md`) states that the standalone workbench CLI
  and its `start` / `workbench` tasks are removed.
- 2026-10-01 - `specs/README.md` records the phase-1 exit audit: every PRD-10 to
  PRD-14 requirement and success metric with its measured value and verdict,
  the deferrals under D20, D23 and D28, and the findings at exit.
- 2026-10-01 - AGENTS.md drops its "Restructuring in progress" section: phase 1
  has exited (`specs/README.md`, Phase-1 exit), and `specs/` stays listed under
  Instruction Sources.
- 2026-10-02 - Repo layout lists only the ACP runner and the interactive REPL as
  modules not yet moved, and names `prototype/diagnostics/`; the `arch.imports`
  description no longer says that directory is yet to exist.
- 2026-10-02 - The `[secrets]` section says how a runtime that started with a
  pointer unavailable reports it (`runtime/status`, `dyfj status`, the Rust
  REPL's startup lines) and that recovery is a restart.
- 2026-10-02 - The Rust REPL description lists what it now covers (the per-turn
  receipt line and the `/model`, `/fast`, `/session`, `/friction` and `/idea`
  commands) and no longer says those stay in the TypeScript CLI.
- 2026-10-02 - Section 1's done-line names the one route daily use is measured
  on, hosted inference over an OpenAI-compatible provider with OpenRouter as its
  default provider, selected by configuration rather than as the bare-turn
  default, and `specs/README.md` records decision D29, which defers the
  external-agent (ACP) routes from the route plan and supersedes that part of
  D20.
- 2026-10-02 - The interactive-terminal section says a bare `dyfj` now opens the
  Rust REPL when it can, and how `DYFJ_REPL` and `DYFJ_REPL_BIN` choose or
  require a front end.
- 2026-10-03 - The runtime-boundary section links a headless consumer contract
  that separates existing native-turn ports from proposed host, context and
  deployment decisions; the specs index identifies it as exploratory.
- 2026-10-03 - `specs/README.md` records, beside the phase-1 exit measures,
  that the D28 code splits have landed: no D28 entry remains in
  `scripts/arch-size-exceptions.json`, and PRD-11 R2 and the largest-file
  metric are met outside the D20 and D23 exceptions.
- 2026-10-03 - The local-default section says a catalog row set inactive stays
  out of routing even when Workbench has a built-in row for that model.
- 2026-10-03 - The local default is now DeepSeek-R1 Distill 32B served by
  llama.cpp's `llama-server` on port 8080; the prerequisites, run instructions
  and provider check say how to start it, and that Ollama users select the
  Ollama row explicitly.
- 2026-10-03 - `specs/03-testing.md` and the testing section of
  `prototype/README.md` list only the shared fakes that exist and exempt
  `SequentialIds` from a conformance suite until its port lands; PRD-14 R2
  states the exemption, and `specs/README.md` records R2 as met since exit
  except `FakeIo`, whose suite stays deferred.
