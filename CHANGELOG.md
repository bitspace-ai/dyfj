# Changelog

Notable changes to DYFJ. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

DYFJ is an actively developed prototype with no release tags yet, so entries are
dated rather than versioned. Document-level revisions of the operating-context
README are tracked separately in its Revision history section.

## [Unreleased]

### Added

- <!-- closure-claim: semantic-contract-behavior --> **Workbench first-product
  semantic contract package**: A new versioned package at
  `contracts/workbench/first-product/v1/` states the first-product room,
  participant, membership, thread, agent-specification, task, run, route,
  capability-report, context-packet, grant, lease, artifact, event, projection,
  receipt, route-control, label, claim-source, and authority semantics as JSON
  Schema 2020-12 plus repository-owned TypeScript validators, with a synthetic
  fixture corpus in which every negative fixture names the stable rule id it
  must be rejected for and every one of the package's stable rule ids has a
  named negative fixture. An AgentSpec binds identity, declared behavior,
  posture, tools, and guardrails; a Task carries a complete execution envelope
  (objective, context scope, assigned agent specification, posture, route
  requirements, tools, workspace, budget, and guardrails) alongside its approval
  envelope; and a Run requires and reconciles its Task, agent specification,
  route session, an exclusively owned ContextPacket, and a CapabilityGrant. Task
  and Run lifecycles are separate state types with separate transitions; the
  required progression, Run-to-Task independence (including that a failed,
  interrupted, abandoned, or superseded Run always leaves a recorded causal
  consequence on its Task), per-Task run-attempt uniqueness, state-and-event
  pairing, label and claim-source preservation, route-phase ordering and route
  binding, continuity evidence, durable commit before acknowledgement, receipt
  family requirements and receipt subject reconciliation, and explicit deferrals
  are enforced, while the exceptional-state graph, adapter-specific context
  projection, and detailed process provenance are deliberately left open.
  `running` → `ready` and `completed` → `closed` are conditional edges: the
  first requires a failed or interrupted Run's causal evidence, the second an
  explicit attributable operator decision that never asserts or implies
  acceptance. A RouteSpec requires lane, modality, model, adapter, policy basis,
  and cost basis, plus at least one of runner or provider — lane identifies loop
  ownership and does not forbid either field.
  <!-- closure-claim: effective-event-authority --> Authorization is checked as effective rather than
  declared: a grant-authorized event must name a resolved grant issued to its
  own author, an authority-bearing event cannot rest on a denied policy
  decision, an `allowed-with-approval` basis must resolve to a human-authored
  approval recorded no later than its first reliance, and a machine-authored
  `operator-direct` event must resolve to a preceding human authorizing event
  for the same Task or Room. A false Task-envelope approval flag rejects, but
  the missing attributable approval event is recorded as blocked. A Run grant
  may transitively supersede its envelope grant when it keeps both principals
  and does not broaden authority. Run grants explicitly scope Task, Room, route,
  and any named provider; absent grant scopes and RouteSpec components require
  an explicit `not-applicable` or `opaque` disposition. A deterministic policy
  rejects an egress-capable grant (network reach plus an egress destination
  class) acting on content that is simultaneously private and untrusted, receipt
  evidence may never postdate the receipt's own commit sequence, a turn receipt
  carries lifecycle state only when a Run participates. Within a declared event
  family, the first inline writer establishes the package's cutover convention
  and later omissions or competitors reject; selecting that writer has no
  separate authority record and remains blocked. Structural alternatives —
  payload representations, speak policies, thread classes, internal versus
  external references, version evidence, and participant independence — are
  enforced by schema rather than described in prose, and inline payload bytes
  are forbidden wherever any secrecy tag applies rather than only for a fixed
  list of tag names. The positive acceptance matrix is decided by test-owned
  predicates over the fixture's own witnesses; a fixture's `proves` list is
  display metadata only. The package adds no dependency, implements no
  persistence, routing, or provider integration, grants no runtime authority,
  and does not displace the canonical Dolt DDL. Validating a document proves the
  document and nothing about a running system.
  <!-- closure-claim: closure-report-evidence --> A generated deterministic closure report computes all
  61 invariant results, all 31 preserved probe dispositions, and the 24-target
  rollup from observed validator results; checks every reject branch against an
  explicit expected-rule table and every invariant against explicit required
  mutation classes; maps every stable rule to invariant authority or structural
  safety; records ladder steps it does not execute as `not-evaluated`; and fails
  closed on missing or altered identifiers, witnesses, rules, classes, targets,
  or declared claim markers. Undeclared prose lies outside the trace. The report
  generator, preserved-probe test, report self-check, and focused validator
  tests run in the aggregate gate under the existing `test.aggregate` check, in
  both full and fast modes. The gate fails when the checked-in report differs
  byte-for-byte from a fresh regeneration without rewriting the tracked file.
