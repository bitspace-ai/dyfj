# DYFJ Prototype (TypeScript on Deno)

This is the TypeScript prototype layer of DYFJ.

This layer contains working prototype code for Workbench CLI, the JSON-RPC/UDS transport seam, shared runtime execution, a local ACP-client foundation, memory, command routing, provider routing, budget tracking, session persistence, MCP, and tests. Stabilized components can move into `../core/` when the Rust boundary is worth the extra compile-time structure.

If you want to understand DYFJ's stance on why prototype-and-substrate coexist in the same repo, read the project README at the repo root, especially the Layer 0 stance on Rust as a moving boundary.

## Run it

You'll need [Deno](https://deno.com) 2.9+.

```sh
deno install
deno task compile-cli
./dist/dyfj
```

The bare `dyfj` invocation is the daily-driver path. It connects to the local
Unix-socket runtime and opens the streaming REPL; if no runtime answers, the
launcher starts one in the background and waits for it. Use `dyfj exec
"<prompt>"` for a one-shot turn, `dyfj status` to inspect the local runtime, or
`dyfj start` when you explicitly want to foreground the runtime. Put `dist/` on
your `PATH` to use `dyfj` without the `./dist/` prefix.

The local default is the Ollama model `qwen3.6:35b-a3b`, reached through Ollama's OpenAI-compatible endpoint:

```sh
ollama pull qwen3.6:35b-a3b
```

The catalog also carries MLX-LM Server rows (`mlx_lm.server` on `http://127.0.0.1:18080/v1`); they ship inactive, so set a row's `active` flag in the `models` table before selecting it with `--model`.

Agent-tool turns default to 32 steps. Every entrypoint accepts `DYFJ_MAX_TOOL_STEPS`; the UDS engine also loads `[agent].max_tool_steps` from `~/.dyfj/config.toml`. Values are integers from 1 through 64, and the environment value takes precedence. The final receipt reports `Tool steps: used/limit` and marks when the configured limit ended tool use.

With no configured companion default, a bare turn uses the registry's local
default. The operator can instead configure a hosted companion default or
select a hosted model listed by `dyfj models`. Paid inference requires approval
on a loopback session through `--approve-paid`, `/model <slug> --approve-paid`,
or the standing `[paid].approve_paid_default` posture. Ordinary approved calls
inside the configured budget envelopes run without another budget prompt;
ceiling crossings require confirmation, the runaway-anomaly hard stops remain
separate, and non-loopback callers fail closed. Every call is receipted with
cost and prompt-cache telemetry.

Each hosted provider fails closed without its credential. The recommended
credential posture is to declare pointers under `[secrets.pointers]` in
`~/.dyfj/config.toml`; `dyfj start` resolves them into the runtime environment at
boot, without storing secret values in the config file. An already-set env var
wins. See the root README's "Hosted inference" section for the resolver shape,
isolation, and fail-closed behavior.

Configured external MCP tools join the same session-first resolution batch but
use a separate `[secrets.named]` map. A successful probe lets the bounded
followers run; a generic resolver is not guaranteed to share authentication
between subprocesses. Named credentials remain in memory and are not projected
into environment variables. `[[mcp.servers]]` currently accepts only strict MCP
`2026-07-28` Streamable HTTP servers with bearer authentication. Each registered
tool must be both discovered and named in the server's configured `tools`
allowlist. Read tools may be configured with `approval = "allow"`; every
`write_external` tool requires `approval = "ask"`. Set
`minimum_clearance = "loopback"` to withhold a server's tools from remote-clearance turns,
or `"remote"` to declare eligibility on both transport clearances. The current
boot integration is the UDS daily-driver runtime. Use `dyfj start` so the launcher
can derive the configured host grants. The complete configuration, trust,
result-framing, and receipt-redaction contract is in the root README under
"Configured external MCP tools."

Both `save_issue` and legacy `create_issue` are reserved across configured servers.
Configure exactly one with the Linear binding; search/fetch mappings are rejected.
Both expose only local `mcp.<server>.create_issue`. Calls to `save_issue` omit `id`,
patches and template fields, so this binding grants creation only. Boot diagnostics give fixed withholding reasons for a missing
binding, missing discovered tool, or unsupported schema. The native runner
exposes it
only when that server also has a valid loopback-only `linear_issue_creation`
binding with one fixed team ID and an exact project-name-to-ID allowlist. Local
validation requires title, description, project, and priority; related issue
identifiers are optional. Description length is at most 16,000 UTF-16 code units.
Schema validation precedes approval, with relation count checked before individual
items; distinctness is checked after approval but before any connector call. For valid arguments, the connector
receives configured IDs, never a model-selected team
or project ID. Each connector write requires operator approval. A validated success returns and
persists only the issue identifier; transport or response ambiguity is not
retried and requires reconciliation. Bare ACP sessions, a REPL command, and an
`/idea` file workflow are not part of this surface. See the root README for the
configuration and exact local limits.

The operator commands are:

```sh
dyfj                      # streaming multi-turn REPL; autostarts the runtime
dyfj exec "Summarize this repository"
dyfj --model codex-chatgpt/gpt-5.6-terra --approve-paid --fast exec "Fast one-shot turn"
dyfj --runner fixture exec "Exercise the local ACP fixture"
dyfj --runner codex-chatgpt --approve-paid exec "Inspect this repository"
dyfj status
dyfj stop
dyfj models
dyfj sessions
```

Inside the REPL, `/session` prints the current session id, `/model` shows or
switches the active model (with optional `--fast` or `--no-fast`), `/fast [on|off]`
toggles the fast speed tier for supported models,
`/friction <sev> [--escaped] <text...>` posts a numbered daily-driver friction
entry through the configured Linear MCP tools, and `/quit` or `/exit` quits
cleanly. `/idea mark|list|show` marks and reviews candidate ideas for the
session, and `/packet draft|list|show` drafts work packets from them; both are
held in the runtime's memory only (see the root README's UDS method notes).
`/friction last` shows only the last successfully posted receipt from
the current REPL. Its posted `Context:` line contains exactly the model slug,
workspace basename, and previous slash command when one exists; the slash
command is capped at 120 characters with a visible `…` marker, and free-text
prompts and absolute workspace paths are never posted.

The HTTP peer server is retired. UDS JSON-RPC is the only seam (`deno task serve-unix` / `dyfj`); a remote or browser surface returns later as a thin gateway client of that seam.

The launcher's background runtime and `dyfj start` both serve the JSON-RPC seam
over a Unix domain socket, the canonical `loopback` transport. For direct
development use, the equivalent engine task is:

```sh
deno task serve-unix
```

It serves a duplex JSON-RPC 2.0 protocol — read methods for `runtime/liveness`,
`runtime/status`, `surface/snapshot`, `models/list`, `sessions/list`,
`sessions/inspect`, `events/query`, `ideas/list`, `ideas/get`, `packets/list`,
`packets/get`, `tools/list`, and `tools/inspect`; `runtime/stop`; the narrow
operator-approved `friction/post` method; `ideas/mark` and `packets/draft`; plus
streaming `turn` and cancellation `turn/cancel` methods — over a socket resolved
from `DYFJ_SOCKET` (else `$XDG_RUNTIME_DIR/dyfj`, else `~/.dyfj/run`), running
the shared turn core. `friction/post` accepts
`{ severity, escaped, text, context?: { sessionId, model, workspace, command } }`
and returns `{ number, escapeNumber?, commentId, firstLine }`. The resulting
`Context:` line contains exactly the model slug, workspace basename, and
previous slash command when one exists; it never contains a free-text prompt or
absolute workspace path. It reuses the configured `linear.get_issue`, `linear.list_comments`, and
comment-write command policies and their redacted tool-call receipts. The write is
either `linear.create_comment` or `linear.save_comment`, whichever the configured
server exposes. Comments come from `list_comments`, which is paged; the read follows
the continuation shapes it recognises to the end or fails, because the next number is
derived from the highest one already present and a partial read could reuse a number
that exists.
Set `DYFJ_FRICTION_ISSUE_ID` on the runtime to identify the operator's
friction-checkpoint issue; `friction/post` fails at the `configuration` stage
when the variable is unset or blank. `runtime/status` includes grouped method
catalog metadata for client surfaces.
A second client, the Rust REPL front-end in `core/dyfj-repl`, speaks the same
protocol for interactive turns, approvals and `turn/cancel`; see
[`../core/README.md`](../core/README.md). The engine-free `dyfj` CLI reaches the
read methods over it with `dyfj models` and `dyfj sessions`; after a TTY-backed
UDS turn connects, Ctrl-C sends `turn/cancel` for REPL and one-shot turns, while pre-connection and non-TTY
SIGINT behavior remains unchanged. After an autostarted server installs its
SIGINT handler, when cancellation is the terminal outcome after the active
provider or tool operation settles, the turn stops without stopping the runtime;
a REPL allows another turn on the same session, while a one-shot exits with its
interrupted receipt. An independent provider or protocol error that settles
first remains an error rather than being masked. The launcher grants the
concrete Unix-socket permission at runtime so custom `DYFJ_SOCKET` /
`XDG_RUNTIME_DIR` paths keep working.

