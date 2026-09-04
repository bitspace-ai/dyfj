# DYFJ

An operator-owned AI workbench and automation framework built for optionality —
you choose where each task runs, local or hosted, with cost visible while work
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

- `core/` - Rust substrate. Contains the first schema tracer bullet: a small
  event read/write library plus a demo binary that round-trips an event through
  Dolt. Where stabilized components live.
- `prototype/` - TypeScript on Deno. Real working code (Workbench CLI, the
  JSON-RPC/UDS transport seam, an ACP client foundation, memory, budget, MCP
  server, tests, and provider diagnostics). The active prototyping surface.
  Components either move down into `core/` as they stabilize or stay here as
  fast-moving prototype code.
- `schema/` - Dolt DDL. Canonical data model. Language-agnostic source of truth.
- `CHANGELOG.md` - dated change tracking in
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style.
- `LICENSE` - MIT.

The split between `core/` and `prototype/` is a permanent two-tier structure
where the Rust line advances downward as components stabilize. See Layer 0
stance #3 below.

## Status

Early and active. The prototype is functional - the `dyfj` CLI (REPL and
one-shot) over a duplex JSON-RPC 2.0 Unix-socket seam (the canonical loopback
transport), shared single-turn runtime boundary, a multi-step agent loop
(iterating model↔tools with read-only workspace file tools), an operator-routed
provider path with local models plus hosted providers (Anthropic, OpenAI,
OpenRouter, and Google Gemini) behind paid-approval and budget controls, and a
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
  they're not yet ready. Integration tests run against real dependencies (a real
  Dolt instance, real model APIs in CI when relevant), not mocks. Mocks are
  reserved for things that don't exist yet (failure modes we haven't observed,
  third-party services we haven't integrated).
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
- [MLX-LM](https://github.com/ml-explore/mlx-lm) for the Apple silicon local
  default, or [Ollama](https://ollama.com) as a supported local fallback
- _(Optional, for `core/`)_ [`rustup`](https://rustup.rs/) - the toolchain pin
  in `core/rust-toolchain.toml` will install the right Rust automatically when
  you `cargo build` there.

### Set up the prototype

```sh
git clone https://github.com/bitspace-ai/dyfj
cd dyfj/prototype
deno install
cp .env.example .env
```

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

For the Apple silicon local default, run an OpenAI-compatible MLX-LM Server:

```sh
mlx_lm.server \
  --model mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit \
  --host 127.0.0.1 \
  --port 18080
```

Workbench uses `http://127.0.0.1:18080/v1` for that local MLX endpoint. Ollama
remains a supported local fallback; pass `--model laguna-xs.2` or set
`DYFJ_WORKBENCH_MODEL=laguna-xs.2` to select the Ollama fallback explicitly.

Agent-tool turns default to 32 steps. Every entrypoint accepts
`DYFJ_MAX_TOOL_STEPS`; served HTTP and UDS engines also load
`[agent].max_tool_steps` from `~/.dyfj/config.toml`. Values are integers from 1
through 64, and the environment value takes precedence for served engines. The
final receipt reports `Tool steps: used/limit` and marks when the configured
limit ended tool use.

The REPL's `/friction <sev> [--escaped] <text...>` command posts one numbered
entry to the daily-driver checkpoint through the configured Linear MCP read and
write tools. The narrow UDS `friction/post` method retains their existing
authorization: the read follows configured-external read policy and the comment
write still asks for operator approval. Set `DYFJ_FRICTION_ISSUE_ID` on the
runtime to identify the operator's friction-checkpoint issue; `/friction` fails
at the `configuration` stage when the variable is unset or blank.

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
(`XAI_API_KEY`). The **pointer** mechanism keeps secret values off the config
file: for a declared secret env var you write a `[secrets.pointers]` _pointer_
(an `op://` ref, etc.), never the value, and it is resolved at process start.
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
unaffected.

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
for dir in ../../schema/current ../../schema/catalog ../../schema/migrations; do
    find "$dir" -maxdepth 1 -name '*.sql' | sort | while read -r f; do
        dolt sql < "$f"
    done
done
dolt sql-server --host 127.0.0.1 --port 3306 &
cd ../..
```

The `data/` directory is gitignored.

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

The seam exposes read methods for `runtime/status`, `surface/snapshot`,
`models/list`, `sessions/list`, `events/query`, `tools/list`, and
`tools/inspect`, the narrow operator-approved `friction/post` method, plus
streaming `turn` and cancellation `turn/cancel` methods
(intermediate text deltas and runtime events arrive as `stream` notifications;
the receipt is the result). `runtime/status` returns both the simple method id
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
evidence as unavailable, and a later reconstruction refuses that session before
model work. Persisted prior tool work is carried as historical evidence, not as
a tool grant: each request and its persisted result are quoted line by line under
labelled headers that keep their pairing, ordering, and outcome status
(including failures and denials); identifiers and names are restricted to an
inert ASCII metadata grammar, and the header tells the receiving agent that the
records are Workbench's history of an expired session, not actions it took or
may repeat. Quotation prevents historical content from forging the record
structure; it is not a semantic prompt-injection boundary, so ordinary tool
permission policy remains authoritative for anything the receiving agent may
propose. A reconstruction is refused before any prompt reaches the agent —
rather than silently shortened, reordered, or stripped — when it would exceed
the ACP prompt limit, the 32-message projection bound, a per-message bound, a
per-field tool bound, or the tool-argument depth/node limit, or when persisted
tool history is unpaired, malformed, or carries one of the explicitly checked
credential shapes in any field, including the explicit ACP gap marker. Idle
handles retire on a TTL, a small
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

The project configuration pins adapter version `1.1.10` exactly, and the Deno
lockfile records its transitive graph and registry integrity. The runtime reads
the installed package metadata and rejects metadata that does not declare
version `1.1.10`.

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
deno task test:fast       # policy checks + source typecheck, for local feedback
deno task check           # strict typecheck of production and test import graphs
deno task test:schema
deno task validate-schema
deno task verify-workbench-events
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
and interruption is reported distinctly from failure. The `gate-status` line is
a bounded diagnostic of this run's checks, not an assurance receipt, and
validating the receipt schema generates no receipt. These are pipeline assurance
checks for this repository only: a green gate grants no Workbench runtime
capability and claims no remote review, acceptance testing, or publication —
private gates (disclosure review, independent model review, operator acceptance)
remain outside this repository.

After the policy checks, the gate runs the retired-surface scan, the source and
recursive test-file typechecks, the prototype unit suite, current and historical
schema checks, non-ignored Rust tests using offline SQLx metadata and no
inherited `DATABASE_URL`, and an isolated-Dolt integration lane (including UDS
and MCP round trips). The task resolves the Deno executable selected for the
invocation and uses that same absolute command identity for each nested Deno
lane and permission grant. The prototype Vitest lane is exclusive and bounded:
one operator-scoped lock (`$HOME/.dyfj/run/dyfj-vitest-run.lock`) refuses a
second run while a prior `run-vitest` PID is still alive, including across
checkouts. A hang fails `DYFJ_TEST_BOUND_SEC` (default 600s, or 180s when the
args name a test file or `-t` pattern). Leftover fixture children, launcher
supervisors, `serve-unix` processes bound to test sockets, `.vitest-tmp`
sockets, and run-scoped `start-test-runtime-*.lock` files are reaped after the
suite exits or the runner dies. Cleanup matches this run's tmp dir, spawn
manifest, and explicit command needles — not matched by generic process name.
SIGTERM/SIGINT to the supervisor, SIGKILL of Vitest, and SIGKILL of the
supervisor (sibling reaper) are covered; SIGKILL of the supervisor and reaper
together is recovered by the next run, which reaps the saved Vitest process
group only when a recovering run generation is supplied and the recorded
recovery directory, run generation, leader start time, and command still match.
Malformed-lock recovery does not signal a saved process group because no
generation can be recovered. A spawn-manifest PID is not kill authority unless
that record carries matching start time, command, recovery directory, and run
generation; incomplete records fail closed for process signaling while file
cleanup stays run-scoped. If the saved leader is gone, that numeric group is
left alive; descendants whose command names this run's tmp dir are still reaped
by run-scoped discovery. Supervised runs fail closed without an absolute `HOME`
rather than falling back to a checkout-local lock. The integration lane owns a
temporary Dolt repository and SQL server, with cleanup on normal completion and
handled failure. SIGINT and SIGTERM request cooperative cancellation; the direct
lane process receives SIGTERM followed by a bounded wait and possible SIGKILL.
The Rust tracer test retains its manual-run `.env` loader, but the fixture's
explicit `DATABASE_URL` takes precedence, so the lane does not use the
operator's Dolt database. It requires Deno, Dolt, and the pinned Rust toolchain.

The same aggregate command runs remotely: a GitHub Actions workflow
(`.github/workflows/gate.yml`) executes `deno task test` from a clean checkout
on pull requests and pushes to `main`, with a read-only token, no secrets, and
the subject/range binding described above. Its stable check name, `full-gate`,
is the intended branch-protection required check. The workflow pins its one
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
`deno task test:fast` runs every deterministic policy check plus the source
typecheck, reusing the production lane definitions verbatim for quick local
feedback; it is a convenience, not the green bar — `deno task test`, locally or
in CI, remains the single full gate. Remote CI is authoritative only for the
public deterministic checks it runs.

Before treating a Workbench model failure as a DYFJ problem, validate that the
selected local provider can actually generate, not just report health. For
MLX-LM Server:

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

Today the binary is the Rust schema tracer bullet: it inserts a `session_start`
event through `dyfj_core::events::write()`, reads it back with
`events::read_by_id()`, and verifies equality. The ignored integration tests
exercise the same path when a live Dolt server is available:

```sh
cargo test -- --ignored
```

For a DB-free Rust compile/test pass using the committed `.sqlx/` cache:

```sh
SQLX_OFFLINE=true cargo test
```

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
- **Workbench runtime boundary.** Shared single-turn runtime invoked by the
  `dyfj` CLI over the JSON-RPC/UDS seam — every transport runs the identical
  turn through one shared core (`turn-runner`), not a per-transport copy.
  Presentation layers pass inputs and render results; the runtime owns model
  routing, command/tool execution, session/event writes, budget tracking, and
  receipt facts.
- **Tool Registry & Dynamic Dispatch.** MCP-native. Tools are discoverable,
  versioned, addressable.
- **Session/State Persistence & Lifecycle.** Full thread storage (messages, tool
  results, artifacts) with resume, rewind, fork. Sessions outlive harnesses.
- **Inter-Agent Contracts & Capability Discovery.** Bilateral registration:
  agents advertise capabilities, agents declare needs, the substrate matches
  them. Per Section 1: the shared runtime event schema carries the audit and
  trace substrate; concrete discovery schema follows real producers and
  consumers.

### 6.3 Layer 2 - cross-cutting concerns

Touch every subsystem.

- **Observability.** OpenTelemetry metadata is mandatory on the event/message
  schema. Every step (context build → LLM call → tool exec → result injection)
  gets automatic spans plus full transcript. Sampling controls volume.
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
- **Self-reflection / planning / review loops.** Built-in mechanisms for the
  agent to critique its own output, decompose subtasks, verify results, and
  recover from errors.

### 6.4 Layer 3 - runtime mechanisms

How things actually execute.

- **Streaming + interruptability + partial result handling.** Output streams.
  Users (and other agents) can interrupt mid-stream. Partial results are
  represented explicitly and can be resumed, inspected, or discarded.
- **Checkpointing + transactional state.** Every meaningful state transition is
  checkpointed. Rollback is real, not aspirational.
- **Time / async / scheduled action.** Cron-ness as a primitive: agents can take
  action on a schedule, watch for change, return async results, and reason about
  asymmetric time between themselves and the world.

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
- 2026-09-03 - The run-it and transport sections now document the REPL friction
  capture command, its narrow UDS method, configurable checkpoint, and retained
  external-MCP authorization boundary.
