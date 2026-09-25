# 02 — Data layer and schema-derived types

Status: normative for phase 1. Layer 0 stance #4 governs. The Dolt DDL is the
source of truth, and TypeScript consumes it.

## 1. Problems addressed

- **SQL is scattered.** It is issued from 8 runtime modules plus
  `prototype/mcp/`, which has its own pool.
- **Duplicated persistence.** Session writes and memory SELECTs are duplicated
  between `src/` and `mcp/`.
- **Untyped writes.** `writeEvent(event: Record<string, unknown>)` derives
  column names from object keys, so a typo or a dropped column is caught only at
  runtime.
- **No single write path.** Events are append-only, but `sessions` is updated in
  place, `memories` is upserted by the MCP server without an event, and
  ideas/packets never reach storage. README Section 1's "the log is ground
  truth" is therefore not yet true (`00-baseline-findings.md` defect 10).
- **Unverified schema replay.** Nothing verifies that `current/ + catalog/` and
  `history/ + migrations/` produce the same structure.
- **Fixture skips migrations.** The isolated Dolt fixture applies only
  `current + catalog`, so migration-only paths are never exercised.

## 2. Store port (event-first)

AGENTS.md rule 4 says the event log is the write path and tables are its
projections. The store is shaped around that rule from the start, even though
phase 1 cannot finish it (§7).

`prototype/src/store/mod.ts` exports:

```ts
interface Store {
  journal: Journal; // the ONLY mutation path
  events: EventReader; // byId, bySession, query(filter), exists (read-only)
  sessions: SessionReader; // get, list, inspect (projection, read-only)
  memories: MemoryReader; // list/read by visibility & inject class (projection, read-only)
  models: ModelReader; // reference data: catalog rows incl. pricing & execution profile
  prompts: PromptReader; // reference data: companion prompt by slug
  spend: SpendReader; // session/day baselines for budget envelopes (derived from events)
  close(): Promise<void>;
}

interface Journal {
  // Append events and apply their projection updates atomically, in one transaction.
  commit(
    batch: { events: EventInsert[]; mutations?: UnjournaledMutation[] },
  ): Promise<CommitReceipt>;
}
```

- **One write path.** Every write in the runtime and in the MCP server goes
  through `journal.commit`. Readers never write. The events table has no update
  or delete path anywhere in the store API; a conformance test asserts this.
- **Projectors.** Each projected table has a projector: a pure function from
  `(current row | none, event) → new row | none`. `commit` applies the
  projectors in the same transaction as the event append. In phase 1 the only
  projectors are the ones today's events already imply (for example
  `session_start` creating a session row), and only where that reproduces
  today's rows exactly.
- **Unjournaled mutations (the declared gap).** Some writes have no event type
  today: session updates, the memory upsert, the second session-insert path.
  They pass through `commit` as typed `UnjournaledMutation` values, and each
  kind is listed in `store/unjournaled.ts` with the reason it has no event yet.
  - The list may only shrink. `arch.imports` fails on any direct write that
    bypasses `commit`, and the conformance suite fails on a mutation kind that
    is not listed.
  - PRD-15 empties the list.
  - Routing these writes through `commit` in phase 1 changes no rows, so the
    golden suite stays unchanged.
- **Reference data is the declared exception.** `models` and `prompts` are
  written only by `schema/catalog/` and migrations, and versioned through Dolt
  commits. The runtime never writes them.
- **Read contracts come from current call sites, not invented.** Each existing
  query becomes one reader method with the same SQL semantics. There are no new
  capabilities, and SQL is parameterized only. The MCP server's
  `start_session`/`update_session`/memory tools use the same journal and readers
  as the runtime.
- **Privacy scoping in one place.** Memory visibility filtering
  (`private | shareable | client_safe | public`) and the loopback/non-loopback
  clearance rule are implemented once, in `memories`. Both the runtime and the
  MCP server use it.
- **Adapters:**
  - `DoltStore`: one `mysql2` pool, constructed by the composition root and
    passed in. It is not a module-level singleton. It replaces the pools in
    `utils.ts:57-104`, `mcp/dolt-config.ts` and `mcp/server.ts:42-67`, and the
    second raw-connection path in `writeEvent`.
  - `MemoryStore`: an in-memory implementation for unit and component tests.
