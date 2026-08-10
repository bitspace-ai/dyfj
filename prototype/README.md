# DYFJ Prototype (TypeScript on Deno)

This is the TypeScript prototype layer of DYFJ.

This layer contains working prototype code for Workbench CLI/shell, local HTTP, the JSON-RPC/UDS transport seam, shared runtime execution, a local ACP-client foundation, memory, command routing, provider routing, budget tracking, session persistence, MCP, and tests. Stabilized components can move into `../core/` when the Rust boundary is worth the extra compile-time structure.

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

The Apple silicon local default expects an OpenAI-compatible MLX-LM Server:

```sh
mlx_lm.server \
  --model mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit \
  --host 127.0.0.1 \
  --port 18080
```

Workbench uses `http://127.0.0.1:18080/v1` for that MLX endpoint. Ollama remains a supported local fallback; pass `--model laguna-xs.2` or set `DYFJ_WORKBENCH_MODEL=laguna-xs.2` to select the fallback explicitly.

Agent-tool turns default to 32 steps. Every entrypoint accepts `DYFJ_MAX_TOOL_STEPS`; served HTTP and UDS engines also load `[agent].max_tool_steps` from `~/.dyfj/config.toml`. Values are integers from 1 through 64, and the environment value takes precedence for served engines. The final receipt reports `Tool steps: used/limit` and marks when the configured limit ended tool use.

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

The operator commands are:

```sh
dyfj                      # streaming multi-turn REPL; autostarts the runtime
dyfj exec "Summarize this repository"
dyfj --runner fixture exec "Exercise the local ACP fixture"
dyfj --runner codex-chatgpt exec "Inspect this repository"
dyfj status
dyfj models
dyfj sessions
```

Inside the REPL, `/session` prints the current session id, `/model` shows or
switches the active model, and `/quit` or `/exit` quits cleanly.

The HTTP implementation remains available as an explicit standalone server; it
is not the default terminal-client path:

```sh
deno task workbench-http
```

The HTTP task listens on `http://127.0.0.1:8787/` by default. `GET /` returns a minimal HTML surface; `POST /api/turn` accepts JSON and calls the same single-turn runtime used by the CLI veneer; `GET /api/models` returns the model registry for pickers; and the session surface provides `GET /api/sessions`, `POST /api/sessions`, and `GET /api/sessions/{id}/events`.

Loopback needs no credentials. To serve additional interfaces (a private overlay network, for example), set `DYFJ_WORKBENCH_HTTP_HOST` to a comma-separated host list and provide a bearer key in `DYFJ_WORKBENCH_API_KEY` - non-loopback requests must present it as `Authorization: Bearer <key>`, and the server refuses non-loopback binds without it. `DYFJ_WORKBENCH_ALLOWED_HOSTS` allows extra non-loopback hostnames beyond the bind list. Authenticated requests are recorded on the event log with `authn_mechanism = api_key`. Project the key at process start (for example `op run`), as with provider keys; see the root README's "Remote access" section for the full posture.

The launcher's background runtime and `dyfj start` both serve the JSON-RPC seam
over a Unix domain socket, the canonical `loopback` transport. For direct
development use, the equivalent engine task is:

```sh
deno task serve-unix
```

It serves a duplex JSON-RPC 2.0 protocol — read methods for `runtime/status`, `surface/snapshot`, `models/list`, `sessions/list`, `events/query`, `tools/list`, and `tools/inspect`, plus streaming `turn` and cancellation `turn/cancel` methods — over a socket resolved from `DYFJ_SOCKET` (else `$XDG_RUNTIME_DIR/dyfj`, else `~/.dyfj/run`), running the same shared turn core as the HTTP path. `runtime/status` includes grouped method catalog metadata for client surfaces. The engine-free `dyfj` CLI reaches the read methods over it with `dyfj models` and `dyfj sessions`; after a TTY-backed UDS turn connects, Ctrl-C sends `turn/cancel` for REPL and one-shot turns, while pre-connection and non-TTY SIGINT behavior remains unchanged. After an autostarted server installs its SIGINT handler, when cancellation is the terminal outcome after the active provider or tool operation settles, the turn stops without stopping the runtime; a REPL allows another turn on the same session, while a one-shot exits with its interrupted receipt. An independent provider or protocol error that settles first remains an error rather than being masked. The launcher grants the concrete Unix-socket permission at runtime so custom `DYFJ_SOCKET` / `XDG_RUNTIME_DIR` paths keep working.

