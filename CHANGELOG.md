# Changelog

Notable changes to DYFJ. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

DYFJ is an actively developed prototype with no release tags yet, so entries are
dated rather than versioned. Document-level revisions of the operating-context
README are tracked separately in its Revision history section.

## [Unreleased]

### Added

- **The runtime names each configured external MCP tool that a reachable
  server leaves out.** At boot, a configured tool the server does not offer prints
  `external MCP <server>: configured tool "<name>" not offered by the server`,
  and one whose schema the sanitizer rejects prints `... schema rejected:
  <reason>`, naming the limit or rule it broke (for example `enum of 65 values
  exceeds 64`), and a web capability tool that an earlier server outranks
  prints `... not used: web_search comes from <server>`. Before, all three
  were dropped silently and only the tool count changed. A server that is
  unavailable (no credential, failed discovery) is still reported as one
  line for the whole server. `dyfj status` shows the same lines, which `runtime/status` reports
  as `externalMcp`. The ready line now names the `web_search`/`web_fetch`
  commands a server backs, so a web-only server such as Tavily no longer reads
  as `ready (0 tools, ...)`.

- **`dyfj dev` falls back to the last good runtime, so the model can repair
  an edit that breaks it.** A runtime that boots on the working tree is copied
  to `prototype/.dyfj-dev-last-good/` (gitignored). When a reload's runtime
  fails to start, `dyfj dev` runs that copy instead on the same socket, the
  REPL resumes on it, and one line says so; the next save tries the working
  tree again. Each native loopback turn the fallback runs carries the failed start's
  error output as a labelled block of local diagnostic output (sanitized,
  capped at 2 KB, listed in the receipt's context sources); external-agent
  turns do not. A copy recorded with a different `package-lock.json` hash, or one whose
  files no longer match its record, is not run. A failed first start uses a
  copy from an earlier run and says so. `/rollback` switches to the last good
  code by hand, and `/reload` returns to the working tree. Under `dyfj dev`,
  the REPL's freshness warning names the last good code (or a pending
  reload) instead of the autostarted lifetime. The
  README adds "Working on the harness from inside it".

- **`dyfj dev`: the runtime and the Rust REPL reload when their code
  changes.** One command in one terminal: it builds the REPL
  (`cargo build -p dyfj-repl`, debug), starts its own runtime on a dev socket
  (`--socket`, else `dev.sock` beside the default daily socket) with the real
  config and Dolt, and runs the REPL in the foreground. It watches
  `prototype/src` and `core/` and takes each batch of saves 300 ms after the
  last one. A module the server's import graph reaches (from the `arch.imports`
  graph code) restarts the runtime. A file in the REPL's crate, or a workspace
  crate it depends on, rebuilds the REPL and restarts it in the same session.
  A `contract/` or `transport/` module restarts both, the runtime first. Test
  files and modules only the TypeScript client loads restart nothing. Reloads
  wait while a turn is in flight; `/reload` in the REPL forces one, and the
  REPL's `runtime reloaded` notice says why (`3 files changed`). A REPL build
  failure keeps the running REPL and runtime and shows the error on one line;
  a runtime that fails to start leaves the REPL waiting, and the next save
  starts it again. Quitting the REPL stops the runtime and ends `dyfj dev`; a
  `dyfj dev` killed outright leaves a runtime that stops 10 s after its last
  client. Plain `dyfj` is unchanged.
- **The Rust REPL takes a `dyfj dev` control channel** on the socket
  descriptor named by `DYFJ_DEV_CONTROL_FD`: the supervisor sends the reload
  reason and asks it to exit before a rebuilt REPL replaces it; the REPL
  reports its session id and `/reload`. Malformed or unknown messages are
  dropped, and a closed channel leaves a plain REPL. Without the variable,
  `/reload` is still sent as a prompt.

- **The Rust REPL survives a runtime restart.** When the socket drops,
  `dyfj-repl` prints `runtime disconnected; waiting…` and retries with a
  backoff that doubles from 100 ms to a 2 s cap, without a limit. The prompt
  stays open while it waits, so Ctrl-C, Ctrl-D or `/quit` quits at once; any
  other line is refused rather than queued. On reconnecting it reads the
  session back with `sessions/inspect`, prints `runtime reloaded` with the
  session it resumed and a posture line from the new runtime, and the next
  turn names the same session id. A turn in flight at the drop is reported
  as interrupted and is not retried; if it was the session's first turn, the
  REPL keeps the id from the runtime's `sessionStart` event, so the next turn
  resumes that session instead of opening a second one. An approval question open at the drop is
  cancelled and never answered: the client writes nothing on a closed
  connection, and an answer typed into the question afterwards is reported
  as not sent. A request made on a closed connection now fails at once
  instead of waiting for a reader that has gone.
- **The Rust REPL drains the runtime's messages between turns.** Stream
  frames that arrive while it waits at the prompt (from a turn abandoned
  with a second Ctrl-C) are discarded instead of rendering under the next
  prompt, and an approval request that arrives then is denied on the
  connection that raised it. Left queued, they could fill the client's
  channel and stall its reader, which would then miss a disconnect.
- **The launcher passes the Rust REPL its runtime log as
  `DYFJ_RUNTIME_LOG`.** It is this socket's autostart log
  (`~/.dyfj/log/runtime-<socket>-<hash>.log`). While the REPL waits for the
  runtime, it reads only what the log gained since the drop and prints the
  last new line containing `error`, with control characters replaced and
  capped at 200 characters, so a runtime that crashes while starting says
  why. A missing or unreadable log is skipped silently; a replaced or
  truncated one is read from its start.
- **An autostarted runtime stops with its last client.** A runtime the
  launcher autostarted (`--launcher-autostarted`) now stops 10 s after its
  last client disconnects, through the same shutdown as `dyfj stop`: warm ACP
  sessions and their child processes are closed, then the store. A client
  that connects inside the 10 s keeps it, so back-to-back `dyfj exec` calls
  share one runtime. An interactive REPL keeps it up while it waits at the
  prompt: the Rust REPL holds its one connection, and the TypeScript REPL now
  holds a connection for the session besides the one each turn opens. The
  golden normalizer masks the new code fingerprint (`specs/03-testing.md`).
  A runtime started with `dyfj start` is unchanged and
  stays up until `dyfj stop` or Ctrl-C. Before this, an autostarted runtime
  ran until stopped by hand.
- **The runtime records which code it loaded, and clients say when it is
  stale.** At boot the runtime records a code fingerprint: the checkout's git
  HEAD, read from the `.git` files without running git (worktrees, packed refs
  and a detached HEAD included), and a SHA-256 content hash of the files under
  `prototype/src` (dotfiles and symlinks skipped). Either is `unknown` when it
  cannot be read, and a hash that is unknown or not well formed (on either
  side) is never compared, so it never causes a warning or a restart.
  `runtime/status` reports it as `fingerprint` (`{ head, contentHash }`), along with the open
  `clients` and the `inFlightTurns`; clients that predate these fields ignore
  them. `dyfj status` shows the code version, whether it matches the working
  tree, and the client and turn counts. The TypeScript and Rust REPLs print
  `warning: runtime is behind the working tree` after the posture line when
  the runtime's hash differs from their own checkout's. The Rust REPL finds its
  checkout through `DYFJ_PROTOTYPE_ROOT`, which the launcher now exports.
  The three implementations of the hash share one test vector
  (`prototype/testing/fixtures/code-fingerprint`).
- **The launcher restarts a stale runtime it autostarted.** Its first probe is
  now a launcher-internal client mode (`--freshness-probe`, refused outside the
  launcher and absent from `--help`). When the runtime was autostarted and is
  behind the working tree, the probe asks it to stop with the new conditional
  `runtime/stop` parameter `{ ifSoleClient: true }`, and the launcher
  autostarts a current one. The runtime declines that stop
  (`{ status: "declined", reason }`) while another client is connected or a
  turn is in flight; the launcher then warns and uses the running runtime.
  When it does stop, it stops admitting connections in the same step as that
  check, before any cleanup; a client that connects after that is refused or
  disconnected unserved, as after any stop, and a `dyfj` invocation then
  autostarts a current runtime. Tests enforce both orderings. A runtime started with
  `dyfj start` is never restarted.
- **The launcher warns when the Rust REPL binary is stale.** When
  `core/target/release/dyfj-repl` is older than a file under
  `core/dyfj-repl/src`, the workspace `Cargo.toml` files or `Cargo.lock`, a
  bare interactive `dyfj` routed to it prints
  `cargo build --release -p dyfj-repl` to run from `core/`. The launcher builds
  nothing. A binary chosen with `DYFJ_REPL_BIN` or found on `PATH` is not
  checked.
- **`.node-version` is the single Node pin.** It holds `26.11.1`, and both
  CI jobs install Node through `actions/setup-node` with
  `node-version-file: .node-version` instead of two hard-coded copies of the
  version. A gate test (`scripts/ci-workflow.test.ts`) fails when the file,
  the workflow and the `engines` field of both `package.json` files (`>=26`)
  disagree.
- **A dependency-policy tripwire for the retired Deno runtime.** The
  `dependency.policy` lane now fails on a tracked `deno.json`, `deno.jsonc`
  or `deno.lock` at any depth, on a quoted `jsr:@scope/name` specifier in
  tracked code or JSON, and on a `deno` Dependabot lane. Gate tests also fail
  when a gate lane starts `deno` or any lane or test runner forwards a
  `DENO_*` variable, and test discovery fails on a file anywhere that
  registers with the retired runner.
- **`npm run test:file` and `npm run test:golden` in `prototype/`.** They
  replace the `deno task` entries of the same names:
  `npm run test:file -- <path>... [--filter <pattern>]` runs named unit test
  files (it exits 2 without a path), and `npm run test:golden` (with
  `-- --update` to rewrite snapshots) runs the golden suite.

- **`ratchet.base`: the ratchet lists are checked against the merge base.**
  A new gate lane, `node scripts/ratchet-base.ts`, under `test.aggregate` in
  the full gate and `test:fast` (a docs-only pull-request run skips it, since
  a Markdown-only change cannot change a list), compares
  `scripts/runtime-neutral-exceptions.json`,
  `scripts/arch-size-exceptions.json` and `scripts/arch-imports-baseline.json`
  with the same files at the merge base of HEAD and `DYFJ_GATE_RANGE_BASE`
  (locally, of HEAD and `origin/main`, which it reports as the fallback). An
  entry that rose, or is new, fails unless it carries a `growth_reason` added
  in the same change, and the lane prints each accepted reason; a new
  arch-imports baseline entry always fails. Until now "may only shrink" held
  only through review, because each list was checked only against the tree in
  the same checkout. With no base to compare against the lane fails closed in
  CI and reports a skip locally.

### Removed

