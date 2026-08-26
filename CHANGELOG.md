# Changelog

Notable changes to DYFJ. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

DYFJ is an actively developed prototype with no release tags yet, so entries are dated rather than versioned. Document-level revisions of the operating-context README are tracked separately in its Revision history section.

## [Unreleased]

### Added

- **Warm ACP Session Reuse**: Sequential ACP turns in the same Workbench session, workspace, and execution profile reuse one live worker and ACP session. Concurrent same-session work fails as busy instead of queueing. Turn cancellation keeps a healthy handle; protocol or process failure replaces it. Idle sessions retire on a TTL and capacity fails closed without eviction. UDS close, SIGINT, and `dyfj stop` wait for in-flight creation and for every started close to settle, then surface a retained close failure instead of reporting success. A shutdown failure exits with status 1. A timed-out reused route-evidence replay aborts its callback signal so a late durable selection event does not land. Standalone HTTP owns the same map without a close hook; idle TTL and process exit retire those handles.
- **Bounded Test Runtime Supervision**: Prototype Vitest runs through `run-vitest.ts` now take an exclusive operator-scoped run lock (`$HOME/.dyfj/run/dyfj-vitest-run.lock`), a wall-clock bound (`DYFJ_TEST_BOUND_SEC`, default 10 minutes or 3 minutes for a focused file/name), and a detached sibling reaper. Force-killing the runner reaps launcher/runtime leftovers, test sockets, and run-scoped `start-test-runtime-*.lock` files. A second run refuses to start while a prior run is still alive, including across checkouts. A hung suite fails the bound instead of occupying a worker indefinitely. Stale-lock recovery TERM-then-KILLs the saved Vitest process group only when identity and the recovering run generation match. Survivor discovery is scoped to the run tmp dir, spawn manifest, and explicit command needles.
- **Live ACP Progress Indication**: Interactive TTY turns now show an ephemeral spinner status for the full in-flight turn (`thinking…`, a bounded tool title, or the truthful generic `working…`) with one live elapsed timer. The indicator yields while response text, status, or an approval prompt owns the terminal, then resumes until completion. Raw thought text is not rendered, persisted, or replayed, and progress events do not enter durable session history.
- **ACP Usage Receipts**: External-agent receipts now carry ACP-reported optional unstable prompt-response usage and the latest context-window snapshot with explicit ACP provenance. The terminal receipt renders those fields when reported. Optional ACP cost remains labeled as cumulative session cost; subscription-backed Codex turns state that USD cost was not reported instead of inventing a dollar figure.
- **Codex ACP GPT-5.6 Terra Model & Fast Speed Tier**: Added `codex-chatgpt/gpt-5.6-terra` model and `fast-speed` capability to GPT-5.6 Sol and Terra in the model catalog and Dolt migration `011`. Exposed `--fast` / `--no-fast` CLI flags, `/fast [on|off]` REPL command, and `/model <slug> [--fast|--no-fast]` options with posture indicators, propagating `service_tier = "fast"` into `CODEX_CONFIG` for supported Codex ACP runners.
- **Automatic ACP Model Dispatch**: Selecting an ACP-backed model (such as `codex-chatgpt/gpt-5.6-sol` or `fixture`) via `--model`, `/model`, or `default_model` in `config.toml` automatically dispatches turns to the ACP runner without requiring explicit `--runner` flags.
- **ACP REPL & Multi-Turn Session Resume**: Allowed `codex-chatgpt` in interactive REPL turns and multi-turn session resume, forwarding session identifiers without one-shot rejection.
- **Direct xAI (Grok) Provider**: Added native provider support for `https://api.x.ai/v1` (configured xAI API key) under `frontier-hosted` modality with session-affinity header forwarding (`x-grok-conv-id`).
- **OpenRouter Aggregator & Hosted Frontier Model Lineups**: Refreshed catalog seed entries in `schema/catalog/001_models.sql` and added migrations `009` and `010` for current Anthropic, OpenAI, Google Gemini, and xAI models, plus verified OpenRouter aggregator endpoints.
- **Access Modality Classification**: Annotated models with access categories (`local`, `frontier-hosted`, `aggregator-hosted`, `subscription-oauth`, `custom-hosted`) across CLI listings and JSON-RPC methods.
- **Session Ideas & Work Packets**: Added REPL commands (`/session`, `/idea`, `/packet`) and UDS JSON-RPC endpoints to inspect session metadata, mark candidate ideas, and draft structured work packets.
- **Launcher Lifecycle & Stop Command**: Added `dyfj stop` subcommand, `runtime/stop` RPC method, and socket-keyed autostart lock files under `~/.dyfj/run/` to cleanly manage background runtime lifecycles.
- **Streamable HTTP MCP Client**: Added support for strict MCP `2026-07-28` Streamable HTTP servers with configurable tool allowlists, approval policies, and bearer auth.
- **W3C Trace Context Conformance**: Added W3C trace context extraction and propagation support across memory recall spans.
- **Local Context Compression**: Added transcript compression generated only on local models before prompt dispatch; summaries travel with the session transcript to the active session model, including hosted providers.
- **Declared Secrets & Vault Resolution**: Added declarative secret pointers in `config.toml` resolved at startup into the runtime process only, with presence-only logging and an isolated resolver environment.
- **Budget Envelopes & Anomaly Gates**: Added session, daily, and per-call spending envelopes with warn-then-confirm prompts and runaway-anomaly hard stops.
- **Single-Command Launch**: Running `dyfj` automatically boots the background runtime over UDS when unreachable before opening the REPL or executing one-shot turns.
- **Read-Only Workspace File Tools**: Added `grep_files` (regex content search) and `glob_files` (pattern name search) alongside line-ranged `read_file` with automatic allow-listing under command policy.
- **Ambient Workspace Instructions**: Added optional `AGENTS.md` instruction loading in agent mode when `[workspace] trust_instructions = true` is configured.
- **Interactive Mutating Tool Approvals**: Added interactive `y/N` approval prompts over the UDS seam for mutating tools (such as `write_file`).
- **Google Generative AI (Gemini) Provider**: Native `generateContent` / `streamGenerateContent` adapter behind the paid-escalation gate.
- **Hosted OpenAI Inference**: Added hosted API route for OpenAI-compatible completions alongside local routes.
- **Inter-Agent Coordination Primitives**: Added session-coordination claims, launch packets, exit receipts, and heartbeats for visibility across delegated agent work.