- **macOS portability gate**: The full deterministic gate now runs in an
  independent macOS 15 arm64 clean checkout with digest-pinned Deno and Dolt
  archives, alongside the stable Linux required check on Ubuntu 24.04.

### Fixed

- <!-- closure-claim: contract-evidence-closure --> **Workbench contract
  evidence closure**: Task-ending operator decisions now bind to the same Task
  and follow the causing Run, Run-to-RouteSession binding is bidirectional, Run
  receipts reconcile Route, ContextPacket, and capability posture, and
  independently verified material requires evidence from a distinct verifier.
  Event grant scopes, summons grantees, receipt Room and participation, spend
  reliance, receipt budget/tools/effects, receipt provenance and attribution,
  and durable commit ordering are reconciled. Abandoned and superseded Runs now
  require the same recorded Task consequence as failed and interrupted Runs. The
  closure generator uses explicit allowed-branch witnesses, requires every
  declared mutation class, runs internal report mutations, supports
  residual-bearing `blocked` and `not-applicable` results, and maps public
  claims to their supporting invariant results.
- **Portable process-group signaling**: Test-process cleanup now separates
  `/bin/kill` options from process targets explicitly. GNU/Linux therefore
  treats a negative process-group ID as the intended target instead of parsing
  it as another signal option and signaling the test gate itself. A new checkout
  can also reclaim a stale operator test lock without receiving write authority
  over the prior checkout's test artifacts, and lock-contender failures now
  report their bounded diagnostic instead of degrading into a generic timeout.
- **Test-process cleanup isolation**: The supervised test harness no longer
  sends a process-group signal when a matched child shares the current test
  runner's or supervisor's process group. Those children are reaped by PID, so
  platform differences in detached-process behavior cannot interrupt the gate.
  Process-supervision tests now run in a separate supervised Vitest invocation
  instead of concurrently with other process-spawning suites.
- **Release-range secret coverage**: `secret.diff` now scans the added lines of
  every commit made newly reachable by the bound range, including merge-only
  additions, so a secret introduced and removed before the range endpoint still
  fails the gate. Added source lines whose content begins with `++` are no
  longer mistaken for diff file headers and skipped.
- **Dependency command policy**: Network-to-shell detection now evaluates
  bounded logical workflow commands across YAML block, folded, quoted, and
  continued-line forms instead of scanning each physical line independently.
  Workflow shell structures the scanner cannot resolve fail closed, and Rust
  toolchain evidence is described as an exact pin plus a reported-version check
  rather than an archive-digest verification.
- **Assurance receipt semantics**: A required check that returns `warn` can no
  longer support a passing decision, and placeholder fixture family names no
  longer satisfy production different-family review claims.
- **Noninteractive Vitest gate**: The production Vitest launcher now disables
  runtime permission prompts and declares the previously implicit hostname and
  home-directory queries in its named test profile. Missing permissions fail
  immediately instead of hanging an unattended full gate.

