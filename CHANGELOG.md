# Changelog

Notable changes to DYFJ. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

DYFJ is an actively developed prototype with no release tags yet, so entries are
dated rather than versioned. Document-level revisions of the operating-context
README are tracked separately in its Revision history section.

## [Unreleased]

### Added

- **Test lanes have deadlines and outlive neither a hang nor a killed gate.**
  The aggregate gate stops `test.unit` at 120 s and the isolated-Dolt
  integration and golden lanes at 900 s (`DYFJ_TEST_BOUND_SEC` overrides all
  three, in whole seconds up to 2147423), tearing the lane down as on an
  interruption and failing it with a message naming the deadline. The gate
  starts each of the three runners directly as the leader of its lane's
  process group and hands it a backstop 60 s past that deadline and a random
  lane token, which an idle same-group token carrier holds on its command line
  for the whole run. When its work is done the runner stops its own process
  group (TERM, then KILL to whatever is left), so a same-group descendant does
  not outlive the lane even when the gate was killed; if the gate is gone and a
  test hangs, the backstop stops the child the runner is waiting on and then
  its group, and a runner still running 30 s past its backstop stops its group
  and exits regardless. The gate records each running test lane's group and
  token under `$HOME/.dyfj/run/gate-lanes/` and, at its next start, stops a
  group left by a gate that is no longer running, only when a live member of
  that group still carries the lane token. New gate orchestration tests cover
  each case with a lane whose test leaves a same-group grandchild that ignores
  TERM.

- **The CI gate can be run manually**: `.github/workflows/gate.yml` accepts
  `workflow_dispatch` on any branch, with a required `range_base` input that
  binds the release range a manual run has no push or pull-request base for.
  It runs the same `deno task test` jobs with the same read-only token and no
  secrets. This lets repeated-run evidence (such as a count of consecutive
  gate runs without timeout-class failures) come from real CI runners without
  pushing commits to a pull request.

- **Git hooks against AI-tool attribution**: `.githooks/commit-msg` refuses a
  commit whose author or committer is an AI tool identity (including one given
  with `--author`, and merge commits), since GitHub turns each distinct commit
  author into a `Co-authored-by` trailer when a pull request is squash-merged,
  and strips `Co-authored-by` trailers naming a tool, `Claude-Session` trailers
  and "Generated with/by Claude Code" footers from commit messages.
  `.githooks/pre-push` checks the commits being pushed for the same identities
  and message lines, catching commits that skipped `commit-msg`. Tools are
  recognized by exact name or address, so a person whose name contains a
  tool's name is unaffected. Enable them per clone with
  `git config core.hooksPath .githooks`.
- **Row types generated from the DDL, with two schema gate lanes**:
  `schema/codegen.ts` applies `schema/current/` then `schema/catalog/` to a
  disposable Dolt repository, reads `information_schema`, and writes
  `prototype/src/store/generated/rows.ts`: per table a `<Table>Row` (as the
  driver decodes it) and `<Table>Insert` (NOT NULL columns without a default
  required), the column-name tuple, each column's declaration, and the SQL
  enum unions (`EventType`, `MemoryVisibility`, `MemoryInject`, ...). The
  `schema.codegen` lane regenerates it and fails when the committed file
  differs, so a DDL change without `deno task schema:codegen` fails the gate.
  The `schema.equivalence` lane (`deno task schema:equivalence`) applies
  `current/` + `catalog/` and `history/` + `migrations/` to two repositories
  and fails on any difference in tables, columns, types, nullability,
  defaults, ON UPDATE clauses, indexes, enums, constraints (with their key
  columns and, for foreign keys, the referenced table, columns and rules) or
  check constraints. Catalog data is not compared.
- **Typed event writes**: `journal.commit` takes the generated `EventInsert`,
  and every event the runtime appends is built by its per-type constructor in
  `prototype/src/store/events/builders.ts` (`sessionStartEvent`,
  `toolCallEvent`, `providerCallEvent`, ...), which requires the fields that
  type always carries. A misspelled column, a wrong value type or a missing
  NOT NULL field is now a compile error instead of a rejected INSERT. The
  builders only set `event_type`; the rows written are unchanged.

- **Rust REPL front-end (`core/dyfj-repl`)**: an interactive client that owns
  the terminal and speaks the existing Workbench UDS protocol. The agent loop
  is untouched — it stays server-side in `prototype/`, and this is a second
  client of it.

  It exists to make a pasted prompt behave like a typed one. The TypeScript
  REPL borrows Node's `readline` through Deno's compatibility layer, which
  splits a multi-line paste into one turn per line; the layer also lacks the
  bracketed-paste markers Node added in 2023, so enabling them there corrupts
  input rather than fixing it. Owning the terminal in Rust gets paste, line
  editing and history from `rustyline` instead of reimplementing them.

  At startup it prints a posture line from `runtime/status`: the default
  model, its tier and locality, whether paid inference is approved or off
  (hosted turns fail closed), the permission level and the tool-step limit.

  An approval is read only when both the question and the answer are on an
  interactive terminal. Without terminal input there is no operator and a
  prewritten line on a pipe would answer the request; without terminal output
  the request's details go somewhere the answering operator cannot see, so
  redirecting output would collect consent for a command, an amount and a limit
  that were never displayed. A line typed at the terminal while a turn is running does not answer
  a later prompt either: pending input is discarded first, and if that discard
  fails the prompt is not read at all and the request is denied, because a
  warning would not stop the queued keystroke from answering. Approval arguments are shown in full rather than
  clipped, and control characters are replaced in the runtime-supplied text
  that reaches the terminal — approval titles and arguments, streamed answers,
  receipt text, tool names, error messages and the posture line — so neither
  truncation nor an escape sequence can hide what is being approved. Sanitising
  only the approval would leave a streamed answer, or an error, able to change
  terminal state before the prompt appears. Answer text keeps its newlines and
  tabs so paragraphs and code blocks render; carriage returns are dropped from
  it, and everywhere else newlines and tabs become spaces.

  A budget request is not a tool call and is not rendered as one. Its amounts,
  limits and crossed scopes arrive in named fields with a preformatted warning
  rather than in `arguments`, so it is shown with that warning and a line
  naming what approving authorises. A spending request whose warning cannot be
  read is denied rather than reduced to a bare question: an approval nobody
  could read is not consent. A request that offers options is refused unless
  every option can be read, as the TypeScript CLI requires: each needs an id, a
  name and a known kind, ids are unique, and there are at most 16. It does not
  fall back to yes/no, where `y` would grant broader consent than any option
  offered.

  Ctrl-C cancels an in-flight turn through `turn/cancel` and leaves the session
  alive; a second press abandons the wait. Inside an approval prompt Ctrl-C
  denies that approval instead, which is a different path. Ctrl-D at the
  ordinary prompt exits. A panic restores echo, line editing and the cursor;
  there is no termination-signal handler, so a SIGTERM mid-read exits without
  restoring.

  One approval is handled at a time, on the loop that issued the turn, so the
  prompt on screen is the request being answered. That costs an earlier warning
  — a runtime disconnecting mid-approval is not reported until the operator
  answers. Approvals carry no turn id, so a delayed approval from an abandoned
  turn can still be presented during a later one; tagging them is a protocol
  change rather than a client fix.

  When the runtime abandons an attempt and starts again, the answer shown so
  far is marked as abandoned and the turn is treated as having displayed
  nothing authoritative — otherwise a replacement that arrives only in the
  receipt would be suppressed, leaving the abandoned attempt on screen as the
  answer. Tool-call markup that executed nothing is reported rather than left
  to read as tool activity.

  Known limits are recorded in the source where they are met, not left to be
  rediscovered: approvals and frames carry no turn id, so a delayed one from an
  abandoned turn can appear during a later turn; a dropped write can leave a
  partial frame; no closed state is recorded after the reader
  ends; one pending entry leaks per abandoned turn; and the submission ceiling
  bounds what is remembered rather than what is allocated.

  Frames from the runtime are capped at 16 MiB, the TypeScript peer's
  ceiling; a larger one, or a stream that passes the ceiling without a newline,
  closes the connection and fails the requests waiting on it. So does a frame
  that is not valid JSON, which could be the response a request is waiting
  for; skipping it would leave that request waiting with nothing on screen.

  Not yet: model switching, session resume and the other interactive commands
  remain in the TypeScript CLI, which is unchanged and still the entry point.

