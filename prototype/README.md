# DYFJ Prototype (TypeScript on Node)

This is the TypeScript prototype layer of DYFJ.

This layer contains working prototype code for Workbench CLI, the JSON-RPC/UDS transport seam, shared runtime execution, a local ACP-client foundation, memory, command routing, provider routing, budget tracking, session persistence, MCP, and tests. Stabilized components can move into `../core/` when the Rust boundary is worth the extra compile-time structure.

If you want to understand DYFJ's stance on why prototype-and-substrate coexist in the same repo, read the project README at the repo root, especially the Layer 0 stance on Rust as a moving boundary.

## Run it

You'll need [Node.js](https://nodejs.org) 26 with npm: the runtime and the
`dyfj` CLI run on it, and the launcher refuses any other major version. npm
alone installs the npm dependencies. This directory is a member of the one
npm workspace at the repository root, so run `npm ci` at the repository root,
which holds the lockfile and installs into the root `node_modules`; rerun it
after any change to the root `package-lock.json`. The tests and the repository
gate run on Node too (`npm test` at the repository root).

```sh
(cd .. && npm ci)
./scripts/dyfj-launcher.sh
```

The earlier standalone in-process workbench CLI, with its launch tasks, is
removed; turns reach the engine only over
the Unix socket, through `dyfj` or the Rust REPL client in `../core/dyfj-repl`.
The bare `dyfj` invocation is the daily-driver path. It connects to the local
Unix-socket runtime and opens the streaming REPL; if no runtime answers, the
launcher starts one in the background and waits for it. On a terminal the REPL
is the Rust one in `../core/dyfj-repl` when its binary is built and the
arguments are ones it takes; `DYFJ_REPL=ts` keeps the TypeScript REPL (the
root README's "Build the core" has the details). Use `dyfj exec
"<prompt>"` for a one-shot turn, `dyfj status` to inspect the local runtime, or
`dyfj start` when you explicitly want to foreground the runtime. Link
`scripts/dyfj-launcher.sh` onto your `PATH` as `dyfj` to use it without the
path prefix; the launcher resolves its own symlink to find this directory.
It runs the client as `node --permission --allow-fs-read=* --allow-net
src/cli/main.ts`, except for `dyfj start` (and autostart's background start),
which runs as plain `node` and starts the runtime as plain
`node src/server/main.ts`; the root README's "Egress, spawn and environment
limits" section says why.

A runtime the launcher autostarted belongs to the `dyfj` invocations that use
it: it stops on its own 10 s after its last client disconnects, through the same
shutdown as `dyfj stop` (warm ACP sessions and their children are closed, then
the store). A client that connects inside those 10 s keeps it, so back-to-back
`dyfj exec` calls share one runtime. A runtime started with `dyfj start` stays up
until `dyfj stop` or Ctrl-C. `dyfj start` holds the terminal until its runtime
has exited and leaves the terminal's modes alone, so Ctrl-C reaches the runtime
as a signal. A second Ctrl-C while the shutdown is pending prints what it is
waiting on; a third exits at once with status 130, without finishing the
cleanup. At boot the runtime records which code it loaded:
the checkout's git HEAD, read from the `.git` files without running git, and a
SHA-256 content hash of the files under `src/` (dotfiles and symlinks skipped;
`unknown` when either cannot be read). `dyfj status` shows it, along with open
clients and turns in flight, and says whether it matches the working tree. When
it does not, the REPL's posture line (TypeScript and Rust) warns
`runtime is behind the working tree`. Before an invocation that needs a runtime,
the launcher restarts a stale runtime it autostarted when the launcher is that
runtime's only client and no turn is in flight, and otherwise warns and leaves
it running. The runtime makes that check itself (`runtime/stop` with
`ifSoleClient`) and, when it stops, stops admitting connections in the same
step, before any cleanup; a client that connects after that is refused or
disconnected unserved, as after any stop. A runtime started with `dyfj start`
is never restarted for this. When
the Rust REPL binary at `../core/target/release/dyfj-repl` is older than a file
under `../core/dyfj-repl/src`, the workspace `Cargo.toml` files or `Cargo.lock`,
the launcher prints the `cargo build --release -p dyfj-repl` command; it builds
nothing itself.

`dyfj dev` is the variant for working on the harness itself, with the same
one-terminal shape. The launcher routes it to `scripts/dyfj-dev.ts` on plain
`node`, with the dev socket (`--socket`, else `$XDG_RUNTIME_DIR/dyfj/dev.sock`,
else `~/.dyfj/run/dev.sock`; `DYFJ_SOCKET` names the daily runtime and is not
read) and that socket's runtime log. It takes the arguments the Rust REPL
takes (`--model`, `--session`, `--workspace`, `--approve-paid`, `--fast`) and
refuses any other. It refuses to start when a runtime already answers on the
dev socket. Then:

- It builds the REPL with `cargo build -p dyfj-repl` (a debug build, into
  `../core/target/debug/`), starts a runtime on the dev socket with the real
  config and the real Dolt, and runs the REPL in the foreground. Every child it
  starts goes through the config unit's guarded spawn, with a run list of
  `node`, `cargo` and that REPL binary.
- The runtime's output goes to the dev socket's log under `~/.dyfj/log/`,
  held to what the autostart log is: the directory is set to 0700 and the
  file to 0600 whether or not they existed, a symlinked log is refused, and a
  log that cannot be made owner-only (another account's, say) stops the
  runtime from starting, with one line naming the path.
- The runtime runs in its own process group, so the terminal's Ctrl-C (the
  REPL's, to cancel a turn) never reaches it, and with the autostarted
  lifetime. The supervisor holds a connection to it, so it stays up while the
  supervisor runs; if the supervisor is killed without stopping it, the
  runtime stops itself 10 s after its last client, the REPL included, leaves.
  While that connection is open, the launcher's freshness check declines to
  restart it (`ifSoleClient` sees a second client); the supervisor owns its
  restarts.
- It watches `src/` and `../core/` with Node's recursive `fs.watch`, dropping
  editor scratch files, and takes each batch of saves 300 ms after the last
  one. `../core/target/` is not watched: `../core/`'s top level is watched on
  its own and each other directory recursively, so a directory added there is
  watched only after `dyfj dev` restarts. `scripts/dev-classify.ts` classifies the batch
  from the `arch.imports` module graph (`../scripts/arch-imports-graph.ts`),
  rebuilt for each batch: a module reachable from `src/server/main.ts` over
  value edges restarts the runtime; `contract/` and `transport/` restart the
  runtime and then the REPL; a test or fixture file, or a module only the
  TypeScript client reaches, restarts nothing; any other file under `src/`
  restarts the runtime. A file under `../core/` belongs to the Cargo workspace
  member with the longest matching directory (`cargo metadata`), and rebuilds
  the REPL when that member is `dyfj-repl` or a workspace crate it depends on
  by path; `Cargo.lock`, the root `Cargo.toml` and `rust-toolchain.toml` always
  do. Without `cargo metadata`, every `../core/` change rebuilds the REPL.
- A reload waits while `runtime/status` reports a turn in flight, and `/reload`
  in the REPL forces one now. A runtime restart goes through `runtime/stop`,
  then SIGTERM and SIGKILL to the runtime's process group if it has not exited
  in 10 s. The REPL shows `runtime reloaded (<n> files changed)` when it
  reconnects. A REPL rebuild asks the REPL to exit, then starts the new binary
  with `--session` and the session it was in.
- A REPL build failure changes nothing: the REPL and the runtime keep running,
  the first `error` line of the build is shown, and the next save retries.
- A runtime that boots on the working tree becomes the last good code
  (`scripts/dev-snapshot.ts`): `src/` is copied to a staging directory named
  for the process, the copy is kept only if its content hash is the
  `fingerprint.contentHash` the runtime reported (a save can land between the
  boot and the copy), and it is swapped in at `.dyfj-dev-last-good/` with a
  record of that hash, the time and the sha256 of `../package-lock.json`
  sampled just before the runtime was spawned. The
  copy sits beside `src/`, so the files the runtime finds from its own
  location resolve as they do from `src/`: the Codex ACP package from the
  directory above, the code fingerprint from the copy itself. Every
  `.dyfj-dev-*` directory is gitignored and outside every lane's roots
  (`scripts/dev-snapshot-exclusion.test.ts`).
- A runtime that fails to start (it exits, or does not answer in 60 s) is
  replaced by the last good code: `node .dyfj-dev-last-good/server/main.ts`,
  with the same args, env and socket, plus `DYFJ_DEV_BOOT_FAILURE`, the failed
  start's log output with repository paths made relative and the home
  directory as `~`. The REPL resumes on it. Before it runs, the copy is
  re-hashed against its record and the lock file compared; a mismatch refuses
  it with one line, and so does a missing copy, and the runtime then stays
  down while the REPL waits and shows the error from the log, as before. While
  the last good code runs, the next save of any file tries the working tree.
  A failed first start uses a copy from an earlier run if one passes those
  checks, and says it is from an earlier run; with none, `dyfj dev` exits.
- `/rollback` runs the last good code on purpose, for a runtime that starts
  but fails every turn; its `DYFJ_DEV_BOOT_FAILURE` says the operator rolled
  back. `/reload` or a save returns to the working tree.
- `DYFJ_DEV_BOOT_FAILURE` is a `dev`-domain key: declared in the config
  schema, never in the runtime's env grants, so the launcher never forwards an
  ambient value and only a runtime `dyfj dev` started as the last good code
  has it. The runtime sanitizes it again when it reads it
  (`src/context/dev-boot-failure.ts`: escape sequences, control and bidi
  characters stripped, capped at 2 KB) and `buildContext` adds it to each
  native loopback turn's system prompt (a turn on any other transport, or none,
  gets nothing) as a labelled block of local diagnostic output,
  framed as data and not instructions, with a `dyfj dev boot failure` line
  under the receipt's context sources. External-agent turns do not carry it.
- Quitting the REPL stops the runtime and ends `dyfj dev` with the REPL's exit
  status. SIGTERM or SIGHUP to `dyfj dev` stops both.

The supervisor talks to the REPL over a socket pair on the REPL's descriptor 3
(`DYFJ_DEV_CONTROL_FD`): the reload reason and an exit request go down, the
session id, `/reload` and `/rollback` come up. Under the channel, the REPL's
freshness warning says the runtime is the last good code or a reload still
pending, and that a save retries the working tree, instead of naming the
autostarted lifetime. When one change reloads the runtime and the REPL, the
new REPL is started with the reason in `DYFJ_DEV_RELOADED` and prints a single
`runtime and REPL reloaded (...)` notice. `scripts/dev-supervisor.ts` holds the reload
state machine over ports, so its timing is tested on a fake clock.

The local default is Qwen3.6 35B-A3B served by llama.cpp's `llama-server` (catalog slug `llama-cpp/qwen3.6-35b-a3b`), reached through its OpenAI-compatible endpoint on `http://localhost:8080/v1`:

```sh
llama-server -m /path/to/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf \
  --host 127.0.0.1 --port 8080 --alias llama-cpp/qwen3.6-35b-a3b \
  --ctx-size 32768 --parallel 1 --reasoning off --jinja
```

`--jinja` explicitly enables the GGUF's chat template for OpenAI-style tool calls. The catalog declares the served 32K context. The previous DeepSeek llama.cpp row was removed by the catalog trim, so this is the only built-in local row and the only local default.

The catalog no longer carries MLX-LM Server rows (`mlx_lm.server` on `http://127.0.0.1:18080/v1`), so one has to be added to the `models` table before selecting it with `--model`.

Workbench also carries a built-in row for the local default above and adds it when the catalog has no row for it. A catalog row set inactive stays out of routing and the model picker; the built-in row does not replace it. The catalog trim removed every Ollama row, so the local preference order is now that one built-in row and then whatever the caller passes.

Agent-tool turns default to 32 steps. Every entrypoint accepts `DYFJ_MAX_TOOL_STEPS`; the UDS engine also loads `[agent].max_tool_steps` from `~/.dyfj/config.toml`. Values are integers from 1 through 64, and the environment value takes precedence. The final receipt reports `Tool steps: used/limit` and marks when the configured limit ended tool use. At the limit, the runtime makes a call that offers no tools and asks the model for a handoff (done, next, uncommitted state); if that call fails or a budget gate stops it, the turn ends on a runtime notice of its last tool calls. A session sets its own limit with `--tool-steps N` or `/steps N`, up to `[agent].max_tool_steps_ceiling` (`DYFJ_MAX_TOOL_STEPS_CEILING`, default 64); the runtime refuses a value above it.

The receipt line adds `cached N%` when a provider reports cache traffic: the share of the turn's input read from the prompt cache. The turn result's optional `tokens.steps` lists each agent-loop provider call whose usage was recorded (purpose, fresh input, cache read, cache write, output and cost), and `/receipt steps` prints one line per listed call of the last turn in both REPLs. A call that failed before returning usage is not listed.

With no configured companion default, a bare turn uses the registry's local
default. The operator can instead configure a hosted companion default or
select a hosted model listed by `dyfj models`. Paid inference requires approval
on a loopback session through `--approve-paid`, `/model <slug> --approve-paid`,
or the standing `[paid].approve_paid_default` posture. Ordinary approved calls
inside the configured spend limits run without another budget prompt; a call
that crosses limits asks once per check, naming every limit it crosses, and
non-loopback callers fail closed. `/budget` in either REPL shows the limits,
and `--budget-turn`, `--budget-session`, `--budget-day`, `--budget-per-call`
and `--budget-runaway` set them for one session. Every call is receipted with
cost and prompt-cache telemetry. On the hosted OpenAI-compatible providers the
cached share of the prompt is reported apart from input and priced at the
catalog's cache rates, or at the input rate when a row has no cache price.

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
allowlist; boot names each configured tool that is not offered or whose schema
is rejected, with the reason, and `dyfj status` repeats those lines. Read tools
may be configured with `approval = "allow"`; every
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
dyfj --model codex-chatgpt/gpt-6.1-terra --approve-paid --fast exec "Fast one-shot turn"
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

The HTTP peer server is retired. UDS JSON-RPC is the only seam (`dyfj`); a remote or browser surface returns later as a thin gateway client of that seam.

The launcher's background runtime and `dyfj start` both serve the JSON-RPC seam
over a Unix domain socket, the canonical `loopback` transport, on Node:

```sh
dyfj start
```

It serves a duplex JSON-RPC 2.0 protocol — read methods for `runtime/liveness`,
`runtime/status`, `surface/snapshot`, `models/list`, `sessions/list`,
`sessions/inspect`, `events/query`, `ideas/list`, `ideas/get`, `packets/list`,
`packets/get`, `tools/list`, and `tools/inspect`; `runtime/stop`; the narrow
operator-approved `friction/post` method; `ideas/mark` and `packets/draft`; plus
streaming `turn` and cancellation `turn/cancel` methods — over a socket resolved
from `DYFJ_SOCKET` (else `$XDG_RUNTIME_DIR/dyfj`, else `~/.dyfj/run`), running
the shared turn core. `runtime/status` also reports the runtime's code
`fingerprint` (`{ head, contentHash }`), its open `clients` and its
`inFlightTurns`; `runtime/stop` with `{ ifSoleClient: true }` answers
`{ status: "declined", reason }` instead of stopping while another client is
connected or a turn is in flight. Clients that predate these fields ignore them.
`friction/post` accepts
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
protocol for interactive turns, approvals and `turn/cancel`, and for the
`/model`, `/fast`, `/session`, `/friction` and `/idea` commands (`models/list`,
`sessions/list`, `sessions/inspect`, `friction/post`, `ideas/mark`,
`ideas/list`); `sessions/inspect` also reports the session's recorded model,
which the Rust REPL restores on `--session` and `/session switch`; see
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

The experimental `--runner fixture` selector takes the separate external-agent test path. It launches the repository's deterministic ACP v1 fixture over local stdio without a shell, passes only a profile-selected environment and the resolved workspace, and emits runner-specific outer evidence rather than model/provider accounting. Sequential turns that share a Workbench session, workspace, and execution profile reuse one live ACP worker and session; a concurrent turn for that same key fails as busy instead of queueing. Turn cancellation keeps a healthy handle; a protocol or process failure removes it so the next turn can create a replacement. Idle handles retire on a TTL, capacity fails closed without eviction, and UDS close, a foreground SIGINT, or `dyfj stop` wait for in-flight creation and for every started close to settle, then surface a retained close failure rather than reporting success. A shutdown failure exits with status 1. On an interactive TTY, ACP activity remains visible through the terminal result: thought/tool updates select a bounded label, text/status/approval output temporarily owns the terminal, and the indicator resumes with the original elapsed timer and a truthful generic `working…` label when no more specific activity is known. Raw thought text is not rendered, persisted, or replayed. Interactive Unix-socket clients render every accepted ACP permission option (up to 16) as a numbered choice and return the exact selected option identifier. Invalid input re-prompts inside the same exchange up to three times before failing closed; empty or closed input, non-interactive use, or an unavailable approver selects the request's rejection option when present, otherwise the request is cancelled. Empty option lists and empty or duplicate identifiers fail at protocol ingress. The same permission-selection contract applies to every ACP profile. On non-Windows systems, fixture containment requires `/bin/kill` with negative process-group support: before each spawn the runner starts an inert `/bin/sleep 30` child in its own process group, checks that `/bin/kill -0 -- -<group>` reaches it, then kills it, so the runtime's run policy names `/bin/sleep` beside `/bin/kill`. When its parent dies, the fixture agent reaps its own process group with a signal (`process.kill(-pid, "SIGKILL")`), starting no process, so no spawn grant or permission model can refuse the reap. The probe child is a system binary rather than the runtime itself, and it exits on its own if the runtime dies mid-probe. Windows uses direct-child signaling. The fixture agent (`scripts/acp-fixture-agent.ts`) is written to `node:` builtins, and the fixture profile starts it as `<node> <script>` on the Node executable running the product (`process.execPath`), with no permission sandbox. `fixtureAgentCommand` in `src/acp-fixture-command.ts` builds that command, and the ACP tests that start the fixture themselves use it too. Initialization, prompt, cancellation acknowledgement, signal subprocesses, and child cleanup waits each have deadlines.

The experimental `--runner codex-chatgpt` selector uses a local stdio child and the community-maintained `@agentclientprotocol/codex-acp` adapter requiring adapter-reported ChatGPT authentication that the Workbench profile classifies as subscription-backed. Sequential Workbench turns reuse the same live adapter process and ACP session under the same session/workspace/profile rule as the fixture. It runs on supported non-Windows systems with `/bin/kill` and `/bin/sleep` (the process-group probe above) and an absolute operator home containing neither comma nor colon; inference may use remote services. Colons would split the child's `PATH`, and commas stay refused from the comma-separated grants the login once used, so the login script and the runtime reject either delimiter. The TypeScript CLI receipt names the routed model slug (for example, `codex-chatgpt/gpt-6.1-sol`) before the ACP protocol and access-route evidence; the runner result exposes it as optional `runner.modelSlug`, with the profile label used when absent. The Rust REPL currently shows only the shorter external-runner label. The route requires standing workspace trust and rejects remote calls and model-routing flags. Workbench uses a dedicated home under `~/.dyfj/runner-homes/codex-chatgpt/`, rejecting a symlinked, non-owned, or group/other-writable operator home and non-owned or group/other-writable existing `.dyfj` and runner-home directories without changing safe parent modes. It sets the runner-root, dedicated HOME, Codex-home, and Cargo-home directories to mode `0700`; the adapter receives a cleared allowlisted environment. ACP session updates remain finite per prompt: ordinary profiles allow 1,024 updates and this long-running profile allows 8,192, with the same resolved allowance enforced at protocol ingress and by the SDK consumer. Under a warm session those ingress counters reset at each prompt, so sequential turns do not inherit the previous exchange's budget. Newline-delimited protocol messages are also bounded by profile: ordinary profiles retain the 384 KiB ceiling, while this long-running profile permits newline-delimited messages up to 1 MiB each. The selected message ceiling is resolved once before stream construction and enforced before the SDK consumes the frame. Exceeding either update or message ceiling fails closed with a specific client diagnostic; the 16 MiB protocol-input and 60,000-byte agent-response caps apply per prompt/exchange; permission, timeout, cancellation, and process-cleanup bounds remain independent. This integration does not claim OpenAI support or endorsement and does not expand or interpret subscription terms. The project configuration pins adapter version `2.5.0` exactly, the npm lockfile records its transitive graph and registry integrity, and the runtime rejects installed package metadata that does not declare that version. The launcher selects the delimiter-safe regular executable path from `DYFJ_NODE_PATH` or ambient `PATH` and adds it to the runtime's run policy; at profile construction, the runtime resolves and validates the target then invokes the selected path without pinning that target or attesting that it is Node.js. `DYFJ_CODEX_TOOLCHAIN_PATH` may project one validated executable directory into the narrow child `PATH`, while `DYFJ_CODEX_RUSTUP_HOME` may project one validated Rustup state directory. Both selections reject slash-only root spellings and whole `.` or `..` components before filesystem resolution. The private Node shim and shell profiles are each written to a new file created exclusively (`wx`, mode `0600`) under a random name beside the final one, so no existing file is followed, then given their mode and renamed into place; a failure removes the temporary and reports a fixed diagnostic without the path. The child `PATH` places a private Node shim before the optional explicit executable directory, `/usr/bin`, and `/bin`; private zsh and Bash login profiles reset earlier macOS `path_helper` changes. It does not dynamically derive and add an arbitrary parent directory from the selected Node executable; the fixed `/usr/bin` and `/bin` entries remain, and the operator may explicitly select another directory as the toolchain. The child uses a separate persistent private Cargo home rather than the operator's Cargo home. Adding these environment selections leaves the existing Workbench ACP action-approval plumbing unchanged, and dedicated receipt evidence retains only the count of distinct canonical operator directories. These controls project tool discoverability and Rustup state access; they do not attest binaries. Generic direct engine tasks remain runner-neutral, so use the `dyfj` launcher for this route. Authenticate the dedicated home out of band before the first turn:

```sh
cd prototype
npm run codex-chatgpt-login
```

The login runs the adapter on `DYFJ_NODE_PATH` when it is set, and otherwise on the Node running the script.

Before `session/new`, Workbench requires `authentication/status` to return an object whose top-level `type` is exactly `chat-gpt`. A missing response or any other top-level type fails closed, and Workbench supplies no API-key or metered-provider fallback. Durable `runner_route_source` and `runner_auth_type` fields record the profile's declared route classification separately from the authentication type reported by the adapter and from caller `authn_*` fields. Workbench carries optional unstable ACP-reported prompt-response usage, context-window occupancy, and cumulative session cost as explicitly ACP-sourced receipt evidence rather than native accounting. The pinned Codex adapter reports token/context usage on this subscription route but not currency cost; the receipt states that USD cost was not reported. See the root README for the complete boundary and evidence contract.

**Runtime policy — committed lists vs. launch-resolved.** The runtime policy module (`src/config/runtime-policy.ts`) is the one committed source of the runtime's static net, run and env lists (`RUNTIME_NET_GRANTS`, `RUNTIME_RUN_GRANTS`, `RUNTIME_ENV_GRANTS`); the net and run lists are derived from tagged tables (`RUNTIME_NET_GRANT_TABLE`, `RUNTIME_RUN_GRANT_TABLE`) that give each entry its role, and `composeRuntimeGrants` records where each composed entry came from. The effective role policy (`src/config/effective-policy.ts`, with `-digest`, `-subset` and `-compile`) is built from that same composition. Natively, nothing reads or enforces it yet. On the opt-in contained Linux target (`sandbox/linux/README.md`), `scripts/sandbox-install.ts` derives the role policies from it, and `core/dyfj-sandbox` enforces their compiled output; `src/config/linux-launch-plan.ts` turns each role's compiled output into its bubblewrap, Landlock and nftables plan. There the launcher sets `DYFJ_EXECUTOR_SOCKET`, and the `bash` and `git` tools send their commands to the executor over it (`src/tools/builtin/executor-transport.ts`) instead of spawning them. The single declared engine surface (`CONFIG_SCHEMA` in `src/config/schema.ts`) is asserted against the env list by a parity test, so a runtime env var can't be declared without reaching the runtime, or reach it without being declared. Runtime code reads the environment only through the `Env` port in `src/config/env.ts`, and every `DYFJ_*` key it names is declared in `CONFIG_SCHEMA`; the `arch.imports` gate lane enforces both. A few entries are inherently machine- or operator-specific and so are *never* committed — `dyfj start` and the engine at boot compose them into the runtime policy (`composeRuntimePolicy`): the private memory-endpoint host, configured external MCP hosts, `[network] allow` entries, `<ip>:53` for each `nameserver` in `/etc/resolv.conf` (the web tools' address check resolves hostnames through them), the configured `DOLT_HOST:DOLT_PORT`, and — when a `[secrets]` resolver is configured — the resolver command binary. The runtime runs on Node as plain `node`, with no permission flags (`RUNTIME_NODE_PERMISSION_FLAGS` is empty), and enforces the policy in code at its seams (`src/config/egress.ts` for HTTP and the Dolt pool, `src/config/spawn-guard.ts` for child processes); the root README's "Egress, spawn and environment limits" section describes them and why Node's `--permission` is not used for the runtime. `dyfj start` also starts the runtime with an explicit environment, exactly the policy's names plus `TMPDIR`, `TMP` and `TEMP`, and `DYFJ_SOCKET` set to the socket the client resolved: it reads `.env` itself (ambient values win, as with `--env-file`), filters the result to those names, and starts the runtime without `--env-file`. Node has no environment permission, so the CLI reads every variable in its own environment. Fail-closed: `dyfj start` refuses to run when it can't establish a trusted prototype root (`DYFJ_PROTOTYPE_ROOT` or its own on-disk install location), rather than trusting the current directory's `src/server/main.ts` and `.env`. See "Hosted inference" and "Configured external MCP tools" in the root README for the configuration shapes.