### Added

- **Clean-checkout CI gate**: A GitHub Actions workflow
  (`.github/workflows/gate.yml`, stable required-check name `full-gate`) runs
  the repository-owned `deno task test` from a clean checkout on pull requests
  and pushes to `main`, with a read-only token, no secrets, no persisted
  checkout credential, a digest-pinned checkout action watched by Dependabot, a
  bounded runtime, and superseded-run cancellation kept distinct from failure.
  The workflow binds the exact checked-out commit and release-range base into
  the gate, installs Deno 2.9.6 and Dolt 2.3.1 from exact-version release URLs
  (no `latest` URLs, no scripts piped into a shell), checks each downloaded
  archive against a SHA-256 digest committed in the workflow before unpacking or
  executing it, and verifies each reported tool version as secondary evidence.
  The digests are repository-owned and never fetched at run time, so a checksum
  file or trust root served by the archive's own origin cannot launder a swapped
  archive; release signatures remain unverified and are declared as a known gap
  in the dependency manifest. Workflow-hygiene tests in the aggregate gate
  assert those properties — including that every downloaded archive has a
  committed-digest check between its download and its unpack — that the workflow
  never restates lane definitions in YAML, and that it never hands untrusted
  pull-request code an elevated context.
- **Deterministic policy checks with stable ids**: The aggregate gate now runs,
  ahead of the test suites: `subject.resolve`/`subject.digest` (bind the run to
  one immutable commit, recompute its digest from object bytes, and fail closed
  on a missing binding, mismatch, or dirty subject tree in CI; local runs are
  labeled non-authoritative), `secret.tree` (secret-shaped values in tracked
  files), `public.boundary` (operator-identifying material: non-example email
  addresses, absolute home-directory paths), `secret.diff` (secret shapes in
  what the release range adds), `diff.whitespace` (`git diff --check` equivalent
  for the range), `markdown.links` (changed-Markdown structure and
  repository-relative link validation), `shell.parse` (`bash -n` on changed
  shell files, failing closed when the parser is unavailable), and
  `dependency.policy` (rejects unpinned workflow actions, mutable installer
  URLs, network-to-shell piping, and a floating Rust toolchain, surfaces
  dependency-surface mutations in the range, and validates the committed
  dependency manifest — every source class must require
  `operator-inspect-before-apply`, and an inspect class declared as integrity or
  provenance evidence is rejected, since inspection records that a human looked
  and never grants apply authority on its own). The tree scans cover every
  tracked file with no allowlist and no path exemption — tests, binary-looking
  payloads, and the scanner's own source included — and scan a tracked symlink
  as its link-target text rather than following it. Diagnostics are value-free —
  rule id, path, and line only — and the gate emits one bounded machine-readable
  `gate-status` JSON line in which a failed, unavailable, or skipped required
  check can never compose into a pass and interruption stays distinct from
  failure. The `gate-status` line is a bounded diagnostic, not an assurance
  receipt. These are pipeline assurance checks; a green gate grants no runtime
  capability.
- **Assurance receipt schema validator**: `scripts/assurance-receipt.ts`
  validates the `dyfj.assurance.receipt/v1` evidence envelope fail-closed —
  unknown decisions or fields, missing required fields, unknown policy ids or
  policy versions other than 1, subject references not bound to the supplied
  immutable digest (for every subject kind, not only git), subject/digest
  mismatches, stale or future timestamps, negative finding counts, passing
  decisions carrying failed or missing required checks, unconfirmed redaction,
  unbounded reference lists, runner identity without a revision, independence
  objects missing their explicit fields (bounded sentinels such as `none` are
  required instead of omission), known-unknown entries without
  `evidence_needed`, degraded-condition entries without `scope`, mutable
  `approval_ref`/`bypass_ref` labels, unsupported independence evidence, and
  tampered payloads (recomputed canonical evidence digest) are all rejected,
  with value-free violation ids. The gate runs its focused positive/negative
  tests under the `receipt.schema` check id; validating the schema generates no
  receipt and claims no remote review, acceptance testing, publication, or
  runtime authority.