- **A `Deno.test` unit lane and shared test fakes**: new tests can now be
  written with `Deno.test`, `@std/assert` and `@std/testing` (pinned in the
  prototype import map) and run in a fast lane of their own.
  `deno task test:unit` in `prototype/` runs every non-integration, non-golden
  `Deno.test` file with `deno test --parallel`, the op and resource sanitizers
  enabled (opt-in in the pinned Deno), and no run, net, or env permission; the
  aggregate gate runs it as `Prototype unit Deno.test suite (test.unit)`,
  including under `deno task test:fast`, and the prototype `deno task test` runs
  it before Vitest. `prototype/testing/fakes/` provides the first port fakes,
  each with its own tests: `ManualClock`, `SequentialIds`, `MapEnv`, and
  `fakeIo`. The three copies each of the `fakeIo` and `buildClock` test helpers
  now import these instead. During the transition a test file's framework is
  read from its imports as `deno info --json` reports them: files whose static
  imports reach `vitest`, directly or through a helper module, stay under
  Vitest, which now excludes every other `*.test.ts`.
- **`arch.imports` gate lane (ratchet mode)**: `scripts/arch-imports.ts` builds
  the module graph of `prototype/src`, `prototype/mcp`, `prototype/scripts`,
  and `prototype/diagnostics` (once it exists) with `deno info --json`, plus a
  `deno lint` plugin that reports every dynamic `import()`, and checks it
  against the layer rules in `specs/01-architecture.md` §3–4, kept as
  data in `scripts/arch-layers.json`. It detects import cycles (type-only edges
  included), upward and non-listed same-layer edges, `cli/` imports outside its
  allow-list, and dynamic local imports. Today's violations are committed in
  `scripts/arch-imports-baseline.json` — three cycles (`mcp-tools` ⇄
  `web-tools`, `workbench` ⇄ `external-agent-runtime`, `sessions` ⇄
  `idea-packet`) and 32 entries in all. The lane fails on any violation not in
  the baseline and on any baseline entry that no longer occurs, so the count
  can only go down. Intentional cycles need a named entry in
  `scripts/arch-cycles.json` with exact edges inside an import cycle, a
  justification, and an existing test file; an entry exempts those edges from
  the cycle and dynamic-import rules only. The list starts empty. Deep imports
  that bypass a `mod.ts` and a size report (modules over 600 lines, functions
  over 150 lines) are printed without failing. The lane runs in both
  `deno task test` and `deno task test:fast` under the existing
  `test.aggregate` check id.

### Changed

- **Ten top-level prototype modules moved into their layer directories.**
  `src/secrets.ts` is now `src/config/secrets.ts`; `src/utils.ts` is
  `src/store/model-selected-event.ts`; the external MCP adapter
  (`src/mcp-tools.ts`), MCP trace-context rules (`src/mcp-conformance.ts`) and
  memory recall (`src/memory-search.ts`) are under `src/tools/mcp/` as
  `adapter.ts`, `conformance.ts` and `memory-search.ts`; and the memory record
  format (`src/memory.ts`) is `src/tools/builtin/memory-records.ts`. Their tests
  moved with them. `resolveSecrets`, `secretsRunGrant` and
  `writeModelSelectedEvent` are now exported through `config/mod.ts` and
  `store/mod.ts`. The four manual diagnostic helpers
  (`model-response-modes`, `context-size-response`, `structured-output`,
  `workbench-events`) moved to the new `prototype/diagnostics/`, outside the
  runtime graph; the typecheck and unit-test file lists now include it.
  `scripts/arch-layers.json` maps only the ACP runner and the interactive REPL
  by name. No behavior changes.

- **The `arch.imports` lane fails at the runtime size limits.** A runtime module
  over 1,000 lines, or a function in one over 200 lines, now fails the gate
  unless `scripts/arch-size-exceptions.json` names it with its reason and the
  size it may not exceed. An excepted module or function may shrink but not
  grow, and an exception for one back under its limit must be removed. The
  file starts with 22 entries: the ACP runner (deferred with its
  restructuring), the interactive REPL (being replaced by the Rust client),
  and the file tools, web tools, idea/packet domain, OpenAI-compatible stream
  and adapter, MCP and secrets config parsers, external MCP commands and the
  memory MCP server, whose splits are deferred past phase 1. The 600- and
  150-line targets stay a non-failing report.

- **A Markdown-only pull request runs only the gate's policy lanes and the lanes
  that read Markdown.** When every path a pull request's release range changes
  is Markdown (deletions included; a rename to a `.md` name does not count),
  `deno task test` runs `subject.resolve`, `subject.digest`, the retired-surface
  scan, both public-safety tree scans, `secret.diff`, `diff.whitespace`,
  `markdown.links`, `shell.parse`, `dependency.policy` and `receipt.schema`,
  plus the two contract lanes, whose closure report reads `closure-claim`
  markers in the Markdown. It names each lane it skips (unit, integration,
  golden, schema, `arch.imports`, typecheck, orchestration and Rust lanes)
  before it starts. Its `gate-status` line reports `"mode":"docs-only"` and it
  makes its own success claim, not the full green bar's. The decision is made
  inside the gate (`scripts/change-scope.ts`), not by a workflow path filter, so
  both CI jobs still report a status. A push to `main`, a manual dispatch and
  every local run keep the full gate. The `test` task now reads
  `GITHUB_EVENT_NAME`.

- **The aggregate gate reports every failing lane.** A failing lane no longer
  stops `deno task test` or `deno task test:fast`: every remaining lane still
  runs, and the gate ends by listing each lane that failed (`✗ N of M lanes
  failed:`, one lane per line) before its `gate-status` line. The exit code is
  unchanged: it is still the first failing lane's code (124 past a deadline,
  127 for a lane that could not start). Only an interruption stops the gate
  early; one that arrives after a failure keeps that failure's code, and the
  `gate-status` result reads `interrupted` because the run is incomplete,
  with the failed check still reading `fail`.

- **The isolated-Dolt integration lane runs with the op and resource
  sanitizers**, so a test there that leaks an op, a timer, a resource or a
  child process fails at that test. The two test-side leaks this found are
  fixed: the isolated Dolt fixture clears its shutdown timeout once the server
  exits, and the memory-recall UAT fixture test releases its child's pipes. The
  secrets-resolver timeout case, where the resolver abandons a stuck child's
  output by design, runs in a suite of its own with both sanitizers off and a
  comment saying why.

- **`deno task test` in `prototype/` is the typecheck plus `test.unit`.**
  `deno task test:file <path>... [--filter <pattern>]` runs the named unit test
  files under the unit lane's grants and sanitizers, without the full
  typecheck. It takes only test file paths and one `--filter`, and exits 2 on
  anything else, so it cannot run every test or change the lane's flags.

- **The ACP client, session-map, external-agent runtime and ACP runner tests
  run on `Deno.test` instead of Vitest**, with every case kept. Each file is
  split by tier: the pure cases stay in `acp-client.test.ts` (22),
  `acp-session-map.test.ts` (30) and `external-agent-runtime.test.ts` (12) in
  `test.unit`, and the cases that spawn the ACP fixture agent, read the
  process environment or build symlinks move to `*.integration.test.ts` (71, 7
  and 78). `acp-runner.integration.test.ts` moves from Vitest to the
  integration lane's `Deno.test` invocation, the last integration file on
  Vitest, so the integration lane no longer starts Vitest at all. The runtime
  tests no longer mock `kernel/ids.ts` and `store/sessions.ts`; each test
  injects a `MemoryStore` and injects write failures through the journal it
  hands the runtime. That invocation now points `TMPDIR` at a directory of its
  own, removed afterwards, and grants read and write on it alone; the grants
  on the whole system temp roots, which the Dolt fixture, secret-resolver,
  launcher, launch-grant and repo-context tests had used, are dropped, since
  those tests now make their temp directories there too. It also gains
  `--allow-sys=uid` (the Codex profile builder checks directory ownership)
  and the env names the ACP tests read or set: `ACP_FIXTURE_AMBIENT_VALUE`,
  `ANTHROPIC_API_KEY`, `DYFJ_MEMORY_MCP_TOKEN`, `SSH_AUTH_SOCK`,
  `DYFJ_NODE_PATH`, `DYFJ_CODEX_TOOLCHAIN_PATH` and `DYFJ_CODEX_RUSTUP_HOME`.
  Product behavior is unchanged.

- **The REPL, launcher, launch-grant, repo-context and `deno.json` task tests
  run on `Deno.test` instead of Vitest**, with every case kept.
  `src/cli.test.ts` (the REPL) stays a unit test. Its `deno.json` task cases
  moved out: the one that only reads the committed task strings to
  `scripts/deno-tasks.test.ts` (unit), and the three that run
  `codex-chatgpt-login` through `/bin/sh` to
  `scripts/deno-tasks.integration.test.ts`. Three files moved to the
  integration tier because they spawn processes or build symlink fixtures:
  `scripts/dyfj-launcher.test.ts` became `dyfj-launcher.integration.test.ts`,
  and the Vitest-only `grants.platform.test.ts` and
  `repo-context.platform.test.ts` became `grants.integration.test.ts` and
  `repo-context.integration.test.ts`. The fixtures now use the system temp
  directory instead of the working tree, and create symlinks with `ln -s`. The
  integration lane's `Deno.test` invocation gains only what these tests use:
  run grants for `/bin/ps`, `/bin/sh`, `bash`, `/bin/bash` and `ln`, the temp
  roots, and the `DENO_DIR` and `DYFJ_WORKBENCH_CONTEXT_TOKENS` env names. The
  aggregate gate now forwards a caller's `DENO_DIR` to its lanes, and the
  integration lane passes it on to its children; when it is unset, the
  launcher tests fall back to Deno's own per-platform cache (`~/.cache/deno`
  off macOS) instead of the macOS path they used everywhere. Product behavior
  is unchanged.