- **Deno's lanes, tooling, config and CI steps: the Node runtime track
  (decision D32) is complete.** The runtime, the tests and the gate now run with no Deno on
  `PATH`. Deleted: the two `deno check` typecheck lanes (`typecheck.tsc`
  covers every file, and the tsconfig exclusion list is gone), the Deno
  executable selector (`prototype/scripts/deno-executable.ts`, its test and
  the gate's lookup of it), `prototype/scripts/typecheck.ts`, the unit and
  integration runners' Deno test step and the routing that fed it, the unused
  `prototype/scripts/mcp-child-wrapper.sh`, and every `DENO_BIN`, `DENO_DIR`
  and `DENO_JOBS` forward (`node --test` parallelism is now the machine's
  available parallelism). Deleted config: `deno.json`, `deno.lock` and
  `prototype/deno.json`, with their `deno task` shims. CI no longer installs
  Deno, Dependabot no longer runs a `deno` lane, and the dependency manifest
  no longer declares the Deno workspace or the Deno release archive. The
  `runtime.neutral` allow-list is empty.

- **The migration-only tooling.** The test codemods (`scripts/codemod/`:
  the test-dialect and test-registrations codemods, their fixtures and their
  tests), the import-extension rewriter
  (`prototype/scripts/add-import-extensions.ts` and its test) and the
  historical UDS JSON-RPC spike (`prototype/examples/uds-jsonrpc-spike.ts`)
  are deleted. The codemods and the rewriter served the move of the tests to
  `node:test`, which is done; the spike ran only under Deno, and the
  transport it proved lives in `prototype/src/transport/`. The git history
  keeps all of them. Their entries leave the gate's orchestration lane, the
  `runtime.neutral` list and the tsconfig exclusion list, and the READMEs no
  longer describe them. Decision D32.

- **The Deno launch entry points for the runtime and the CLI.**
  `prototype/deno.json` no longer holds any permission profile (`test`,
  `cli`, `serve-unix`, `local-model-diagnostic`, `verify-workbench-events`),
  and the `serve-unix` and `cli` tasks are gone from both `deno.json` files,
  with `prototype/scripts/serve-unix-net-flag.ts`. Run the runtime with
  `dyfj start` (or let `dyfj` autostart it) and the CLI as `dyfj`; both
  already ran on Node. The runtime policy module
  (`prototype/src/config/runtime-policy.ts`) is now the only source of the
  runtime's static net, run and env lists, which keep their values and are
  renamed `RUNTIME_NET_GRANTS`, `RUNTIME_RUN_GRANTS` and
  `RUNTIME_ENV_GRANTS`. The profile/policy parity test goes with the
  profiles, and the declared-config parity test (`schema.test.ts`) now checks
  `RUNTIME_ENV_GRANTS`. The ACP fixture agent always starts as
  `<node> <script>`; the branch that started it under Deno with permission
  grants is gone. Not covered: the gate, the test, check and typecheck tasks,
  the schema CLIs and their tasks, and the gate-tooling tests under
  `prototype/scripts/` still run on Deno through `deno.json` until the gate
  tooling moves to Node.

### Changed

- **External MCP tool schemas may carry enums of up to 64 values (was 32).**
  Linear's `get_issue` advertises a 45-value `fields` enum, so it was dropped
  at boot and sessions could not read an issue. The 64,000-byte limit on the
  whole schema is unchanged. The operator config should drop Linear's
  `create_comment`, which the server no longer offers: `save_comment`
  creates a comment, and updates one given its `id`.

- **The memory MCP README says `--allow-fs-read` needs the resolved path.**
  `prototype/mcp/README.md` now says that the grant must name the checkout's
  resolved path (for example `$(cd /path/to/dyfj && pwd -P)`), because Node's
  permission check compares resolved paths. On macOS, a checkout under a
  `mktemp` directory (`/var` → `/private/var`) otherwise fails to load.

- **The runtime no longer grants `deno` by name.** `RUNTIME_RUN_GRANTS` drops
  `deno`, a narrowing of what the runtime may start; the runtime's own Node
  executable stays granted by path, as before.
- **The memory MCP server runs on Node under its permission model.** The
  documented launch is
  `node --permission --allow-fs-read=/path/to/dyfj --allow-net /path/to/dyfj/prototype/mcp/server.ts`,
  and the file's shebang is the same with `--allow-fs-read=*`. The server may
  read files and use the network, and may not write files, start child
  processes or load addons. The former Deno launch also limited the network
  to `127.0.0.1:3306` and the environment to the Dolt variables; Node's model
  cannot express either, so those two limits are gone;
  `prototype/mcp/README.md` says so.
- **The contract closure report names the Node entry points.** Its ladder
  commands are now `node scripts/run-node-test-files.ts --lane contracts …`,
  the `diff.whitespace` range check, `npm run test:fast` and `npm test`; no
  ladder result changes.
- **Generated-code and snapshot messages name npm scripts.** The row-types
  header and the codegen lane's stale-file message say
  `npm run schema:codegen`, and the golden suite's messages say
  `npm run test:golden -- --update`.

- **The schema CLIs and the receipt-schema tests run on Node.**
  `schema/validate-schema.ts`, `schema/codegen.ts` and `schema/equivalence.ts`
  are written to `node:` builtins (`process.argv`, `process.on` for SIGINT and
  SIGTERM, `node:fs/promises`), with their output, exit codes and the
  generated `prototype/src/store/generated/rows.ts` byte-identical. The four
  schema gate lanes (current-schema apply, historical replay plus forward
  migrations, `schema.codegen` and `schema.equivalence`) run them as plain
  `node` in place of `deno run -A`, so the only Deno lanes left are the two
  `deno check` typecheck lanes. The root `validate-schema`, `schema:codegen`,
  `schema:equivalence` and `test:schema` entry points are now root npm
  scripts (`npm run <name>`); the root `deno.json` keeps only a one-line
  `schema:codegen` shim, because the generated file's header and the codegen
  lane's stale-file message name `deno task schema:codegen`.
  `scripts/assurance-receipt.test.ts` registers with `node:test` and
  `node:assert/strict`, and the `receipt.schema` lane runs it under
  `node --test` through `scripts/run-node-test-files.ts` (50 tests, as
  before). `prototype/scripts/isolated-dolt-fixture.integration.test.ts`
  registers with `node:test` too, so the integration lane runs it in its Node
  subset; with the launcher test already moved, the lane's `deno test` subset
  is now empty. The tsconfig exclusion list drops the ported files and
  `scripts/node-modules-check.ts` with its test, which `tsc` already checks
  cleanly. Decision D32.

- **The launcher integration test runs under `node --test`.**
  `prototype/scripts/dyfj-launcher.integration.test.ts` registers with
  `node:test` and takes its assertions from `node:assert/strict`. It runs the
  bash launcher with `node:child_process`, and builds its temp roots, symlink
  fixtures and stand-in executables with `node:fs`. It therefore leaves the
  integration lane's `deno test` subset for the lane's Node subset, which
  runs it with the per-file handle check. It keeps all 73 cases, with the same
  names in the same 13 groups. The file is now under `tsc` (it is off the root
  `tsconfig.json` exclude list) and off the `runtime.neutral` exception list.
  The `deno test` subset's grants lose what only this file used: `bash`,
  `/bin/bash`, `ln`, `python3`, `/bin/kill` and `/bin/ps` to run, and
  `DENO_DIR`, `DYFJ_NODE_PATH`, `DYFJ_CODEX_TOOLCHAIN_PATH` and
  `DYFJ_CODEX_RUSTUP_HOME` to read. What remains in that subset is
  `isolated-dolt-fixture.integration.test.ts`. The launcher itself is
  unchanged.
- **The gate runs on Node, and `npm test` is its entry.** The aggregate gate
  (`scripts/aggregate-test-gate.ts`) is written to `node:` builtins: it starts
  each lane with `node:child_process` as the leader of its own process group,
  handles SIGINT and SIGTERM through `process`, lists processes with `ps` and
  signals lane groups itself in place of short-lived `deno eval` children, and
  keeps its lane table, labels, check ids, deadlines, fast and docs-only
  subsets and `gate-status` line unchanged. The root `npm test` and
  `npm run test:fast` run `node scripts/aggregate-test-gate.ts [--fast]`, the
  root `deno.json`'s `test` and `test:fast` tasks are one-line shims to them,
  and both CI jobs run `npm test` after `npm ci`, with the pinned Deno still
  installed. Every per-lane `--allow-*` grant string is gone: lanes run as
  plain `node`, `cargo` and `dolt`, unsandboxed, from the same cleared
  environment. The Deno lanes left are the two `deno check` typecheck lanes,
  until close-out, and the receipt-schema test and the four schema CLI lanes,
  which run as `deno run -A` with no grant list, until S3.3d. The gate finds
  the selected Deno by running `prototype/scripts/deno-executable.ts` with the
  `deno` on `PATH` and resolving symbolic links, and exits 64 with the
  selector's diagnostic before any lane when that fails. The contract
  closure-report comparison runs as `node` and writes nothing, in place of a
  `deno run` with writes denied. The gate's own tests
  (`scripts/aggregate-test-gate.test.ts`, the gate-driver fixture,
  `ci-workflow`, `git-hooks`, `lane-supervision`, `runtime-neutral` and the
  ported static checks' tests) and `prototype/scripts/test-files.test.ts` are
  on `node:test`; the orchestration lane runs them under `node --test` through
  `scripts/run-node-test-files.ts`, which now also forwards `DENO_BIN`. The
  docs, the rooms guide and the work orders name `npm test` as the gate.
  Decision D32.
- **The test-lane runners and their supervision run on Node.** The unit,
  isolated-Dolt integration and golden runners
  (`prototype/scripts/run-unit-tests.ts`,
  `prototype/scripts/isolated-dolt-integration.ts`,
  `prototype/testing/golden/run.ts`) and `prototype/scripts/lane-supervision.ts`
  are written to `node:` builtins. The gate starts the three lanes as
  `node <runner>` in place of `deno run` with per-lane grants, and
  `deno task test:unit`, `test:file` and `test:golden` in `prototype/` do the
  same. The lane token carrier and the group stop are `node` children of the
  runner in place of `deno eval`, with the same token, grace and KILL rules.
  The unit and integration runners still run their gate-tooling `deno test`
  subset, with the executable `DENO_BIN` names, which they now require; the
  golden runner needs no Deno at all and does nothing when imported, so the
  Node load probe no longer reports it. The gate driver itself stays on Deno
  for now. Decision D32.
- **The static checks run on Node.** `subject-check.ts`,
  `public-safety-scan.ts`, `range-checks.ts`, `retired-surface-scan.ts`,
  `dependency-policy.ts`, `change-scope.ts` and their shared `scan-lib.ts` are
  written to `node:` builtins, and the gate runs their lanes, and the
  docs-only classification, as `node scripts/<check>.ts` (decision D32). Their
  checks, messages and value-free diagnostics are unchanged; git and the shell
  parser now start with only `PATH` and `HOME` in their environment. The
  retired-surface scan's lane runs the scan alone; its rule tests moved to
  `scripts/retired-surface-scan.test.ts`, which the scan allowlists as it does
  its own source. The tests moved to `node:test` and `node:assert/strict`, the
  ported files left the `tsconfig.json` exclusion list, and the
  `runtime.neutral` count fell from 932 references in 44 files to 660 in 33.

- **The `arch.imports` lane runs on Node, with its own parser and import
  graph.** The gate runs it as `node scripts/arch-imports.ts`; regenerate the
  baseline with `node scripts/arch-imports.ts --write-baseline`, and the
  `--deno=<path>` flag is gone. Each module's TypeScript is stripped with
  Node's `module.stripTypeScriptTypes` in strip mode, which keeps every
  offset, line and column, then parsed as ESTree with `acorn` 8.19.0, a new
  exact-pinned root devDependency
  (`scripts/arch-imports-parse.ts`). Type-only imports, import types and
  string literal types, which stripping erases, are read back from the erased
  spans with `acorn`'s tokenizer. The lane's visitors (dynamic imports,
  environment access, `DYFJ_*` keys, package specifiers, SQL write literals)
  are ported from the `deno lint` plugin to a walk over that tree, with the
  same reports and positions. `scripts/arch-imports-graph.ts` resolves
  specifiers itself in place of `deno info`: a relative specifier resolves to
  the file it names, and one that names no file, or names a module that fails
  to parse, fails the lane. A bare or `node:` specifier is a package, not an
  edge. Over the whole tree and every test fixture, the Node implementation
  produced the same edges, findings and diagnostics as the Deno one. The
  plugin (`scripts/arch-imports-lint-plugin.ts`) and its config
  (`scripts/arch-imports-lint.json`) are deleted. The checker's tests register
  with `node:test` and run in a new "Architecture import rules tests" lane
  through `scripts/run-node-test-files.ts`, not in the orchestration
  `deno test` lane. They gain cases for stripping parity, the warning hook,
  type-position findings, inline `type` modifiers against `import type` and
  `export type` statements, malformed modules (a syntax error, an
  unterminated specifier, a non-literal static specifier, a malformed type),
  and an import of a module that does not parse. The
  experimental-feature warning from type stripping is dropped for that call
  only. `runtime.neutral` falls from 1007 to 932 references; what remains in
  the checker names the runtime's env object, which the env rule forbids
  reading. The checker's files leave the tsconfig `exclude` list.
- **Eight diagnostic, example and helper tasks run on Node, as npm
  scripts.** `context-size-response`, `model-response-modes`,
  `structured-output`, `structured-output-streaming`,
  `verify-workbench-events`, `smoke`, `codex-chatgpt-login` and
  `memory-recall-uat-fixture` moved from Deno tasks to `prototype/package.json`
  scripts with the same names: run them with `npm run <name>` from
  `prototype/`, passing arguments after `--`. Each prints its usage with
  `--help`. The model diagnostics and `verify-workbench-events` load
  `prototype/.env` when it exists. The smoke example is now
  `examples/smoke-test.ts` and prints the Node version.
  `codex-chatgpt-login` runs the Codex adapter on `DYFJ_NODE_PATH` when it is
  set, and otherwise on the Node running the script; when the adapter cannot
  be started it prints the error code and exits 1. The memory-recall UAT
  fixture serves through the tests' `node:http` fetch server, which now takes
  an optional fixed port. `examples/uds-jsonrpc-spike.ts`, a historical
  transport spike with no task, stays Deno-only.

### Security

- **A `core` integration test no longer writes `DATABASE_URL` into its own
  error context.** When `schema_round_trip` could not connect, the context it
  added to the error interpolated the full `DATABASE_URL`, including any
  password in it. That context now names the variable instead of its value.
  The underlying database driver error is still attached unchanged.

### Fixed

- **Ctrl-C stops a `dyfj start` runtime again, including the next one in the
  same terminal.** The `dyfj` client created a readline interface on the
  terminal at startup, even for commands that never read a line. On a
  terminal that switches it to raw mode, so in `dyfj start` the first Ctrl-C
  was a byte the unused readline consumed, not a signal. Worse, the runtime,
  spawned with the terminal as its stdio while it was raw, recorded raw mode
  as its startup state and restored it on exit. In zsh that left the
  terminal with signals off, so in the next `dyfj start` in that pane Ctrl-C
  only echoed `^C` and the runtime could not be stopped from its terminal.
  The client now creates its readline only when it first reads a line or
  listens for a turn's Ctrl-C, so `start`, `status`, `stop`, `models` and
  `sessions` never change the terminal's modes.
- **A foreground runtime can always be stopped from its terminal.**
  `dyfj start` now ignores Ctrl-C itself and holds the terminal until its
  runtime exits; before, the client died on the first Ctrl-C and gave the
  terminal back to the shell while the runtime was still shutting down. In
  the runtime, a second Ctrl-C while the shutdown is pending prints what it
  is waiting on (the server's connections and warm ACP sessions, or the
  store's connection pool), and a third exits at once with status 130,
  without finishing the cleanup.
- **Gate-lane helpers no longer outlive an interrupted gate run.** A test-lane
  token carrier waited only for its lane's group to empty, so a gate killed
  mid-lane, or killed between its teardown's TERM and KILL, left the runner,
  the carrier and any process that ignored TERM running indefinitely, holding
  a lane token, unless a later gate run recovered them. Now a runner checks
  every 200 ms that its gate is still there and, once it is gone, ends its
  current step, stops its group and exits; the carrier checks its runner the
  same way and stops the group itself if the runner is killed; and the group
  stop is bounded on its own. Each compares its parent with the one it must
  have (the gate passes its pid to the runner as `DYFJ_LANE_PARENT_PID`), so a
  parent that died before the helper started is caught too, and each checks
  once as it starts. The group stop fails closed: when `ps` cannot list the
  lane's processes it says so and KILLs the whole group, which fails the
  lane, instead of taking the group for empty. New tests SIGKILL a gate driver
  mid-lane, and the gate and its runner together, start a runner and a
  carrier whose parent has already exited, and stop a group with `ps`
  failing, and check by pid that no helper or lane process survives.
- **`dyfj --socket <path> start` listens on that path.** The runtime took its
  socket from the environment, so a socket given only by `--socket` was not
  the one it bound. The launcher now passes the resolved socket to the
  runtime as `DYFJ_SOCKET`, and the fallback command `dyfj start` prints when
  it cannot start the runtime sets `DYFJ_SOCKET` to that socket, quoted for
  the shell.

- **The ACP fixture agent's parent-death watchdog reaps its process group
  without starting a process.** It signals its group with
  `process.kill(-pid, "SIGKILL")` in place of running `/bin/kill`, which a
  runtime or permission model that grants no spawn refused, leaving a group
  member alive after its parent died.

- **`dyfj start` works with a non-default Dolt endpoint.** The runtime's
  network grant held only the default `127.0.0.1:3306`, so a configured
  `DOLT_HOST` or `DOLT_PORT` elsewhere was refused at the first query. The
  launcher now reads the configured endpoint (ambient, then `prototype/.env`)
  and grants it. An invalid `DOLT_PORT` now fails at start instead of at the
  first query.

- **The per-file Node handle check no longer fails a file for its own
  in-flight test output.** Under `node --test`, a file's stdout is the
  runner's channel to its parent, and on macOS pipe writes are asynchronous.
  When that output was still being written as the file's last test ended,
  the check counted the pending write (`SimpleWriteWrap`) as a leaked
  resource and failed a clean file, intermittently. The check now waits for
  the file's stdout and stderr to flush before it compares. A pending write
  to any other stream is still a leak. A file that does leak now sets a
  failing exit code and exits after a bounded grace period, with its output
  flushed, instead of exiting at once: the hard exit had cut off the
  runner's report of the file's other tests, so a leaking file's passing
  tests went missing from the lane's count.

- **A timed-out secrets resolver no longer holds pipes open in the runtime.**
  On a resolver timeout the runtime kills the resolver and stops waiting for
  its output, so a stuck resolver can never hold the boot. It did not close its
  own ends of the resolver's stdout and stderr pipes, though. A resolver that
  left a descendant running, such as a shell wrapper, kept both pipe fds open
  in the runtime, and kept buffering whatever the descendant wrote, for as long
  as the descendant lived. The runtime now closes both pipes and stops
  collecting output at the timeout; the timeout reason and the fail-closed
  result are unchanged. `config/secrets.integration.test.ts` now registers
  with `node:test` and runs under `node --test`, where the per-file handle
  check failed it on the two leaked pipes before this fix (decision D32).

- **The launcher's pseudo-terminal tests no longer hang on macOS when
  `python3` is Python 3.9.** The tests ran the launcher under Python's
  `pty.spawn`. On macOS, Python 3.9's copy loop reaches an empty `select`
  and waits forever once the child exits while stdin is already at EOF.
  macOS's own `/usr/bin/python3` is 3.9. That stalled the Isolated Dolt
  integration lane until its 900 s deadline in local gate runs, though CI's
  newer Pythons passed. The tests now fork the pty themselves and stop
  reading at the terminal's end of file, whatever the Python version.

- **The Rust REPL prints a turn receipt's safety warning.** The runtime puts
  a skipped-event-write warning in the receipt string, beside the answer
  text. The REPL read the answer and dropped that string, so a turn whose
  audit records were not all written showed its answer with no warning.
  Lines in that string that begin with `WARNING:` are now printed,
  sanitized, whether the answer streamed or arrived only with the receipt.
  Event writes stay best-effort. The runtime builds the receipt before its
  last session write, so a failure of that write is still not reported in
  the receipt; the runtime's own diagnostic records it.
- **Ctrl-C at the Rust REPL's approval prompt cancels the turn, and `n` denies that call.**
  While an approval was being read, Ctrl-C was readline's interrupt and was
  answered as a denial (`operator declined`). The keypress was not delivered as
  SIGINT, because the read had cleared ISIG, so the turn's cancel path did not
  run and the turn kept going. Ctrl-C now answers that approval with `abort`
  and sends `turn/cancel` for the turn the REPL started, then waits for the
  turn to settle and returns to the prompt. `n`, and any other line that is not
  `y` or `yes`, denies that call. The request text is written and flushed,
  then queued input is discarded, then the answer is read. A key typed before
  the request is visible is not the answer. A key typed after the text is
  shown and before that discard returns is dropped, and the operator retypes.
  If the text cannot be flushed, the prompt is not read. Ctrl-D and a lost
  terminal still deny, with the
  reason `approval prompt was not answered`. A `toolCallCompleted` frame with
  `verdict: "approval_denied"` is shown as `⊘ <tool> not approved`, replacing
  the `declined by the operator` rendering in the tool-refusal note under
  Changed: the frame does not say whether the operator declined or the prompt
  produced no decision. During `/friction`, Ctrl-C at the approval prompt
  denies that approval and later ones for the command, and waits for the
  runtime to settle the post.
- **The CLI wraps at 80 columns on a terminal that reports no width.** A pty
  with no size set reports 0 columns, and the markdown renderer took the smaller
  of that and 100, so a turn's text wrapped at zero columns. An unknown width
  and a zero width now both fall back to 80; a wider terminal is still capped
  at 100. The width now comes from `process.stdout.columns`.
- **A complete textual tool call that runs no tool now raises the unparsed
  tool-call markup warning.** A local model can write a whole
  `<tool_call><function=…>…</function></tool_call>` block as text. The
  OpenAI-compatible adapter recovers such a block only when the request
  offers that tool, and a forced conclusion (the step limit, or a step that
  only repeated earlier calls) offers none, so the turn ended on the markup as
  if it were an answer, with no warning: the warning counted only two or more
  unmatched `<tool_call>` openings and assumed a complete block had been
  recovered. It now also counts every function element of a complete block
  left in the text after recovery, whether no tools were offered, the name was
  not offered, or the arguments were unrecoverable; each element counts once,
  toward its innermost wrapper, however the wrappers nest. A forced conclusion still runs no tool; the
  operator is told one went unrun. A wrapper with no function element inside
  stays prose. The count is still carried as `unparsedToolCallMarkup` and
  recorded in `unparsed_tool_call_count` (no schema change), whose meaning
  widens to unrun function elements plus unmatched openings, and the CLI warning now reads
  "N unrun tool call(s)" instead of "N unmatched opening(s)".
- **A resumed session comes back on the model it last ran on, not the
  configured default.** The model choice lived only in the REPL client, so
  `dyfj --session <id>` restored a session's workspace and history but routed
  it to the default model, whose window a history built on a hosted model can
  overflow on the first prompt. Every provider call and every completed turn
  is already recorded, as `provider_call` and `model_response` events; the
  engine now reads the model of the session's latest completed one (a new
  `EventReader.latestRun`, no schema change and no new write path; the
  turn's `model_response` is an integrity write, so a skipped best-effort
  `provider_call` write does not lose the turn) and routes a resumed turn that names no model, tier
  or hint of its own to it, with the route reason `session_model`. A model a
  turn only selected does not count: a turn whose provider call failed, or
  whose request was refused as too large for the model's window before it was
  sent, leaves the session's model where it was, as do compression calls. A
  session whose latest turn ran on an external-agent runner, whose own model
  the log does not record, refuses a bare resume rather than route the
  runner's conversation to an older native model. A recorded model
  that is no longer routable (left the catalog, deactivated or unpriced) fails
  the turn with a message naming it, instead of falling back.
  `sessions/inspect` now reports the recorded model, and the runner profile
  when the latest turn ran on one. The Rust REPL restores it
  on `--session` and `/session switch`, names it on the posture line
  (`restored from session`) and leaves the routing to the runtime so the
  receipt reports `session_model`, refuses an unroutable one at startup or at
  the switch with the available models listed, refuses to resume or switch
  when the session's recorded model cannot be read, never carries a model chosen
  for one session into another, and lets an explicit `--model` win;
  a session with no recorded model resumes on the default and the posture line
  says so. Sessions created before this change are restored too, because their
  turns already wrote the events. Golden scenarios 05, 10 and 11 were
  re-snapshotted for the new route reason and `sessions/inspect` field.

- **`--socket` validity now uses last-wins semantics.** An empty `--socket` no
  longer permanently invalidates the invocation; only the final `--socket`
  value determines whether `LAUNCHER_ARGS_INVALID` is set.
- **`runtime_log_path` no longer produces a double-slash path when `HOME=/`.**
  A root `HOME` is collapsed to the empty string before the `printf`
  template, yielding `/.dyfj/log/...` instead of `//.dyfj/log/...`.
- **A provider's failure reaches the operator as a readable condition with a
  recovery hint, not as `[Error, N bytes]`.** A rejected request printed
  `turn failed: [Error, 260 bytes]` in the REPL and recorded the same label
  in the `error` event, because the adapters threw plain `Error`s carrying
  the provider's text, which the wire boundary withholds by design. The
  three adapters now classify every failure through one shared classifier
  (`providers/shared/failure.ts`), from the HTTP status and the body's
  documented markers for the OpenAI-compatible (llama-server, OpenRouter),
  Anthropic and Gemini shapes, and throw a `ProviderFailureError` subclass
  whose message Workbench writes: context exceeded with the provider's
  request and window sizes, authentication failed (a 403 names denied
  access rather than a bad key), rate limited (or out of quota, or
  overloaded), model not found at the provider (only when the body names
  the model; a bare 404 stays unclassified), unreachable
  (connection refused, host unresolved, network failure, or the header
  deadline), a redirect the adapter refused to follow, and request too
  large. Each message names the provider, the
  model and the status and ends with what to do next; none carries the
  provider's text. An unclassified failure keeps the opaque treatment of
  the foreign part (the body's byte count, or the `[Error, N bytes]` label
  of a transport throw) and now adds the provider and the status. Every
  adapter reads a non-2xx body to a 64 KiB cap (the Anthropic and Gemini
  adapters read it whole before), cancelling the rest and reporting the cut.
  The `error` event records the class in `provider_error_class` beside the
  message, and the server console no longer logs a classified provider
  failure as an unexpected error. A context-size rejection whose refit
  cannot bring the request under the window now fails the turn with the
  provider's measured sizes (the 2026-10-03 case: 82366 tokens against a
  32768-token window) instead of the fit's own estimate.
- **The agent loop fits each request to the model's context window before
  sending it, and recovers when a provider rejects one as too large.** On a
  32K-window local model, a few `grep_files` or `read_file` results, or one
  test run's output, grew the next request past the window, and the provider
  refused it (llama-server: `request (82366 tokens) exceeds the available
  context size (32768 tokens)`). Nothing fitted the request first, and the
  oversized results stayed in the session's history, so every later turn in
  that session failed the same way. Three changes, in `engine/fit-request.ts`
  and `context/request-fit.ts`:
  - Before each loop call, the engine estimates the request as its adapter
    will send it, tool definitions included, against the model's
    `contextWindow` less the output cap the request transmits. The estimate
    is four characters per token with a margin. A request over that budget
    is shrunk before it is sent: earlier turns' tool results first, oldest
    first, to a 1 KiB prefix and a marker; then elder turns, through the
    existing compressor; then the current turn's results. A request that
    still does not fit by the estimate fails the turn with
    `ContextWindowOverflowError`, which names the window, without being
    sent. Gemini sends only the prompt, so it is sized by the prompt alone
    and never proactively compressed. Length-recovery retries are fitted the
    same way, by shrinking only. The compressor's own request is sized
    against its window too: an elder transcript larger than that window is
    compressed from its oldest turns in passes.
  - Each tool result is bounded, as it is produced, to its share of the
    window left for the turn, not only to the tool's fixed cap. A marker
    states how much was cut and how to get the rest: `read_file` by
    `offset` and `limit`, search tools by a narrower query, `bash` through
    `head`, `tail` or `grep`, `git` by paths or a smaller `limit`. A result
    cut more than once keeps reporting its original size.
  - Because the estimate is not the provider's tokenizer, a provider can
    still reject a request that passed it. That rejection (from
    llama-server, OpenAI, Anthropic or Gemini) is now classified as
    `ProviderContextExceededError` instead of a generic error. On an adapter
    that sends the transcript (OpenAI-compatible, including llama-server,
    and Anthropic), the request is refitted against the counts the provider
    reported and retried once; a second rejection fails the turn as context
    overflow. Gemini sends only the prompt, so there is nothing to refit:
    its rejection fails the turn as context overflow without a retry.

  A session whose history is already over the window recovers on its next
  turn through the same path. The durable `tool_call` events are untouched:
  shrinking decides what the model sees, not what the log keeps. Two
  runtime events, `toolResultTrimmed` and `contextFitted`, report what was
  cut, and both clients show them. Golden scenario 12's fixture window was
  raised from 2,000 to 12,000 tokens (`specs/03-testing.md` §4): the old
  window could not hold the fixed request prefix, which only the fake model
  server had let pass.

### Changed

- **The npm dependencies install from one npm workspace at the repository
  root.** A root `package.json` names `prototype` as its workspace member and
  holds the tooling devDependencies, exact-pinned: `typescript` 7.0.2 and
  `@types/node` 26.6.5. `npm ci` now runs at the repository root, locally and
  in both CI jobs, from one root `package-lock.json` into the root
  `node_modules`; `prototype/package-lock.json` is gone. Every runtime
  dependency resolves to the same version, tarball and integrity hash as
  before. The install settings (`save-exact`, `ignore-scripts`,
  `min-release-age=3`) move to a root `.npmrc`, because npm ignores an
  `.npmrc` inside a workspace member. The npm install precondition lane
  checks the root install and its remedy reads `` run `npm ci` at the
  repository root ``. It also checks the link npm installs for the
  workspace member: the link must be a symlink resolving to exactly the
  member directory the lockfile names, inside the repository, so a link into
  any other directory fails the lane. Dependabot's npm lane watches `/`. TypeScript 7 is the
  native compiler: `typescript` 7.0.2 ships its `tsc` binary through 20
  per-platform optional packages (`@typescript/typescript-<os>-<arch>`), each
  locked with an integrity hash, of which npm installs only the one for the
  running platform. Install scripts stay off; none of them declares one.
- **Deno's lockfile is the root `deno.lock`, and Deno runs with it frozen.**
  The npm workspace makes the repository root Deno's workspace root, so
  `prototype/deno.lock` moves to the root (every JSR version and integrity
  hash unchanged) and `nodeModulesDir: "manual"` moves to the root
  `deno.json`. The root `deno.json` sets `"lock": { "frozen": true }`: a Deno
  run now fails when the lock is missing or out of date, where before it would
  silently resolve the JSR ranges again. It also declares `compilerOptions`
  (`strict`, Deno's default), so Deno keeps its own type-checking settings
  rather than reading the root `tsconfig.json`. Dependabot's deno lane watches
  `/`.
- **`dependency.policy` understands npm workspaces.** A workspace member is
  held to its workspace root's lockfile and `.npmrc`, and its npm update lane
  is the root's. A tracked `.npmrc` or `package-lock.json` beside a member
  fails (`npm-workspace-member-config`), because npm would ignore it, and a
  `workspaces` field that is not a list of plain relative directories fails
  (`npm-workspaces-unsupported`), including an entry with a `.`, `..` or
  empty segment anywhere in its path. The manifest's npm surface is now
  `npm.workspace`.
- **The `codex-chatgpt` runner finds its pinned adapter in the workspace
  install.** It looks for `@agentclientprotocol/codex-acp` in
  `prototype/node_modules` first, where npm nests a member-only copy, then in
  the workspace root's `node_modules`, where npm hoists it, and never further
  up. The version check and the bounded metadata read are unchanged. The
  `codex-chatgpt-login` task's read grant adds the root `node_modules` for
  the same reason.
- **The `deno check` source typecheck covers `prototype/examples/`.** An API
  change that broke an example used to pass the gate.
- **Root `npm test` and `npm run test:fast` run the gate**, as
  `deno task test` and `deno task test:fast` until the gate itself moves to
  Node.

- **The runtime and the `dyfj` CLI run on Node 26.** The launcher
  (`prototype/scripts/dyfj-launcher.sh`) runs the client as
  `node src/cli/main.ts`, and `dyfj start` starts the runtime as
  `node src/server/main.ts`, on the client's own Node executable. The
  launcher stops with a message naming the problem when `node` is not on
  `PATH` or is not Node 26. The runtime runs as plain `node`, with no
  `--permission`: its network, process and environment limits are the
  product's own seams (the guarded fetch, the Dolt connect check, the guarded
  spawn and the explicit environment), which Node's permission model cannot
  express, and Node hands a process's permission flags to every Node process
  it starts through `NODE_OPTIONS`, so a sandboxed runtime would have
  sandboxed the ACP agents and any `node` or `npm` a tool runs, refusing their
  native addons. `dyfj start` and autostart's background start run the client
  as plain `node` for the same reason. The client's other routes (the REPL,
  `exec`, `status`, the parse check and the probe) run under
  `node --permission --allow-fs-read=* --allow-net`. The runtime's
  environment no longer carries `DENO_DIR`. Test support and the golden
  harness start the engine and the CLI the same way, on Node; golden
  snapshots are unchanged. The gate and test tooling still run on Deno.