- **Fast gate subset**: `deno task test:fast` runs every deterministic policy
  check plus the prototype source typecheck for quick local feedback, reusing
  the production lane definitions verbatim; unknown gate arguments fail closed,
  and `deno task test` remains the single full green bar.
- **Retired-surface scan**: The aggregate test gate fails when demolished
  Workbench surface names reappear outside dated history, the superseded veneers
  note, or the scanner's own definition.
- **Warm ACP Session Reuse**: Sequential ACP turns in the same Workbench
  session, workspace, and execution profile reuse one live worker and ACP
  session. Concurrent same-session work fails as busy instead of queueing. Turn
  cancellation keeps a healthy handle; protocol or process failure replaces it.
  Idle sessions retire on a TTL and capacity fails closed without eviction. UDS
  close, SIGINT, and `dyfj stop` wait for in-flight creation and for every
  started close to settle, then surface a retained close failure instead of
  reporting success. A shutdown failure exits with status 1. A timed-out reused
  route-evidence replay aborts its callback signal so a late durable selection
  event does not land.
- **Bounded Test Runtime Supervision**: Prototype Vitest runs through
  `run-vitest.ts` now take an exclusive operator-scoped run lock
  (`$HOME/.dyfj/run/dyfj-vitest-run.lock`), a wall-clock bound
  (`DYFJ_TEST_BOUND_SEC`, default 10 minutes or 3 minutes for a focused
  file/name), and a detached sibling reaper. Force-killing the runner reaps
  launcher/runtime leftovers, test sockets, and run-scoped
  `start-test-runtime-*.lock` files. A second run refuses to start while a prior
  run is still alive, including across checkouts. A hung suite fails the bound
  instead of occupying a worker indefinitely. Stale-lock recovery
  TERM-then-KILLs the saved Vitest process group only when identity and the
  recovering run generation match. Survivor discovery is scoped to the run tmp
  dir, spawn manifest, and explicit command needles.
- **Live ACP Progress Indication**: Interactive TTY turns now show an ephemeral
  spinner status for the full in-flight turn (`thinking…`, a bounded tool title,
  or the truthful generic `working…`) with one live elapsed timer. The indicator
  yields while response text, status, or an approval prompt owns the terminal,
  then resumes until completion. Raw thought text is not rendered, persisted, or
  replayed, and progress events do not enter durable session history.
- **ACP Usage Receipts**: External-agent receipts now carry ACP-reported
  optional unstable prompt-response usage and the latest context-window snapshot
  with explicit ACP provenance. The terminal receipt renders those fields when
  reported. Optional ACP cost remains labeled as cumulative session cost;
  subscription-backed Codex turns state that USD cost was not reported instead
  of inventing a dollar figure.
- **Codex ACP GPT-5.6 Terra Model & Fast Speed Tier**: Added
  `codex-chatgpt/gpt-5.6-terra` model and `fast-speed` capability to GPT-5.6 Sol
  and Terra in the model catalog and Dolt migration `011`. Exposed `--fast` /
  `--no-fast` CLI flags, `/fast [on|off]` REPL command, and
  `/model <slug> [--fast|--no-fast]` options with posture indicators,
  propagating `service_tier = "fast"` into `CODEX_CONFIG` for supported Codex
  ACP runners.
- **Automatic ACP Model Dispatch**: Selecting an ACP-backed model (such as
  `codex-chatgpt/gpt-5.6-sol` or `fixture`) via `--model`, `/model`, or
  `default_model` in `config.toml` automatically dispatches turns to the ACP
  runner without requiring explicit `--runner` flags.