- **Twelve more prototype test files run on `Deno.test` instead of Vitest**:
  `model-response-modes`, `runtime-sigint`, `workbench-events`, `secrets`,
  `memory-search`, `mcp-conformance`, `mcp-tools`, `context-size-response`,
  `structured-output`, `scripts/add-import-extensions`,
  `scripts/deno-executable` and `scripts/isolated-dolt-fixture.integration`,
  with every case kept. Pure cases run in `test.unit`. The seven
  secret-resolver cases that spawn `bash` moved to
  `src/secrets.integration.test.ts`, and the redirect case that binds a
  loopback socket moved into `src/memory-search.integration.test.ts`.
  `scripts/isolated-dolt-fixture.integration.test.ts` now runs under the
  integration lane's `Deno.test` invocation instead of Vitest; its two
  fixture-setup cases keep their 30-second bound by aborting setup through the
  fixture's own signal, since `Deno.test` has no per-test timeout. That
  invocation gains only what these tests use: `dolt` and `bash` run grants,
  the temp roots, `../schema`, and the `TMPDIR`/`TEMP`/`TMP` and
  `LEAKY_AMBIENT` env names. Product behavior is unchanged.

- **The `dyfj` client's turn code moved out of `src/cli.ts`, which is now the
  interactive REPL only.** The turn request and socket turn with its
  cancellation (`src/cli/turn-client.ts`), the interactive mid-turn approval
  prompt (`src/cli/approval.ts`, shared by `exec` and the REPL), the one-shot
  `exec` command (`src/cli/commands/exec.ts`), and the turn's terminal
  rendering (`src/cli/render/`: streaming markdown and runtime-event lines,
  the busy spinner and its label sanitizing, the receipt line) are separate
  modules. `src/busy-spinner.ts` and `src/streaming-markdown.ts` moved into
  `src/cli/render/` unchanged. Turns, approvals, cancellation, output and exit
  codes are unchanged; the golden suite passes with no snapshot diff. Their
  tests moved to `Deno.test` beside them, with the shared turn fixtures in
  `prototype/testing/builders/turn-client.ts`; the real-socket turn round
  trip runs in the integration lane.

- **The `dyfj` client's entrypoint is `prototype/src/cli/main.ts`.** Argument
  parsing, config resolution and help (`src/cli/args.ts`), the client's
  terminal and socket ports (`src/cli/io.ts`), the `models`, `sessions`,
  `status`, `stop` and `start` subcommands (`src/cli/commands/`), and the
  runtime launch with its permission-grant computation (`src/cli/launcher/`)
  moved out of `src/cli.ts`, which keeps the interactive REPL and the one-shot
  turn and no longer runs as a program: `deno run src/cli.ts` does nothing.
  `deno task compile-cli`, the `dyfj` launcher (`--parse-check`, the status
  probe and the `deno run` route) and the golden harness run the new
  entrypoint. The launcher now treats the compiled binary as stale when it is
  older than any client source (`src/cli.ts` or a non-test module under
  `src/cli/`), not only `src/cli.ts`, so an edit to a moved module still
  routes through `deno run` until the binary is rebuilt. Commands, flags, exit
  codes, output and the runtime's launch grants are unchanged; the golden
  suite passes with no snapshot diff. The tests for the moved modules run on
  `Deno.test` beside them, the real-socket `stop` and `status` cases in the
  integration lane; the four launcher-grant cases that build symlink fixtures
  stay on Vitest in `src/cli/launcher/grants.platform.test.ts`.

- **Friction and Linear are extensions too; the core no longer imports any
  extension.** `friction/post` now comes from `prototype/src/extensions/friction/`
  and the Linear integration from `extensions/linear/`; `src/friction.ts`,
  `src/linear-tools.ts` and `src/server/rpc/legacy-extensions.ts` are gone.
  The linear extension resolves the Linear MCP commands friction calls once,
  when the engine starts, instead of friction building a registry of them on
  every post. MCP discovery (`buildExternalMcpCommands`) no longer builds the
  bounded Linear `create_issue` command itself: it takes a
  `buildIssueCreationCommand` port, which the engine fills with the linear
  extension's builder. A caller that omits it gets configured `create_issue`
  and `save_issue` tools withheld as unsupported. The `arch.imports` lane now
  fails when anything other than `src/server/` or `src/cli/` imports
  `extensions/`. `friction/post`'s payloads, numbering, approvals, receipts and
  error messages, and the REPL's `/friction` command, are unchanged.

- **Ideas and packets are an extension behind the new Extension interface.**
  `ideas/*` and `packets/*` now come from `prototype/src/extensions/ideas/`,
  which the engine's composition root builds and plugs in through
  `src/server/extensions.ts`. The idea/packet registry is owned by that
  extension instance, one per engine, instead of a process-wide singleton:
  two engines in one process (as some tests build) no longer share ideas and
  packets. It is still in memory only, so ideas and packets are still lost
  when the engine restarts. The REPL's in-process path (`unix: false`, used
  only by tests) keeps its own registry per REPL session. Method names,
  payloads, error messages and the REPL's `/idea` and `/packet` commands are
  unchanged. The shared RPC parameter sanitizers moved from
  `src/server/rpc/params.ts` to `src/transport/rpc-params.ts`.

- **The engine server's entrypoint is `prototype/src/server/main.ts`.** It
  replaces `src/uds-serve.ts` and `src/uds-server.ts`, which are gone. It is the
  composition root: it builds the store, the session owners, the turn runtime
  and the ACP session map, and it binds the socket. The RPC methods live in one
  module per namespace under `src/server/rpc/`. `deno task serve-unix` and
  `dyfj start` launch the new file with the same permission grants. Anything
  that ran `src/uds-serve.ts` directly must use the new path. The method set,
  payloads, stream frames and error messages are unchanged.

- **A new session's id is allocated when its turn is admitted.** A turn that
  names no session now gets its session id from the engine's session owners
  (`SessionOwners.runTurn`) at admission, and its session owner is registered
  under that id before the runtime starts, so a later turn naming that id is
  serialized behind it. The runtime (native and ACP) uses the allocated id,
  passed as the new `newSessionId` runtime input, instead of generating one.
  The id format, the events, their order and the `sessionStart` frame are
  unchanged.

- **The engine calls back to its caller only through declared ports.** On the
  runtime input (`WorkbenchRuntimeInput`), the five approval handlers
  (`confirmPaidEscalation`, `confirmBudgetCeiling`, `confirmRunawayAnomaly`,
  `confirmToolApproval`, `confirmExternalAgentPermission`) move under one
  `approver` port, and the three output sinks (`onRuntimeEvent`,
  `onTextDelta`, `log`) move under one `frames` port (`FrameSink`).
  `onCancellationClosed` is replaced by `cancellationWindow`, the turn's
  ticket, which the runtime closes by message. `fetchSpendBaselines` and
  `recoverContextOverflow` move from the input to the runtime services
  (`WorkbenchRuntimeServices`). `executeTurn`'s dependencies and the ACP
  runner's input take the same `approver` and `frames` shapes. This changes
  in-process call sites only: the wire protocol, event rows, receipts and the
  golden suite are unchanged.
- **`finalize` is the native turn's last named pipeline stage**
  (`engine/finalize.ts`), and `runNativeWorkbenchRuntime` is now only the
  composition of the six stages. `completeTurn` records a finished or
  cancelled turn, `failTurn` classifies a failure by its real class, and
  `finalize` writes `session_end`, the budget summary, the receipt and the
  session record before returning the result or rethrowing the turn's error.
  Event rows, receipts and the golden suite are unchanged. The engine's last
  Vitest file (`src/workbench.test.ts`, which mocked ten internal modules) is
  gone; its cases run on `Deno.test` against the engine fakes, including a
  new proof that a turn requested from inside a tool approval waits for the
  approving turn to finish.
- **`agentLoop` is the native turn's fifth named pipeline stage**
  (`engine/agent-loop.ts`): it drives model and tool steps until the model
  stops requesting tools, the model repeats prior tool calls, or the
  tool-step limit forces a no-tools conclusion. Each step runs its requested
  tools in order, stops starting new ones once the turn is cancelled, and
  replays the assistant's tool-call turn with its linked results into the
  next call. Event rows, receipts and the golden suite are unchanged.