The experimental `--runner fixture` selector takes the separate external-agent test path. It launches the repository's deterministic ACP v1 fixture over local stdio without a shell, passes only a profile-selected environment and the resolved workspace, refuses permission requests without an explicit approval callback, and emits runner-specific outer evidence rather than model/provider accounting. On non-Windows systems, fixture containment requires `/bin/kill` with negative process-group support; Windows uses direct-child signaling. Initialization, prompt, cancellation acknowledgement, signal subprocesses, and child cleanup waits each have deadlines.

The experimental `--runner codex-chatgpt` selector uses a local stdio child and the community-maintained `@agentclientprotocol/codex-acp` adapter for a one-shot route requiring adapter-reported ChatGPT authentication that the Workbench profile classifies as subscription-backed. It runs on supported non-Windows systems with `/bin/kill` and an absolute operator home containing neither comma nor colon; inference may use remote services. Commas cannot be represented safely in this integration's comma-separated Deno grants, and colons would split the child's `PATH`, so the login task and runtime reject either delimiter. The route requires standing workspace trust and rejects remote calls, model-routing flags, session resume, and the REPL. Workbench uses a dedicated home under `~/.dyfj/runner-homes/codex-chatgpt/`, rejecting a symlinked, non-owned, or group/other-writable operator home and non-owned or group/other-writable existing `.dyfj` and runner-home directories without changing safe parent modes. It sets the runner-root, dedicated HOME, Codex-home, and Cargo-home directories to mode `0700`; the adapter receives a cleared allowlisted environment. ACP session updates remain finite: ordinary profiles allow 1,024 updates and this long-running profile allows 8,192, with the same resolved allowance enforced at protocol ingress and by the SDK consumer. Newline-delimited protocol messages are also bounded by profile: ordinary profiles retain the 384 KiB ceiling, while this long-running profile permits newline-delimited messages up to 1 MiB each. The selected message ceiling is resolved once before stream construction and enforced before the SDK consumes the frame. Exceeding either update or message ceiling fails closed with a specific client diagnostic; the 16 MiB cumulative protocol-input, 60,000-byte agent-response, permission, timeout, cancellation, and process-cleanup bounds remain independent. This integration does not claim OpenAI support or endorsement and does not expand or interpret subscription terms. The project configuration pins adapter version `1.1.10` exactly, the Deno lockfile records its transitive graph and registry integrity, and the runtime rejects installed package metadata that does not declare that version. The launcher grants the selected delimiter-safe regular executable path from `DYFJ_NODE_PATH` or ambient `PATH`; at profile construction, the runtime resolves and validates the target then invokes the selected path without pinning that target or attesting that it is Node.js. `DYFJ_CODEX_TOOLCHAIN_PATH` may project one validated executable directory into the narrow child `PATH`, while `DYFJ_CODEX_RUSTUP_HOME` may project one validated Rustup state directory. The child `PATH` places a private Node shim before the optional explicit executable directory, `/usr/bin`, and `/bin`; private zsh and Bash login profiles reset earlier macOS `path_helper` changes. It does not dynamically derive and add an arbitrary parent directory from the selected Node executable; the fixed `/usr/bin` and `/bin` entries remain, and the operator may explicitly select another directory as the toolchain. The child uses a separate persistent private Cargo home rather than the operator's Cargo home. Adding these environment selections leaves the existing Workbench ACP action-approval plumbing unchanged, and dedicated receipt evidence retains only the count of distinct canonical operator directories. These controls project tool discoverability and Rustup state access; they do not attest binaries. Generic direct engine tasks remain runner-neutral, so use the `dyfj` launcher for this route. Authenticate the dedicated home out of band before the first turn:

```sh
cd prototype
deno task codex-chatgpt-login
```

