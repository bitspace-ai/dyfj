/**
 * The engine-owned state of one native turn (specs/01-architecture.md §5.1).
 *
 * - `TurnSession` is what `openSession` fixes for the whole turn: identity,
 *   principal, auth, budget tracker, and the turn's configuration. It never
 *   changes after `openSession` returns.
 * - `TurnAudit` counts best-effort event writes that failed and remembers the
 *   first failed integrity write, so neither is ever silent.
 */
import type { BudgetTracker, SpendBaselines } from "../budget/mod.ts";
import type {
  WorkbenchAuthContext,
  WorkbenchRuntimeMode,
} from "../contract/mod.ts";
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

export type AuthnEventFields = Pick<
  EventInsert,
  "authn_status" | "authn_mechanism" | "authn_issuer_ref"
>;

export interface TurnSession {
  mode: WorkbenchRuntimeMode;
  /** The operator's prompt as sent, persisted on `session_start`. */
  prompt: string;
  resumingSession: boolean;
  sessionId: string;
  sessionSlug: string;
  traceId: string;
  /** The session-start span: the root every event of this turn hangs below. */
  turnRootSpanId: string;
  /** Clock reading at turn start; durations are measured from it. */
  startedAt: number;
  principalId: string;
  authContext: WorkbenchAuthContext;
  authnEventFields: AuthnEventFields;
  budgetConfig: {
    sessionLimitUsd: number;
    perCallLimitUsd: number;
    dailyLimitUsd: number;
  };
  anomalyConfig: { turnMultiple: number; scopeMultiple: number };
  /** Reads the spend already on the books for a session. */
  fetchBaselines: (sessionId: string) => Promise<SpendBaselines>;
  budget: BudgetTracker;
  isNextWork: boolean;
  /** Ask and next-work turns load repo context instead of the companion's. */
  usesRepoAskContext: boolean;
  workletId: string | undefined;
  maxToolSteps: number;
  /** The root the file tools fall back to when no workspace resolves. */
  fallbackRoot: string;
  /** The transport-gated workspace request, persisted on a new session. */
  honoredWorkspace: string | undefined;
  /** The resumed session's stored workspace could not be read. */
  workspaceLookupFailed: boolean;
  /** Presenter narration; silent unless the caller injects one. */
  log: (...parts: unknown[]) => void;
}

/** Failed event writes this turn: counted when best-effort, kept when not. */
export class TurnAudit {
  #skippedEventWrites = 0;
  #fatalEventError: unknown = null;

  get skippedEventWrites(): number {
    return this.#skippedEventWrites;
  }

  /** The first integrity write that failed, or null. */
  get fatalEventError(): unknown {
    return this.#fatalEventError;
  }

  /** Count a best-effort event write that failed. */
  readonly noteSkippedEventWrite = (): void => {
    this.#skippedEventWrites++;
  };

  /**
   * Run an integrity write. A failure is remembered, so the turn cannot hand
   * back a normal receipt with a missing audit or transcript event, and
   * rethrown.
   */
  async writeIntegrity(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (err) {
      this.#fatalEventError ??= err;
      throw err;
    }
  }
}