- **The agent loop's provider calls are engine modules**: `observedTurn`
  (`engine/observed-turn.ts`) is one budget-gated, recorded loop call — the
  daily-spend refresh, the runaway-anomaly stop and the ceiling before the
  call; the turn aggregates, frames and the fail-closed unparsed-markup
  disclosure after it. `recoveredTurn` (`engine/recovered-turn.ts`) wraps it
  with length-stop recovery: one continuation retry when the output budget
  ran out, or one overflow-recovery retry, announced as a superseding retry,
  when the context window overflowed. Event rows, receipts and the golden
  suite are unchanged.
- **`loadTranscript` is the native turn's fourth named pipeline stage**
  (`engine/load-transcript.ts`): it seeds the first call's conversation
  (prior turns for companion turns only, then the current prompt) and
  compresses elder turns first when the transcript would cross half the
  model's context window. Transcript compression is its own module
  (`engine/compression.ts`), shared by that proactive trigger and the agent
  loop's overflow recovery: on-machine model choice, the gated and recorded
  compression call, and the durable `context_compressed` write with its
  by-id durability probe. Event rows, receipts and the golden suite are
  unchanged.
- **`budgetGate` is the native turn's third named pipeline stage**
  (`engine/budget-gate.ts`): it selects the turn's model, runs the entry
  checks in their existing order (runaway-anomaly hard stop, budget ceiling,
  paid consent), and records `model_selected`. The ceiling and anomaly gates
  it builds serve every later provider call of the turn. `SessionOwners` now
  also holds the budget-ceiling confirmation store: a turn reaches its
  session's scope only through `budgetScope`, and the runtime services take
  `budgetScopes` (the owners) in place of `ceilingConfirmations`. The UDS
  server builds one `SessionOwners` and shares it between the turn handlers
  and the runtime. Event rows, receipts and the golden suite are unchanged.
- **`buildContext` is the native turn's second named pipeline stage**
  (`engine/build-context.ts`): it resolves the transport-gated workspace root,
  then assembles repo context for ask and next-work turns, or memory, tools,
  elevated AGENTS.md instructions and the summary trust policy for companion
  turns, and composes the persisted-history omission notice. It writes into
  an engine-owned `TurnState` (`engine/turn-state.ts`), which the rest of the
  turn and its receipt read whatever the stages reached. Event rows, receipts
  and the golden suite are unchanged.
- **`openSession` is the native turn's first named pipeline stage**
  (`engine/open-session.ts`): it fixes the turn's identity, principal, auth,
  budget posture and tool-step limit as a `TurnSession`, announces the turn,
  and writes `session_start`. Failed event writes are counted and kept by a
  per-turn `TurnAudit` (`engine/turn-state.ts`). Event rows, receipts and the
  golden suite are unchanged.
- **The native runtime's helpers and types are separate engine modules**:
  receipt and tally formatting (`engine/receipt.ts`), the next-work worklet
  (`engine/next-work.ts`), runtime-event delivery (`engine/runtime-events.ts`)
  and the runtime's input, services and result types
  (`engine/runtime-types.ts`) moved out of `engine/native-runner.ts`. The
  runtime services accept an optional clock, environment and provider
  transport, and `loadAskRepoContext` an optional `env`; the defaults are the
  system clock, the process environment and the platform `fetch`, as before.
  Event rows, receipts and the golden suite are unchanged.
- **The turn entry and session ownership live in `prototype/src/engine/`**: the
  shared turn core (`turn-runner.ts`) is now `engine/turn.ts`, with request
  validation split into `engine/turn-request.ts`, and the native runtime
  (`workbench.ts`) is now `engine/native-runner.ts`. A new `SessionOwners`
  (`engine/session-owner.ts`), built once per set of turn handlers (the server
  builds one), is the single writer for each session's turn lock (previously
  module-level state in `turn-runner.ts`) and for each admitted turn's cancel
  signal (previously an `AbortController` and flag in the server's handler); the
  server routes `turn/cancel` to the turn's ticket. The external-agent
  permission prompt and selection types moved to `contract/`. Same-session
  serialization, the one-turn-per-connection rule, and cancel semantics are
  unchanged, and the golden suite passes with no snapshot change.
- **`web_fetch` refuses a target it cannot verify as public**: a hostname
  passes the address check only when its A and AAAA lookups both answer
  (either may have no records), together they return at least one address,
  and none is private, loopback or internal. A
  lookup that fails or cannot be made, a name with no addresses, or a lookup
  that outlives the fetch deadline refuses the target before the upstream
  fetch tool is called. A public IP literal is accepted without a lookup, and
  private-literal and localhost rejection is unchanged. For these lookups,
  both `dyfj start` and `deno task serve-unix` grant the engine `<ip>:53` for
  each `nameserver` in `/etc/resolv.conf` on its `--allow-net`
  (`prototype/src/config/nameservers.ts`); the task gets its flag from
  `prototype/scripts/serve-unix-net-flag.ts`, which repeats the profile's net
  list, and falls back to the profile's own list when that cannot be read.
- **The web tools look up hostnames through a `DnsResolver` port**
  (`prototype/src/tools/web/dns.ts`): the web tools' address check resolves a
  target's A and AAAA records through an injected resolver whose lookups never
  throw and report either an answer or why none was obtained. The real adapter wraps `Deno.resolveDns`; tests use the
  `ScriptedDnsResolver` fake (`prototype/testing/fakes/`) instead of replacing
  the `Deno.resolveDns` global, and the address check gains direct tests. Both
  pass the port's conformance suite
  (`prototype/testing/conformance/dns-resolver.ts`): the fake in the unit
  lane, the real adapter in the integration lane in whichever mode that lane's
  net grant allows. The Deno integration lane now runs with `--no-prompt`, so
  ungranted access fails locally as it does in CI instead of prompting.
- **Anthropic and Gemini requests follow the same host and redirect rules as
  the hosted OpenAI-compatible providers**: each key is pinned to its
  provider's canonical https endpoint, the same one `getModelAccessModality`
  classifies as frontier-hosted. `ANTHROPIC_API_KEY` goes only to
  `https://api.anthropic.com` and `GEMINI_API_KEY` only to
  `https://generativelanguage.googleapis.com`, on the default port with an
  empty base path. A catalog row for `anthropic` or `google` that names any
  other base URL fails with `WorkbenchHostedProviderBaseUrlError` before any
  request is sent. Both adapters now refuse redirects (`redirect: "error"`),
  as the OpenAI-compatible adapter already did, and the Gemini adapter encodes
  the model slug as a single path segment of the request URL. The provider
  conformance kit gains two required fixtures, an off-host https base URL
  (rejected before any request) and a redirect response (the turn fails), and
  checks that every request an adapter sends refuses redirects. Requests for
  the canonical endpoints are unchanged.
- **Route resolution and the observed provider call live in
  `prototype/src/engine/`**: `resolveRoute` (`engine/route.ts`) is the one
  step that chooses the runner for a turn. It serves both the native engine
  and the external-agent (ACP) runner, and replaces the two copies of the ACP
  paid-escalation preflight in `workbench.ts`. The native turn selects its
  model through `selectModelRoute`, and all three preflights now go through
  one `confirmPaidRoute`. `observedProviderCall` (`engine/observed-call.ts`)
  is the one implementation of "call the provider, write the `provider_call`
  event, record the usage with the budget tracker"; the agent loop and
  transcript compression both call it instead of each carrying a copy. The
  engine's error classes and `classifyErrorKind` moved to `engine/errors.ts`.
  Event rows, their order, receipts and cost accounting are unchanged, and the
  golden suite passes with no snapshot change.
- **Tools live in `prototype/src/tools/`, with one tool shape and one catalog
  builder**: `commands.ts` is split into the tool shape (`definition.ts`), the
  registry, argument validation, the call-shape policy, a shared redactor
  (`redaction.ts`) and invoke-with-event. The redactor is now the one place a
  tool call is reduced to its durable `tool_call` event: it applies each
  definition's declared argument redaction (`redact` on a schema property,
  `redactArguments`) and result redaction (`redactResult`), exactly as before.
  The builtin tools moved beside their executors as `define<Name>` builders:
  `tools/builtin/memory.ts` (`memory.read`, `memory.search`; `executeReadMemory`
  moved from `memory.ts`), `tools/builtin/file.ts` (was `file-tools.ts`),
  `tools/builtin/exec.ts` (was `exec-tools.ts`), `tools/builtin/git.ts` (was
  `git-tools.ts`); the web tools moved to `tools/web/web.ts` (was
  `web-tools.ts`). `buildToolCatalog` (`tools/catalog.ts`) replaces the three
  registry assemblies (the runtime's per-turn toolset, the `tools/list` and
  `tools/inspect` listing, and the friction command set), and `BUILTIN_TOOLS`
  lists the builtins in their existing order. The legacy `ToolDefinition` and
  `ToolResultMessage` types in `memory.ts` are gone. Tool names, schemas,
  policy verdicts, events, the tool definitions sent to providers and the
  `tools/list`/`tools/inspect` output are unchanged, and the golden suite
  passes with no snapshot change; the engine now imports the tool and memory
  modules statically. A tool conformance kit
  (`prototype/testing/conformance/tool.ts`) runs over a catalog and checks every
  command it holds: a valid schema that rejects invalid arguments before the
  executor or any approver, a declared and coherent effect envelope, the
  policy verdict under `strict` and `operator`, redaction reaching the event
  payload, and exactly one `tool_call` event per invocation. It covers the
  builtins and the MCP-derived commands (`src/tools/conformance.test.ts`), and
  its own self-test covers every effect class. The tests of the moved modules
  are `Deno.test` files in the unit lane beside the modules they cover;
  `buildSafeBashEnv` takes the `Env` port so its test uses `MapEnv`.
  `specs/recipes/add-tool.md` describes adding a tool, and a test-only
  `text.stats` tool under `prototype/testing/tools/text-stats/`, written from
  it, passes the kit.