- **ACP REPL & Multi-Turn Session Resume**: Allowed `codex-chatgpt` in
  interactive REPL turns and multi-turn session resume, forwarding session
  identifiers without one-shot rejection.
- **Direct xAI (Grok) Provider**: Added native provider support for
  `https://api.x.ai/v1` (configured xAI API key) under `frontier-hosted`
  modality with session-affinity header forwarding (`x-grok-conv-id`).
- **OpenRouter Aggregator & Hosted Frontier Model Lineups**: Refreshed catalog
  seed entries in `schema/catalog/001_models.sql` and added migrations `009` and
  `010` for current Anthropic, OpenAI, Google Gemini, and xAI models, plus
  verified OpenRouter aggregator endpoints.
- **Access Modality Classification**: Annotated models with access categories
  (`local`, `frontier-hosted`, `aggregator-hosted`, `subscription-oauth`,
  `custom-hosted`) across CLI listings and JSON-RPC methods.
- **Session Ideas & Work Packets**: Added REPL commands (`/session`, `/idea`,
  `/packet`) and UDS JSON-RPC endpoints to inspect session metadata, mark
  candidate ideas, and draft structured work packets.
- **Launcher Lifecycle & Stop Command**: Added `dyfj stop` subcommand,
  `runtime/stop` RPC method, and socket-keyed autostart lock files under
  `~/.dyfj/run/` to cleanly manage background runtime lifecycles.
- **Streamable HTTP MCP Client**: Added support for strict MCP `2026-07-28`
  Streamable HTTP servers with configurable tool allowlists, approval policies,
  and bearer auth.
- **W3C Trace Context Conformance**: Added W3C trace context extraction and
  propagation support across memory recall spans.
- **Local Context Compression**: Added transcript compression generated only on
  local models before prompt dispatch; summaries travel with the session
  transcript to the active session model, including hosted providers.
- **Declared Secrets & Vault Resolution**: Added declarative secret pointers in
  `config.toml` resolved at startup into the runtime process only, with
  presence-only logging and an isolated resolver environment.
- **Budget Envelopes & Anomaly Gates**: Added session, daily, and per-call
  spending envelopes with warn-then-confirm prompts and runaway-anomaly hard
  stops.
- **Single-Command Launch**: Running `dyfj` automatically boots the background
  runtime over UDS when unreachable before opening the REPL or executing
  one-shot turns.
- **Read-Only Workspace File Tools**: Added `grep_files` (regex content search)
  and `glob_files` (pattern name search) alongside line-ranged `read_file` with
  automatic allow-listing under command policy.
- **Ambient Workspace Instructions**: Added optional `AGENTS.md` instruction
  loading in agent mode when `[workspace] trust_instructions = true` is
  configured.
- **Interactive Mutating Tool Approvals**: Added interactive `y/N` approval
  prompts over the UDS seam for mutating tools (such as `write_file`).
- **Google Generative AI (Gemini) Provider**: Native `generateContent` /
  `streamGenerateContent` adapter behind the paid-escalation gate.
- **Hosted OpenAI Inference**: Added hosted API route for OpenAI-compatible
  completions alongside local routes.

### Changed

- **Exact Rust toolchain pin**: `core/rust-toolchain.toml` now pins `1.98.0`
  instead of the floating `stable` channel, so local builds and clean-checkout
  CI compile with the same verified toolchain; the new `dependency.policy` check
  rejects a floating channel.
- **Configurable Companion Default Model**: Configured default models in
  `config.toml` (`[companion] default_model = "<slug>"`) are now honored on bare
  turns across local, subscription-oauth, and hosted routes when priced.
  Unconfigured turns continue to default safely to local tier 0
  (`qwen3.6:35b-a3b`).
- **Default Local Companion Promotion**: Promoted `qwen3.6:35b-a3b` (Ollama 35B
  MoE) as the primary default local companion, replacing
  `mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit`.
