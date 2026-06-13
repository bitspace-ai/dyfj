# Changelog

Notable changes to DYFJ. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

DYFJ is an actively developed prototype with no release tags yet, so entries are dated rather than versioned. Document-level revisions of the operating-context README are tracked separately in its Revision history section.

## [Unreleased]

### Added

- Hosted OpenAI inference lane: the `openai-completions` adapter now serves a hosted path (https base URL + `OPENAI_API_KEY` bearer) alongside the local path, via a shared `executeOpenAICompatibleTurn`. GPT rows added to the registry (`schema/014_models_openai_2026_06.sql`): `gpt-5.4-mini` (tier 1), `gpt-5.4` and `gpt-5.5` (tier 2). Hosted GPT inherits the existing paid-escalation gate; tier>0 fails closed over HTTP. The adapterless Gemini rows are deactivated until a Google adapter ships.
- `deno task check`: strict typecheck of the non-test import graph (entrypoints `src/http.ts`, `src/workbench.ts`, `mcp/server.ts`). `deno task test` now runs it first, closing the gap where vitest's esbuild transpilation let type errors accumulate unenforced.
- Session REST surface for the cockpit: `GET /api/sessions` (grouped by project), `POST /api/sessions` (create bound to a project), and `GET /api/sessions/{id}/events` with an optional `asOf` Dolt time-travel read. Sessions gain a `project` column (`schema/013_sessions_project.sql`).
- Multi-turn conversations: `POST /api/turn` accepts a `sessionId` to resume — events append to the session and a compact transcript is rebuilt from prior `session_start`/`model_response` events so the model carries the conversation. The operator prompt now rides on `session_start` events to make transcripts reconstructable from Dolt alone.

### Fixed

- Three latent strict-mode type errors: command policy "ask" outcomes now default a reason instead of passing `undefined` into a required field; the streaming chat reader declares the (always-absent) `toolCalls` field so both reader paths share one shape; JSON-schema tool types became type aliases so they satisfy `Record<string, unknown>` tool-parameter contracts; structured-output validation now narrows types instead of asserting past the checker.

### Changed

- `AS OF` reads resolve against Dolt commit history: events newer than the latest Dolt commit are not yet visible to time-travel queries. A periodic event-commit cadence is future work for the inspector.

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
