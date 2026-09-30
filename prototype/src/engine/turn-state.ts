/**
 * The engine-owned state of one native turn (specs/01-architecture.md §5.1).
 *
 * - `TurnSession` is what `openSession` fixes for the whole turn: identity,
 *   principal, auth, budget tracker, and the turn's configuration. It never
 *   changes after `openSession` returns.
 * - `TurnState` is what the later stages fill in as the turn runs. The turn's
 *   pipeline is its single writer: exactly one stage runs at a time, and the
 *   finalize step reads whatever the stages reached, so a turn that fails in
 *   `buildContext` still reports the context sources it had loaded.
 * - `TurnAudit` counts best-effort event writes that failed and remembers the
 *   first failed integrity write, so neither is ever silent.
 */
import type { BudgetTracker, SpendBaselines } from "../budget/mod.ts";
import type { CommandRegistry, RootAnchors } from "../tools/mod.ts";
import type {
  HistoryOmissionReceipt,
  WorkbenchAuthContext,
  WorkbenchRuntimeMode,
} from "../contract/mod.ts";
import type {
  AskContextProfile,
  ContextOverflowRecoverer,
  PackedContextSummary,
  WorkspaceRootIdentity,
} from "../context/mod.ts";
import type {
  WorkbenchCallTimings,
  WorkbenchTurnResult,
} from "../providers/mod.ts";
import type { EventInsert, Store } from "../store/mod.ts";
import type { Clock } from "../kernel/mod.ts";
import type { Env } from "../config/mod.ts";
import type { WorkbenchTurnParams } from "../providers/mod.ts";
import type { BudgetScopes } from "./session-owner.ts";
import type { WorkbenchValidationSummary } from "./runtime-types.ts";

/** The ports a native turn's stages run against. */
export interface NativeTurnPorts {
  store: Store;
  budgetScopes: BudgetScopes;
  clock: Clock;
  env: Env;
  /**
   * The provider transport and credential reader, spread into every provider
   * call. Empty unless the caller injected them, so adapters otherwise use
   * the platform `fetch` and the process environment.
   */
  providerIo: Pick<WorkbenchTurnParams, "fetchFn" | "getEnv">;
  /** The session and daily spend rollup; the store's when absent. */
  fetchSpendBaselines?: (sessionId: string) => Promise<SpendBaselines>;
  /** The compressor seam for a context overflow; none when absent. */
  recoverContextOverflow?: ContextOverflowRecoverer;
  /** The engine's workspace-root anchors, which the file tools verify against. */
  rootAnchors: RootAnchors;
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

/** The model a turn reports on its receipt and error events. */
export interface ReceiptModel {
  displayName: string;
  slug: string;
  tier: 0 | 1 | 2;
  provider?: string;
  api?: string;
}

/** What the stages have reached so far; finalize reads it whatever happened. */
export interface TurnState {
  readonly session: TurnSession;
  readonly audit: TurnAudit;
  // buildContext
  workspaceRoot: string;
  workspaceRootIdentity: WorkspaceRootIdentity | undefined;
  /** A requested workspace failed to resolve; see `buildContext`. */
  workspaceResolutionFailed: boolean;
  systemPrompt: string;
  /** The text the model receives as the user turn. */
  modelPrompt: string;
  contextSourceLines: string[];
  contextBudget: PackedContextSummary | undefined;
  contextProfile: AskContextProfile | undefined;
  historyOmission: HistoryOmissionReceipt | undefined;
  commandRegistry: CommandRegistry;
  commandTools: ReturnType<CommandRegistry["projectTools"]>;
  // route and budget
  selectedForReceipt: ReceiptModel | null;
  selectedForEvents: { slug: string; provider: string; api: string } | null;
  routingReason: string;
  estimatedCostUsd: number;
  // agent loop accounting, across every provider call this turn makes
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  turnInputTokens: number;
  turnOutputTokens: number;
  turnCostUsd: number;
  providerCallOrder: number;
  callTimings: WorkbenchCallTimings | undefined;
  toolSteps: number;
  toolStepLimitReached: boolean;
  finalText: string;
  finalStopReason: WorkbenchTurnResult["stopReason"];
  validation: WorkbenchValidationSummary | undefined;
  /** An unexpected turn error, rethrown after the receipt is written. */
  turnError: unknown;
}

/** A fresh state for a turn `openSession` has opened. */
export function newTurnState(
  session: TurnSession,
  commandRegistry: CommandRegistry,
): TurnState {
  return {
    session,
    audit: new TurnAudit(),
    workspaceRoot: session.fallbackRoot,
    workspaceRootIdentity: undefined,
    workspaceResolutionFailed: false,
    systemPrompt: "",
    // Prior conversation rides in the transcript as real messages, so the
    // prompt is just the current message.
    modelPrompt: session.prompt,
    contextSourceLines: [],
    contextBudget: undefined,
    contextProfile: undefined,
    historyOmission: undefined,
    commandRegistry,
    commandTools: [],
    selectedForReceipt: null,
    selectedForEvents: null,
    routingReason: "not_selected",
    estimatedCostUsd: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    turnInputTokens: 0,
    turnOutputTokens: 0,
    turnCostUsd: 0,
    providerCallOrder: 0,
    callTimings: undefined,
    toolSteps: 0,
    toolStepLimitReached: false,
    finalText: "",
    finalStopReason: "error",
    validation: undefined,
    turnError: null,
  };
}