- **Model providers live in `prototype/src/providers/`, one adapter per API
  family behind a `ProviderAdapter` interface**: the 3,797-line
  `provider.ts` is split into `registry/` (catalog parsing from the store's
  model reader, routing, the built-in local defaults, and dispatch),
  `http.ts` (the `HttpTransport` port and the header deadline), `shared/`
  (SSE line reading, text tool-call extraction, token estimates, wire-safe
  tool names, base-URL rules) and the `openai-compatible/`, `anthropic/` and
  `gemini/` adapters, each with its request, stream, usage and stop-reason
  code. `runWorkbenchTurn` selects the model and dispatches to the adapter
  serving its provider; a provider no adapter serves still fails closed
  before any request. Text tool-call extraction moved verbatim. Request
  bodies, headers, streams, results, errors and receipts are unchanged, and
  the golden suite passes with no snapshot change. The engine now imports the
  provider API statically. A provider conformance kit
  (`prototype/testing/conformance/provider-adapter.ts`) runs every adapter
  through recorded request/response fixtures (plain text, native and
  text-markup tool calls, usage and cost, a length stop, a mid-stream error,
  an abort, a base-URL rejection, plus the header deadline in both request
  modes and an abort before dispatch), replayed by a scripted `HttpTransport`
  fake. That fake passes the port's conformance suite
  (`prototype/testing/conformance/http-transport.ts`) in the unit lane, and
  real `fetch` passes the same suite against a loopback server in the
  isolated-Dolt integration lane. `provider.test.ts` (Vitest) is gone: its
  cases are kit fixtures or `Deno.test` unit tests beside the modules they
  cover, using the scripted transport and the `MapEnv` and `ManualClock`
  fakes. `specs/recipes/add-provider.md` describes adding a provider, and a
  test-only synthetic adapter under `prototype/testing/providers/synthetic/`,
  written from it, passes the kit.

- **Budget and context code live in `prototype/src/budget/` and
  `prototype/src/context/`**, with no change in behavior. `budget.ts` is split
  into the tracker (`tracker.ts`), spend baselines and the local-day boundary
  (`spend.ts`), the envelope gates (`envelope-gate.ts`), the ceiling
  confirmation store (`confirmations.ts`) and the runaway anomaly gate
  (`anomaly-gate.ts`). The confirmation store is no longer a pair of
  module-level maps: the composition root builds one `CeilingConfirmationStore`
  per engine and passes it to the runtime with its services, so confirmations
  still last for their scope periods across the engine's turns. `context/`
  gathers repo-context packing, companion prompt loading, transcript
  compression (`context-compression.ts` is now `compression.ts`), length
  recovery, and the conversation projection that
  rebuilds prior turns from session events (`conversation.ts`). `sessions.ts`
  is gone: its session-record helpers moved to `store/sessions.ts`, and the
  `WorkbenchSessionEvent` read shape moved to `contract/`, so the CLI and the
  ideas extension take it from the contract. Reading wall-clock time for the
  budget's local day now goes through a `Clock` port (`kernel/clock.ts`),
  which the system clock and the `ManualClock` fake both pass a shared
  conformance suite against; the budget's session-envelope warn-then-confirm
  and anomaly hard stop gain component tests over `ManualClock` and
  `MemoryStore`. The moved tests run under `Deno.test`, except two
  repo-context cases that need a subprocess and the process environment,
  which the `Deno.test` unit lane does not grant; they stay on the Vitest
  lane in `repo-context.platform.test.ts`. The engine now imports
  these modules statically rather than through `await import()`, and the
  `arch.imports` baseline shrinks from 23 entries to 13.

- **The engine refuses to start against an un-migrated database**: at boot,
  `serve-unix` compares the Dolt database's columns for the canonical tables
  (`events`, `memories`, `models`, `prompts`, `sessions`) with the generated
  column tuples. When the database is reachable and any are missing, the boot
  fails with a message naming the missing columns and pointing at
  `schema/migrations/`. Before, the event and model readers fell back to older
  column sets instead. A database that cannot be reached or used at boot
  (connection refused or lost, access denied, unknown database, or no answer
  within 5 seconds) is left to fail on first use, as before; any other failure
  of the check fails the boot. Extra columns are not reported.
- **One schema apply-order rule in the docs**: a fresh install applies
  `schema/current/` then `schema/catalog/`; an existing database replays
  forward through `schema/migrations/` on top of the structure `schema/history/`
  ends with. `schema/README.md`, `schema/migrations/README.md` and the README's
  "Initialize Dolt" section now all state it.

- **Every database read and write goes through one store port
  (`prototype/src/store/`), and every write through `journal.commit`**: the
  store is the only code that issues SQL. `Store` exposes `journal` (the one
  mutation path) and read-only readers for events, sessions, memories, the
  model catalog, prompts and spend baselines; each reader is one of the
  queries the runtime and the memory MCP server issued before, with the same
  SQL. `DoltStore` runs over one `mysql2` pool that the composition root
  builds and passes in: the engine server, the memory MCP server and the
  `verify-workbench-events` diagnostic each build theirs from the `DOLT_*`
  settings (`config/dolt.ts`; names and defaults unchanged). The module-level
  pool in `utils.ts`, the MCP server's private pool, `mcp/dolt-config.ts`, and
  the second raw connection that cancellable event writes opened are gone; a
  cancellable write now runs in a transaction on a pooled connection.
  `journal.commit` applies a batch's events, their projections and its
  declared mutations in one transaction. The writes that have no event type
  yet (session inserts and updates, from the runtime and from the MCP
  server's `start_session`/`update_session`, and the MCP `write_memory`
  upsert) pass through it as the three `UnjournaledMutation` kinds listed,
  each with its reason, in `store/unjournaled.ts`; `commit` rejects any other
  kind. The projector mechanism is in place with no phase-1 projectors,
  because no event written today reproduces a session or memory row. Memory
  clearance for loopback, non-loopback and standalone MCP stdio consumers is
  computed in one place, `store/memories.ts`. Rows, receipts, event sequences
  and MCP tool output are unchanged, and the golden suite passes with no
  snapshot change. `MemoryStore` holds the same port in memory for tests. A
  store conformance suite (`prototype/testing/conformance/store.ts`) runs
  against it in the unit lane and against `DoltStore` in the isolated Dolt
  integration lane, each case in its own database. It covers every reader,
  memory clearance for the three consumers, and the journal cases: atomicity
  (including a failing projector), no update or delete path for events,
  rejection of an undeclared mutation kind, and projector determinism. The
  `arch.imports` lane gains two rules, both starting with no baselined
  violations: `mysql2` may be imported only from `store/` (and the
  isolated-Dolt test fixture), and a string literal that begins with an SQL
  write statement may appear only in the store's journal (and that fixture).
  The second rule sees SQL written as literals. The `mysql2` confinement keeps
  any other SQL inside `store/`, and inside it the readers get only a handle
  that runs a single `SELECT` (checked on every call), so only the journal
  holds a write-capable connection.

