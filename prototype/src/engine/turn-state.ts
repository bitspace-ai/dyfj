/**
 * The engine-owned state of one native turn (specs/01-architecture.md §5.1)
 * and the ports its stages run against.
 */
import type { EventInsert, Store } from "../store/mod.ts";
import type { Clock } from "../kernel/mod.ts";
import type { Env } from "../config/mod.ts";
import type { WorkbenchTurnParams } from "../providers/mod.ts";
import type { CeilingConfirmationStore } from "../budget/mod.ts";

/** The ports a native turn's stages run against. */
export interface NativeTurnPorts {
  store: Store;
  ceilingConfirmations: CeilingConfirmationStore;
  clock: Clock;
  env: Env;
  /**
   * The provider transport and credential reader, spread into every provider
   * call. Empty unless the caller injected them, so adapters otherwise use
   * the platform `fetch` and the process environment.
   */
  providerIo: Pick<WorkbenchTurnParams, "fetchFn" | "getEnv">;
}

/** Write one event row through the store's journal. */
export async function commitEvent(
  store: Store,
  event: EventInsert,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  await store.journal.commit({ events: [event] }, options);
}
