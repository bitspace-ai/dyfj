/**
 * store/ (L2): the store port and its adapters. The only directory that issues
 * SQL (`specs/02-data-layer.md` section 2).
 *
 * Responsibility: one mutation path (`journal.commit`), read-only readers over
 * the projected tables and reference data, the memory clearance rule, and the
 * adapters: `DoltStore` over one `mysql2` pool that the composition root builds
 * and passes in, and `MemoryStore` for unit and component tests. Both pass the
 * conformance suite in `testing/conformance/store.ts`.
 *
 * Allowed dependencies: `kernel/`, `config/` (types), and `mysql2`, which no
 * other directory may import.
 *
 * Readers return rows as the Dolt driver renders them to text, NULL as the
 * empty string: the contract every caller parsed before the port existed.
 * Typed row shapes arrive when row types are generated from the DDL
 * (`specs/02-data-layer.md` section 3).
 */

export {
  MCP_STDIO_MEMORY_CLEARANCE,
  MEMORY_VISIBILITY_ALL,
  memoryClearanceFor,
  type MemoryType,
  type MemoryVisibility,
} from "./memories.ts";
export {
  isDeclaredMutationKind,
  type MemoryUpsertMutation,
  type SessionInsertMutation,
  type SessionUpdateMutation,
  UndeclaredMutationError,
  UNJOURNALED_MUTATION_KINDS,
  type UnjournaledMutation,
  type UnjournaledMutationKind,
} from "./unjournaled.ts";
export {
  PHASE1_PROJECTORS,
  type ProjectedTable,
  type ProjectionRow,
  type Projector,
} from "./projectors.ts";
export { createDoltPool, type DoltPool } from "./dolt-pool.ts";
export { DoltStore } from "./dolt.ts";
export {
  type MemorySeed,
  MemoryStore,
  type MemoryStoreSeed,
  type ModelSeed,
  type PromptSeed,
} from "./memory-store.ts";

export {
  type CommitBatch,
  type CommitOptions,
  type CommitReceipt,
  type EventInsert,
  type EventReader,
  invalidAsOfError,
  isValidAsOfTimestamp,
  type Journal,
  type MemoryReader,
  type ModelReader,
  type PromptReader,
  type SessionEventsQuery,
  type SessionReader,
  type SpendBaselineSums,
  type SpendReader,
  type Store,
  type TextRow,
} from "./port.ts";