- **The JSON-RPC/UDS transport lives in `prototype/src/transport/`**: the
  codec, request dispatch and duplex peer (`jsonrpc.ts`, `jsonrpc-peer.ts`),
  socket-path resolution (`uds-path.ts`), the client connect (`uds-client.ts`)
  and the server's socket bind/accept/close loop, split out of
  `uds-server.ts` into `uds-listener.ts`, sit behind `transport/mod.ts`. The
  CLI reaches the engine only through it, and `uds-server.ts` keeps the method
  handlers and calls the listener. The peer now builds its request frames with
  the codec's new `request()` envelope builder instead of an object literal;
  the bytes on the wire are unchanged (framing, method names, error codes and
  socket-path resolution included), which the Rust REPL client relies on, and
  unit tests pin the request, notification and response frames byte for byte.
  The transport tests moved to `Deno.test` beside their modules: protocol
  cases run in the unit lane over in-memory connections, and `uds-client`,
  which had no tests, gains unit and real-socket cases. The real-socket cases,
  including the stale-socket and bind-refusal checks that were in
  `uds-server.test.ts`, run in the isolated-Dolt integration lane, which now
  grants `unix:` access to the exact socket paths listed in
  `prototype/testing/servers/uds-sockets.ts` inside a lane-created directory
  passed as `DYFJ_UDS_TEST_SOCKET_DIR` (declared in `CONFIG_SCHEMA`'s `test`
  domain; no runtime permission profile grants it).

- **Configuration lives in `prototype/src/config/`, and runtime code reads the
  environment only through an `Env` port**: `config.ts` is split into the env-key
  schema (`schema.ts`), TOML loading (`toml.ts`), the engine config
  (`workbench.ts`), the `[secrets]` and `[mcp]` parsers, and the
  budget/agent/anomaly resolvers (`defaults.ts`), behind `config/mod.ts`. The
  port (`config/env.ts`) is the only runtime module that touches `Deno.env` or
  `process.env`; every other module, including the CLI, engine and memory MCP
  entrypoints, takes an `Env` or uses its process adapter. Its semantics are
  `Deno.env`'s exactly, so env var names, defaults, precedence and error
  messages are unchanged. The launcher's `.env` parser moved out of `cli.ts`
  into `config/env-file.ts`, together with the ambient-before-`.env` rule the
  launcher shares with the spawned runtime. `CONFIG_SCHEMA` now also declares
  `DYFJ_NODE_PATH`, `DYFJ_CODEX_TOOLCHAIN_PATH`, `DYFJ_CODEX_RUSTUP_HOME` (engine
  and client), `DYFJ_PROTOTYPE_ROOT` (client), `DYFJ_TEST_RUN_DIR` and
  `DYFJ_MCP_TEST_TEMP_DIR` (a new `test` domain) and the test harness's `DYFJ_TEST_BOUND_SEC`, `DYFJ_LOCK_TMP`,
  `DYFJ_LOCK_FILE` and `DYFJ_LOCK_RESULT` (a new `tooling` domain); no runtime
  permission profile grants a `test` or `tooling` key, and none changed. The `arch.imports` lane gains two rules: direct
  environment access outside `config/` and the entrypoints named in
  `scripts/arch-layers.json` (today only the `prototype/scripts` tooling), and
  a `DYFJ_*` key (a string literal, object key or member name) anywhere
  under the lane's `prototype/` roots (runtime, `mcp/` and `scripts/`) that
  the schema does not declare. Only modules that physically live in
  `config/` are exempt from the first rule; a legacy module mapped into the
  config unit by name is not. The root
  gate's own `DYFJ_GATE_*` keys are outside `prototype/` and out of scope.
  Both start with no baselined violations. The config tests moved to
  `Deno.test` next to the modules they cover, and an `Env` conformance suite
  (`prototype/testing/conformance/env.ts`) runs against the `MapEnv` fake in
  the unit lane and against the process adapter in the integration lane.

- **Typecheck file lists are derived, not hand-maintained**: the prototype
  `check` task and the aggregate gate's source typecheck each carried their own
  hand-written list of entry files, and the two had drifted apart. Both now run
  `deno task check:sources`, which typechecks every non-test module under
  `src/`, `mcp/`, `scripts/` and `testing/`, found by walking the tree; the
  test-file typecheck (`check:tests`) uses the same discovery module
  (`prototype/scripts/test-files.ts`, replacing `check-test-files.ts`). A new
  module is covered on arrival, and modules that were outside both lists are now
  typechecked too.

- **Local imports carry explicit extensions; `--sloppy-imports` is gone**: every
  local import under `prototype/` now names its file (`./utils.ts`), and the
  inline `npm:` specifiers for the MCP SDK, `zod`, `ulid` and `mysql2` moved into
  the `prototype/deno.json` import map. `--sloppy-imports` is no longer passed by
  any task (`compile-cli` included), by the CLI when it autostarts the server,
  by the launcher's `deno run` fallback, or by the typecheck, integration and golden
  lanes. Runtime behavior is unchanged. An extensionless local import now fails
  the typecheck instead of being guessed, which keeps file moves grep-safe.
  `prototype/scripts/add-import-extensions.ts` rewrites extensionless imports in
  bulk.
- **Vitest test and hook timeouts are sized to the suite**: the suite ran on
  Vitest's defaults of 5 seconds per test and 10 seconds per hook. Neither was
  chosen for a suite whose workers spawn and reap real processes. Measured on an
  idle machine with every test passing, the slowest single test takes 3.65
  seconds and the five next-slowest all exceed 2.3 seconds, leaving the 5-second
  default about 1.4x headroom. Separately, four files were seen failing under the full
  parallel run in one afternoon — one on the hook timeout, one on the test
  timeout, two on late timers during initialize — every one a timeout rather
  than a failed assertion, and every one green when the file ran on its own.
  Those failing files are not the same set as the slow tests measured above.
  The timeouts are now 30 seconds per test and 45 seconds per hook. The
  durations, the failures and the full-run results are recorded with their
  method in `prototype/VERIFICATION-2026-09-22.md`.

  What this does not establish is the cause. Three consecutive full runs pass at
  2192/2192 with these values, which is a correlation with parallel execution
  rather than an explanation of it. If these files start failing again, the
  cause is still open and that is where to look.

  The cost is that a test or hook which stays pending is reported later: it can
  run to 30 seconds, or 45 for a hook, before the suite says so. These are
  thresholds rather than cancellation or a required duration — work that
  finishes sooner still finishes sooner, and a timed-out teardown that left a
  child holding a resource still leaves it. The supervised Vitest phase keeps
  its own deadline, defaulting to 600 seconds for a full run and 180 for a
  recognised focused one.

- **A buffered provider request gets a larger header deadline**: every provider
  request was bounded by a 30-second wait for response headers, written to
  detect an unreachable provider. The endpoints reached by the buffered path
  defer headers until the response body exists, and the Anthropic and Google
  readers cannot stream tool-offering calls, so in practice that budget capped
  generation: an agent-loop turn could not emit an edit that took more than 30
  seconds to write, and died reporting a connection-shaped error. Buffered
  requests now wait up to 300 seconds for headers; streaming requests keep the
  30-second budget.

  What this does not do: the timer is cleared once headers arrive, in both
  modes, so body consumption afterwards remains unbounded exactly as before.
  The larger budget covers generation only because those endpoints withhold
  headers until they have a body — an observed property of the endpoints, not
  a guarantee this code enforces.

  The cost of the split is stated rather than hidden: before the first byte, a
  buffered request that is silent because the route is dead and one that is
  silent because it is generating look the same, so a buffered call left
  pending without headers can now wait up to 300 seconds before failing. A
  connection error the runtime reports promptly, such as a refused connection,
  still fails promptly. Streaming calls keep the tight budget. Both timeout
  messages now name the mode and the budget that elapsed, which the timer can
  observe, and offer a cause as a possibility rather than a finding.

- **Friction capture follows the Linear MCP tool set it actually finds**:
  `friction/post` posts through either `linear.create_comment` or
  `linear.save_comment`, and reads existing comments through
  `linear.list_comments` rather than expecting them inside the `get_issue`
  response. Both were upstream shapes that had moved, and the command failed
  before it could post.

  The comment read is paged and fail-closed. It follows the continuation shapes
  it recognises — a top-level `hasNextPage` and cursor, or a `pageInfo` object
  beside a `nodes`/`items` container — to the end, or it fails. The next number
  is the highest one on the issue plus one, so numbering from a partial list
  could reuse a number that already exists; a page promised without a cursor, a
  tool declaring no cursor argument, continuation still pending after forty
  pages, and a page clipped by the external-result ceiling each fail the read
  instead. A server signalling continuation some other way reads as finished,
  which the source states rather than hides.

### Removed

