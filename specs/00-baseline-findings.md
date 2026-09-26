# 00 — Baseline findings (pre-interview)

Status: input to the spec set. Observed facts from the tree at `774c9d5`, not
decisions. Decisions come out of the interview and land in later specs. Revised
after the doctrine review: defect 1 reworded, defects 10–11 added.

## Shape of the codebase

| Area                                   | Size                                           | Notes                                                                       |
| -------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------- |
| `prototype/src` runtime                | 47 files, ~36.5k LOC                           | 10 modules > 1k LOC; `cli.ts` 4149, `provider.ts` 3873, `workbench.ts` 3809 |
| `prototype/src` tests                  | 57 files, ~49k LOC                             | 48 unit / 9 integration; ~2.2k tests                                        |
| `contracts/workbench/first-product/v1` | ~9.5k LOC TS + 110 fixtures                    | No runtime consumer                                                         |
| `scripts/` (gate)                      | 23 sequential lanes, fail-fast                 | Solid supply-chain and public-safety posture                                |
| `schema/`                              | current + catalog + 23 history + 12 migrations | Baseline vs history+migrations never compared                               |
| `core/` Rust                           | 317 LOC                                        | Event write/read tracer only                                                |

## Architecture: what is sound (keep)

- **Client/server split holds.** `cli.ts` never imports `workbench` or
  `provider`; it only speaks JSON-RPC over UDS.
- **One shared turn core** (`turn-runner.executeTurn`) behind one transport.
- **Command primitive.** Registry + call-shape policy + `invokeCommandWithEvent`
  is a real, coherent seam.
- **The ACP external-agent lane** is conceptually separate from the native
  provider loop.
- **The gate** has digest-pinned toolchains, public-safety scans, and a
  clean-checkout CI.

## Architecture: structural defects

1. **Unjustified import cycles.** The doctrine (AGENTS.md rule 1) allows a cycle
   only when it is named, justified, and tested. None of these are:
   - `mcp-tools` ⇄ `web-tools`: a runtime value cycle.
   - `workbench` → `external-agent-runtime` → `workbench`: held together by a
     lazy `await import`.
   - `sessions` ⇄ `idea-packet`: type-only, through a barrel re-export. This is
     less a cycle than an ownership inversion: `sessions` re-exports and so owns
     the idea/packet API.
2. **Engine helpers live in the orchestrator.** `turn-runner` and
   `external-agent-runtime` import from `workbench.ts`, the top-level module.
3. **One ~2,200-line function.** `runNativeWorkbenchRuntime`
   (`workbench.ts:1594-3798`) owns context build, session creation, budget
   gates, compression, length recovery, the agent loop, and finalization.
4. **No provider adapter interface.** `runWorkbenchTurn` switches on `model.api`
   across three wire formats inside a single 3.9k-LOC file.
5. **No data-access layer.** SQL is spread across 8 modules plus the MCP server,
   which has its own pool, its own session writes, and duplicate memory queries.
   `writeEvent` builds column names from object keys: untyped against the
   canonical DDL.
6. **Duplication:**
   - UTF-8 byte bounding ×7, ANSI stripping ×4, stop-reason normalizers ×5
   - Dolt pool ×3, MCP client setup ×2, tool-registry assembly ×3
   - Env adapters mixing `Deno.env` and `process.env`; undeclared `DYFJ_*` keys
     that bypass the config schema
7. **Three tool-definition shapes:** `CommandDefinition`, legacy
   `ToolDefinition`, `WorkbenchToolDefinition`.
8. **Vestigial code:**
   - A standalone argv CLI in `workbench.ts`, still wired to `deno task start`
     and `deno task workbench`
   - The `WorkbenchHttpRuntime` name
   - Dead CSV helpers
   - Five schema-drift fallback shims
   - `--sloppy-imports` everywhere
9. **Misplaced code:**
   - `cli.ts` embeds ~665 lines of idea/packet REPL flows and the Deno
     permission-grant computation for the launcher.
   - `uds-server.ts` builds its own command registry inline to post friction
     reports.

10. **The log is not ground truth.** README Section 1 says it is. The mutation
    inventory at `774c9d5`:

    | Table / state       | Writers                                                                                                         | Evented?                                                            |
    | ------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
    | `events`            | `writeEvent` (called from `workbench`, `external-agent-runtime`, `budget`, `utils`, commands); `core/events.rs` | append-only                                                         |
    | `sessions`          | `sessions.ts` (2 INSERT, 1 UPDATE); `mcp/server.ts` (INSERT, UPDATE)                                            | only `session_start`/`session_end`; in-place updates carry no event |
    | `memories`          | `mcp/server.ts` `write_memory` upsert only                                                                      | no                                                                  |
    | ideas / packets     | `IdeaPacketRegistry` module-level singleton                                                                     | no, and not durable: lost on server restart                         |
    | receipts            | rendered at display time                                                                                        | partially (budget/provider events); no receipt record               |
    | `models`, `prompts` | `schema/catalog/` and migrations only                                                                           | reference data, versioned through `schema/`: the declared exception |

11. **Module-level mutable state.** `defaultIdeaPacketRegistry` and the Dolt
    pool singleton (`utils.ts` `_pool`) are process-global. This breaks
    single-writer ownership (AGENTS.md rule 3).

## Testing: structural defects

1. **The stated doctrine is not followed.** README §4 says integration tests use
   real deps and mocks are only for things that don't exist yet.
   - `workbench.test.ts` `vi.mock`s 10 internal modules.
   - Dolt is faked almost everywhere.
   - Several `*.integration.test.ts` files run against in-test fake servers, not
     real dependencies.
2. **Catch-all test files** mirror the god-modules (cli/provider/workbench tests
   ~6k LOC each).
3. **No shared test support.** `fakeIo`, `buildClock`, fake fetches, fake
   MCP/HTTP/UDS servers and assert helpers are copy-pasted.
4. **Two frameworks for one tier.** Integration tests are split between Vitest
   and `Deno.test`, with a hand-maintained assignment list.
5. **Unchecked drift:**
   - Schema baseline vs replay
   - TS row types vs DDL
   - sqlx offline cache vs DDL
   - The isolated Dolt fixture skips migrations
   - Two typecheck file lists that already differ
   - Local vs gate lane selection
6. **Supervisor weight.** ~2.5k LOC of lock/reaper/process-group code contains
   leaks from process-spawning _unit_ tests. The parallel-timeout root cause is
   still open.
7. **Weak fast loop.** The gate is sequential and stops at the first failure,
   and `test:fast` runs no product behavior tests.

## Docs drift (README "docs must not lie")

- HTTP/SSE leftovers in the README, `config.example.toml`, CHANGELOG prose and
  the `.d2` diagram. The d2 diagram is stale; the `.dsl` is current.
- Provider count (3 / 4 / 5) and the local default model (MLX Qwen3-Coder vs
  Ollama qwen3.6) are inconsistent.
- The schema apply order differs across three docs.
- README §6.2–6.4 describe resume/rewind/fork, OTel spans, eval harnesses,
  checkpoint rollback and cron primitives as if they exist.
- Undocumented surfaces:
  - `web_search` / `web_fetch`
  - `ideas/*`, `packets/*`, `runtime/liveness`, `runtime/stop`,
    `sessions/inspect`
  - `/idea`, `/packet`

## The biggest open question

`contracts/workbench/first-product/v1` defines a domain model (Room, Task, Run,
Route, Grant, Lease, ContextPacket, Receipt, Projection) that **the runtime does
not implement**. The runtime has `sessions` + a flat `events` log. How a
refactor relates to that model decides most of the specs that follow.