### Changed

- **Configurable Companion Default Model**: Configured default models in `config.toml` (`[companion] default_model = "<slug>"`) are now honored on bare turns across local, subscription-oauth, and hosted routes when priced. Unconfigured turns continue to default safely to local tier 0 (`qwen3.6:35b-a3b`).
- **Default Local Companion Promotion**: Promoted `qwen3.6:35b-a3b` (Ollama 35B MoE) as the primary default local companion, replacing `mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit`.
- **Preserved ACP Permission Options**: Interactive ACP permission requests now render the agent's full option list and return exact selected identifiers instead of collapsing to binary allow/deny.
- **Multi-Step Agent Tool Loop**: Extended the agent loop to iterate model tool calls sequentially up to a configurable step limit (`max_tool_steps`, default 32) before concluding.
- **Privacy-Class Memory Scoping**: Memory rows now enforce visibility clearances (`private`, `shareable`, `client_safe`, `public`), restricting non-loopback transports to client-safe and public projections.
- **Transport Seam Unification**: Lifted session execution, resume, budget tracking, and escalation gating into a transport-neutral `turn-runner.ts` shared across UDS and HTTP.
- **Prompt Storage in Dolt**: Companion system prompts now load from the versioned `prompts` table in Dolt rather than static strings.
- **Operator Permission Profile**: Added an `operator` permission profile that auto-approves contained mutating tools on loopback sessions instead of prompting per call.
- **Line-Buffered Streaming Markdown**: The CLI output path now wraps prose toward a 100-column maximum without splitting words, uses hanging indents for wrapped lists and quotes, renders horizontal rules, and turns safe web, mail, and absolute-local Markdown links into labeled OSC 8 terminal hyperlinks while preserving destinations in plain `NO_COLOR` output.
- **Semantic Memory Search**: Added `search_memory` tool for querying external vector/MCP memories on demand.