The experimental `--runner fixture` selector takes the separate external-agent test path. It launches the repository's deterministic ACP v1 fixture over local stdio without a shell, passes only a profile-selected environment and the resolved workspace, and emits runner-specific outer evidence rather than model/provider accounting. Sequential turns that share a Workbench session, workspace, and execution profile reuse one live ACP worker and session; a concurrent turn for that same key fails as busy instead of queueing. Turn cancellation keeps a healthy handle; a protocol or process failure removes it so the next turn can create a replacement. Idle handles retire on a TTL, capacity fails closed without eviction, and UDS close, a foreground SIGINT, or `dyfj stop` wait for in-flight creation and for every started close to settle, then surface a retained close failure rather than reporting success. A shutdown failure exits with status 1. On an interactive TTY, ACP activity remains visible through the terminal result: thought/tool updates select a bounded label, text/status/approval output temporarily owns the terminal, and the indicator resumes with the original elapsed timer and a truthful generic `working…` label when no more specific activity is known. Raw thought text is not rendered, persisted, or replayed. Interactive Unix-socket clients render every accepted ACP permission option (up to 16) as a numbered choice and return the exact selected option identifier. Invalid input re-prompts inside the same exchange up to three times before failing closed; empty or closed input, non-interactive use, or an unavailable approver selects the request's rejection option when present, otherwise the request is cancelled. Empty option lists and empty or duplicate identifiers fail at protocol ingress. The same permission-selection contract applies to every ACP profile. On non-Windows systems, fixture containment requires `/bin/kill` with negative process-group support; Windows uses direct-child signaling. Initialization, prompt, cancellation acknowledgement, signal subprocesses, and child cleanup waits each have deadlines.

The experimental `--runner codex-chatgpt` selector uses a local stdio child and the community-maintained `@agentclientprotocol/codex-acp` adapter requiring adapter-reported ChatGPT authentication that the Workbench profile classifies as subscription-backed. Sequential Workbench turns reuse the same live adapter process and ACP session under the same session/workspace/profile rule as the fixture. It runs on supported non-Windows systems with `/bin/kill` and an absolute operator home containing neither comma nor colon; inference may use remote services. Commas cannot be represented safely in this integration's comma-separated Deno grants, and colons would split the child's `PATH`, so the login task and runtime reject either delimiter. The route requires standing workspace trust and rejects remote calls and model-routing flags. Workbench uses a dedicated home under `~/.dyfj/runner-homes/codex-chatgpt/`, rejecting a symlinked, non-owned, or group/other-writable operator home and non-owned or group/other-writable existing `.dyfj` and runner-home directories without changing safe parent modes. It sets the runner-root, dedicated HOME, Codex-home, and Cargo-home directories to mode `0700`; the adapter receives a cleared allowlisted environment. ACP session updates remain finite per prompt: ordinary profiles allow 1,024 updates and this long-running profile allows 8,192, with the same resolved allowance enforced at protocol ingress and by the SDK consumer. Under a warm session those ingress counters reset at each prompt, so sequential turns do not inherit the previous exchange's budget. Newline-delimited protocol messages are also bounded by profile: ordinary profiles retain the 384 KiB ceiling, while this long-running profile permits newline-delimited messages up to 1 MiB each. The selected message ceiling is resolved once before stream construction and enforced before the SDK consumes the frame. Exceeding either update or message ceiling fails closed with a specific client diagnostic; the 16 MiB protocol-input and 60,000-byte agent-response caps apply per prompt/exchange; permission, timeout, cancellation, and process-cleanup bounds remain independent. This integration does not claim OpenAI support or endorsement and does not expand or interpret subscription terms. The project configuration pins adapter version `1.11.0` exactly, the Deno lockfile records its transitive graph and registry integrity, and the runtime rejects installed package metadata that does not declare that version. The launcher grants the selected delimiter-safe regular executable path from `DYFJ_NODE_PATH` or ambient `PATH`; at profile construction, the runtime resolves and validates the target then invokes the selected path without pinning that target or attesting that it is Node.js. `DYFJ_CODEX_TOOLCHAIN_PATH` may project one validated executable directory into the narrow child `PATH`, while `DYFJ_CODEX_RUSTUP_HOME` may project one validated Rustup state directory. Both selections reject slash-only root spellings and whole `.` or `..` components before filesystem resolution. The child `PATH` places a private Node shim before the optional explicit executable directory, `/usr/bin`, and `/bin`; private zsh and Bash login profiles reset earlier macOS `path_helper` changes. It does not dynamically derive and add an arbitrary parent directory from the selected Node executable; the fixed `/usr/bin` and `/bin` entries remain, and the operator may explicitly select another directory as the toolchain. The child uses a separate persistent private Cargo home rather than the operator's Cargo home. Adding these environment selections leaves the existing Workbench ACP action-approval plumbing unchanged, and dedicated receipt evidence retains only the count of distinct canonical operator directories. These controls project tool discoverability and Rustup state access; they do not attest binaries. Generic direct engine tasks remain runner-neutral, so use the `dyfj` launcher for this route. Authenticate the dedicated home out of band before the first turn:

```sh
cd prototype
deno task codex-chatgpt-login
```

Before `session/new`, Workbench requires `authentication/status` to return an object whose top-level `type` is exactly `chat-gpt`. A missing response or any other top-level type fails closed, and Workbench supplies no API-key or metered-provider fallback. Durable `runner_route_source` and `runner_auth_type` fields record the profile's declared route classification separately from the authentication type reported by the adapter and from caller `authn_*` fields. Workbench carries optional unstable ACP-reported prompt-response usage, context-window occupancy, and cumulative session cost as explicitly ACP-sourced receipt evidence rather than native accounting. The pinned Codex adapter reports token/context usage on this subscription route but not currency cost; the receipt states that USD cost was not reported. See the root README for the complete boundary and evidence contract.