- **Product tests run on `node:test` only; the Deno test path is narrowed to
  the gate-tooling tests.** Test discovery (`prototype/scripts/test-files.ts`)
  now routes by path and content: a test file under `prototype/scripts/` that
  calls `Deno.test` or imports `@std/testing/bdd` runs under `deno test` until
  the gate tooling moves to Node; every other test file runs under
  `node --test` with the per-file handle check; and a `Deno.test` or bdd
  registration in any other test file fails discovery with the file's path
  (decision D32). The conformance-kit import rule and the mixed-file case are
  gone. The golden runner (`testing/golden/run.ts`) no longer spawns
  `deno test`, and refuses any suite argument other than `--update`. The
  unit and integration runners keep a `deno test` run only for their
  gate-tooling files, and the integration lane's `deno test` grants drop what
  only product tests needed (the MCP and Unix-socket test directories, the
  ambient-secret and ACP probe variables, the MCP child wrapper, `/bin/sleep`
  and `--allow-sys=uid`). The unit gate lane is now labelled
  `Prototype unit test suite (test.unit)`. Lane test counts are unchanged,
  apart from the routing tests (`prototype/scripts/test-routing.test.ts`),
  whose four cases for the deleted kit-import and mixed-file rules go with
  them.

- **The CLI may read every environment variable.** The `cli` permission
  profile, `compile-cli` and the launcher's source route now grant the CLI the
  whole environment, where it named 14 variables before. To start the runtime
  with an explicit environment the CLI must read each value it forwards,
  including the operator's `[secrets].inherit_env` names, which no static
  list can name. The CLI is the operator's own process and already holds that
  environment; tools never run in it. The launcher's parse check and status
  probe keep the narrow list.