- **Fake fidelity.** `MemoryStore` must pass the same conformance suite as
  `DoltStore` (`03-testing.md` §5), including atomicity: a failed projector
  leaves neither the event nor the projection changed. A fake that diverges from
  Dolt is a failing test, not a judgment call.

## 3. Generated row types

- **Generator.** `schema/codegen.ts` (repository-owned) runs as follows:
  1. Starts an isolated Dolt instance, reusing `isolated-dolt-fixture`.
  2. Applies `current/` then `catalog/`.
  3. Reads `information_schema.columns` for the canonical tables.
  4. Emits `prototype/src/store/generated/rows.ts`.
- **Generated output** (header: `// generated from schema/ — do not edit`):
  - `<Table>Row` (selected shape) and `<Table>Insert` (insert shape:
    nullable/defaulted columns optional);
  - column-name constant tuples;
  - SQL enum unions, e.g. `EventType`, `MemoryVisibility`, `MemoryInject`.
- **Emission rules:** output is deterministic (sorted, stable formatting) and
  emitted by the script; no hand edits.
- **Typed event writes.** `journal.commit` takes `EventInsert[]`. The current
  `writeEvent` call sites migrate to typed constructors per event type
  (`events/builders.ts`), so each event type's required fields are checked at
  compile time.
- **Gate lane `schema.codegen`.** Regenerates the file and fails if it differs
  from the committed copy. Changing the DDL without regenerating fails the gate.

## 4. Schema equivalence

**Gate lane `schema.equivalence`:**

1. Apply `current + catalog` to one isolated Dolt, and `history + migrations` to
   another.
2. Compare the normalized `information_schema` for both: tables, columns, types,
   nullability, defaults, indexes, enums, check constraints.
3. Fail on any difference. Catalog _data_ is not compared; structure only.

**Resolving the doc conflict on apply order:**

- **Fresh install** = `current/` + `catalog/`.
- **Existing database** = replay forward via `migrations/`, applied on top of
  `history/`.

Correct `schema/README.md`, `schema/migrations/README.md`, and README §5
"Initialize Dolt" to state this single rule.

**Fixture:** the isolated Dolt fixture keeps applying `current + catalog`. That
is valid once equivalence is enforced.

## 5. Deleting the drift shims

Once equivalence and codegen are enforced:

- **Delete** the five `isMissing*Column` fallbacks and the legacy models query.
- **Add a boot check:** at server start, `DoltStore` compares the live
  database's columns for the canonical tables against the generated column
  tuples. On mismatch it fails with a message naming the missing columns and
  pointing at `schema/migrations/`.

## 6. Rust

- **No Rust change in phase 1.**
- **The seam is the process boundary** (`01-architecture.md` §10). A future Rust
  journal would be a service that `DoltStore`'s successor calls over JSON-RPC,
  not an in-process adapter.
- **`core/events.rs` is a second writer to the log.** It is acceptable as the
  schema tracer bullet only.
- **Deferred.** A `cargo sqlx prepare --check` lane (catching `.sqlx` cache
  drift) is deferred until the Rust line grows.

## 7. Projections and replay (target state; delivered by PRD-15)

- **Every state change is an event.** The unjournaled list is empty. New event
  types cover session updates, memory writes, and idea/packet marks and drafts,
  which also makes ideas and packets durable. They are added through DDL and
  migrations first (Layer 0 stance #4).
- **Replay equivalence.** A gate lane, `projections.replay`, works as follows:
  1. Run the golden scenarios against an isolated Dolt.
  2. Truncate the projected tables.
  3. Rebuild them from `events` with the projectors.
  4. Require the rebuilt tables to be identical to the originals.
- **Replay is deterministic.** Projectors read only the event and the prior row.
  They never read the clock, IDs, or config. Timestamps come from the event.
- **Dolt history is not the log.** Dolt's commit history versions table storage.
  It is useful for operator time travel (`AS OF`), but it is not the domain
  event log, and the runtime never uses it as a substitute for events.