**Permission grants — committed profile vs. launch-resolved.** `deno.json` declares each entrypoint's static permission profile; the single declared engine surface (`CONFIG_SCHEMA` in `src/config/schema.ts`) is asserted against those profiles by a parity test, so a runtime env var can't drift into one profile and out of another. Runtime code reads the environment only through the `Env` port in `src/config/env.ts`, and every `DYFJ_*` key it names is declared in `CONFIG_SCHEMA`; the `arch.imports` gate lane enforces both. A few grants are inherently machine- or operator-specific and so are *never* committed to a profile — the launcher resolves them at `dyfj start` and appends them to an explicit flag (which replaces, not extends, the profile list, so the launcher rebuilds the profile grants alongside): the concrete `unix:<socket>` path, private memory-endpoint host, configured external MCP hosts, and `<ip>:53` for each `nameserver` in `/etc/resolv.conf` (so the web tools' address check can resolve hostnames; `deno task serve-unix` gets the same nameserver grants, plus a copy of the profile's net list, from `scripts/serve-unix-net-flag.ts`) on `--allow-net`, and — when a `[secrets]` resolver is configured — the resolver command binary on `--allow-run`. Fail-closed: `dyfj start` refuses to run when it can't establish a trusted prototype root (`DYFJ_PROTOTYPE_ROOT` or its own on-disk install location), rather than trusting the current directory's `deno.json`/`.env` for the child's grants. See "Hosted inference" and "Configured external MCP tools" in the root README for the configuration shapes.

For an operator-facing recall check without an external memory or credential,
run `deno task memory-recall-uat-fixture`. It serves a strict modern MCP endpoint
on loopback, prints its local URL, exposes only `fixture-search`, never prints
the query, and returns fixed synthetic text. Point `DYFJ_MEMORY_MCP_URL` at the
printed URL, set `DYFJ_MEMORY_MCP_TOOL=fixture-search`, and set
`DYFJ_MEMORY_MCP_TOKEN` to the empty string before starting the isolated
runtime. A successful UDS turn renders the bounded `Memory recall MCP:`
negotiation line on the client event stream; it does not enable the runtime's
general narration on the server console.

Recall calls carry validated W3C trace context in MCP `_meta`, derived from the
same canonical trace and tool-span identifiers written to the event log. The
production recall-tool row records the current trace flags, `client` span kind,
and local-parent evidence; raw `traceparent` and baggage are not stored. The
event schema and reusable extraction helper support normalized trace state and
remote-parent evidence for the first inbound MCP consumer, without claiming
one exists today. The conformance fixtures also pin bounded multi-round-trip
input, completion, request-stream cancellation, safe retry classification,
stable list ordering, cache TTL/scope partitioning, and local JSON Schema
2020-12 `$ref` handling for later MCP consumers. Workbench does not yet own an
MCP OAuth consumer seam, so this boundary does not invent issuer-keyed
credentials or an authorization callback solely to host conformance tests;
issuer and RFC 9207 response checks belong with the first real consumer.

For a compiled daily-driver binary (Deno 2.9+), build and put `dist/` on your `PATH`:

```sh
deno task compile-cli   # dist/dyfj (launcher) + dist/dyfj-bin (compiled)
```

The launcher execs the fast compiled binary on the default socket path and falls back to `deno run` with a runtime-resolved `unix:` net grant when `DYFJ_SOCKET` or `XDG_RUNTIME_DIR` shifts the path away from `~/.dyfj/run/workbench.sock`. Without a compile step, `prototype/scripts/dyfj-launcher.sh` behaves the same via the `deno run` fallback.

The prototype reads Dolt connection settings from environment variables. For the default local server:

```sh
export DOLT_HOST=127.0.0.1
export DOLT_PORT=3306
export DOLT_USER=root
export DOLT_PASSWORD=<your-local-dolt-password>
export DOLT_DATABASE=dolt
```

Useful checks:

```sh
deno task check          # check:sources, then check:tests
deno task check:sources  # every non-test module under src, mcp, scripts, testing
deno task check:tests    # every test file, both frameworks
deno task test:unit      # Deno.test unit lane (test.unit)
deno task test           # checks, test:unit, then the Vitest unit suite
deno task test:file <path>  # run a single test file without full typecheck
                         # (requires a path or -t pattern; exits 2 otherwise)
deno task verify-workbench-events
deno task test:golden    # golden characterization suite (needs Dolt)
deno task test:golden --update  # rewrite snapshots (see below)
(cd .. && deno task test) # repository aggregate gate
```

Use `test:file` for tight iteration loops while developing a single Vitest test — it skips
the full typecheck and runs only your named file. Use `test` for the gate before commit,
which typechecks the entire codebase and runs the full suite excluding integration tests.