- **The schema tooling's Dolt helper and the first-product contract package
  run on either runtime, and the model-catalog and contract tests register
  with `node:test`.** `schema/dolt-apply.ts` is written to `node:` builtins:
  it spawns `dolt` through `node:child_process`, makes and removes its
  disposable repository through `node:fs`, and keeps its error messages and
  exit codes (a signalled `dolt` still reports 128 plus the signal number).
  The `dolt` child now gets `PATH`, `HOME`, `TMPDIR`, `TEMP` and `TMP` only,
  not the caller's whole environment. Every grant list that reaches the
  helper (the model-catalog, current-schema, historical-replay,
  `schema.codegen` and `schema.equivalence` gate lanes, and the `test:schema`,
  `validate-schema`, `schema:codegen` and `schema:equivalence` tasks) now
  grants those variables, `NODE_V8_COVERAGE`, which Deno's
  `node:child_process` reads on every spawn, and read on the temp roots, which
  the recursive remove lists. In `contracts/workbench/first-product/v1`,
  `validate.ts` and `executable-closure-report.ts` read through
  `node:fs/promises` and take the working directory and arguments from
  `node:process`. The package is frozen in meaning, so no contract
  semantics, schema, fixture or report content changes. The committed
  closure report changes only in its `contract_source_manifest` (`sha256` and
  `line_count`), because the report hashes the package's own source and that
  source changed. The registrations codemod moved
  `schema/model-catalog.test.ts` and the three contract test files onto
  `node:test` (24 registrations). Each one passes under `node --test` with the
  per-file leak check, and still passes under `deno test`. They now run there:
  the "Local model catalog data validation" and "Contract package tests" gate
  lanes and the root `deno task test:schema` (all four schema test files) run
  through the shared Node runner (`scripts/run-node-test-files.ts`), each with
  a count line, in place of `deno test`. The contract closure-report
  comparison stays a `deno run` with write denied, because its generator now
  runs on either runtime. Lane totals are unchanged: 2 catalog tests,
  22 contract tests and 22 `test:schema` tests. The
  `runtime.neutral` count falls from 1,154 to 1,104 (decision D32).