- **Preserved ACP Permission Options**: Interactive ACP permission requests now
  render the agent's full option list and return exact selected identifiers
  instead of collapsing to binary allow/deny.
- **Multi-Step Agent Tool Loop**: Extended the agent loop to iterate model tool
  calls sequentially up to a configurable step limit (`max_tool_steps`,
  default 32) before concluding.
- **Privacy-Class Memory Scoping**: Memory rows now enforce visibility
  clearances (`private`, `shareable`, `client_safe`, `public`), restricting
  non-loopback transports to client-safe and public projections.
- **Transport Seam Unification**: Lifted session execution, resume, budget
  tracking, and escalation gating into a transport-neutral `turn-runner.ts`
  shared across UDS and HTTP.
- **Prompt Storage in Dolt**: Companion system prompts now load from the
  versioned `prompts` table in Dolt rather than static strings.
- **Operator Permission Profile**: Added an `operator` permission profile that
  auto-approves contained mutating tools on loopback sessions instead of
  prompting per call.
- **Line-Buffered Streaming Markdown**: The CLI output path now wraps prose
  toward a 100-column maximum without splitting words, uses hanging indents for
  wrapped lists and quotes, renders horizontal rules, and turns safe web, mail,
  and absolute-local Markdown links into labeled OSC 8 terminal hyperlinks while
  preserving destinations in plain `NO_COLOR` output.
- **Semantic Memory Search**: Added `search_memory` tool for querying external
  vector/MCP memories on demand.

### Removed

- **Stale transport wording retired**: doc comments claiming an SSE frame
  transport and an operator-configurable serverUrl are gone from the turn seam;
  the retired-surface scan now denies that wording in tracked text files outside
  its documented allow rules.
- **HTTP peer server and CLI HTTP client retired**: `http.ts` is gone, and the
  `dyfj` CLI no longer reaches a remote HTTP runtime (`--server`, `--unix`,
  `--key`). UDS JSON-RPC is the only seam; `events/query` already carries
  `asOf`. A remote or browser surface returns later as a thin gateway client of
  that seam.
- **Workbench shell retired**: `runWorkbenchShell` is gone. The `dyfj` CLI REPL
  (`runRepl`) over UDS is the interactive surface.
- **Session coordination retired**: `session-coordination.ts` is gone. It had no
  remaining production importers.
- **Legacy stdio MCP client retired**: `mcp-client.ts` (stdio client to the
  in-repo memory server) is gone. Streamable HTTP `mcp-tools` and the memory
  server remain.
- Dropped vestigial `reflections`, `skills`, and capability scaffolding tables
  from Dolt schema (`schema/018_drop_vestigial.sql`).
- Removed `settings.example.json` in favor of `config.toml` and `.env`.

### Fixed

- **Vitest launcher from a fresh checkout**: `run-vitest.ts` no longer fails at
  module load when prototype npm packages are not yet materialized. esbuild
  resolution is deferred past load: an absent install drops the esbuild run
  grant and `ESBUILD_BINARY_PATH` from unsupervised passthrough invocations — so
  `--version` launcher probes, including the aggregate gate's focused
  selected-Deno tests, work from a clean checkout — while a supervised `run`
  still refuses to start without the installed binary and an ambiguous install
  keeps failing closed. The full `deno task test` gate is now deterministic from
  a fresh clone.
- **ACP warm-session ingress caps**: Protocol-input, session-update, and
  60,000-byte agent-response caps now reset at each prompt on a reused ACP
  session, so sequential turns do not inherit the previous exchange's budget. A
  single oversized exchange still fails closed.
- **ACP route evidence after dead-session replacement**: Replacing a dead idle
  ACP session no longer replays route evidence a second time, so a replacement
  turn records one `runner_selected` event.
- **ACP spawn under the Unix runtime**: The process-group signaler probe treats
  an ungranted `DYFJ_TEST_RUN_DIR` read as unset, so `dyfj start` can launch
  fixture and Codex ACP children. The serve-unix env allowlist does not include
  that test-only name, and Deno throws on an ungranted read even when the
  variable is absent.
