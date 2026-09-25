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
- **Unverified schema replay.** Nothing verifies that `current/ + catalog/` and
  `history/ + migrations/` produce the same structure.
- **Fixture skips migrations.** The isolated Dolt fixture applies only
  `current + catalog`, so migration-only paths are never exercised.

## 2. Store port

`prototype/src/store/mod.ts` exports:

```ts
interface Store {
  events: EventRepository; // append(row: EventInsert), byId, bySession, query(filter), exists
  sessions: SessionRepository; // create, update, get, list, inspect
  memories: MemoryRepository; // list/read by visibility & inject class, write (MCP server)
  models: ModelRepository; // active catalog rows incl. pricing & execution profile
  prompts: PromptRepository; // companion prompt by slug
  spend: SpendRepository; // session/day baselines for budget envelopes
  close(): Promise<void>;
}
```

- **Repository contracts are derived from current call sites, not invented.**
  - Each existing query becomes one repository method with the same SQL
    semantics.
  - There are no new capabilities.
  - Every method uses parameterized SQL only.
  - The MCP server's `start_session`/`update_session`/memory tools call the same
    repository methods as the runtime.
- **Privacy scoping stays in one place.** Memory visibility filtering
  (`private | shareable | client_safe | public`) and the loopback/non-loopback
  clearance rule are implemented once, in `memories`, and both the runtime and
  the MCP server use them.
- **Adapters:**
  - `DoltStore`: one `mysql2` pool per process, built from `config/`. It
    replaces the pools in `utils.ts:57-104`, `mcp/dolt-config.ts` and
    `mcp/server.ts:42-67`, and the second raw-connection path in `writeEvent`.
  - `MemoryStore`: an in-memory implementation for unit and component tests.
- **Fake fidelity.** `MemoryStore` must pass the same store conformance suite as
  `DoltStore` (`03-testing.md` §5). A fake that diverges from Dolt is a failing
  test, not a judgment call.

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
- **Typed event writes.** `EventRepository.append` takes `EventInsert`. The 28
  current `writeEvent` call sites migrate to typed constructors per event type
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
- **The seam.** `core/` event read/write maps to
  `EventRepository.append`/`byId`. A future Rust-backed store adapter would sit
  behind the same port.
- **Deferred.** A `cargo sqlx prepare --check` lane (catching `.sqlx` cache
  drift) is deferred until the Rust line grows.