- **The launcher's grant readers use `node:` builtins, and their tests run
  under `node --test`, with the per-file leak check.** `cli/launcher/grants.ts`
  read `deno.json`, resolved paths and checked file modes through the existing
  runtime's global, so its two test files could not leave that runtime's
  runner. It now reads through `node:fs/promises` (`readFile`, `realpath`,
  `stat`, `lstat`) and checks the platform through `node:process`. Behavior is
  unchanged: the same symlink refusal, execute-bit check, delimiter checks and
  error messages, and the launcher still runs under the existing runtime,
  whose `node:fs` is subject to the same permission grants. The registrations
  codemod moved `grants.test.ts` and `grants.integration.test.ts` onto Node.
  New tests pin refusals that had none: a missing, directory or
  non-executable `DYFJ_NODE_PATH`; a `serve-unix` profile without a string
  grant list; and a Codex toolchain or Rustup directory whose canonical path
  carries a delimiter. The `runtime.neutral` count falls from 1,167 to 1,154
  (decision D32).

- **The golden suite and the schema unit tests register with `node:test` and
  run under `node --test`, with the per-file leak check, and a code guard now
  keeps a plain golden run from writing a snapshot.** The registrations
  codemod moved four files onto Node: `testing/golden/golden.test.ts` (one
  runner registration and one step) and `schema/validate-schema.test.ts`,
  `codegen.test.ts` and `equivalence.test.ts` (20 runner registrations), and
  flagged none for hand conversion. The golden lane's Node subset runs them;
  the "Schema unit tests" gate lane runs the schema files through the shared
  Node runner (`scripts/run-node-test-files.ts`) with a count line, in place
  of `deno test` and its read grant. `node --test` has no permission sandbox
  and passes a test file no arguments, so `deno task test:golden --update` now
  reaches the suite as `DYFJ_GOLDEN_UPDATE=1`, and every snapshot write goes
  through one function (`testing/golden/snapshots.ts`) that throws unless that
  variable is `1`. Before, the runner's write grant on the snapshot directory
  enforced the rule. A plain run still fails on a missing or changed snapshot
  and writes nothing, and new tests pin both cases and the update path. The
  golden runner no longer refuses `--update` while a golden file runs under
  `node --test`; it refuses only other suite arguments, which nothing could
  pass on. `schema/model-catalog.test.ts`, the contract package tests and the
  root `test:schema` task stay on the existing runner for now: the modules
  they import still call that runtime's global. The isolated Dolt fixture
  (`prototype/scripts/isolated-dolt-fixture.ts`), which the golden harness
  starts in-process, now uses `node:` builtins (`node:child_process`,
  `node:net`, `node:fs/promises`) in place of that global. It behaves the same
  on both runtimes: the integration lane's runner still starts it on the
  existing runtime. `scripts/arch-layers.json` names it as an
  entrypoint for `node:child_process` and `node:net`, as it already does for
  the shared Node runner. Snapshots are unchanged. The `runtime.neutral` count falls
  from 1,203 to 1,167 (decision D32).

- **The ACP fixture agent runs on either runtime, and the ACP tests that
  drive it register with `node:test`.** `scripts/acp-fixture-agent.ts` is
  written to `node:` builtins. The fixture profile now starts it on the
  runtime running the product: `node <script>` under Node, and the existing
  `run --cached-only` argv under Deno. Before, the profile always used that
  argv with the current executable, so under `node --test` the agent never
  answered. One helper, `fixtureAgentCommand` in the new
  `src/acp-fixture-command.ts`, builds the command, and the tests that start
  the fixture themselves use it too. The Deno argv now also
  grants `NODE_V8_COVERAGE`, which Deno's `node:child_process` reads on every
  spawn. The `acp-client`, `acp-runner`, `acp-session-map` and
  `external-agent-runtime` test files (seven files) run under `node --test`
  with the per-file leak check. A new integration test pins the agent's
  parent-death watchdog: when its parent dies, the agent kills its own
  process group, and a second member of that group must be gone too. The
  `runtime.neutral` count falls from 1,236 to 1,203 (decision D32).

- **The remaining product tests register with `node:test` and run under
  `node --test`, with the per-file leak check.** This covers the `context/`,
  `extensions/`, `server/`, `store/` and `transport/` tests and those under
  `testing/`, `mcp/` and `diagnostics/`. The registrations codemod moved 50
  files onto Node, with 387 runner registrations and 10 bdd imports. It flagged
  two registrations that passed an options object to the existing runner, both
  in the Unix-socket listener's integration tests, and these were converted by
  hand. Every case still runs and the lane totals are unchanged. No converted
  file leaves a resource live. Only the tests that drive the ACP fixture agent,
  the golden suite, the launcher grant tests, the gate tooling's own tests and
  the `schema/` and `contracts/` tests stay on the existing runner. The
  `runtime.neutral` count falls from 1,633 to 1,236 (decision D32).

- **The `providers/`, `engine/` and `contract/` tests register with
  `node:test` and run under `node --test`, with the per-file leak check.** The
  registrations codemod moved 54 files onto Node, with 319 runner
  registrations and 24 bdd imports, and flagged none for hand conversion. Every
  case still runs and the lane totals are unchanged. No file stays on the
  existing runner, and no converted file leaves a resource live. The
  `runtime.neutral` count falls from 1,952 to 1,633 (decision D32).

- **The `cli/`, `config/` and `budget/` tests, with `cli.test.ts`, register
  with `node:test` and run under `node --test`, with the per-file leak
  check.** The registrations codemod moved 38 files onto Node, with 188 runner
  registrations and 26 bdd imports. Every case still runs; the integration
  lane's count falls by two because the existing runner's bdd adds a
  synthetic test for each file with a top-level hook (the `status` and `stop`
  command integration tests), which `node:test` does not. Two files stay on
  the existing runner: `cli/launcher/grants.test.ts` and
  `grants.integration.test.ts` wait for the launcher's grant readers, which
  still read files and paths through the existing runtime's global, to move
  onto `node:` builtins. The `runtime.neutral` count falls from 2,140 to
  1,952 (decision D32).

- **The conformance kits and every test file that calls one run under
  `node --test`.** The seven kits under `prototype/testing/conformance/`
  (clock, DNS resolver, env, HTTP transport, provider adapter, store, tool)
  registered their cases with the existing runtime's test function, so each
  caller ran them in its own process and could not move without them. The
  kits and their callers now register with `node:test` together, with the
  per-file leak check: 16 callers, including four that import a kit by a
  shorter relative path than `testing/conformance/` (the tool kit's own
  tests, the scripted HTTP transport fake's tests, the synthetic provider
  adapter and the text-stats example tool). The tool kit's
  per-command steps become `node:test` subtests. Lane routing now sends a file
  that imports a kit to `node --test` even when it registers nothing of its
  own, resolving relative imports against the caller's path, and a kit caller
  that also registers on the existing runner fails discovery as mixed
  (decision D32, `specs/03-testing.md` §1). The real `node:dns` resolver's
  conformance cases no longer run in the integration lane: under
  `node --test` nothing sandboxes the resolver, so its old "ungranted" mode
  cannot be asserted, and real lookups would make the lane depend on the
  network. They are reported skipped unless `DYFJ_TEST_REAL_DNS=1` is set,
  which runs them against the system resolver; the denied-lookup mapping stays
  pinned by injected errors in `dns-system.test.ts`. The `runtime.neutral`
  count falls from 2,171 to 2,140.

- **The bounded regex matcher runs in a `node:worker_threads` worker, so
  `grep_files` works under Node as well as the current runtime.** The matcher
  ran in a web `Worker`, a global Node does not have, so under Node every
  search failed closed with "regex matcher unavailable". It now starts a
  `node:worker_threads` worker from the same embedded `data:` URL source,
  with `parentPort` in place of `self`. The hard time budget, termination of
  a worker that overruns it, and failing closed when no worker can start are
  unchanged, and the worker is still not a file a workspace edit can rewrite.
  A worker that ends on its own, even between searches, now fails the next
  search at once as unavailable; before, it waited out the budget and was
  reported as too expensive. The four test files that grep through the matcher
  (`kernel/bounded-regex.test.ts`, `tools/builtin/file.test.ts`,
  `file-hardening.test.ts` and `file-search.integration.test.ts`) now
  register with `node:test` and run under `node --test` with the per-file
  leak check. The `runtime.neutral` count falls from 2,177 to 2,171
  (decision D32).

- **The `kernel/` and `tools/` tests register with `node:test` and run under
  `node --test`, with the per-file leak check.** A new codemod,
  `scripts/codemod/deno-test-registrations.ts`, rewrites a test file's
  registrations: the existing runner's test function becomes `test`, an
  `@std/testing/bdd` import becomes a `node:test` import (merged with any
  existing one, with `beforeAll` and `afterAll` renamed `before` and `after`),
  a bdd `{ ignore }` option becomes `{ skip }`, and `t.step` on a test context
  becomes `t.test`. It converts a file whole or leaves it as it is: an option
  bag, an object-form registration, a context used for anything but steps or
  any other runtime reference is flagged for hand conversion, because a file
  left with both registration styles fails lane discovery. Each rule and flag
  has a fixture (`scripts/codemod/registration-fixtures/`), run in the gate's
  orchestration lane. Applied to `prototype/src/kernel/` and
  `prototype/src/tools/`, it moved 33 files, with 78 runner registrations and
  21 bdd imports, onto Node; no file leaked under the handle check. Eight
  files stay where they are: the three that only call a conformance kit and
  `tools/conformance.test.ts` wait for the kits, which still register with the
  existing runner, and the four that grep through the bounded regex matcher
  (`kernel/bounded-regex.test.ts`, `tools/builtin/file.test.ts`,
  `file-hardening.test.ts` and `file-search.integration.test.ts`) wait for its
  worker, which uses the web `Worker` global that Node does not have. The
  `runtime.neutral` count falls from 2,255 to 2,177 (decision D32).

- **Shared test support runs on `node:` builtins.** The loopback model, MCP
  and scripted HTTP servers, the raw socket listeners, the golden harness and
  its JSON-RPC client, the process helpers and the engine builders under
  `prototype/testing/` now use `node:http`, `node:net`, `node:child_process`,
  `node:fs` and the `Env` port, and the shared conformance suites assert with
  `node:assert/strict` and fake time with `mock.timers` from `node:test`. The
  test servers' start functions are now async, because a `node:http` or
  `node:net` server knows its port only once it is listening. Support code that
  runs the product (the golden harness and the stale-socket fixture) takes the
  `deno` executable from `DENO_BIN` and fails with an error naming it when it
  is unset; `deno task test:golden` and every gate lane set it. Tests still
  register with the existing runner, so its sanitizers check every listener
  and child. The manual Node load probe now covers `prototype/testing`: all of
  it loads under Node 26 apart from the golden lane's runner, which still runs
  under `deno` (decision D32).