- **Test-runtime sweep verification and ACP probe argv**: The post-sweep
  survivor report is taken before the spawn manifest is cleared, so a
  manifest-only leftover cannot vanish from verification. Normal supervised
  cleanup passes the run generation so manifest identity can authorize a kill.
  The ACP process-group probe receives the run directory as a `deno eval`
  argument rather than interpolated source.
- **Test-runtime spawn-manifest and generation authority**: A stale spawn
  manifest authorizes process signaling only when the record's PID still matches
  a live process whose start time, command, recovery directory, and run
  generation all match. Bare PID or PGID matches are not kill authority. Saved
  Vitest groups are signaled only when a recovering run generation is supplied
  and matches; malformed-lock recovery therefore leaves the numeric group alive.
  The sibling reaper CLI requires `--generation`.
- **Test-runtime lock and process-group identity**: Acquire/reclaim/release
  serialize on an exclusive claim directory; release removes a lock only when
  the generation matches. Saved Vitest groups are signaled only when a
  recovering run generation is supplied and the recovery directory, run
  generation, leader start time, and command still match. If the saved leader is
  gone, the numeric group is left alive. Supervised runs fail closed without an
  absolute `HOME`. Stale `*.writing` lock staging files are swept.
- Made ACP progress delivery best-effort so a hanging or rejecting observer
  cannot stall or fail the turn. Progress fields and spinner labels now consume
  at most 256 code points.
- Bounded client-side UDS status and liveness probing with a 5-second
  `AbortSignal` deadline to prevent indefinite hangs on stalled sockets.
- Capped and bounded tool results to prevent large `read_file` outputs from
  overflowing the Dolt events table column or terminating turns.
- Corrected temporal `TIMESTAMP(6)` decoding in Rust event writes for
  leading-zero fractional seconds.
- Handled mid-turn Ctrl-C cancellation cleanly in REPL and one-shot turns
  without crashing the background daemon.
- Fixed OpenAI-compatible tool call streaming and recovery for fragmented
  `<tool_call>` chunks.
- Fixed JSON-RPC error envelope parsing to reject malformed error payloads
  without orphaning pending client requests.
- Validated `DOLT_PORT` as an integer before spawning Deno child network grants.
- Fixed multibyte UTF-8 decoding across socket chunk read boundaries on the
  UDS/JSON-RPC transport.
- Bound provider HTTP response header timeouts to 30 seconds to prevent
  blackholed connections from hanging turns.
- Fixed REPL clean exit on Ctrl-D (EOF).

### Security

- **Value-free scan diagnostics**: the retired-surface scan reports path, line,
  and needle only — matched line content never reaches terminal or CI output.
  Paths are control-stripped and bounded, hit collection and reporting are
  capped, and a git failure reports its exit code only — stderr is never
  relayed.
- **CLI network authority narrowed**: the `dyfj` CLI's Deno grants (launcher and
  compiled binary) no longer include loopback TCP; the Unix socket is the CLI's
  only network grant, and comma-bearing socket paths are rejected from every
  source before any grant is built, so path syntax cannot smuggle extra entries
  into the comma-delimited grant list. The runtime server keeps its own explicit
  per-host grants.
- Enforced strict loopback-only transport boundaries for mutating tool execution
  and private/shareable memory injection.
- Redacted schema-flagged payload arguments (such as `write_file` content) from
  durable tool-call events and session replays.
- Anchored and re-verified workspace root identity on file-tool operations,
  refused enumerated symlinks and absolute paths, and rejected path traversal.
- Standardized error classification with `DomainError` to prevent internal
  runtime error messages from leaking sensitive paths or credentials across the
  wire.
- Restricted MCP memory tools on standalone stdio connections to `client_safe`
  and `public` data.
