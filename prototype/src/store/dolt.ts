/**
 * `DoltStore`: the store port over one Dolt pool. The composition root builds
 * the pool (`createDoltPool`) and passes it in; the store owns it from then on
 * and ends it on `close()`.
 */

import { DoltJournal } from "./dolt-journal.ts";
import type { DoltPool } from "./dolt-pool.ts";
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

export class DoltStore implements Store {
  readonly journal: Journal;
  readonly events: EventReader;
  readonly sessions: SessionReader;
  readonly memories: MemoryReader;
  readonly models: ModelReader;
  readonly prompts: PromptReader;
  readonly spend: SpendReader;
  readonly #pool: DoltPool;

  constructor(
    pool: DoltPool,
    options: { projectors?: readonly Projector[] } = {},
  ) {
    this.#pool = pool;
    this.journal = new DoltJournal(
      pool,
      options.projectors ?? PHASE1_PROJECTORS,
    );
    this.events = doltEventReader(pool);
    this.sessions = doltSessionReader(pool);
    this.memories = doltMemoryReader(pool);
    this.models = doltModelReader(pool);
    this.prompts = doltPromptReader(pool);
    this.spend = doltSpendReader(pool);
  }

  close(): Promise<void> {
    return this.#pool.end();
  }
}