- **npm is the only resolver of npm packages, and config TOML is parsed by
  smol-toml.** Node can read neither the Deno import map nor `deno.lock`. The
  npm dependencies now live in `prototype/package.json`, pinned to exact
  versions, and in `prototype/package-lock.json`, which npm generates.
  `deno.json` sets `nodeModulesDir: "manual"`, so the test lanes run against
  the install `npm ci` makes: the tree under test is the tree Node will run.
  `prototype/.npmrc` keeps installs exact, turns install scripts off (no
  dependency needs one) and holds back releases younger than three days.
  Four transitive packages move up one patch release each, because npm
  resolves newer patches than the old lock held. The unused dax import is
  gone, and `deno.lock` now holds only the JSR test dependencies. The
  typecheck lanes now read Node's built-in module types from the installed
  `@types/node` rather than the runtime's bundled copy; one test listener that
  assumed a socket chunk is always bytes now accepts a string too.
  - **Parser:** smol-toml (TOML 1.0, no dependencies) replaces `@std/toml`
    behind the lazily loaded config parser. Every TOML shape the repository
    reads parses to the same values under both parsers, and those shapes
    stay as golden cases. smol-toml returns null-prototype tables. A bare
    TOML local time (`07:32:00`) now parses as a date object rather than a
    string, so a string-typed config key rejects it.
  - **Gate:** a new first lane, the npm install precondition, fails with
    `` run `npm ci` in prototype/ `` when `node_modules` is missing or out of
    date with the lockfile, including a package directory deleted after the
    install. It only reads, runs in `test:fast` too, and
    reports under `test.aggregate`. `dependency.policy` gains an `npm`
    surface under the registry contract and 72-hour floor. It also gains
    rules that fail on a non-exact npm version, an `overrides` field
    (rejected until a policy for overrides exists), a `package.json` without a
    tracked lockfile, and a `.npmrc` that does not set `ignore-scripts=true`
    and a `min-release-age` of at least 3.
  - **CI:** both CI jobs install Node 26.11.1 through a digest-pinned
    `actions/setup-node` and run `npm ci` before the gate.
  - **Operator step:** run `npm ci` in `prototype/` in every checkout,
    including the one a `dyfj` on `PATH` runs from, after any change to
    `package-lock.json` (decision D32).

- **A new `erasable.syntax` gate lane rejects constructor parameter
  properties in tracked TypeScript.** Node runs `.ts` files by stripping types
  without transforming them, and a parameter property is the one construct in
  the codebase that stripping cannot erase. The 24 constructors that used one
  now declare the field in the class body and assign it in the constructor,
  with the same visibility, `readonly`, and own-property order, so the
  serialized shape of every error is unchanged. All 215 non-test modules
  under `prototype/src` and `contracts/` now load under Node 22 and 26. The
  lane checks parameter properties only; other syntax that needs a transform
  goes unchecked until `tsc --erasableSyntaxOnly` takes over. The new
  `scripts/node-load-probe.ts` is a manual check of those two roots, not a
  gate lane. The lane runs in the full gate and in `test:fast`, under the
  `test.aggregate` check id (decision D32).

- **The Rust core depends on sqlx 0.9.0.** Connections still use the Tokio
  runtime and rustls (`tls-rustls`: ring, with the webpki roots sqlx 0.9
  enables). A URL that keeps the default `utf8mb4` charset and does not set a
  collation still sends `SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci` after
  connect, the collation sqlx 0.8 used for that charset; a URL with another
  charset gets no collation added. The handshake charset byte sqlx sends
  before that statement is `utf8mb4_general_ci`; 0.9 does not expose a setting
  for it. Plaintext `caching_sha2_password` RSA authentication stays available
  through the `mysql-rsa` feature, which 0.9 no longer compiles in by default.
  The committed `.sqlx/` cache was regenerated for the 0.9 describe format,
  which records a collation id. The event read still types string columns as
  `String` and `created_at` as `DateTime<Utc>`.
- **`core` depends on `ulid` 3.0.0.** Generation calls `Ulid::generate`, the 3.0
  name of `Ulid::new`. Event and session ids are still 26-character Crockford
  Base32 strings with the same 48-bit millisecond timestamp prefix, so their
  stored text and sort order are unchanged.
- **The unit test lane (`test.unit`) may read `TMPDIR`, `TMP` and `TEMP`.**
  Part of the move of the TypeScript tier to Node.js (decision D32): the tests
  are being rewritten onto `node:` builtins inside their existing
  registrations, and a converted test makes its temp directory with
  `node:os` `tmpdir()`, which reads those variables (`TMP` and `TEMP` when
  `TMPDIR` is unset). The lane's child gains `--allow-env=TMPDIR,TMP,TEMP`
  and nothing else; it still has no run or net grant, and the integration
  lane already granted the same three. The first converted tests, `kernel/`
  and `context/`, assert with `node:assert/strict` and mock with `node:test`;
  `runtime.neutral` drops by the context files' 64 references (the kernel
  files held only registrations), and the lane's totals are in the pull
  request.
- **The ACP runners run on `node:` builtins, and the `serve-unix` profile
  grants `/bin/sleep`.** Part of the move of the TypeScript tier to Node.js
  (decision D32). Before it spawns an agent, the runner checks that
  `/bin/kill` can signal a negative process group by probing an inert child in
  its own group. That child was the runtime itself running an `eval` script,
  an argv only one runtime accepts; it is now `/bin/sleep 30`, which exits on
  its own if the runtime dies mid-probe. The `serve-unix` spawn grant, and so
  `dyfj start`, and the integration lane's run flags now name `/bin/sleep`;
  without it the probe fails closed with "ACP process-group signaling is
  unavailable", as before. The `/bin/kill` signaler spawns through
  `node:child_process`; a signaler that cannot start now fails with the fixed
  "ACP process-group signaling failed" diagnostic instead of the raw spawn
  error. The Codex profile's executable, directory and ownership checks use
  `node:fs/promises` and `process.getuid()`, and its private shim and shell
  profiles are written to an exclusively created random sibling (`wx`, mode
  `0600`) before the rename, as before with no existing file followed. The
  fixture profile starts the fixture agent with `process.execPath` and keeps
  the current runtime's `run --cached-only` argv until the fixture agent moves
  onto Node. `runtime.neutral` drops by the two files' 51 references; the
  lane's totals are in the pull request.
- **The web tools' DNS lookups go through a `node:dns` `Resolver`, and the
  `serve-unix` profile grants `sys` `networkInterfaces`.** Part of the move of
  the TypeScript tier to Node.js (decision D32). The `DnsResolver` port's real
  adapter (`src/tools/web/dns.ts`) now makes a `Resolver` per lookup on the
  system's default nameservers, so an abort cancels only that lookup, and it
  reads those nameservers before querying: a process that may not read them
  reports the resolver unavailable, as before. Reading them needs the
  `networkInterfaces` system-information grant, which the `serve-unix`
  profile, and so `dyfj start`, now carries; the test profile already did.
  The integration lane's grants are unchanged. One message can change: under
  `serve-unix`, a nameserver missing from the launch-time net grants (for
  example, `/etc/resolv.conf` changed after the runtime started) now reads
  "DNS lookup failed" rather than "unavailable"; the address check refuses the
  target either way. `runtime.neutral` drops by the file's seven references;
  the lane's totals are in the pull request.
- **The CLI and the server's process surface run on `node:process`.** Part of
  the move of the TypeScript tier to Node.js (decision D32). The CLI and the
  runtime read their arguments from `process.argv`, the working directory from
  `process.cwd()`, terminal detection from `isTTY`, and exit with
  `process.exit`; Ctrl-C is handled with `process.on("SIGINT")`, and the
  client's signal source is renamed `processSigintSource`. The CLI's
  stdout and stderr writes, its status and error lines included, go through a
  synchronous write-all loop over `node:fs` `writeSync` that writes the rest
  after a partial write and waits briefly on `EAGAIN`, because under Node one
  write to a slow pipe can take only one pipe buffer, and `console.error` to a
  pipe is asynchronous and can be cut off by `process.exit`; output under Deno
  is unchanged. The server's shutdown
  still tolerates a closed-resource error from the close path, now matched by
  the error's name. Grants and lane flags are unchanged. `runtime.neutral`
  drops by the seven files' references (23); the lane's totals are in the pull
  request.
- **A tool call that is not approved reaches the model as a refusal, and tool
  use ends for that turn.** Before, the model received exactly the client's
  reason, `operator declined`, which reads like what a command printed; on
  the local route nothing marked it as an error, so the model drew conclusions
  from it and kept issuing variants of the command, each raising another
  approval. Now the result starts `approval_denied: this <tool> call was not
  approved, so it did not run; this is not its output`, tells the model not to
  retry it or a variant, and gives the reason. It says "not approved" and not
  "the operator declined", because with no terminal nobody declined. A step in
  which any call was refused is followed by the same no-tools concluding call
  the loop already makes at the step limit and on a repeated step, with a third
  reason, so every refusal hands control back to the operator; calls already
  requested in that step still complete, and the stop reason stays `stop`.
  `toolCallCompleted` gains an optional `verdict: "approval_denied"`, present
  only on a refused call, so the bytes of every other frame are unchanged. The
  Rust REPL renders it as `⊘ <tool> declined by the operator` with no duration
  (the time on it is the approval wait), and the TypeScript CLI as
  `⊘ <tool> not approved`; a real failure still renders as a failure. The
  durable `tool_call` event keeps `action: "deny"` and `authz_basis:
  "policy:deny:approval-denied"`, and its `tool_result` carries the refusal; so
  does its `content`, except for a tool that defines its own event content (the
  connector tools), which keeps that provenance text and shows the denial in
  `action` and `tool_result`. The concluding call is final: a tool call it still
  asks for is dropped, so a model that ignores the instruction cannot raise
  another approval. Golden scenario `03-strict-mutation-rejected` is re-snapshotted for
  this (the refusal text in its text, event content and tool result, and its
  second provider call is now a `forced_conclusion`), and `13-bash-denied` is
  added (`specs/03-testing.md` §4).
- **The configuration directory's environment, resolver spawn and file reads
  run on `node:` builtins.** Part of the move of the TypeScript tier to Node.js
  (decision D32). `processEnv` reads and writes `process.env`; the three
  config loaders and the nameserver reader share one default text-file reader
  (`readTextFile`, from `node:fs/promises`), and a missing `config.toml` is
  recognised by the error's `code` (`ENOENT`), so an injected reader that
  throws a Deno `NotFound` keeps working. The secrets resolver starts its
  command with `node:child_process` under the same isolated environment. A
  command that cannot start, because it is missing or not permitted, still
  reads "cannot run the resolver command (not found or not permitted)" at once
  and never carries the configured path: the runtime reports that failure as an
  event and not as a thrown error, so the runner now handles the event instead
  of waiting for its timeout. A resolver killed by a signal reads "resolver was
  killed by <signal>". The "cannot read config" label names the error's `code`
  (for example `EACCES`) when it has one. `node:child_process` is now also
  allowed in `config/` by `scripts/arch-layers.json`. The boot summary, the
  grants and the config surface are unchanged. `runtime.neutral` drops by the
  eight `config/` files' references (23); the lane's totals are in the pull
  request.
- **The builtin tools' process spawning and file access run on `node:`
  builtins.** Part of the move of the TypeScript tier to Node.js (decision
  D32). `bash` and `git` start their command with `node:child_process` in its
  own process group, and at a timeout the group is stopped with three kinds of
  `/bin/kill` run, as the ACP runner signals its agent's group: TERM, a probe
  (`kill -0`) through the grace, then KILL. The short-lived helper process that
  carried the signals is gone. The file tools read, list, search and write
  through `node:fs/promises`, with one shared stat shape (`FileStat`) and error
  reasons chosen from the error's `code`; a device or inode of zero counts as
  an identity that cannot be verified, so the read is refused as before. The
  tools' limits, the exclusion contract, the status lines and the
  path-free error text are unchanged. Visible differences: a command that
  cannot be started reports Node's message (for example `spawn bash ENOENT`),
  and a group made only of unreaped zombies at the settle bound now reads as
  still present, for the milliseconds until they are reaped, where it read
  "stopped". `node:child_process` is confined to `tools/` and the ACP runner by
  `scripts/arch-layers.json`. `runtime.neutral` drops by the seven builtin
  files' references (51); the lane's totals are in the pull request.