### Removed

- **HTTP peer server retired**: `http.ts` is gone. UDS JSON-RPC is the only seam; `events/query` already carries `asOf`. A remote or browser surface returns later as a thin gateway client of that seam.
- Dropped vestigial `reflections`, `skills`, and capability scaffolding tables from Dolt schema (`schema/018_drop_vestigial.sql`).
- Removed `settings.example.json` in favor of `config.toml` and `.env`.

### Fixed

- **ACP warm-session ingress caps**: Protocol-input, session-update, and 60,000-byte agent-response caps now reset at each prompt on a reused ACP session, so sequential turns do not inherit the previous exchange's budget. A single oversized exchange still fails closed.
- **ACP route evidence after dead-session replacement**: Replacing a dead idle ACP session no longer replays route evidence a second time, so a replacement turn records one `runner_selected` event.
- **ACP spawn under the Unix runtime**: The process-group signaler probe treats an ungranted `DYFJ_TEST_RUN_DIR` read as unset, so `dyfj start` can launch fixture and Codex ACP children. The serve-unix env allowlist does not include that test-only name, and Deno throws on an ungranted read even when the variable is absent.
- **Test-runtime sweep verification and ACP probe argv**: The post-sweep survivor report is taken before the spawn manifest is cleared, so a manifest-only leftover cannot vanish from verification. Normal supervised cleanup passes the run generation so manifest identity can authorize a kill. The ACP process-group probe receives the run directory as a `deno eval` argument rather than interpolated source.
- **Test-runtime spawn-manifest and generation authority**: A stale spawn manifest authorizes process signaling only when the record's PID still matches a live process whose start time, command, recovery directory, and run generation all match. Bare PID or PGID matches are not kill authority. Saved Vitest groups are signaled only when a recovering run generation is supplied and matches; malformed-lock recovery therefore leaves the numeric group alive. The sibling reaper CLI requires `--generation`.
- **Test-runtime lock and process-group identity**: Acquire/reclaim/release serialize on an exclusive claim directory; release removes a lock only when the generation matches. Saved Vitest groups are signaled only when a recovering run generation is supplied and the recovery directory, run generation, leader start time, and command still match. If the saved leader is gone, the numeric group is left alive. Supervised runs fail closed without an absolute `HOME`. Stale `*.writing` lock staging files are swept.
- Made ACP progress delivery best-effort so a hanging or rejecting observer cannot stall or fail the turn. Progress fields and spinner labels now consume at most 256 code points.
- Bounded client-side UDS status and liveness probing with a 5-second `AbortSignal` deadline to prevent indefinite hangs on stalled sockets.
- Capped and bounded tool results to prevent large `read_file` outputs from overflowing the Dolt events table column or terminating turns.
- Corrected temporal `TIMESTAMP(6)` decoding in Rust event writes for leading-zero fractional seconds.
- Handled mid-turn Ctrl-C cancellation cleanly in REPL and one-shot turns without crashing the background daemon.
- Fixed OpenAI-compatible tool call streaming and recovery for fragmented `<tool_call>` chunks.
- Fixed JSON-RPC error envelope parsing to reject malformed error payloads without orphaning pending client requests.
- Validated `DOLT_PORT` as an integer before spawning Deno child network grants.
- Fixed multibyte UTF-8 decoding across socket chunk read boundaries on the UDS/JSON-RPC transport.
- Bound provider HTTP response header timeouts to 30 seconds to prevent blackholed connections from hanging turns.
- Fixed REPL clean exit on Ctrl-D (EOF).

### Security

- Enforced strict loopback-only transport boundaries for mutating tool execution and private/shareable memory injection.
- Redacted schema-flagged payload arguments (such as `write_file` content) from durable tool-call events and session replays.
- Anchored and re-verified workspace root identity on file-tool operations, refused enumerated symlinks and absolute paths, and rejected path traversal.
- Standardized error classification with `DomainError` to prevent internal runtime error messages from leaking sensitive paths or credentials across the wire.
- Restricted MCP memory tools on standalone stdio connections to `client_safe` and `public` data.
- Enforced HTTPS and rejected HTTP redirects for remote memory recall endpoints.