- Enforced HTTPS and rejected HTTP redirects for remote memory recall endpoints.

## [2026-06-12]

### Added

- Multi-interface bind for the Workbench HTTP server: `DYFJ_WORKBENCH_HTTP_HOST`
  accepts a comma-separated host list, and a failed bind on one interface no
  longer takes the others down.
- Bearer-key authentication for non-loopback requests via
  `DYFJ_WORKBENCH_API_KEY` and `DYFJ_WORKBENCH_ALLOWED_HOSTS`. Loopback remains
  the keyless local-dev path; a presented bearer is always verified, even on
  loopback.
- Runtime events now populate the authn metadata columns from
  `schema/011_events_authn.sql` (`authn_status`, `authn_mechanism`,
  `authn_issuer_ref`) plus a transport-derived `authz_basis`, threaded through
  the new `WorkbenchAuthContext`.
- API-key entry bar in the minimal HTML surface for remote access; the key
  persists in browser `localStorage` and the bar reappears on a 401.

### Security

- The HTTP server fails closed: non-loopback binds are refused entirely when no
  API key is configured, and unknown hostnames are rejected regardless of
  credentials.

## [2026-06-11]

### Added

- Native Anthropic Messages provider adapter behind the paid-escalation path:
  prompt caching with a stable system-prefix cache block, cache-aware cost
  accounting (reads at 0.1x input, 5-minute-TTL writes at 1.25x), and SSE
  streaming.
- `GET /api/models` registry endpoint serving active registry rows plus the
  local defaults, for model pickers.
- Model registry refresh (`schema/012_models_2026_06_refresh.sql`): MLX Qwen3.5
  4B local default at tier 0; Claude Sonnet 4.6 (tier 1), Claude Opus 4.8 and
  Claude Fable 5 (tier 2) with per-model cache economics. The stale Opus 4.5 row
  is deactivated.
- Session receipts and runtime results now carry prompt-cache token telemetry
  (`cacheRead`/`cacheWrite`).

### Fixed

- DYFJ command ids (for example `memory.read`) are mapped onto the Anthropic
  tool-name wire format and back, instead of failing the request with an
  HTTP 400.
- Explicit tier requests honor the local preference chain (MLX first, then
  Ollama fallbacks) instead of taking the first registry row.

### Changed

- README, prototype README, and `.env.example` brought current with the hosted
  provider path and `op run`-style key projection.

## [2026-06-09]

### Changed

- MLX-LM (Qwen3.5 4B on Apple silicon) became the local provider default; Ollama
  remains the supported fallback.

### Security

- Hardened Workbench local HTTP boundaries: loopback host/origin/content-type
  intent checks on turn and read endpoints.

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

- Workbench runtime split into a shared single-turn boundary with CLI/shell and
  local HTTP veneers; presentation layers pass inputs and render results while
  the runtime owns routing, execution, persistence, budget, and receipts. C4/D2
  runtime diagrams added.

## [2026-06-01]

### Added

- Barebones Workbench harness shell (`deno task workbench shell`).
- Solo operator context kit example.

## [2026-05-30]

### Added

- Authn metadata columns on the events table (`schema/011_events_authn.sql`).
- Repo-native schema validation: `deno task validate-schema` and
  `deno task test:schema`.

## [2026-05-25] through [2026-05-28]

### Added

- Workbench MVP arc: budget tally and per-call/session limits, paid-escalation
  preflight with interactive consent, session receipts, event-sequence
  verification, model routing MVP, repo-local `ask` command, and a
  model-literacy diagnostics suite (response modes, context-size response,
  structured output, streaming TPOT).
- Deno permission sets for prototype tasks.

## [2026-04-26] through [2026-04-27]

### Added

- Initial operating-context README with Layer 0 stances, repo structure
  (`prototype/` TypeScript on Deno, `core/` Rust substrate, `schema/` canonical
  Dolt DDL), and MIT license.