- **Vitest is removed; `Deno.test` is the only test framework.** Gone:
  `npm:vitest` and its locked packages, `vitest.config.ts`, the Vitest runner and
  its process supervisor (`scripts/run-vitest.ts`,
  `scripts/test-process-harness.ts`, `scripts/test-process-reaper.ts` and their
  tests), the esbuild binary resolution, the `.vitest-tmp` directory, and the
  gate's two Vitest lanes. The hand-maintained
  `scripts/integration-test-assignment.ts` is deleted: the integration lane
  runs every `*.integration.test.ts` it finds by name, and test files are no
  longer classified by their imports. The ACP signal probe no longer appends a
  `DYFJ_TEST_RUN_DIR` value to its arguments, and the config schema drops that
  test key and the supervisor's tooling keys (`DYFJ_TEST_BOUND_SEC`,
  `DYFJ_LOCK_TMP`, `DYFJ_LOCK_FILE`, `DYFJ_LOCK_RESULT`).
  `scripts/add-import-extensions.ts` no longer rewrites Vitest module-helper
  paths. The launcher tests' process-scan cleanup moves to
  `testing/processes.ts`. The gate has no per-lane wall-clock bound until the
  supervision that replaces the Vitest supervisor lands.

- **Schema-drift fallbacks removed**: `events.bySession` (behind
  `events/query` and session history) no longer retries with NULL placeholders
  when a column from migrations 003-007 is missing, and the model catalog
  reader no longer falls back to the query without the hardware-profile
  columns. A live database is covered by the boot-time column check; an
  `events/query` read `AS OF` a snapshot that predates one of those migrations
  now fails with the driver's unknown-column error instead of returning NULLs
  for the missing columns.

- **Standalone in-process workbench CLI removed**: `deno task workbench` (root
  and `prototype/`), `deno task start` (`prototype/`), the `workbench`
  permission profile they ran under, and the argv CLI in `src/workbench.ts`
  (its entrypoint, `runWorkbench`, `resolveWorkbenchInvocation`,
  `buildWorkbenchRuntimeInput`, and the TTY consent prompt
  `promptPaidEscalationTty`) are gone. Run turns through the `dyfj` launcher
  over the UDS JSON-RPC seam (`dyfj exec`, or `deno task serve-unix` for the
  engine alone). `deno task verify-workbench-events` now calls the runtime
  directly with its routing read from `DYFJ_WORKBENCH_MODEL`, `_HINT` and
  `_TIER` as before; it no longer prompts for paid-inference consent, so a
  turn routed to a paid model is declined rather than asked about.
- **Unused helpers removed**: the CSV parsers (`parseCSVRows`, `parseCsvRow`),
  `extractText`, `extractThinking` and their `MessageContent` type, and
  `normaliseStopReason` (`utils.ts`); the `read_memory` definition and result
  builders (`buildReadMemoryTool`, `buildToolResult`) and the type-keyed memory
  loaders (`loadMemoriesByType`, `loadMemoryIndex`) (`memory.ts`); and
  `createProjectWorkbenchSession` (`sessions.ts`). None had a production caller.
  `buildModelSelectedEventPayload` and `getMemoryBySlug` are still used inside
  their modules and are no longer exported. The turn runtime type loses its
  HTTP-era name: `WorkbenchHttpRuntime` is now `TurnRuntime`.

### Fixed

- **The file tools' workspace-root anchors are owned by the engine, not held
  in a process-global map.** `RootAnchors` (`tools/builtin/root-anchors.ts`)
  holds them; the composition root builds one per engine and hands it to each
  turn, so a root pinned on its first use stays pinned for the engine's
  lifetime, as before. A tool catalog that registers the file tools without
  anchors now fails closed. The regex worker's memoized Blob URL is now a
  constant `data:` URL. No runtime (non-test) module in `prototype/src/` holds
  module-level mutable state.

- **An interrupted ACP test run no longer leaves files in the working tree**:
  the ACP client, session-map and external-agent runtime tests created their
  pid files, method logs and scratch homes in `prototype/`, so a run stopped
  mid-test left them behind, where a broad `git add` could commit them. They
  now come from the system temp directory, which the integration lane points
  at a per-run directory it removes afterwards, so nothing lands in the
  working tree.

- **ACP agent stdout cancellation is handled cleanly**: when the ACP client
  closes its connection after the agent process exits but before the agent's
  stdout has closed (for example, a descendant still holds the pipe), the
  client now cancels its view of stdout by closing the underlying pipe
  directly instead of forwarding the cancel reason into Deno's Node-stream
  adapter. `prototype/src/acp-client.test.ts` covers the case with an agent
  launched behind a backgrounded descendant that keeps stdout open.
- **A prototype unit test no longer changes the process environment under the
  parallel run**: tests in `prototype/src/external-agent-runtime.test.ts` set
  `PATH`, `HOME`, `DENO_DIR`, `DYFJ_*`, and credential-shaped marker variables
  through `Deno.env.set` and restored them after an `await`. Vitest's worker threads share one process
  environment, so tests running at the same time in other files could see the
  temporary values; one intermittently failed to spawn `bash` by name. Those
  tests now overlay the values on the reads of their own worker only, with
  assertions unchanged. Test-only; runtime behavior is unchanged.

### Added

- **Golden characterization suite and its gate lane (`test.golden`)**:
  twelve black-box scenarios now pin the engine's observable behavior before
  the restructuring starts. They cover one-shot and multi-step turns, approval
  under both permission postures, session resume, the budget ceiling and paid
  consent gates, the runaway-anomaly hard stop, an ACP fixture turn,
  mid-stream cancellation, the read and extension RPC methods, and transcript
  compression. Each scenario drives the real engine server and `dyfj` CLI as
  child processes against an isolated Dolt fixture, a loopback
  OpenAI-compatible model server and a loopback Linear MCP server, and compares
  stream frames, RPC responses, rendered CLI output, and every `events` and
  `sessions` row it writes with committed snapshots. Only generated IDs,
  timestamps, durations, temp paths, PIDs and the fixtures' loopback endpoints
  are normalized; timestamps keep their format, so a change of wire format
  still fails the lane. The aggregate gate runs the lane under `test.aggregate`,
  and `deno task test:golden` (in `prototype/`) runs it alone. Three
  pre-existing defects it surfaced are recorded in `specs/bug-log.md` and are
  not fixed here.

- **DeepSeek V4.1 Flash and Gemini 3.8 Flash in the model catalog**: both are
  routable, on the fresh-install path and the upgrade path alike. DeepSeek
  reaches OpenRouter, Gemini reaches Google directly.

  Their prices carry more caveats than a catalog row can hold, so
  `schema/catalog/VERIFICATION-2026-09-19.md` records the source, capture date
  and figure for each field beside the SQL. Two are worth knowing before
  relying on a cost estimate. DeepSeek V4.1 Flash is priced by time of day —
  half rate at most hours and all weekend, double for seven hours of every
  weekday — and the row stores the peak, so off-peak turns cost half what the
  catalog predicts. Gemini's rates are promotional and double on 2027-01-01,
  after which the row understates cost until someone updates it.

  The Gemini row omits the `tools` capability although the model supports
  function calling, because this codebase's Google adapter sends no tool
  declarations and parses no function calls. That is catalog metadata only; no
  routing decision reads the field, so naming the model for tool-using work
  still selects it.

  This migration preserves each existing row's `active` state, so re-running it
  will not re-enable either model if an operator disabled it. That is specific
  to this migration; earlier ones do overwrite `active` on conflict.

- **`deno task test:file <path>`**: Runs a single Vitest file, skipping the
  whole-project typecheck that `deno task test` performs, for iteration while
  editing one file. `deno task test` is unchanged and remains the entry point
  before committing, since it typechecks the project and runs the full suite.
  `prototype/README.md` records which to use when.

- **Bounded `git` agent tool**: The agent loop can now inspect and record
  changes to the workspace through a `git` command with a closed subcommand set
  — `status`, `diff`, `log`, `add`, `commit`. Arguments are typed and the
  process argv is built from them, so no flags or shell syntax pass through;
  `--literal-pathspecs` and a leading-`:` rejection keep a path argument a
  filename rather than a pathspec expression, so magic prefixes such as
  `:(top)` cannot reach outside a nested workspace. The tool exposes only those five
  subcommands, so network ones (`push`, `pull`, `fetch`, `remote`) and
  history-rewriting or working-tree-destroying ones (`reset`, `rebase`,
  `checkout`, `clean`, `stash`) are rejected as invalid arguments before the
  approval prompt rather than costing an operator decision; the reason each is
  absent is recorded in the module for callers that bypass the schema. Like `bash`, it carries an
  exec-class effect and therefore always requires per-call operator approval,
  and its result is kept out of the durable event log; unlike `bash`, the
  approval names the exact operation and paths. The permission envelope
  declares `network: "external"` because git executes repository configuration
  — hooks, credential helpers, textconv — which the tool deliberately leaves
  enabled so an operator's own pre-commit checks still run. A `commit` without
  paths is a repository operation: when the workspace is a subdirectory, a
  best-effort probe says so in the result. Supplying paths to `commit` records
  their working-tree content rather than narrowing the staged snapshot. Output is collected in full and then clipped to a byte cap,
  and the timeout kills git but not descendants it spawned — the same two
  limits `bash` has. The `workbench` and `serve-unix` permission profiles now
  grant `run` access to `git`, which the runtime needs to execute the tool at
  all.