For an operator-facing recall check without an external memory or credential,
run `npm run memory-recall-uat-fixture` (add `-- --port <n>` for another port than 43137). It serves a strict modern MCP endpoint
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

The prototype reads Dolt connection settings from environment variables. For the default local server:

```sh
export DOLT_HOST=127.0.0.1
export DOLT_PORT=3306
export DOLT_USER=dyfj_runtime
export DOLT_PASSWORD=<your-local-dolt-password>
export DOLT_DATABASE=dolt
```

Run the Workbench as its own Dolt user, not `root`. The user and the table
grants it needs are in [Dolt users](../schema/README.md#dolt-users). If
`DOLT_USER` is unset, the runtime connects as `root`.

Useful checks:

```sh
npm run test:file -- <path>... [--filter <pattern>]
                         # named unit test files, no full typecheck
                         # (paths and one --filter only; exits 2 otherwise)
npm run verify-workbench-events  # one live turn, then check its journal events
npm run test:golden      # golden characterization suite (needs Dolt)
npm run test:golden -- --update  # rewrite snapshots (see below)
(cd .. && npm test)      # repository aggregate gate, typecheck included
```

Use `test:file` for tight iteration loops on a unit test file: it skips the full
typecheck and runs only the named files, unsandboxed under `node --test`. It runs
unit files only: a `*.integration.test.ts` path is rejected before any test starts,
with exit 2 and a message naming the file and the integration lane (`npm test` from
the repository root), since an integration file needs the isolated Dolt fixture. Use
the root `npm test` before commit: it typechecks the entire codebase
(`typecheck.tsc`) and runs every lane.

The `test.unit` and integration file lists are derived by walking the tree
(`scripts/test-files.ts`); nothing is hand-listed. The tier is the file name:
`*.integration.test.ts` files run in the isolated-Dolt integration lane,
`testing/golden/` has its own lane, and every other `*.test.ts` is a unit test.

Tests run on `node:test` only (decision D32, `specs/03-testing.md` §1). Each lane
checks every file it discovers: a file that calls the retired runtime's test
function or imports `@std/testing/bdd` fails discovery with its path in the
message. All three runners run their files with `node --test --import
testing/node-handle-check.ts --test-concurrency=<jobs> --test-reporter=tap`, one
process per file, with the lane's environment (`scripts/node-test-lane.ts`). Each
runner needs Node 26 on `PATH` and fails with a message saying so otherwise. An
empty run is reported as `0 files`, and each run ends with a count line, for example
`test.unit node --test: ok | 52 passed | 0 failed | ...`, parsed from the TAP summary.
The handle check is preloaded into each file's process: it fails a file that
leaves a server, socket, timer or child process live after its last test, naming the
file and the leaked resource types, and exits that process so the run cannot hang.
Before it compares, it waits for the file's own stdout and stderr to flush, since a
write still in flight there is the runner's output to its parent, not a leak; and it
lets the runner finish reporting the file's tests before the exit. It
is per file, so it is coarser than a per-test sanitizer: it names the file, not the
test. Under `node --test`, tests run with no permission sandbox.

The integration lane stays hermetic, so the real `node:dns` resolver's
`DnsResolver` conformance cases (`src/tools/web/dns.integration.test.ts`) are
reported skipped there. They query the system resolver, and run only when
`DYFJ_TEST_REAL_DNS=1` is set; the lane does not pass that variable through, so run
the file directly to exercise them:
`DYFJ_TEST_REAL_DNS=1 node --test --import=./testing/node-handle-check.ts src/tools/web/dns.integration.test.ts`
from `prototype/`.

Product unit and component tests run unsandboxed under `node --test`, so nothing
stops one from reaching Dolt, the network or a child process; keeping them off those
is the test author's job. Write fixture output to a temp directory
(`mkdtemp(join(tmpdir(), prefix))` from `node:fs/promises`, `node:os` and `node:path`),
never the working tree.
`src/engine/headless-host.component.test.ts` uses these fakes to exercise the
native runtime directly from two isolated host configurations and to check a
denied mutation; it does not start the socket server or a cluster workload.

Shared test support lives in `testing/` (never imported by runtime code): the golden
suite in `testing/golden/`, loopback servers in `testing/servers/`, and the port fakes in
`testing/fakes/`: `ScriptedHttpTransport` (`HttpTransport`), `ManualClock` (`Clock`),
`MapEnv` (`Env`), `ScriptedDnsResolver` (`DnsResolver`), and `fakeIo` (the CLI's terminal
`Io`), plus `SequentialIds` (ULID-shaped IDs), which landed ahead of an `IdSource` port.
The `Store` fake, `MemoryStore`, lives in `src/store/`. A unit test replaces a port with
its fake; module mocking is not allowed (`specs/03-testing.md` §1). A fake's conformance
suite lands with the port it stands in for; `fakeIo`'s is deferred (`specs/03-testing.md` §3).
Tests do not define their own fake `fetch` or loopback server: code that takes `typeof fetch`
is scripted through `ScriptedHttpTransport.fetchLike`, and real-socket tests use
`testing/servers/` (`model-server.ts`, `mcp-server.ts`, `scripted-http-server.ts`, and
`listeners.ts` for a listener that never answers, a connected Unix-socket pair, or a stale
socket file).

An integration test that binds or dials a real Unix socket takes its path from
`testing/servers/uds-sockets.ts`: the isolated-Dolt integration lane creates one
directory and passes it in `DYFJ_UDS_TEST_SOCKET_DIR`. A new socket-using test adds
its socket name there.

Local imports name the file they load, extension included (`./utils.ts`, not
`./utils`), so an extensionless local import fails the typecheck. Third-party
packages are imported by package name and resolve from the root `node_modules`;
the dependency policy rejects a `jsr:` specifier.

`test:golden` runs the golden characterization suite in `testing/golden/`:
thirteen black-box scenarios that drive the engine server (`src/server/main.ts`)
and the CLI (`src/cli/main.ts`) as child processes against an isolated Dolt
fixture, a loopback model server (`testing/servers/model-server.ts`) and a
loopback Linear MCP server (`testing/golden/linear-mcp.ts`, built on the shared
loopback MCP server in `testing/servers/mcp-server.ts` that the MCP integration
tests also use). Each scenario's stream frames, RPC responses,
rendered CLI output, and `events`/`sessions` rows are normalized (generated
IDs, timestamps, durations, temp paths, PIDs and the fixtures' loopback
endpoints only) and compared with `testing/golden/snapshots/`. During the
phase-1 restructuring a snapshot may change only for a reason the PR states,
as `specs/03-testing.md` §4 sets out; `--update` rewrites them.

The golden suite registers with `node:test` and runs under `node --test` with the
per-file handle check, which passes a test file no arguments and has no permission
sandbox. So `testing/golden/run.ts` turns `--update` into `DYFJ_GOLDEN_UPDATE=1` for
the test process, and every snapshot write goes through `writeSnapshot` in
`testing/golden/snapshots.ts`, which throws unless that variable is `1`. A plain run
fails on a missing or changed snapshot without writing it; `snapshots.test.ts` pins
both cases and the update path. Before the move to `node:test`, the runner's write grant
on `testing/golden/snapshots` enforced the same rule. Any suite argument other than `--update` is refused, because nothing could pass it
on.

### Disposable runtime

From `prototype/`, `node scripts/scratch-runtime.ts up` starts a foreground
instance and prints its state-file path once it answers liveness. Keep that
terminal open; copy the path into `scratch_state` in another terminal:

```sh
scratch_state=/tmp/dyfj_s_EXAMPLE/state.json  # use the printed path
node scripts/scratch-runtime.ts env --state "$scratch_state"
node scripts/scratch-runtime.ts exec --state "$scratch_state" 'Say hello.'
node scripts/scratch-runtime.ts evidence --state "$scratch_state"
node scripts/scratch-runtime.ts down --state "$scratch_state"
```

`exec` launches the product's `dyfj exec --json` and records its reply and full
receipt for `evidence` and `down` (the latest invocation). `down` prints the commands, reply, receipt and boot commit after the
instance and its children stop and the temporary root is removed. Before
signalling a process, `down` requires the state file to be owned by the current
user with mode `0600` and checks that the PID's command is this script running
`up`. It prints
an explicit notice if no turn was recorded. Ctrl-C or SIGTERM in the `up`
terminal also stops the instance and removes its root. Startup failures clean
up too. Exported variables point at deleted paths after shutdown; use them
inside a separate shell.

For direct CLI use, `env` prints quoted shell exports. Start a shell with
`env -i PATH="$PATH" /bin/sh`, apply those exports there, then use
`node src/cli/main.ts exec --json 'Say hello.'` or the checkout's `dyfj`
launcher as usual. Read the full `receipt` field from the JSON result.
Bare `/receipt` is unavailable in both existing REPLs; `/receipt steps` only
shows per-call usage for a turn run in that REPL. Direct invocations are not captured by the
recording helper; retain their output separately.

`up --script replies.json` accepts a nonempty JSON array of loopback model
replies, consumed in order with the last reply repeated:

```json
[{"kind":"text","text":"A deterministic reply.","usage":{"promptTokens":10,"completionTokens":5}}]
```

Replies may also be `{"kind":"tool","tool":"file.read","arguments":{...}}`
(using an offered registry tool ID), or `{"kind":"hold","text":"Waiting"}`
for cancellation. Malformed scripts fail before boot. The default is the fixed
text `Scratch reply.`. The only active model is `scratch-local`, with zero
cost and a loopback endpoint; real-model behavior and paid routes require
maintainer runtime verification. The instance holds no operator credentials.

The boot path lives in `scripts/disposable-runtime.ts`, shared with the golden
harness: isolated Dolt and catalog seed, model server, Linear MCP fake, engine
profiles, and CLI launches. For this command the Dolt repository, temporary
HOME, configuration, workspace, temp files and socket all live under its fresh
root. Each Dolt fixture child uses `<fixture-root>/home` as HOME. The state
file is owner-readable/writable and carries the supervisor PID, child PIDs,
socket, CLI environment and boot commit. The lifecycle isolation test runs in
the existing integration lane (`scripts/scratch-runtime.integration.test.ts`).

The root aggregate gate runs the schema, Rust, isolated-Dolt integration, and
golden characterization lanes in addition to this prototype unit suite. The integration
lane runs every `*.integration.test.ts`: product files under `node --test` with the
per-file handle check, which catches a leaked server, socket, timer or child process, per
file. Under the gate,
the unit, integration and golden runners are supervised test lanes
(`scripts/lane-supervision.ts`): each runs on Node, has a deadline, a backstop for when
the gate itself is gone, and stops its own process group when its work is done or its gate
dies; the root README describes it. A direct `npm run` of a lane is unsupervised. The lane owns
a temporary Dolt repository and SQL server, with cleanup on normal completion and handled
failure. SIGINT and SIGTERM request cooperative cancellation; the direct lane process
receives SIGTERM followed by a bounded wait and possible SIGKILL. The Rust tracer test
retains
its manual-run `.env` loader, but the fixture's explicit `DATABASE_URL` takes
precedence, so the lane does not use an operator database.

For Workbench failures that look like "the model never responds", check the selected local provider directly before debugging DYFJ. For MLX-LM Server:

```sh
curl -sS http://127.0.0.1:18080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit","messages":[{"role":"user","content":"pong"}],"max_tokens":1}'
```

For llama.cpp:

```sh
curl -sS http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"llama-cpp/qwen3.6-35b-a3b","messages":[{"role":"user","content":"pong"}],"max_tokens":1}'
```

The response must include generated text. Health/list endpoints such as Ollama `/api/version`, `/api/tags`, and `/api/ps` do not prove the model runner can load.

## Layout

- `src/` — the `dyfj` CLI's interactive REPL (`cli.ts`, entered through `cli/main.ts`), the engine entrypoint (`server/main.ts`), the JSON-RPC/UDS transport seam, shared runtime boundary, native provider path, ACP client runner, tests
- `src/kernel/` — layer L0: pure shared helpers with one implementation each (UTF-8 byte bounding, code-point prefixes, terminal escape stripping, boundary-text sanitizing, ULID/trace/span IDs, canonical JSON, the time-bounded regex matcher, lexical path checks, credential-shape detection and scrubbing (`sensitive-shapes.ts`), the shared file-stat shape (`FileStat`, `fileStat`, `hasVerifiableIdentity`) that the file tools and the repo-context loader both read through, and the `Clock` port with its system adapter, which `testing/conformance/clock.ts` holds to the same contract as the `ManualClock` fake), imported through `src/kernel/mod.ts` and importing nothing from other runtime layers
- `src/contract/` — layer L1: the runtime contract shared by the engine, its runners, the server, and the CLI (turn request, receipt and stream-frame types, runtime auth and event types, the persisted session-event read shape (`WorkbenchSessionEvent`), history-omission notices, `DomainError`, the `Runner` interface, and the wire trust policy in `summarizeError` and `workspaceRootForTransport`), imported through `src/contract/mod.ts` and importing only `src/kernel/`; wire types stay plain data. The engine binds its external-agent (ACP) runner through the `Runner` interface: the UDS server composes it, so the engine never imports the ACP runtime
- `src/config/` — layer L1: the declared configuration surface, imported through `src/config/mod.ts`: the env-key schema (`CONFIG_SCHEMA` in `schema.ts`, every `DYFJ_*` key declared), the `Env` port (`env.ts`, over `process.env`, the only runtime module that reads the process environment), the one default text-file reader the loaders share (`read-text-file.ts`), the launcher's `.env` parser, TOML loading and the engine config, the `[secrets]` and `[mcp]` parsers, the budget and agent defaults, and the Dolt connection settings (`dolt.ts`), the launcher's MCP and Dolt net-grant derivation (`mcp-net-grants.ts`) and the memory-recall endpoint rule, https or loopback-only http (`memory-url.ts`), secret-pointer resolution into the engine's environment at boot with the launcher's resolver run grant (`secrets.ts`), the `[network] allow` parser (`network-config.ts`), the runtime's egress, spawn and env policy (`runtime-policy.ts`) with the guards that enforce it at the product's seams: the guarded fetch and the Dolt endpoint check (`egress.ts`) and the guarded spawn (`spawn-guard.ts`), and the effective role policy built from the same composition, with its digest, subset check and platform compilers (`effective-policy*.ts`, not yet read at runtime). The `arch.imports` lane enforces that no other runtime module reads the environment
- `src/store/` — layer L2: the store port and the only code that issues SQL (`specs/02-data-layer.md` §2), imported through `src/store/mod.ts`. `journal.commit` is the one mutation path: a batch's events, their projections and its declared unjournaled mutations (`store/unjournaled.ts`, each kind with the reason it has no event yet) commit in one transaction. Read-only readers cover events, sessions, memories (the loopback/non-loopback/MCP-stdio clearance rule lives in `store/memories.ts`), the model catalog, prompts and spend baselines. `store/sessions.ts` holds the session-record helpers over the port: session create and update through the journal, the session list and record reads, and the typed read-back of a session's events. `DoltStore` runs over one `mysql2` pool the composition root builds from `src/config/dolt.ts` and passes in (`createDoltPool` refuses any endpoint but the runtime policy's configured Dolt host and port); `MemoryStore` is the in-memory adapter for tests. Both pass `testing/conformance/store.ts`. `writeModelSelectedEvent` (`model-selected-event.ts`) commits the `model_selected` event through the journal. The readers get only a handle that runs a single `SELECT`; only the journal holds a write-capable connection. `mysql2` may be imported only here, which the `arch.imports` lane enforces. `store/generated/rows.ts` is generated from the DDL by `schema/codegen.ts` (row and insert types, column tuples and declarations, SQL enum unions; never hand-edited, and the `schema.codegen` gate lane fails when it is stale). Every event is built with its per-type constructor in `store/events/builders.ts`, so `journal.commit` takes only typed `EventInsert` values. At boot, `serve-unix` runs `DoltStore.assertCanonicalColumns`: a reachable database missing a canonical column stops the engine with the missing columns named; there is no fallback for an un-migrated database
- `src/budget/` — layer L2: per-session spend tracking and its gates, imported through `src/budget/mod.ts`: the tracker (`tracker.ts`: per-turn accumulation, the pre-call figures for every spend limit, the tool-progress mark the runaway limit measures from, and the `budget_summary` event written through the journal), spend baselines and the local-day boundary (`spend.ts`, read through the store's spend reader and the `Clock` port; a baseline sums every paid call's `provider_call` cost, so a turn that failed or halted counts too), the spend check (`envelope-gate.ts`: the per-call, runaway, turn, session and daily limits, one warn-then-confirm prompt per call, fail closed without a confirmation channel), the ceiling confirmation store (`confirmations.ts`: one `CeilingConfirmationStore` per engine, held by the engine's `SessionOwners`, which the composition root in `src/server/main.ts` builds, and reached by the runtime as each session's budget scope). Imports only `src/kernel/`, `src/contract/`, `src/config/`, and `src/store/`
- `src/context/` — layer L2: what the model sees on a turn, imported through `src/context/mod.ts`: workspace/repo context packing and AGENTS.md loading (`repo-context.ts`), companion prompt composition (`prompts.ts`), transcript compression (`compression.ts`), length-stop and context-overflow recovery (`length-recovery.ts`), request fitting (`request-fit.ts`: the input budget a request may fill on a model's context window, the window-bounding of a fresh tool result, and the shrinking of earlier tool results to a prefix plus a marker the model can read), and the conversation projection that rebuilds a session's prior turns from its events (`conversation.ts`). Imports `src/kernel/`, `src/contract/`, `src/config/`, `src/store/`, and provider types only
- `src/transport/` — layer L2: the JSON-RPC 2.0 process seam over Unix sockets (codec and framing, request dispatch, the duplex connection peer, socket-path resolution, the client connect, the server bind/accept loop, and the request-parameter sanitizers every method module runs its params through (`rpc-params.ts`)). The peer, client and listener depend on the byte-stream ports in `connection.ts` (`ByteConnection`, `ConnectionListener`, `SocketHost`); `node-socket.ts` is the one `node:net` adapter behind them and today the only non-test module that imports `node:net`; the `arch.imports` lane confines `node:net` to `src/transport/`. Imported through `src/transport/mod.ts` and importing only `src/kernel/`, `src/contract/`, and `src/config/`. The CLI reaches the engine only through it; the engine's method handlers are in `src/server/rpc/`. The Rust REPL client in `../core/dyfj-repl` speaks the same wire format, so framing, method names, error codes, and socket-path resolution stay byte-identical
- `src/providers/` — layer L2: model providers behind one `ProviderAdapter` interface (`specs/01-architecture.md` §5.2), imported through `src/providers/mod.ts`. `registry/` parses the catalog from the store's model reader (declared structurally, so `providers/` does not import `store/`), routes turns, holds the built-in local defaults, and dispatches each turn to the adapter serving the selected model's provider; a provider no adapter serves fails closed. One directory per API family (`openai-compatible/`, `anthropic/`, `gemini/`) holds its request, stream, usage and stop-reason code; `shared/` holds what they share (SSE line reading, text tool-call extraction, token estimates, wire-safe tool names, base-URL rules); `http.ts` holds the `HttpTransport` port and the header deadline. The OpenAI-compatible adapter recovers a tool call a model writes as text (a complete `<tool_call><function=NAME>…</function></tool_call>` block) only when the request offers that tool, so a forced conclusion, which offers none, never runs one; any tool-call markup left in the text that ran no tool (each function element of a complete block recovery did not run, counted once toward its innermost wrapper, plus unmatched `<tool_call>` openings when there are two or more) is reported as the result's `unparsedToolCallMarkup` count, which the engine records on the `provider_call` event and discloses as an `unparsedToolCallMarkupDetected` runtime event. The Anthropic adapter keeps a buffered reply's blocks in order when the reply carries `thinking` or `redacted_thinking` blocks, as the result's `replay`, and the agent loop carries it on that tool step's assistant message, in memory only. The next request of the turn sends that reply back unchanged, as Anthropic requires within a tool turn, while the `system` prompt, the tools and every earlier message are what the reply was produced under (a SHA-256 digest of that prefix rides with it); after a forced conclusion, a context fit or a compression has changed the prefix, that reply and every later one are sent as text and tool calls without thinking. Nothing new is journaled, and a resumed session rebuilds history without thinking, which Anthropic allows across turns. A model whose catalog capabilities include `thinking-progress-updates` (Claude Sonnet 5.5) is sent `thinking: {"type": "adaptive", "display": "updates"}` with the `thinking-display-updates-2026-08-18` beta header, and the text and progress updates of each tool-calling reply reach the operator as text frames before its tools run, and the turn's buffered reply then goes out as frames too, since a client that saw frames does not print the reply from the result; other Anthropic models are sent no thinking configuration. Each result's `usage.cost` carries a `basis`: the OpenAI-compatible adapter sends an OpenRouter request the row's prices as `provider.max_price` and records OpenRouter's billed `usage.cost` (`provider_billed`) when the usage that carried it covers the whole call, and falls back to the catalog rates (`catalog_estimate`), as every other adapter does. The engine writes the basis to `events.cost_basis` on `provider_call` and, for the turn, on `model_response` (billed only when every call was). A provider's failures are classified at the adapter, never relayed: `shared/failure.ts` reads the HTTP status and the body's documented markers (OpenAI-compatible including llama-server and OpenRouter, Anthropic, Gemini) and the runtime's `fetch` rejection, and every adapter throws one `ProviderFailureError` subclass (`errors.ts`: context exceeded with the provider's counts, authentication failed, rate limited or out of quota or overloaded, model not found at the provider, unreachable (refused, unresolved, network, or the header deadline), a redirect the adapter refused to follow, request too large by size, an OpenRouter request no upstream would serve at or below its price cap (`ProviderPriceCapRefusedError`, which states the cap), and the unclassified `ProviderRequestFailedError`), each a `DomainError` whose message Workbench writes from the provider name, the model, the status and a recovery hint, so the operator line, the `turnFailed` frame and the `error` event carry the condition instead of the opaque `[Error, N bytes]` label. An unclassified failure keeps the opaque treatment of the foreign part (the body's byte count, or the `summarizeError` label of a transport throw) and adds the provider and status. Every adapter reads a non-2xx body through `shared/error-body.ts`, to a 64 KiB cap with the rest cancelled and the cut reported, counting bytes as they arrive. The body is matched and dropped; the fixtures the classifier is pinned to are in `../testing/providers/failure-fixtures.ts`. Every adapter passes the provider conformance kit (`testing/conformance/provider-adapter.ts`) with recorded fixtures replayed by the scripted `HttpTransport` fake (its request building and stream parsing are pinned there too, as further named cases), which passes the port's own conformance suite (`testing/conformance/http-transport.ts`) alongside real `fetch`. Adding a provider follows `../specs/recipes/add-provider.md`
- `src/tools/` — layer L2: the command primitive (`specs/01-architecture.md` §5.4), imported through `src/tools/mod.ts`. `CommandDefinition` (`definition.ts`) is the one tool shape; the registry (`registry.ts`), argument validation (`validate.ts`), the call-shape policy (`policy.ts`), the shared redactor that applies each definition's declared argument and result redaction to the durable `tool_call` event (`redaction.ts`), the operator's one-line failure reason, withheld when it echoes an argument value (`failure-reason.ts`), and invoke-with-event (`invoke.ts`) serve every tool. `buildToolCatalog` (`catalog.ts`) is the one place a registry is assembled: the runtime's per-turn toolset, the `tools/list` and `tools/inspect` listing, and the Linear command set the linear extension resolves for friction all come from it. The builtin tools live beside their executors, each exported as a `define<Name>`: `builtin/memory.ts` (`memory.read`, `memory.search`), `builtin/file.ts` (the workspace file tools, with their executors split across `builtin/file-read.ts`, `file-write.ts`, `file-search.ts` and `file-glob.ts` over the shared containment and escaping in `file-access.ts`; each tool's own result cap (`read_file` 64 KiB, `grep_files` 128 KiB, `bash` 64 K characters) is a memory bound, not the model's: the engine bounds every result again against the window left for the turn, see `src/engine/` below; every call verifies the workspace root against the anchors in `builtin/root-anchors.ts`: one `RootAnchors` per engine, built in `server/main.ts` and handed to each turn through the engine's ports, so a root pinned on first use stays pinned for the engine's lifetime), `builtin/exec.ts` (`bash`, which runs in the workspace root or in the workspace directory its optional `cwd` names; under the `operator` posture on a loopback turn a call that `builtin/bash-allowlist.ts` classifies as read-only runs without a prompt, with basis `policy:allow:bash-allowlist`: a hand-written lexer accepts a small shell subset, chains of `git status|diff|log|show|rev-parse|branch --show-current`, `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg` and `sed -n` line printing joined by `&&` or `;`, optionally led by the no-op `cd "$PWD" &&` (any other `cd` asks; pass `cwd` instead), a trailing `2>&1` and `| head` or `| tail`; each command and git subcommand accepts only the options in its `OptionSpec`, every operand and every file-valued option (attached or separate) must resolve inside the workspace with symlinks followed segment by segment, an option-shaped word is an option unless it follows `--` (bash starts with `PWD` and `OLDPWD` set to its real directory and no `CDPATH`), and anything else asks; such a call runs with git's program-running config switched off (`GIT_SAFETY_ENV`: no fsmonitor, no worktree or global attributes and so no textconv or filter driver, no implicit bare repository, no signature check, no pager), and the write tools refuse any path with a `.git` segment so repository config cannot be planted), `builtin/git.ts` (`git`), both spawning through `builtin/bounded-process.ts`, which starts the command in its own process group and, at the call's timeout (for `bash`, 120 s unless the call's optional `timeoutSec` asks for another, up to a 600 s ceiling that is refused rather than clamped, with the effective deadline named in the approval prompt's title; 30 s for `git`), stops the whole group (TERM, a short grace, then KILL, each signalled through `/bin/kill` as the ACP runner signals its agent's group), drops output written after the deadline, and reports in the status line whether a descendant could have survived; the web capability tools are in `web/web.ts`, and their address check, which refuses a target it cannot verify as public, looks up hostnames through the `DnsResolver` port (`web/dns.ts`), whose `node:dns` `Resolver` adapter (a resolver per lookup on the system's default nameservers, read first so a process without the `sys` `networkInterfaces` grant reports the resolver unavailable; an abort cancels that lookup) and `ScriptedDnsResolver` fake both pass `testing/conformance/dns-resolver.ts`. Every tool the catalog can register passes the tool conformance kit (`testing/conformance/tool.ts`), which `src/tools/conformance.test.ts` runs over the builtins and the MCP-derived commands. Adding a tool follows `../specs/recipes/add-tool.md`
- `src/engine/` — layer L3: the turn pipeline (`specs/01-architecture.md` §5.1), imported through `src/engine/mod.ts`. It holds the turn entry (`turn.ts`: `executeTurn` runs a resolved turn under its session's lock, rebuilds the resumed conversation inside that lock, and binds boundary config and the transport's paid verdict; `turn-request.ts`: `resolveTurnFromBody` validates a turn request), session ownership (`session-owner.ts`: `SessionOwners` is the single writer for each session's turn lock (a turn that starts a new session gets its id allocated there at admission, so later turns naming it queue behind it), its budget scope (the ceiling confirmations, reached through `budgetScope`), its "allow this exact command for the rest of the session" grants (`session-grants.ts`, reached through `sessionGrants`: in memory only, never persisted, so a new session or a runtime restart has none), its tool history (`tool-history.ts`, reached through `toolHistory`: a copy of each successful result whose durable event holds only the redaction sentinel, and of the arguments the model sent for a call whose command declares `redactArguments`, as the turn added them to the model's transcript, kept in memory for the engine's lifetime and never persisted, so a restart loses it; bounded to 64 sessions, 1,024 results and 2,000,000 characters per session, oldest dropped first; keyed by the turn's trace id and the call id, and readable only in the clearance scope that recorded it), and each admitted turn's cancel signal, a `TurnTicket` the server routes `turn/cancel` to), route resolution (`route.ts`: `resolveRoute` chooses the native or ACP runner and, for an ACP route, checks workspace trust and runs the paid-escalation preflight; `selectModelRoute` is the native turn's model selection; `confirmPaidRoute` is the one preflight both paths use), the resumed session's route (`session-model.ts`: before route resolution, a turn that names an existing session and no model, tier, hint or runner of its own is routed to the model the session last ran on, the model of its latest completed `provider_call` or `model_response` (compression calls excluded; `model_response` is an integrity write, so a turn whose best-effort `provider_call` write was skipped still counts; a model a turn only selected, or whose call failed, never dispatched or was cancelled, does not count), reported with the route reason `session_model`; a recorded model that is no longer routable fails the turn with `SessionModelUnavailableError` instead of falling back to the configured default, and a session whose latest turn ran on an external-agent runner (a newer `agent_response`, whose model the log does not record) fails it with `SessionRunnerNotRestorableError` rather than route the runner's conversation to an older native model), the observed provider call (`observed-call.ts`: `observedProviderCall` calls the provider, writes the `provider_call` event and records usage with the budget tracker, for both the agent loop and transcript compression), the engine's error classes and `classifyErrorKind` (`errors.ts`), and best-effort event writes (`event-writes.ts`). The native turn is `native-runner.ts` (`runWorkbenchRuntime`, which also hands an ACP route to the bound external-agent runner port), which runs the pipeline stages in order over an engine-owned `TurnState` (`turn-state.ts`, with the `NativeTurnPorts` the stages use: store, budget confirmations, clock, env, the provider transport, the spend rollup and the overflow compressor). The stages are `openSession` (`open-session.ts`: identity, budget posture, `session_start`), `buildContext` (`build-context.ts`: workspace root, repo or companion context, AGENTS.md elevation, the history-omission notice), `budgetGate` (`budget-gate.ts`: model selection, the entry spend check and the paid-consent check, `model_selected`) and `loadTranscript` (`load-transcript.ts`: the first call's conversation, with proactive compression through `compression.ts` on a model whose adapter sends the transcript (never on Gemini, which sends only the prompt), which the agent loop's overflow recovery and the request fit share; a compression request is sized against the compressor's own window, so an elder larger than it is compressed from its oldest turns in passes, with the rest kept verbatim between the summary and the tail until the next pass). `agentLoop` (`agent-loop.ts`) runs the model and tool steps up to the tool-step limit, and ends tool use early, with a no-tools concluding call, when the model repeats prior calls or a call is not approved (the model then reads an `approval_denied:` refusal in place of a result, `toolCallCompleted` carries `verdict: "approval_denied"`, and the operator gets control back); its calls go through `observed-turn.ts` (per-call gates, recording, frames) and `recovered-turn.ts` (length-stop recovery, and, on an adapter that sends the transcript, the refit-then-retry when a provider rejects a request as larger than its context window, where a refit that cannot bring the request under the window fails the turn with the provider's measured sizes rather than the fit's estimate; Gemini sends only the prompt, so its rejection fails the turn as context overflow without a retry). Every call is fitted to the selected model's context window first (`fit-request.ts`): the request is estimated with its tool definitions against the window less the output cap the request transmits in full (`modelTransmittedOutputCap`; a bounded default when it sends none, as a local request with no cap requested does), and one over that budget is shrunk before it is sent, earlier turns' tool results first (oldest first, to a 1 KiB prefix and a marker that says what was cut and how to get the rest), then elder turns compressed through `compression.ts`, then the current turn's results; a request that still does not fit fails the turn with `ContextWindowOverflowError` and is never sent (the estimate measures what the adapter puts on the wire, `modelRequestCarriesTranscript`: Gemini sends only the system prompt and the current prompt, so it is sized by those alone; the length-recovery retries are fitted the same way, shrinking only). Each tool result is bounded the same way as it is produced, to its share of the window left for the turn, so a result larger than the window (a search over the whole workspace, a whole changelog, a test run's output) reaches the model cut and marked rather than failing the call. Shrinking is a projection of what the model is sent: the durable `tool_call` event keeps the result within its own column limit, and resume rebuilds from the events, where the next turn's fit shrinks again. Both are reported as `toolResultTrimmed` and `contextFitted` runtime events. On that rebuild, a successful result whose event holds exactly the redaction sentinel (`bash`, `git`, Linear, MCP and web) is replayed from the session owner's tool history when this caller's clearance recorded it, and otherwise as a line saying the output is not available and that rerunning the command shows it, never as the bare sentinel. A replayed call to a command that declares `redactArguments` is handled the same way: the arguments the model sent come from that history, and a call with no saved arguments replays `{"_withheld": "arguments not kept in session history"}` rather than the sentinel. The decision is the command's, keyed on its id (`redactsArgumentsById`), never the persisted value, so a command that declares no argument redaction replays what it was given unchanged. `finalize.ts` ends every turn: `completeTurn` records a finished or cancelled turn, `failTurn` classifies a failure by its real class (a classified provider failure is recorded as an expected condition, with its class in the `error` event's `provider_error_class` and its Workbench-written message as the content), and `finalize` writes `session_end`, the budget summary, the receipt and the session record, then returns the result or rethrows the turn's error after the receipt. Receipt and tally formatting are in `receipt.ts`, the next-work worklet in `next-work.ts`, runtime-event delivery in `runtime-events.ts`, and the runtime's input/services/result types in `runtime-types.ts`. A turn calls back to its caller only through the ports on its input: the `Approver` (paid escalation, spend checks, tool approval and ACP permission options), the `FrameSink` (runtime events, text deltas and narration), and its ticket's `CancellationWindow`; the spend rollup and the context-overflow compressor are services (`WorkbenchRuntimeServices`). Engine tests run on `node:test` against the fakes in `testing/builders/engine.ts`, with no mocked modules: per-stage units, and component tests (`*.component.test.ts`, with `engine.component.test.ts` for the whole pipeline) that drive whole turns through a scripted provider transport, the real provider adapters and the real tool catalog.
- `src/extensions/` — layer L4: optional features behind the Extension interface, one directory per extension, each importing only lower layers and never another extension; the core never imports them, only `src/server/` and the CLI's `client.ts` entries do. `extensions/ideas/` serves two extensions, `ideas` (`ideas/mark`, `ideas/list`, `ideas/get`) and `packets` (`packets/draft`, `packets/list`, `packets/get`), built as a pair by `createIdeaPacketExtensions` over one `IdeaPacketRegistry` the pair owns (a packet references its idea, and eviction crosses the two). The registry is in memory, so ideas and packets last as long as the engine process. `idea-packet.ts` is the domain (marking, drafting, the Markdown rendering); `client.ts` is what the REPL imports for its in-process `unix: false` path, whose registry the REPL session owns. `extensions/linear/` holds the bounded Linear issue-creation tool (`linear-tools.ts`), whose builder the composition root hands MCP discovery as its `buildIssueCreationCommand` port, so discovery never imports it; and the `linear` extension, which resolves once, from the discovered commands, the Linear commands other extensions call (`get_issue`, `list_comments`, and `create_comment` or `save_comment`) and invokes them through one registry of exactly those commands, each call receipted. `extensions/friction/` holds `friction/post` (`mod.ts`) and its numbering and comment domain (`friction.ts`); it reaches Linear only through those resolved commands, which arrive in `ExtensionDeps.linear`, asks the client, through the deps' `toolApprover`, only for a call the call-shape policy marks as needing approval, and owns the queue that runs posts one at a time. Its `client.ts` gives the REPL's `/friction` command the context normalization and receipt type. The `arch.imports` lane enforces that only `src/server/` and `src/cli/` import `extensions/` (`importOnlyFrom` in `scripts/arch-layers.json`)
- `src/server/` — layer L5: the engine server. `rpc/` holds one RPC method module per namespace, each a `build<Namespace>Handlers(deps)` over only the readers and settings it uses: `runtime.ts` (`runtime/liveness`, `runtime/status` with the method catalog, the code fingerprint and the client and in-flight-turn counts, `runtime/stop` and its conditional `ifSoleClient` form), `surface.ts` (`surface/snapshot`), `models.ts`, `sessions.ts`, `events.ts` and `tools.ts`, with the mapping of a client's `approval` answer to a verdict in `approval.ts`. `extensions.ts` defines the Extension interface (`../specs/01-architecture.md` §6): an extension has an id and returns its JSON-RPC methods from the `ExtensionDeps` the composition root hands it (the session readers, the Linear commands, and `rpcToolApprover`, which asks the client to approve a tool call the call-shape policy gates, and fails closed), and `buildExtensionHandlers` merges them, refusing a duplicate id or method. `turn.ts` holds `turn` and `turn/cancel`: it admits each turn through the engine's `SessionOwners`, records which turn each connection is running so `turn/cancel` reaches only its own, carries approvals to the client as server-initiated `approval` requests and streams deltas and runtime events back as `stream` notifications. The tests call the handlers through the transport's `dispatchRequest` (`testing/builders/rpc.ts`) with a scripted client context, with no socket. `lifetime.ts` owns the count of connected clients, which the transport reports, and stops an autostarted runtime 10 s after its last client leaves. `main.ts` is the composition root and the engine entrypoint (`dyfj start` runs it; its SIGINT handling is in `sigint.ts`): it loads the config, resolves secrets, builds the store (and runs the boot-time column check), the external MCP commands (handing discovery the Linear extension's issue-creation builder), the session owners, the turn runtime (binding the ACP runner and its warm-session map) and the ACP session map, builds the static extension list (every extension enabled; each engine owns its extensions' state), wires every RPC module and the extensions' methods, and binds the socket. `serveWorkbenchUnix` is that composition without the boot, which the socket-level tests (`main.integration.test.ts`, `console-canary.integration.test.ts`, `events-asof.integration.test.ts`) build over their own store
- `src/cli/` — layer L5: the `dyfj` client's non-interactive parts, the ones that stay in TypeScript while the interactive REPL in `src/cli.ts` is replaced by the Rust client in `../core/dyfj-repl`. `main.ts` is the client entrypoint (the launcher and the golden harness run it on Node): it parses the arguments and dispatches to a one-shot turn, a subcommand or the REPL. `args.ts` holds argument parsing (also the launcher's validity contract, through `--parse-check`), config resolution and the help text; `io.ts` the client's ports (the terminal `Io`, the turn's Ctrl-C source and the socket `ConnectFn`) and their real adapters. `turn-client.ts` builds the turn request and runs a turn over the socket: it streams frames to its handlers and owns turn cancellation (`turn/cancel`, its acknowledgement and settle deadlines). `posture.ts` reads and prints the REPL's posture line and the `runtime is behind the working tree` warning, and holds an interactive session's connection to the runtime between turns, so an autostarted runtime does not stop under an idle REPL. `approval.ts` answers a mid-turn approval request interactively (an ACP permission option, a mutating tool, or a spend check) and fails closed without a terminal; on a request the runtime marks `grantable` (bash) it asks `approve? [y/N/s]`, where `s` also allows that exact command for the rest of the session; `exec` and the REPL share it. `render/` holds the turn's terminal output: streaming markdown (`streaming-markdown.ts`, `turn-output.ts`, which also renders runtime events as status lines), the busy spinner and its label sanitizing (`busy-spinner.ts`, `turn-spinner.ts`), the receipt line (`receipt.ts`) and error reporting (`errors.ts`). `commands/` holds one module per command (`exec`, `models`, `sessions`, `status` with the liveness probe, `stop`, `start`), and `freshness.ts`, the launcher-internal `--freshness-probe` that restarts a stale autostarted runtime. `launcher/grants.ts` reads the launch-resolved configuration the runtime policy is composed from (memory MCP and external MCP hosts, `[network] allow`, the Node executable, the secrets resolver and its inherited env names) and builds the runtime's Node arguments, and `launcher/runtime.ts` starts the runtime on the client's own Node from a trusted prototype root, foreground or autostarted. The client imports only `kernel/`, `contract/`, `config/`, `transport/` and `extensions/*/client.ts`, which the `arch.imports` lane checks; the launcher takes its net-grant and memory-endpoint rules from `config/`, so the client has no baselined exception. Tests use the `FakeIo` terminal fake and the scripted connectors in `testing/builders/turn-client.ts`; the real-socket `stop`, `status` and turn round-trip cases are integration tests
- `src/tools/mcp/transport.ts` — the MCP transport every MCP consumer shares: the byte-bounded fetch, the untrusted-result framing, bearer-header construction, and the one SDK client factory, used by the external MCP adapter (`src/tools/mcp/adapter.ts`, which derives a `CommandDefinition` from each configured server's discovered tools), the web tools (`src/tools/web/web.ts`), and memory recall (`src/tools/mcp/memory-search.ts`); `src/tools/mcp/conformance.ts` holds the MCP trace-context propagation, list freshness and retry rules they share. The memory record format, untrusted-memory framing and system-prompt assembly are in `src/tools/builtin/memory-records.ts`
- `mcp/` — MCP server (`server.ts`), a separate stdio entrypoint that builds its own `DoltStore` and reads and writes through the same journal and readers as the runtime
- `diagnostics/` — the manual local-provider and event-sequence diagnostic helpers (`model-response-modes.ts`, `context-size-response.ts`, `structured-output.ts`, `workbench-events.ts`) that the `examples/` programs run; outside the runtime graph, so no runtime module may import them
- `examples/` — diagnostic programs, verification helpers, and historical transport spikes; these are not operator launch paths

The diagnostics, `verify-workbench-events` and the `smoke` example are npm
scripts in `package.json` that run on Node and print their usage with `--help`
(`npm run <name> -- --help`); all but `smoke` load `.env` when it exists. The
`context-size-response`,
`model-response-modes`, `structured-output` and `structured-output-streaming`
scripts are manual local-provider diagnostics.
Pass their `--model` and `--base-url` options (after `--`) when testing the current local
stack; their built-in values target the registry's local default,
`llama-cpp/qwen3.6-35b-a3b` on `http://localhost:8080/v1`.
`verify-workbench-events` is the live event-sequence check, and `smoke` prints
the Node version. The transport implementation lives in `src/transport/`,
with the engine's method handlers in `src/server/rpc/`.

## Where this is heading

Components in `src/` that prove out and stabilize will get re-implemented in `../core/` (Rust). TypeScript stays here for prototyping anywhere that velocity matters more than substrate-level correctness; Rust earns its way in component by component.