- **The Unix-socket JSON-RPC transport runs on `node:net` behind a
  `ByteConnection` port.** Part of the move of the TypeScript tier to Node.js
  (decision D32). `transport/connection.ts` names what the peer, client and
  listener need from a socket: `read()` returns the next chunk or null at end
  of stream, `write()` resolves once every byte is accepted, `close()` is
  idempotent, and `SocketHost` dials and binds a path. The one adapter,
  `transport/node-socket.ts`, is the only non-test module that imports
  `node:net` (`scripts/arch-layers.json` now confines the package to `transport/`). Every
  socket opens with `allowHalfOpen`, so a request that arrives just before the
  client's FIN is still answered. The peer no longer owns a read buffer or a
  partial-write loop, and socket-file hygiene and the 0700 socket directory use
  `node:fs`. The wire, the socket path, the grants and the lane flags are
  unchanged. One visible difference: a missing socket now fails with an error
  whose `code` is `ENOENT` (message `connect ENOENT <path>`), which the CLI's
  existing "runtime not reachable" check already matches. `runtime.neutral`
  drops from 3,225 references in 253 files to 3,219 in 250: the four transport
  source files leave the list, and the new adapter test and the lowered peer
  fakes account for the rest.

### Added

- **A `typecheck.tsc` gate lane.** It runs `tsc --noEmit` with Node's types
  over the root `tsconfig.json`, which covers `prototype/src`, `testing`,
  `examples`, `mcp`, `diagnostics` and `scripts`, plus `schema/`,
  `contracts/` and `scripts/`, with `strict`, `nodenext`,
  `verbatimModuleSyntax`, `allowImportingTsExtensions` and
  `erasableSyntaxOnly`. It runs in the full gate and `test:fast`, alongside
  the `deno check` lanes. Files that still use the `Deno` global or `@std/*`,
  and the files that import them, are on the tsconfig's `exclude` list until
  they port. Four type names that only Deno's DOM library declared
  (`ReadableStreamReadResult`, `RequestRedirect`,
  `TextEncoderEncodeIntoResult`) are now derived from globals both checkers
  know; no behaviour changed.