- **Bounded native Linear issue creation**: A configured external MCP
  `save_issue` (or legacy `create_issue`) can now back a create-only local tool
  on native loopback turns with a fixed team,
  an exact project-name-to-ID allowlist, strict local argument limits, and
  per-call operator approval before a connector write. Relation count is checked
  before item validation and approval; duplicate relations are rejected before
  the connector call. Workbench withholds unbound or schema-mismatched
  creation tools across configured servers, excludes update IDs and patch inputs,
  projects supported creation fields, reports fixed withholding reasons
  at boot, withholds creation tools when schema serialization fails,
  never retries ambiguous failures, validates returned
  team/project evidence, and returns and durably records only the validated
  issue identifier while retaining generic MCP argument/result redaction. Receipts
  accept issue-style `id` aliases and distinguish display labels from explicit
  association IDs. Malformed or conflicting values in explicit `teamId`, `team_id`,
  `projectId`, `project_id`, `team.id`, or `project.id` fields produce an
  indeterminate outcome even when another ID matches. In the streaming CLI and
  interactive REPL, failed creation calls
  display reconciliation guidance independently of model prose. Durable trace
  evidence requires the OTel event migration. This
  does not add the capability to bare ACP sessions or add a REPL command.
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
- **REPL friction capture**: `/friction <sev> [--escaped] <text...>` now posts
  one numbered ritual-format entry through a narrow loopback `friction/post`
  method that reuses configured Linear MCP read/write authorization, prints an
  honest comment receipt, and retains the last successful receipt in the REPL.
  `DYFJ_FRICTION_ISSUE_ID` must identify the operator's friction-checkpoint
  issue.
- **macOS portability gate**: The full deterministic gate now runs in an
  independent macOS 15 arm64 clean checkout with digest-pinned Deno and Dolt
  archives, alongside the stable Linux required check on Ubuntu 24.04.

### Fixed

- **Fail-visible persisted-history continuation**: Malformed persisted tool
  records and fixed ACP history-gap markers are now withheld per record across
  runner kinds instead of invalidating an otherwise usable session. Resume
  preserves valid tool pairs, empty valid results, prompts, prose, and stored
  summaries. At the history-reconstruction boundary it refuses an
  unrepresentable retained pair or a transcript left empty by withholding, and
  it recomputes exact whole-history and selected-window record counts from
  immutable events without deduplication or a false minimum missing-call count.
  Continuing native companion, warm ACP, reconstructed ACP, and direct ACP
  requests carry one value-free Workbench-generated notice outside compressible
  history, while receipts report those counts separately from the actual
  history-delivery mode. Receipts label notice composition, not confirmed
  delivery. One-shot native ask and next-work requests remain transcript-free
  and omit the omission notice and receipt. Existing downstream checks and
  prompt bounds still apply to the final decorated ACP request, including the
  existing acquired-handle close behavior on an oversized prompt; persisted
  events are not changed or deleted.
- **Read-only closure comparison**: The deterministic gate compares the generated
  report in memory with the committed bytes, with writes denied. It no longer
  writes through a predictable temporary filename. Comparison rejects an output
  path; explicit report generation remains a separate write operation.
- **Event-family omission evidence**: The closure report removes each required
  family from a copy of the schema inventory and checks that the same inventory
  predicate rejects it before reporting the omission witness as passing.
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
- **Bounded-field byte sizing fails closed on a short encoder read**: The
  UTF-8 byte-limit helper that bounds ACP continuity history and tool fields
  now documents the invariant it relies on (a 4,096-code-unit chunk fits a
  12,288-byte buffer because UTF-8 needs at most three bytes per UTF-16 code
  unit), advances by the encoder's reported read count, and treats a short
  read as an overflow so the caller refuses the field instead of undercounting.
  Non-ASCII bound tests cover three-byte characters, four-byte emoji, lone
  surrogates, a surrogate pair straddling the chunk boundary, exact-limit and
  one-byte-over inputs, and a forced short read.
- **ACP continuity after an expired handle**: A follow-up turn whose keyed ACP
  handle has been retired no longer starts an empty native session while the
  Workbench session is presented as continuous. Workbench now decides continuity
  against the handle it actually acquired and, when that handle is a
  replacement, projects a bounded transcript of the session's own prior turns
  into its prompt. Each external-agent turn records one observed state — `new`,
  `warm-reused`, `durably-resumed`, or `reconstructed` — with the durable-resume
  status, the projected message and tool-exchange counts, and the prior and new
  external session identifiers on the runner receipt. A durable native resume is
  claimed only when the runner advertises ACP `session/load` and the resumed
  external session identity is verified. Workbench now merges real ACP tool-call
  updates and persists their terminal raw input/output as a bounded pair only
  when the adapter supplied complete evidence and its values pass the explicit
  credential-shape gate. Incomplete, oversized, or credential-shaped evidence
  leaves only a fixed value-free gap marker; a replacement turn then refuses
  before model work instead of silently losing the exchange. Prior tool work
  travels as bounded, quoted historical evidence that preserves request/result
  pairing, ordering, and outcome status — labelled as Workbench's record of an
  expired session rather than as something the receiving agent did or may
  repeat — and no recorded call is re-executed. The `dyfj` footer exposes the
  continuity state, native-session disposition, and tool-evidence counts. Tool
  metadata uses an inert ASCII grammar;
  quotation protects the transcript structure but is not claimed as a semantic
  prompt-injection boundary. A reconstruction is refused before any prompt
  reaches the agent when it would exceed the prompt, 32-message, per-message,
  per-field, or tool-argument complexity bounds, or when persisted tool history
  is unpaired, malformed, or matches an explicitly checked credential shape.
  At the Dolt read boundary, persisted JSON tool arguments are projected as
  text and then validated by the session decoder. Malformed persisted tool
  history from any runner kind is rejected before reconstruction.
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

- **Dependency updates**: Bumped `@david/dax` 0.42.0 → 0.50.0, `@std/toml`
  1.0.8 → 1.0.11, `mysql2` 3.22.3 → 3.24.4, and `ulid` 2.4.0 → 3.0.2 in the
  prototype, and `anyhow` 1.0.102 → 1.0.104, `rand` 0.10.1 → 0.10.2, and
  `thiserror` 2.0.18 → 2.0.20 in `core`.
- **Current Codex ACP adapter**: Upgraded the pinned `codex-chatgpt` adapter to
  `@agentclientprotocol/codex-acp` 1.11.0 and refreshed its locked compatible
  Codex CLI dependency.
- **Dependency refresh configuration**: Dependabot now targets the Deno
  workspace at `prototype/` (its dependency manifest and lockfile) and the
  Rust crate set at `core/`, instead of the repo-root `deno.json` (which
  declares only deno tasks). The weekly GitHub Actions digest lane is
  unchanged. The Rust toolchain pin and the Deno/Dolt archive pins in
  `.github/workflows/gate.yml` are not Dependabot-covered; applying a change
  to them is intended to be a manual, operator-inspected step.
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

- **The runtime's Unix-socket server no longer keeps a connection open after
  its client disconnects.** Before this fix, `serve-unix` left its side of
  every client connection open until the runtime stopped, so each `dyfj`
  command that connected to the runtime held one file descriptor for the life
  of the runtime. A long-running
  runtime, or any local process able to connect to its socket, could exhaust
  the process's descriptor limit, after which the runtime could no longer accept
  connections or open files. The server now closes a connection once its client
  disconnects and the requests the client already sent have been answered.
- **A new session's first turn is serialized with later turns that name it**:
  a turn that started a new session previously ran outside that session's turn
  lock, because its session id was generated only once the turn was running. A
  second turn naming that id, sent from another connection while the first was
  still running, could run alongside it: its resume read could see a partially
  written first turn, and both turns appended to the same session. The id is
  now allocated when the turn is admitted, so later turns naming it wait for
  it.
- **Anthropic and Gemini credentials pinned to their providers' hosts**: the
  Anthropic and Gemini adapters previously accepted any https base URL from the
  model catalog and followed redirects, so a catalog row naming another host, or
  a redirect from the provider, could send `ANTHROPIC_API_KEY` or
  `GEMINI_API_KEY` and the request body to that host. Each key now goes only to
  its provider's canonical endpoint, redirects are refused, and the Gemini model
  slug is encoded as a single URL path segment.
- **The web tools' private-address check fails closed**: the check that keeps
  `web_fetch` away from private, loopback and internal addresses previously
  passed a hostname whenever its DNS lookup failed or could not be made. The
  engine's host-pinned network grant made every such lookup fail, so a hostname
  resolving to a private address was not refused. Targets the check cannot
  verify are now refused, lookups go through a `DnsResolver` port, and the
  engine is granted its system nameservers so lookups can run.
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