Before `session/new`, Workbench requires `authentication/status` to return an object whose top-level `type` is exactly `chat-gpt`. A missing response or any other top-level type fails closed, and Workbench supplies no API-key or metered-provider fallback. Durable `runner_route_source` and `runner_auth_type` fields record the profile's declared route classification separately from the authentication type reported by the adapter and from caller `authn_*` fields. ACP can surface model and usage data, but Workbench does not collect or attest those optional signals on this route, so its outer receipt omits native model, token, and USD accounting. See the root README for the complete boundary and evidence contract.

**Permission grants — committed profile vs. launch-resolved.** `deno.json` declares each entrypoint's static permission profile; the single declared engine surface (`CONFIG_SCHEMA` in `src/config.ts`) is asserted against those profiles by a parity test, so a runtime env var can't drift into one profile and out of another. A few grants are inherently machine- or operator-specific and so are *never* committed to a profile — the launcher resolves them at `dyfj start` and appends them to an explicit flag (which replaces, not extends, the profile list, so the launcher rebuilds the profile grants alongside): the concrete `unix:<socket>` path and the private memory-endpoint host on `--allow-net`, and — when a `[secrets]` resolver is configured — the resolver command binary on `--allow-run`. Fail-closed: `dyfj start` refuses to run when it can't establish a trusted prototype root (`DYFJ_PROTOTYPE_ROOT` or its own on-disk install location), rather than trusting the current directory's `deno.json`/`.env` for the child's grants. See "Hosted inference" in the root README for the `[secrets]` shape.

For a compiled daily-driver binary (Deno 2.9+), build and put `dist/` on your `PATH`:

```sh
deno task compile-cli   # dist/dyfj (launcher) + dist/dyfj-bin (compiled)
```

The launcher execs the fast compiled binary on the default socket path and falls back to `deno run` with a runtime-resolved `unix:` net grant when `DYFJ_SOCKET` or `XDG_RUNTIME_DIR` shifts the path away from `~/.dyfj/run/workbench.sock`. Without a compile step, `prototype/scripts/dyfj-launcher.sh` behaves the same via the `deno run` fallback.

The session coordination prototype lives below the operator surface. It is a visibility and advisory layer for coordination claims, launch packets, heartbeats, stale-base warnings, deterministic scope overlap, hook checks, reconciliation, and exit receipts. Workbench uses that primitive for delegated work while the CLI remains the daily-driver conversation client.

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
deno task check          # production and Vitest source typechecking
deno task check:tests    # Vitest sources only
deno task test           # checks first, then runs the prototype unit suite
deno task verify-workbench-events
(cd .. && deno task test) # repository aggregate gate
```

The root aggregate gate runs the schema, Rust, and isolated-Dolt integration
lanes in addition to this prototype unit suite. It owns a temporary Dolt
repository and SQL server, with cleanup on normal completion and handled
failure. SIGINT and SIGTERM request cooperative cancellation; the direct lane
process receives SIGTERM followed by a bounded wait and possible SIGKILL. The
Rust tracer test retains
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

- `src/` — Workbench entrypoint, shell, local HTTP veneer, the JSON-RPC/UDS transport seam, shared runtime boundary, native provider path, ACP client runner, command registry, memory, budget, session persistence, event verification, MCP client, utilities, tests
- `mcp/` — MCP server (`server.ts`)
- `examples/` — diagnostic programs, verification helpers, and historical transport spikes; these are not operator launch paths

The named `context-size-response`, `model-response-modes`, `structured-output`,
and `structured-output-streaming` tasks are manual local-provider diagnostics.
Pass their `--model` and `--base-url` options when testing the current local
stack; their built-in values target the Ollama development fixture rather than
the MLX daily-driver default.
`verify-workbench-events` is the live event-sequence check. The standalone
`uds-jsonrpc-spike.ts` records the original duplex-transport proof; the current
transport implementation lives in `src/jsonrpc.ts`, `src/jsonrpc-peer.ts`, and
`src/uds-server.ts`.

## Where this is heading

Components in `src/` that prove out and stabilize will get re-implemented in `../core/` (Rust). TypeScript stays here for prototyping anywhere that velocity matters more than substrate-level correctness; Rust earns its way in component by component.
