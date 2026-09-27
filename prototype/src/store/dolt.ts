/**
 * `DoltStore`: the store port over one Dolt pool. The composition root builds
 * the pool (`createDoltPool`) and passes it in; the store owns it from then on
 * and ends it on `close()`. The engine's composition root runs
 * `assertCanonicalColumns` before it serves.
 */

import { DoltJournal } from "./dolt-journal.ts";
import { type DoltPool, type DoltSelect, selectOnly } from "./dolt-pool.ts";
import {
  doltEventReader,
  doltMemoryReader,
  doltModelReader,
  doltPromptReader,
  doltSessionReader,
  doltSpendReader,
} from "./dolt-readers.ts";
import type {
  EventReader,
  Journal,
  MemoryReader,
  ModelReader,
  PromptReader,
  SessionReader,
  SpendReader,
  Store,
} from "./port.ts";
import { PHASE1_PROJECTORS, type Projector } from "./projectors.ts";
import {
  missingCanonicalColumns,
  MissingSchemaColumnsError,
} from "./schema-check.ts";

export class DoltStore implements Store {
  readonly journal: Journal;
  readonly events: EventReader;
  readonly sessions: SessionReader;
  readonly memories: MemoryReader;
  readonly models: ModelReader;
  readonly prompts: PromptReader;
  readonly spend: SpendReader;
  readonly #pool: DoltPool;
  readonly #reads: DoltSelect;

  constructor(
    pool: DoltPool,
    options: { projectors?: readonly Projector[] } = {},
  ) {
    this.#pool = pool;
    this.journal = new DoltJournal(
      pool,
      options.projectors ?? PHASE1_PROJECTORS,
    );
    // Readers get a handle that runs only a single SELECT; the write-capable
    // pool stays with the journal.
    const reads = selectOnly(pool);
    this.#reads = reads;
    this.events = doltEventReader(reads);
    this.sessions = doltSessionReader(reads);
    this.memories = doltMemoryReader(reads);
    this.models = doltModelReader(reads);
    this.prompts = doltPromptReader(reads);
    this.spend = doltSpendReader(reads);
  }

  /**
   * The boot-time column check: reject with `MissingSchemaColumnsError`
   * when the live database lacks a column of a canonical table (a database
   * that predates a migration in `schema/migrations/`). A database that
   * cannot be reached rejects with the driver's error.
   */
  async assertCanonicalColumns(): Promise<void> {
    const rows = await this.#reads.select(
      "SELECT table_name AS tbl, column_name AS col " +
        "FROM information_schema.columns WHERE table_schema = database()",
    );
    const live = new Map<string, Set<string>>();
    for (const row of rows) {
      const table = String(row.tbl);
      const columns = live.get(table) ?? new Set<string>();
      columns.add(String(row.col));
      live.set(table, columns);
    }
    const missing = missingCanonicalColumns(live);
    if (missing.length > 0) throw new MissingSchemaColumnsError(missing);
  }

  close(): Promise<void> {
    return this.#pool.end();
  }
}