- **The runtime enforces its egress, spawn and environment limits at its own
  seams.** Before, the only limits on which hosts the runtime reached, which
  binaries it started and which environment variables it saw were the Deno
  permission flags, which Node's permission model cannot express (it has
  all-or-nothing network and child-process switches and no env control). One
  product-owned policy (`prototype/src/config/runtime-policy.ts`) now holds
  the static lists and composes the operator's entries. The launcher builds
  the runtime's Deno grants from it, and the engine composes the same policy
  at boot and checks it in code:
  - every HTTP request (provider calls, external MCP discovery and calls,
    memory recall, the web tools' direct fetch) goes through one guarded
    fetch that refuses a `host:port` outside the policy and rechecks each
    redirect hop. The refusal names only the `host:port` and the
    `[network] allow` key, never the URL's path, query or credentials. A
    refused provider call fails as the new `egress_refused` provider failure;
  - the Dolt pool refuses any endpoint but the configured `DOLT_HOST` and
    `DOLT_PORT`, and that endpoint is a network policy entry, so the
    runtime's permission flags grant it too;
  - every child process (the `bash` and `git` tools and their stopper, the
    secrets resolver, the ACP agent, signaler and probe, the CLI's start of
    the runtime) goes through one guarded spawn that refuses a binary outside
    the run list before anything starts. The secrets resolver's refusal, like
    its other reasons, does not name the resolver's path;
  - `dyfj start` gives the runtime an explicit environment, exactly the
    policy's names plus `TMPDIR`, `TMP`, `TEMP` and `DENO_DIR`, and nothing
    inherited. The launcher reads `prototype/.env` itself (ambient values
    win) and no longer passes `--env-file` to the runtime, so a `.env` name
    outside the policy does not reach it either.

  A test fails when the policy module and the `deno.json` profiles disagree.
  Accepted risks: a compromised dependency can still open its own connection
  or process, and the web tools' DNS preflight queries the system nameservers
  without a guard; an OS-level sandbox is the planned follow-up for both.

- **`[network] allow` in `~/.dyfj/config.toml` adds hosts to the runtime's
  network policy**, for example a local model server on a port the static
  list does not name: `allow = ["127.0.0.1:1234"]`. Each entry is exactly
  `host:port` (port required, IPv6 bracketed; no scheme, path, wildcard,
  comma or whitespace); an invalid entry fails the config load. Both the
  launcher's Deno grant and the engine's guard read the list. Restart the
  runtime after changing it. Runtime data such as a model catalog row's
  `base_url` never adds a host.

- **Test files that register with `node:test` now run under `node --test`,
  with a per-file leak check.** Deno's sanitizers do not see `node:`
  resources: a leaked `node:net` server or socket, or a `node:child_process`
  child, passed unnoticed, and in a file that registers with `node:test` they
  checked nothing. The unit, integration and golden lanes now route each
  discovered file by its own content (`prototype/scripts/test-files.ts`): a
  file that registers a test or hook with `node:test` runs under
  `node --test`, one process per file, after the lane's `deno test` subset; the
  rest run under `deno test` exactly as before; a file that registers with
  both fails discovery, naming the file. Each Node file's process preloads a
  handle check (`prototype/testing/node-handle-check.ts`) that fails the file
  when a server, socket, timer or child process is still live after its last
  test, names the leaked resource types, and exits so the run cannot hang. The
  check is per file, coarser than a per-test sanitizer. Each lane prints a
  count line for its Node files beside `deno test`'s own, parsed from the TAP
  summary, and fails when the summary is missing, so moving files cannot drop
  tests from a lane's output unnoticed. The runners require Node 26 and say
  so when it is missing, and `node` joins their run grants. `node --test`
  and its per-file processes stay in the lane's process group, and a gate
  test shows a hung Node test file stopped at the lane deadline. Four test
  files already registered with `node:test` and now run under Node, and two
  more were converted by hand so CI exercises the Node path in the unit and
  integration lanes: `src/cli-idea-local.test.ts` and
  `src/server/events-asof.integration.test.ts`. `deno task test:file` now
  rejects any `*.integration.test.ts` path before either runtime starts, exiting
  2 with a message that names the file and the integration lane; it used to rely
  on the permission sandbox denying the file's first access, which a Node-routed
  file does not have. The testing spec and README now describe `Deno.test`
  and `node:test` as coexisting during the move, with assertions and mocks
  from `node:`, instead of `Deno.test` with `@std/assert` as the only
  framework. Test discovery reads the tree with
  `node:fs`. The docs that said the sanitizers catch every leaked resource are
  corrected.

- **Dependabot now watches `prototype/`'s npm packages, and its npm and deno
  lanes declare the 72-hour release-age floor as a cooldown.** Since npm became the
  only resolver of npm packages, `prototype/package.json` and
  `package-lock.json` had no update lane, so the shipped dependency tree got no
  update pull requests. `.github/dependabot.yml` adds a weekly npm lane for
  `prototype/` with `cooldown: default-days: 3` and
  `versioning-strategy: increase`, which rewrites an exact pin to the new exact
  version. The `@agentclientprotocol/codex-acp` ignore rule moves from the deno
  lane to the npm lane, where that package now lives, and the deno lane gains
  the same 3-day cooldown. `dependency.policy` now checks the config: a tracked
  `package.json` with no npm lane for its directory fails
  (`dependabot-npm-unwatched`), as does an npm or deno lane without a cooldown
  of at least 3 days or with `include`/`exclude` carve-outs
  (`dependabot-cooldown`), an npm lane with any versioning strategy other than
  `increase` (`dependabot-versioning-strategy`). A lane key or a value the
  policy decides on that the check cannot read fails as `dependabot-unparsed`
  rather than being skipped. That includes a double-quoted scalar with a
  backslash escape: the check rejects escapes rather than decoding them, so a
  spelling such as an escaped `deno` cannot slip a lane past the cooldown
  rule. Settings the policy does not decide on, such as `schedule` and
  `ignore`, are not read.

- **A `runtime.neutral` gate lane ratchets references to the `Deno` global
  down to zero.** Decision D32 moves the TypeScript tier from Deno to Node.js
  on a `node:`-only API surface, and nothing yet measured that progress or
  stopped a new branch adding a reference. `scripts/runtime-neutral.ts`
  counts each whole-word `Deno` (identifier boundaries, comments and strings
  included) in every git-tracked `.ts` file, so a member access, an optional
  chain, an index, a value passed on, a destructuring and an alias all count,
  and compares each file to the committed
  `scripts/runtime-neutral-exceptions.json` (`path`, `count`, `reason`). The
  ratchet is exact: a file with references and no entry, a count above its
  entry, a count below it (the entry must be lowered in the same change), an
  entry for a file that is gone or has no references, and a malformed or
  duplicate entry all fail. It prints one report line on every run and is
  reported under `test.aggregate`, so the receipt check ids are unchanged; it
  is in the `test:fast` subset beside `arch.imports`. The baseline is 3,225
  references in 253 files, all recorded in the list; later port leaves lower
  their files' entries, and once none remain the list is `[]`. The lane and
  its test use `node:` builtins only, so they add no reference and need no
  change when the gate itself is ported.
- **`bash` takes a per-call `timeoutSec`, shown in the approval prompt.** The
  agent-loop `bash` tool accepts an optional whole number of seconds before
  the command and its whole process tree are stopped. Absent, the 120 s
  default stands; a value above the 600 s ceiling, zero, a negative number or
  a fraction is refused before the approval prompt with a reason that names
  the accepted range (`timeoutSec must be at most 600`), never clamped, so the
  model learns the limit. The approval request's title now carries the
  effective deadline, `Run Bash Command (timeout 300 s)`, and both the Rust
  REPL and the TypeScript client show it as sent, so the operator approves the
  duration along with the command. The tool description states the default
  and the ceiling, and the value is recorded on the durable `tool_call`
  event's arguments like any other argument. For tool authors, a
  `CommandDefinition` may now set `approvalTitle(call)` to vary the prompt's
  title per call, and `integer` and `number` schema properties may declare
  inclusive `minimum` and `maximum` bounds, which argument validation
  enforces and the corrective feedback renders (`1 to 600`). The `git` tool's
  30 s deadline is unchanged.

- **llama.cpp is a local provider, with Qwen3.6 35B-A3B as its default.**
  The `llama-cpp` provider reaches `llama-server`'s OpenAI-compatible endpoint
  on `http://localhost:8080/v1`, and the engine's net grants allow loopback
  port 8080. `llama-cpp/qwen3.6-35b-a3b` declares the served 32K context and
  tool calls; migration `014` adds it to existing databases and deactivates
  the previous DeepSeek row without deleting it. An unconfigured bare turn
  prefers this row, then Ollama's separate `qwen3.6:35b-a3b` row. The
  operator's configured default still wins over this preference order.

- **A bare `dyfj` on a terminal opens the Rust REPL.** When a `dyfj-repl`
  binary is available (`DYFJ_REPL_BIN`, `core/target/release/dyfj-repl` or
  `PATH`), every argument is one it takes (`--model`, `--approve-paid`,
  `--fast`, `--session`, `--workspace`, `--socket`) and neither
  `DYFJ_WORKBENCH_TIER` nor `DYFJ_WORKBENCH_HINT` holds a value the
  TypeScript client applies, the launcher hands the
  interactive session to it after autostart; otherwise the TypeScript REPL
  opens as before. `DYFJ_REPL=ts` keeps the TypeScript REPL and
  `DYFJ_REPL=rust` requires the Rust one for interactive sessions on a
  terminal; piped input stays on the TypeScript REPL either way. The Rust
  REPL also refuses an unknown or unroutable `--model` at launch, listing the
  available models, instead of failing the first turn.
- **The Rust REPL can be a daily driver.** `dyfj-repl` now sends the same
  turn request as the TypeScript client: the chosen model and fast tier, the
  per-session paid opt-in, and the workspace for a new session, set with
  `--model`, `--fast`, `--approve-paid`, `--workspace` and `--session` (or
  `DYFJ_WORKBENCH_MODEL` and `DYFJ_WORKSPACE`); `--session` takes the id or
  the slug `dyfj sessions` lists and refuses anything else at startup, and the
  startup posture line names the chosen model, fast tier and paid opt-in
  rather than the runtime's defaults. Each turn ends with a receipt
  line naming the model, turn and session cost, tokens, prompt-cache reads and
  writes when reported, tool steps and the route reason. The commands
  `/model`, `/fast`, `/session` (show, list, switch), `/friction`, `/idea mark`,
  `/idea list` and `/help` are recognised only when typed alone on one line, so
  pasted text that contains them stays prompt text and an unknown `/word` is
  sent as a prompt; the input length limit applies to them too. Ctrl-C
  while a read-only command waits on the runtime abandons it without
  cancelling the next turn. The two writes do not return early:
  `/friction` waits for the runtime to settle its post and denies the
  approval it then asks for, and `/idea mark` waits for the runtime to
  record the idea, so a retry cannot record it twice. `/friction` names a
  slash command in its context only when it was typed just before, with no
  turn in between. `/model` refuses unknown and unroutable slugs.
  `/friction` posts only the workspace's name, never its path. A request
  abandoned mid-write no longer leaves a partial frame on the connection.
- **A runtime that started with secrets unavailable says so up front.**
  When a declared secret pointer fails to resolve at boot (a locked vault, a
  timed-out resolver), `runtime/status` now lists it under
  `unavailableSecrets` with the env var (or, for a `[secrets.named]`
  credential, its name) and the resolver's value-free reason. `dyfj status` and the Rust REPL print one line per failed pointer at
  startup, with the recovery: fix what the reason names (a locked vault, a
  failing resolver command, a bad pointer) and restart the runtime, since
  pointers resolve only at boot. A clean start leaves the field out.
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
  a later prompt either: the request is written and flushed, then pending
  input is discarded, and the answer is read after that. If showing the
  request or discarding that input fails, the prompt is not read at all and
  the request is denied, because a warning would not stop a queued keystroke
  from answering. Approval arguments are shown in full rather than
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
  abandoned turn can appear during a later turn; no closed state is recorded
  after the reader ends; and the submission ceiling bounds what is remembered
  rather than what is allocated.

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

- **Dependabot no longer proposes bumps for `@agentclientprotocol/codex-acp`.**
  The `codex-chatgpt` runner asserts an exact adapter version at launch and
  two test fixtures pin the same string, so a bot bump of that package alone
  cannot pass the gate. External-agent work is deferred; the adapter is
  upgraded deliberately, pin and fixtures together, when it resumes. The other
  Deno, Cargo and workflow-action surfaces are unchanged.
- **The Rust REPL restores the whole terminal, not a subset of its flags.** On
  exit and on panic it now replays the termios captured before rustyline took
  the terminal, comparing every field (including `c_line` on Linux) rather than
  re-enabling only echo, line editing and signal generation — so an input flag
  or a VMIN/VTIME change an editor left behind no longer survives into the
  operator's shell. The termios replay happens only when the current settings
  differ from the snapshot, and reports a failed restore on stderr. The
  bracketed-paste and cursor reset is independent of termios, so it is written
  on every restore (to a terminal), whether or not a snapshot existed or
  changed.

- **The workspace file tools are split by job.** `tools/builtin/file.ts` was
  1,929 lines, past the 1,000-line module ceiling, and `executeGrepFiles` was
  past the 200-line function ceiling; both carried size exceptions. The module
  now holds only the six `define*` functions. The executors sit beside it:
  `file-read.ts` (`read_file`, `list_files`), `file-write.ts` (`write_file`,
  `edit_file`), `file-search.ts` (`grep_files`, `glob_files` and their
  traversal), and `file-glob.ts` (the glob matcher), all over the containment,
  verified reads and output escaping in `file-access.ts`. Grep's completeness
  notes are built by one helper from a tally of what the call skipped. Tool
  behavior and output are unchanged, and both size exceptions are gone.
- **Provider request and stream tests folded into the conformance kit.** The
  kit takes named `cases` beyond its required fixtures, each a recorded
  exchange run under the same invariants. The unit tests that called the
  Anthropic, Gemini and OpenAI-compatible request builders and stream-line
  parsers directly (`request.test.ts`, `stream.test.ts`,
  `stream-line.test.ts`) are now such cases in each adapter's
  `conformance.test.ts`, so they assert the request the adapter sends and the
  result and frames it returns, not a helper's return value. The
  OpenAI-compatible check that a legacy reasoning alias is not read twice is
  now pinned through the reasoning-token estimate the turn reports. Turn-level provider tests (limits,
  aborts, errors, usage, tool calls, text-markup recovery) already drive the
  adapter through the scripted transport and stay as they are. The
  `add-provider` recipe and `specs/03-testing.md` say where such cases go. No
  runtime code changed.

- **Inline test support moved into `prototype/testing/`.** Tests no longer
  define their own fake `fetch` functions or loopback servers. Code that takes
  `typeof fetch` rather than the `HttpTransport` port (the web fetch tool, the
  bounded MCP fetch, the diagnostics) is now tested through
  `ScriptedHttpTransport.fetchLike`, the same scripted fake behind the platform
  `fetch` signature, which passes the `HttpTransport` conformance suite.
  `testing/servers/` gains `scripted-http-server.ts` (the loopback server the
  real-`fetch` conformance run uses) and `listeners.ts` (a listener that accepts
  and never answers, a connected Unix-socket pair, and a stale socket file left
  by a killed listener); the canary test uses the shared loopback model server,
  and the MCP redirect tests use the shared loopback HTTP listener. The CLI
  `stop` test for a refused connection now runs against a genuinely stale
  socket: before, a cleanly closed listener removed its file, so the test
  exercised a missing socket instead. No runtime code changed.

- **Ten top-level prototype modules moved into their layer directories.**
  `src/secrets.ts` is now `src/config/secrets.ts`; `src/utils.ts` is
  `src/store/model-selected-event.ts`; the external MCP adapter
  (`src/mcp-tools.ts`), MCP trace-context rules (`src/mcp-conformance.ts`) and
  memory recall (`src/memory-search.ts`) are under `src/tools/mcp/` as
  `adapter.ts`, `conformance.ts` and `memory-search.ts`; and the memory record
  format (`src/memory.ts`) is `src/tools/builtin/memory-records.ts`. Their tests
  moved with them. Their callers outside the unit now import them through
  `config/mod.ts`, `store/mod.ts` and `tools/mod.ts`. The four manual diagnostic helpers
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

- **The `erasable.syntax` lane.** `erasableSyntaxOnly` in the `typecheck.tsc`
  lane now rejects constructor parameter properties, and every other construct
  Node's type stripping cannot erase, so the `deno lint` plugin lane
  (`scripts/erasable-syntax.ts`, its plugin, configuration and tests) is
  deleted. `scripts/typecheck-tsc.test.ts` pins the rejection with a
  parameter-property fixture.

- **The compiled CLI and its `compile-cli` task.** The launcher no longer has
  a compiled route (`dist/dyfj-bin`) or a Deno route; it runs the client on
  Node. Link `prototype/scripts/dyfj-launcher.sh` onto your `PATH` as `dyfj`
  in place of `prototype/dist/`.

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

- **The `bash` and `git` tool timeouts now bound the call and stop the whole
  command tree.** On timeout the tools killed only the direct child (the
  `bash -c` shell, or `git`) and then waited for the output pipes to close.
  Descendants inherited those pipes and kept running, so a pipeline such as
  `deno task test | tail` ran past the 120 s cap until it finished on its own,
  a command tree that never exits (a backgrounded `sleep`, a hung server, a
  watch-mode test) could hang the turn indefinitely, and the result reported
  both "killed" and the command's complete output. Both tools now start the
  command in its own process group outside Windows; at the deadline they stop
  the group the way the aggregate gate stops a test lane (SIGTERM, a grace of
  about a second that ends once the group is empty, then SIGKILL), stop
  collecting output at the deadline, and return after a bounded drain of the
  pipes. The status line reads `timed out after <ms>ms (killed; output shown up
  to the deadline)`, and says so when a group member outlived SIGKILL, when the
  group could not be signalled (Windows, or no signaller), when the command
  itself was still present after SIGKILL (its exit status is then unavailable),
  or when a process that left the group kept the output open and may still be
  running (or, when the group was emptied, that a process outside it did).
  Every wait after the deadline is bounded, the signaller's and the command's
  own exit included, so a process stuck in uninterruptible I/O cannot hold the
  call open: a timed-out call returns about 2.5 s after its deadline when the
  stop goes as designed, and within about 8 s if the signalling child itself
  hangs. `git`'s old `(git killed; descendants may survive)` wording is gone. A
  command that exits normally is not signalled, so a background process whose
  output is redirected elsewhere still keeps running. Output is still collected
  in full before it is clipped.
- **Friction's write-stage error no longer names a tool it may not have
  called.** `FrictionStageError`'s stage was `"create_comment"`, but the
  `save_comment` alias means the runtime may call either tool for the write;
  the stage is now `"comment write"`.
- A `/friction` that the Rust REPL rejects (no severity, or an unknown option)
  is no longer recorded as the last command, so its text no longer appears in
  the next friction's context line.
- **Deactivating a built-in local model row now sticks.** Workbench overlays
  its built-in local rows (the Ollama defaults) on the catalog when the catalog
  lacks them, but it treated a row the operator had set inactive as missing and
  added the built-in copy back, so ask and next-work routing, the ACP route
  check and the model picker could still select a deactivated model. The
  overlay now skips any slug the catalog lists as inactive; the store's model
  reader gains `listInactiveSlugs()` for this.

- **The missing-credential error points at the real recovery.** A hosted turn
  whose provider key is absent used to say to project the key with `op run` at
  process start. It now says that secrets resolve only at runtime start: fix
  the failure `dyfj status` reports, or set the key or declare it under
  `[secrets]`, then restart the runtime. The message stays inside the wire
  summary's size limit, so the restart advice is never cut off.
- **Hosted OpenAI-compatible turns meter prompt-cache traffic**: on OpenAI,
  OpenRouter and xAI the receipt reported zero cache reads and writes and
  charged every prompt token at the full input rate, because the adapter
  ignored `prompt_tokens_details` and the catalog's `cost_cache_read` /
  `cost_cache_write` columns were never loaded. A turn now splits
  `cached_tokens` (and OpenRouter's `cache_write_tokens`) out of
  `prompt_tokens` into `cacheRead` / `cacheWrite`, so `input` counts uncached
  tokens as it does for Anthropic, and prices each share at the row's cache
  rate. A row without a cache price (the schema default of zero) charges cache
  traffic at the input rate, so cost is never understated. Streaming requests
  to these providers now send `stream_options.include_usage`, which OpenAI
  needs before it reports usage on a stream; local servers are not sent it.
  `models/list` rows carry `costCacheRead` / `costCacheWrite` when the
  catalog prices them. The turn's receipt line now shows the cached share
  beside the token counts (`12→5 tok · cache 9,000 read, 100 write`) whenever
  a provider reported cache traffic, so the smaller uncached `input` figure is
  never the only prompt size on screen.

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

- **The Rust REPL scopes a spending approval to the options it was offered.**
  A budget-ceiling or runaway-spend approval that carries a set of scoped
  `options` is now answered by choosing one of them, through the same consent
  path as every other approval, instead of a bare yes/no. A `y` to such a
  request previously sent an unrestricted `approve` — broader consent than any
  option the request presented and than the operator was shown. An options set
  that cannot be read in full is refused rather than falling back to yes/no.
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