Both typecheck file lists and the `test.unit` file list are derived by walking the tree
(`scripts/test-files.ts`); nothing is hand-listed. While the two frameworks coexist, a
test file's framework is read from its imports, as `deno info --json` (Deno's own parser)
reports them: a file whose static imports reach `vitest`, directly or through a helper
module, runs under Vitest; any other `*.test.ts` is a `Deno.test` file and Vitest
excludes it.
`*.integration.test.ts` files and `testing/golden/` have their own lanes. `test:unit`
runs `deno test --parallel --sanitize-ops --sanitize-resources` (both sanitizers are
opt-in in the pinned Deno), with read access to the prototype and
temp roots, write access to temp roots only, and no run, net, or env grant, so unit and
component tests stay off Dolt, the network, and child processes. Write fixture output to
`Deno.makeTempDir()`, never the working tree.

Shared test support lives in `testing/` (never imported by runtime code): the golden
suite in `testing/golden/`, loopback servers in `testing/servers/`, and the port fakes in
`testing/fakes/`: `ManualClock` (`Clock`), `SequentialIds` (`IdSource`, ULID-shaped),
`MapEnv` (`Env`), `ScriptedDnsResolver` (`DnsResolver`), and `fakeIo` (the CLI's terminal `Io`). A unit test replaces a port with
its fake; module mocking is not allowed (`specs/03-testing.md` §1). A fake's conformance
suite lands with the port it stands in for.

Deno grants Unix-socket access per exact path, not per directory, so a `Deno.test`
integration test that binds or dials a real socket takes its path from
`testing/servers/uds-sockets.ts`: the isolated-Dolt integration lane creates one
directory, passes it in `DYFJ_UDS_TEST_SOCKET_DIR`, and grants `unix:` access to each
socket named in that file. A new socket-using test adds its socket name there.

Local imports name the file they load, extension included (`./utils.ts`, not
`./utils`); no task passes `--sloppy-imports`, so an extensionless local import
fails the typecheck. Third-party packages resolve through the `imports` map in
`deno.json` rather than inline `npm:` or `jsr:` specifiers. To fix up a batch of
extensionless imports, for example after a merge, run
`deno run --allow-read=. --allow-write=. scripts/add-import-extensions.ts` from
this directory; it rewrites each one to the file it resolves to and reports any
it cannot resolve.

`test:golden` runs the golden characterization suite in `testing/golden/`:
twelve black-box scenarios that drive the engine server (`src/server/main.ts`)
and the CLI (`src/cli.ts`) as child processes against an isolated Dolt
fixture, a loopback model server (`testing/servers/model-server.ts`) and a
loopback Linear MCP server (`testing/golden/linear-mcp.ts`, built on the shared
loopback MCP server in `testing/servers/mcp-server.ts` that the MCP integration
tests also use). Each scenario's stream frames, RPC responses,
rendered CLI output, and `events`/`sessions` rows are normalized (generated
IDs, timestamps, durations, temp paths, PIDs and the fixtures' loopback
endpoints only) and compared with `testing/golden/snapshots/`. During the
phase-1 restructuring a snapshot may change only for a reason the PR states,
as `specs/03-testing.md` §4 sets out; `--update` rewrites them.

The root aggregate gate runs the schema, Rust, isolated-Dolt integration, and
golden characterization lanes in addition to this prototype unit suite. Prototype Vitest is exclusive
and bounded: `$HOME/.dyfj/run/dyfj-vitest-run.lock` refuses a second run while
a prior run is alive (including across checkouts), a hang fails
`DYFJ_TEST_BOUND_SEC` (default 600s; 180s for a named file or `-t` pattern),
and leftover fixture/runtime processes, test sockets, and run-scoped
`start-test-runtime-*.lock` files are reaped after exit or runner death. The
next run recovers a saved Vitest process group only when a recovering run
generation is supplied and the recorded recovery directory, run generation,
leader start time, and command still match. Malformed-lock recovery does not
signal a saved process group. A spawn-manifest PID is not kill authority
unless that record carries matching start time, command, recovery directory,
and run generation. If the
saved leader is gone, that numeric group is left alive. Supervised runs fail
closed without an absolute `HOME`. Sweeping is scoped to this run's tmp dir,
spawn manifest, and explicit command needles. It
owns a temporary Dolt
repository and SQL server, with cleanup on normal completion and handled
failure. SIGINT and SIGTERM request cooperative cancellation; the direct lane
process receives SIGTERM followed by a bounded wait and possible SIGKILL. The
prototype and root test tasks resolve the selected Deno executable once per
entrypoint and reuse that absolute command identity in nested run grants.
The Rust tracer test retains
its manual-run `.env` loader, but the fixture's explicit `DATABASE_URL` takes
precedence, so the lane does not use an operator database.

For Workbench failures that look like "the model never responds", check the selected local provider directly before debugging DYFJ. For MLX-LM Server:

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

The response must include generated text. Health/list endpoints such as Ollama `/api/version`, `/api/tags`, and `/api/ps` do not prove the model runner can load.

## Layout

- `src/` — the `dyfj` CLI (`cli.ts`) and engine (`server/main.ts`) entrypoints, the JSON-RPC/UDS transport seam, shared runtime boundary, native provider path, ACP client runner, memory loading and prompt assembly, event verification, utilities, tests
- `src/kernel/` — layer L0: pure shared helpers with one implementation each (UTF-8 byte bounding, code-point prefixes, terminal escape stripping, boundary-text sanitizing, ULID/trace/span IDs, canonical JSON, the time-bounded regex matcher, lexical path checks, and the `Clock` port with its system adapter, which `testing/conformance/clock.ts` holds to the same contract as the `ManualClock` fake), imported through `src/kernel/mod.ts` and importing nothing from other runtime layers
- `src/contract/` — layer L1: the runtime contract shared by the engine, its runners, the server, and the CLI (turn request, receipt and stream-frame types, runtime auth and event types, the persisted session-event read shape (`WorkbenchSessionEvent`), history-omission notices, `DomainError`, the `Runner` interface, and the wire trust policy in `summarizeError` and `workspaceRootForTransport`), imported through `src/contract/mod.ts` and importing only `src/kernel/`; wire types stay plain data. The engine binds its external-agent (ACP) runner through the `Runner` interface: the UDS server composes it, so the engine never imports the ACP runtime
- `src/config/` — layer L1: the declared configuration surface, imported through `src/config/mod.ts`: the env-key schema (`CONFIG_SCHEMA` in `schema.ts`, every `DYFJ_*` key declared), the `Env` port (`env.ts`, the only runtime module that reads `Deno.env` or `process.env`), the launcher's `.env` parser, TOML loading and the engine config, the `[secrets]` and `[mcp]` parsers, the budget/agent/anomaly defaults, and the Dolt connection settings (`dolt.ts`). The `arch.imports` lane enforces that no other runtime module reads the environment
- `src/store/` — layer L2: the store port and the only code that issues SQL (`specs/02-data-layer.md` §2), imported through `src/store/mod.ts`. `journal.commit` is the one mutation path: a batch's events, their projections and its declared unjournaled mutations (`store/unjournaled.ts`, each kind with the reason it has no event yet) commit in one transaction. Read-only readers cover events, sessions, memories (the loopback/non-loopback/MCP-stdio clearance rule lives in `store/memories.ts`), the model catalog, prompts and spend baselines. `store/sessions.ts` holds the session-record helpers over the port: session create and update through the journal, the session list and record reads, and the typed read-back of a session's events. `DoltStore` runs over one `mysql2` pool the composition root builds from `src/config/dolt.ts` and passes in; `MemoryStore` is the in-memory adapter for tests. Both pass `testing/conformance/store.ts`. The readers get only a handle that runs a single `SELECT`; only the journal holds a write-capable connection. `mysql2` may be imported only here, which the `arch.imports` lane enforces. `store/generated/rows.ts` is generated from the DDL by `schema/codegen.ts` (row and insert types, column tuples and declarations, SQL enum unions; never hand-edited, and the `schema.codegen` gate lane fails when it is stale). Every event is built with its per-type constructor in `store/events/builders.ts`, so `journal.commit` takes only typed `EventInsert` values. At boot, `serve-unix` runs `DoltStore.assertCanonicalColumns`: a reachable database missing a canonical column stops the engine with the missing columns named; there is no fallback for an un-migrated database
- `src/budget/` — layer L2: per-session spend tracking and its gates, imported through `src/budget/mod.ts`: the tracker (`tracker.ts`: per-turn accumulation, the pre-call envelope check, the anomaly check, and the `budget_summary` event written through the journal), spend baselines and the local-day boundary (`spend.ts`, read through the store's spend reader and the `Clock` port), the envelope gates (`envelope-gate.ts`: per-call, session and daily ceilings, warn-then-confirm, fail closed without a confirmation channel), the ceiling confirmation store (`confirmations.ts`: one `CeilingConfirmationStore` per engine, held by the engine's `SessionOwners`, which the composition root in `src/server/main.ts` builds, and reached by the runtime as each session's budget scope), and the runaway anomaly gate (`anomaly-gate.ts`: the hard stop on actual spend). Imports only `src/kernel/`, `src/contract/`, `src/config/`, and `src/store/`
- `src/context/` — layer L2: what the model sees on a turn, imported through `src/context/mod.ts`: workspace/repo context packing and AGENTS.md loading (`repo-context.ts`), companion prompt composition (`prompts.ts`), transcript compression (`compression.ts`), length-stop and context-overflow recovery (`length-recovery.ts`), and the conversation projection that rebuilds a session's prior turns from its events (`conversation.ts`). Imports `src/kernel/`, `src/contract/`, `src/config/`, `src/store/`, and provider types only
- `src/transport/` — layer L2: the JSON-RPC 2.0 process seam over Unix sockets (codec and framing, request dispatch, the duplex connection peer, socket-path resolution, the client connect, the server bind/accept loop, and the request-parameter sanitizers every method module runs its params through (`rpc-params.ts`)), imported through `src/transport/mod.ts` and importing only `src/kernel/`, `src/contract/`, and `src/config/`. The CLI reaches the engine only through it; the engine's method handlers are in `src/server/rpc/`. The Rust REPL client in `../core/dyfj-repl` speaks the same wire format, so framing, method names, error codes, and socket-path resolution stay byte-identical
- `src/providers/` — layer L2: model providers behind one `ProviderAdapter` interface (`specs/01-architecture.md` §5.2), imported through `src/providers/mod.ts`. `registry/` parses the catalog from the store's model reader (declared structurally, so `providers/` does not import `store/`), routes turns, holds the built-in local defaults, and dispatches each turn to the adapter serving the selected model's provider; a provider no adapter serves fails closed. One directory per API family (`openai-compatible/`, `anthropic/`, `gemini/`) holds its request, stream, usage and stop-reason code; `shared/` holds what they share (SSE line reading, text tool-call extraction, token estimates, wire-safe tool names, base-URL rules); `http.ts` holds the `HttpTransport` port and the header deadline. Every adapter passes the provider conformance kit (`testing/conformance/provider-adapter.ts`) with recorded fixtures replayed by the scripted `HttpTransport` fake, which passes the port's own conformance suite (`testing/conformance/http-transport.ts`) alongside real `fetch`. Adding a provider follows `../specs/recipes/add-provider.md`
- `src/tools/` — layer L2: the command primitive (`specs/01-architecture.md` §5.4), imported through `src/tools/mod.ts`. `CommandDefinition` (`definition.ts`) is the one tool shape; the registry (`registry.ts`), argument validation (`validate.ts`), the call-shape policy (`policy.ts`), the shared redactor that applies each definition's declared argument and result redaction to the durable `tool_call` event (`redaction.ts`), and invoke-with-event (`invoke.ts`) serve every tool. `buildToolCatalog` (`catalog.ts`) is the one place a registry is assembled: the runtime's per-turn toolset, the `tools/list` and `tools/inspect` listing, and the friction command set all come from it. The builtin tools live beside their executors, each exported as a `define<Name>`: `builtin/memory.ts` (`memory.read`, `memory.search`), `builtin/file.ts` (the workspace file tools), `builtin/exec.ts` (`bash`), `builtin/git.ts` (`git`); the web capability tools are in `web/web.ts`, and their address check, which refuses a target it cannot verify as public, looks up hostnames through the `DnsResolver` port (`web/dns.ts`), whose `Deno.resolveDns` adapter and `ScriptedDnsResolver` fake both pass `testing/conformance/dns-resolver.ts`. Every tool the catalog can register passes the tool conformance kit (`testing/conformance/tool.ts`), which `src/tools/conformance.test.ts` runs over the builtins and the MCP-derived commands. Adding a tool follows `../specs/recipes/add-tool.md`
- `src/engine/` — layer L3: the turn pipeline (`specs/01-architecture.md` §5.1), imported through `src/engine/mod.ts`. It holds the turn entry (`turn.ts`: `executeTurn` runs a resolved turn under its session's lock, rebuilds the resumed conversation inside that lock, and binds boundary config and the transport's paid verdict; `turn-request.ts`: `resolveTurnFromBody` validates a turn request), session ownership (`session-owner.ts`: `SessionOwners` is the single writer for each session's turn lock (a turn that starts a new session gets its id allocated there at admission, so later turns naming it queue behind it), its budget scope (the ceiling confirmations, reached through `budgetScope`), and each admitted turn's cancel signal, a `TurnTicket` the server routes `turn/cancel` to), route resolution (`route.ts`: `resolveRoute` chooses the native or ACP runner and, for an ACP route, checks workspace trust and runs the paid-escalation preflight; `selectModelRoute` is the native turn's model selection; `confirmPaidRoute` is the one preflight both paths use), the observed provider call (`observed-call.ts`: `observedProviderCall` calls the provider, writes the `provider_call` event and records usage with the budget tracker, for both the agent loop and transcript compression), the engine's error classes and `classifyErrorKind` (`errors.ts`), and best-effort event writes (`event-writes.ts`). The native turn is `native-runner.ts` (`runWorkbenchRuntime`, which also hands an ACP route to the bound external-agent runner port), which runs the pipeline stages in order over an engine-owned `TurnState` (`turn-state.ts`, with the `NativeTurnPorts` the stages use: store, budget confirmations, clock, env, the provider transport, the spend rollup and the overflow compressor). The stages are `openSession` (`open-session.ts`: identity, budget posture, `session_start`), `buildContext` (`build-context.ts`: workspace root, repo or companion context, AGENTS.md elevation, the history-omission notice), `budgetGate` (`budget-gate.ts`: model selection, the entry anomaly, ceiling and paid-consent checks, `model_selected`) and `loadTranscript` (`load-transcript.ts`: the first call's conversation, with proactive compression through `compression.ts`, which the agent loop's overflow recovery shares). `agentLoop` (`agent-loop.ts`) runs the model and tool steps up to the tool-step limit; its calls go through `observed-turn.ts` (per-call gates, recording, frames) and `recovered-turn.ts` (length-stop recovery). `finalize.ts` ends every turn: `completeTurn` records a finished or cancelled turn, `failTurn` classifies a failure by its real class, and `finalize` writes `session_end`, the budget summary, the receipt and the session record, then returns the result or rethrows the turn's error after the receipt. Receipt and tally formatting are in `receipt.ts`, the next-work worklet in `next-work.ts`, runtime-event delivery in `runtime-events.ts`, and the runtime's input/services/result types in `runtime-types.ts`. A turn calls back to its caller only through the ports on its input: the `Approver` (paid escalation, budget ceilings, runaway anomalies, tool approval and ACP permission options), the `FrameSink` (runtime events, text deltas and narration), and its ticket's `CancellationWindow`; the spend rollup and the context-overflow compressor are services (`WorkbenchRuntimeServices`). Engine tests run on `Deno.test` against the fakes in `testing/builders/engine.ts`, with no mocked modules: per-stage units, and component tests (`*.component.test.ts`, with `engine.component.test.ts` for the whole pipeline) that drive whole turns through a scripted provider transport, the real provider adapters and the real tool catalog.
- `src/extensions/` — layer L4: optional features behind the Extension interface, one directory per extension, each importing only lower layers and never another extension; the core never imports them, only `src/server/` and the CLI's `client.ts` entries do. `extensions/ideas/` serves two extensions, `ideas` (`ideas/mark`, `ideas/list`, `ideas/get`) and `packets` (`packets/draft`, `packets/list`, `packets/get`), built as a pair by `createIdeaPacketExtensions` over one `IdeaPacketRegistry` the pair owns (a packet references its idea, and eviction crosses the two). The registry is in memory, so ideas and packets last as long as the engine process. `idea-packet.ts` is the domain (marking, drafting, the Markdown rendering); `client.ts` is what the REPL imports for its in-process `unix: false` path, whose registry the REPL session owns
- `src/server/` — layer L5: the engine server. `rpc/` holds one RPC method module per namespace, each a `build<Namespace>Handlers(deps)` over only the readers and settings it uses: `runtime.ts` (`runtime/liveness`, `runtime/status` with the method catalog, `runtime/stop`), `surface.ts` (`surface/snapshot`), `models.ts`, `sessions.ts`, `events.ts` and `tools.ts`, with the mapping of a client's `approval` answer to a verdict in `approval.ts`. `extensions.ts` defines the Extension interface (`../specs/01-architecture.md` §6): an extension has an id and returns its JSON-RPC methods from the `ExtensionDeps` the composition root hands it, and `buildExtensionHandlers` merges them, refusing a duplicate id or method. `friction/post` has not moved behind it yet and stays, unchanged, in `rpc/legacy-extensions.ts`. `turn.ts` holds `turn` and `turn/cancel`: it admits each turn through the engine's `SessionOwners`, records which turn each connection is running so `turn/cancel` reaches only its own, carries approvals to the client as server-initiated `approval` requests and streams deltas and runtime events back as `stream` notifications. The tests call the handlers through the transport's `dispatchRequest` (`testing/builders/rpc.ts`) with a scripted client context, with no socket. `main.ts` is the composition root and the engine entrypoint (`deno task serve-unix` and `dyfj start` run it): it loads the config, resolves secrets, builds the store (and runs the boot-time column check), the external MCP commands, the session owners, the turn runtime (binding the ACP runner and its warm-session map) and the ACP session map, builds the static extension list (every extension enabled; each engine owns its extensions' state), wires every RPC module and the extensions' methods, and binds the socket. `serveWorkbenchUnix` is that composition without the boot, which the socket-level tests (`main.integration.test.ts`, `console-canary.integration.test.ts`, `events-asof.integration.test.ts`) build over their own store
- `src/tools/mcp/transport.ts` — the MCP transport every MCP consumer shares: the byte-bounded fetch, the untrusted-result framing, bearer-header construction, and the one SDK client factory, used by the external MCP tools (`src/mcp-tools.ts`), the web tools (`src/tools/web/web.ts`), and memory recall (`src/memory-search.ts`)
- `mcp/` — MCP server (`server.ts`), a separate stdio entrypoint that builds its own `DoltStore` and reads and writes through the same journal and readers as the runtime
- `examples/` — diagnostic programs, verification helpers, and historical transport spikes; these are not operator launch paths

The named `context-size-response`, `model-response-modes`, `structured-output`,
and `structured-output-streaming` tasks are manual local-provider diagnostics.
Pass their `--model` and `--base-url` options when testing the current local
stack; their built-in values target Ollama `gemma4:e2b` rather than the
registry's local default.
`verify-workbench-events` is the live event-sequence check. The standalone
`uds-jsonrpc-spike.ts` records the original duplex-transport proof; the current
transport implementation lives in `src/transport/`, with the engine's method
handlers in `src/server/rpc/`.

## Where this is heading

Components in `src/` that prove out and stabilize will get re-implemented in `../core/` (Rust). TypeScript stays here for prototyping anywhere that velocity matters more than substrate-level correctness; Rust earns its way in component by component.