## [2026-06-12]

### Added

- Multi-interface bind for the Workbench HTTP server: `DYFJ_WORKBENCH_HTTP_HOST` accepts a comma-separated host list, and a failed bind on one interface no longer takes the others down.
- Bearer-key authentication for non-loopback requests via `DYFJ_WORKBENCH_API_KEY` and `DYFJ_WORKBENCH_ALLOWED_HOSTS`. Loopback remains the keyless local-dev path; a presented bearer is always verified, even on loopback.
- Runtime events now populate the authn metadata columns from `schema/011_events_authn.sql` (`authn_status`, `authn_mechanism`, `authn_issuer_ref`) plus a transport-derived `authz_basis`, threaded through the new `WorkbenchAuthContext`.
- API-key entry bar in the minimal HTML surface for remote access; the key persists in browser `localStorage` and the bar reappears on a 401.

### Security

- The HTTP server fails closed: non-loopback binds are refused entirely when no API key is configured, and unknown hostnames are rejected regardless of credentials.

## [2026-06-11]

### Added

- Native Anthropic Messages provider adapter behind the paid-escalation path: prompt caching with a stable system-prefix cache block, cache-aware cost accounting (reads at 0.1x input, 5-minute-TTL writes at 1.25x), and SSE streaming.
- `GET /api/models` registry endpoint serving active registry rows plus the local defaults, for model pickers.
- Model registry refresh (`schema/012_models_2026_06_refresh.sql`): MLX Qwen3.5 4B local default at tier 0; Claude Sonnet 4.6 (tier 1), Claude Opus 4.8 and Claude Fable 5 (tier 2) with per-model cache economics. The stale Opus 4.5 row is deactivated.
- Session receipts and runtime results now carry prompt-cache token telemetry (`cacheRead`/`cacheWrite`).

### Fixed

- DYFJ command ids (for example `memory.read`) are mapped onto the Anthropic tool-name wire format and back, instead of failing the request with an HTTP 400.
- Explicit tier requests honor the local preference chain (MLX first, then Ollama fallbacks) instead of taking the first registry row.

### Changed

- README, prototype README, and `.env.example` brought current with the hosted provider path and `op run`-style key projection.

## [2026-06-09]

### Changed

- MLX-LM (Qwen3.5 4B on Apple silicon) became the local provider default; Ollama remains the supported fallback.

### Security

- Hardened Workbench local HTTP boundaries: loopback host/origin/content-type intent checks on turn and read endpoints.

## [2026-06-08]

### Added

- Expanded Workbench HTTP surface beyond the initial smoke path.

## [2026-06-05]

### Changed

- Defaulted Workbench to Laguna XS.2 (superseded 2026-06-09 by the MLX default).

### Security

- Hardened Workbench memory boundaries.

## [2026-06-04]

### Changed

- Workbench runtime split into a shared single-turn boundary with CLI/shell and local HTTP veneers; presentation layers pass inputs and render results while the runtime owns routing, execution, persistence, budget, and receipts. C4/D2 runtime diagrams added.

## [2026-06-01]

### Added

- Barebones Workbench harness shell (`deno task workbench shell`).
- Solo operator context kit example.

## [2026-05-30]

### Added

- Authn metadata columns on the events table (`schema/011_events_authn.sql`).
- Repo-native schema validation: `deno task validate-schema` and `deno task test:schema`.

## [2026-05-25] through [2026-05-28]

### Added

- Workbench MVP arc: budget tally and per-call/session limits, paid-escalation preflight with interactive consent, session receipts, event-sequence verification, model routing MVP, repo-local `ask` command, and a model-literacy diagnostics suite (response modes, context-size response, structured output, streaming TPOT).
- Deno permission sets for prototype tasks.

## [2026-04-26] through [2026-04-27]

### Added

- Initial operating-context README with Layer 0 stances, repo structure (`prototype/` TypeScript on Deno, `core/` Rust substrate, `schema/` canonical Dolt DDL), and MIT license.
