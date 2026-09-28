/**
 * The native runtime's input, services, and result types. The input is the
 * contract request plus the ports the engine calls back through (the
 * `Approver`, the `FrameSink` and the ticket's cancellation window); none of
 * it crosses the wire.
 */

import type { WorkbenchRoutingOptions } from "../providers/mod.ts";
import type {
  AcpPermissionPrompt,
  AcpPermissionSelection,
  AcpRunnerSelection,
  ExternalAgentWorkbenchRuntimeResult,
  NativeTurnReceipt,
  PaidEscalationVerdict,
  Runner,
  WorkbenchRuntimeEvent,
  WorkbenchRuntimeMode,
  WorkbenchRuntimeRequest,
} from "../contract/mod.ts";
import type { WorkbenchMessage } from "../providers/mod.ts";
import type {
  ConfirmBudgetCeiling,
  ConfirmRunawayAnomaly,
  SpendBaselines,
} from "../budget/mod.ts";
import type { CommandDefinition, ConfirmToolApproval } from "../tools/mod.ts";
import type { BudgetTallyMode, Env, PermissionLevel } from "../config/mod.ts";
import type {
  AskContextProfile,
  ContextOverflowRecoverer,
  PackedContextSummary,
} from "../context/mod.ts";
import type { Clock } from "../kernel/mod.ts";
import type { HttpTransport } from "../providers/mod.ts";
import type { Store } from "../store/mod.ts";
import type { BudgetScopes } from "./session-owner.ts";

export interface WorkbenchInvocation {
  mode: WorkbenchRuntimeMode;
  prompt: string;
  routingOptions: WorkbenchRoutingOptions;
}

/**
 * The engine's approval port (`specs/01-architecture.md` §5.6): each verdict a
 * turn may need from its caller. A verdict answers the waiting stage; it never
 * starts a turn or reaches another session. Each member is a standalone
 * function, so a caller passes a plain object of handlers.
 */
export interface Approver {
  /**
   * Consent handler for paid-inference escalation. Returns a verdict
   * (approve | deny+reason | escalate), not void/throw — so a headless driver
   * can pre-approve or escalate. Drivers inject their own; the core defaults to
   * deny and makes no TTY assumption. The UDS turn runner grants approval
   * only to a loopback caller that set approvePaidInference for the turn.
   */
  confirmPaidEscalation?: (banner: string) => Promise<PaidEscalationVerdict>;
  /**
   * Warn-then-confirm handler when projected spend crosses a budget ceiling.
   * Without it the runtime fails closed at the ceiling (same posture as the
   * approval gate on non-interactive transports).
   */
  confirmBudgetCeiling?: ConfirmBudgetCeiling;
  /**
   * Confirm handler for a runaway-anomaly hard stop (actual spend past the
   * anomaly multiples). Unlike the ceiling handler, an approval admits the
   * next call only and never raises an envelope; without a handler the
   * runtime fails closed at the halt.
   */
  confirmRunawayAnomaly?: ConfirmRunawayAnomaly;
  /**
   * Approval handler for mutating tools. When a tool's policy is
   * "ask", the runtime calls this for an approve/deny verdict; the default (no
   * handler) denies, fail-closed. The UDS transport asks the operator over the
   * duplex channel; HTTP has no such channel and so denies.
   */
  confirmToolApproval?: ConfirmToolApproval;
  /** External-agent permission requests fail closed when this is absent. */
  confirmExternalAgentPermission?: (
    prompt: AcpPermissionPrompt,
    signal: AbortSignal,
  ) => Promise<AcpPermissionSelection>;
}

/**
 * The engine's frame port, the `onFrame` sink of `specs/01-architecture.md`
 * §5.7: output only, never re-entering the engine. Each member is a
 * standalone function and each is optional: an absent member means the caller
 * does not consume that kind of frame.
 */
export interface FrameSink {
  /**
   * Runtime lifecycle events. A streaming caller (one that renders `onTextDelta`)
   * MUST consume this to honor the superseding-retry reset contract: the
   * `supersedingRetryStarted` event is what tells it to discard the deltas it has
   * shown before a superseding retry replaces them. A caller that streams deltas
   * with overflow recovery enabled but supplies no event channel here (and does
   * not surface the recovery `log` note) cannot be signaled, and would render the
   * stale and replacement deltas concatenated. The same channel carries the
   * required unparsed-markup disclosure. Delivery of either safety signal is
   * fail-closed when this handler is present.
   */
  onRuntimeEvent?: (event: WorkbenchRuntimeEvent) => void | Promise<void>;
  onTextDelta?: (delta: string) => void;
  /**
   * Presentation sink for human-readable turn narration: context loading,
   * workspace/model/route lines, turn text, budget tally, and the receipt.
   * An in-process caller (the verify-workbench-events check) injects console
   * output; the UDS server leaves it unset so client presentation never
   * renders on the server console.
   * Default: silent — the runtime core does not narrate.
   */
  log?: (...parts: unknown[]) => void;
}

/** A turn ticket's cancellation window, as the runtime sees it. */
export interface CancellationWindow {
  /** The runtime has begun finalizing; later cancel requests are declined. */
  closeCancellation(): void;
}

/**
 * The engine's runtime input: the plain-data request from contract/ plus the
 * in-process hooks and ports this engine consumes. Only the request half is a
 * contract; everything declared here stays inside the process.
 */
export interface WorkbenchRuntimeInput extends WorkbenchRuntimeRequest {
  routingOptions: WorkbenchRoutingOptions;
  /**
   * The approval port: every verdict this turn may need from its caller.
   * Absent verdicts fail closed.
   */
  approver?: Approver;
  abortSignal?: AbortSignal;
  /**
   * The cancellation window of the turn's ticket. The runtime closes it when
   * it begins finalizing, so later cancel requests are declined. Only a turn
   * that can be cancelled by id carries one.
   */
  cancellationWindow?: CancellationWindow;
  /**
   * Earlier turns in the session as real conversation messages, assembled by
   * the caller (e.g. from session_start/model_response events). Seeded into the
   * agent loop ahead of the current user message so resumed conversations carry
   * their history as structured user/assistant turns — not a flattened string.
   * Companion turn mode only; ignored for one-shot ask/next-work modes.
   */
  conversationMessages?: WorkbenchMessage[];
  /** The frame port: the turn's text deltas, runtime events and narration. */
  frames?: FrameSink;
  /** Boot-discovered external MCP commands; filtered again by turn clearance. */
  externalMcpCommands?: readonly CommandDefinition[];
  /**
   * Whether to print the end-of-turn budget tally — a presentation/driver
   * concern. Lifted to the boundary: entrypoints resolve it from
   * DYFJ_BUDGET_TALLY; the core reads only this field (default "paid").
   */
  budgetTallyMode?: BudgetTallyMode;
  /**
   * Default companion model slug, used when a turn specifies no model, tier, or
   * hint (the "bare turn" default). Lifted to the boundary: entrypoints resolve
   * it from config (~/.dyfj/config.toml) / DYFJ_WORKBENCH_MODEL via loadConfig();
   * the core reads only this field and falls through to the registry local
   * default when absent. A headless driver supplies its own.
   */
  defaultCompanionModel?: string | null;
  /**
   * Operator permission posture from config ("strict" | "operator"), resolved at
   * the boundary. The core reads only this field (default "strict"); the command
   * policy uses it together with the loopback transport to decide whether
   * contained mutating tools auto-approve or prompt. A headless driver supplies
   * its own.
   */
  permissionLevel?: PermissionLevel;
  /**
   * Maximum model↔tool loop steps in one turn, resolved at the boundary from
   * startup config. The config loader accepts integers from 1 through 64; the
   * runtime clamps direct integer inputs to that range and falls back to its
   * valid default for non-integer or non-finite direct inputs.
   */
  maxToolSteps?: number;
  /**
   * Default budget limits (the engine's startup posture), resolved once at the
   * boundary from the declared config surface (DYFJ_BUDGET_* via
   * resolveBudgetDefaultsFromEnv) so the core reads no env. The core uses these
   * as the per-session defaults; the per-turn overrides below take precedence,
   * and the declared BUDGET_DEFAULTS are the final fallback. A headless driver
   * supplies its own.
   */
  defaultSessionBudgetUsd?: number;
  defaultPerCallBudgetUsd?: number;
  defaultDailyBudgetUsd?: number;
  /**
   * Runaway-anomaly hard-stop multiples (startup posture), resolved at the
   * boundary like the budget defaults. Deliberately config-only — no per-turn
   * override field for the multiples themselves. The dollar thresholds they
   * produce scale with the effective budget config, so an explicit loopback
   * per-turn budget override moves them with the envelope it raises; the gate
   * always binds at multiple × the envelope in force.
   */
  anomalyTurnMultiple?: number;
  anomalyScopeMultiple?: number;
  /**
   * Per-turn budget-limit overrides. Absent → the default limits above
   * apply. The HTTP boundary only sets these from a request on the LOOPBACK
   * transport, so a remote caller can never raise the spend cap. The core just
   * reads the fields; a headless driver supplies its own.
   */
  sessionLimitUsd?: number;
  perCallLimitUsd?: number;
  dailyLimitUsd?: number;
}

export interface NativeWorkbenchRuntimeResult extends NativeTurnReceipt {
  context: {
    profile?: AskContextProfile;
    sources: string[];
    budget?: PackedContextSummary;
  };
  agent: {
    toolStepsUsed: number;
    maxToolSteps: number;
    limitReached: boolean;
  };
  validation?: WorkbenchValidationSummary;
}

export type WorkbenchRuntimeResult =
  | NativeWorkbenchRuntimeResult
  | ExternalAgentWorkbenchRuntimeResult;

export interface WorkbenchValidationSummary {
  ok: boolean;
  errors: string[];
}

export interface ToolResultSummary {
  commandId: string;
  callId: string;
  isError: boolean;
  result: string;
}

/**
 * The external-agent (ACP) runner the engine delegates to. The composition
 * root binds the concrete runner; the engine never imports it.
 */
export type ExternalAgentRunner = Runner<
  WorkbenchRuntimeInput & { runner: AcpRunnerSelection },
  ExternalAgentWorkbenchRuntimeResult
>;

export interface WorkbenchRuntimeServices {
  /** The store every native-turn read and write goes through. */
  store: Store;
  /**
   * Where a turn finds its session's budget scope: the engine's
   * `SessionOwners`, built once at the composition root so ceiling
   * confirmations persist for their scope periods.
   */
  budgetScopes: BudgetScopes;
  externalAgentRunner?: ExternalAgentRunner;
  /** Wall clock for durations; the system clock when absent. */
  clock?: Clock;
  /** Environment reads (memory recall config, provider credentials). */
  env?: Env;
  /** Provider HTTP transport; the platform `fetch` when absent. */
  http?: HttpTransport;
  /**
   * Test seam for the events-table spend rollup that seeds the session/daily
   * envelopes; the default reads the store's spend rollup (fetchSpendBaselines).
   */
  fetchSpendBaselines?: (sessionId: string) => Promise<SpendBaselines>;
  /**
   * Context-overflow recovery hook (the compressor seam). When a provider
   * call length-stops and classifies as context overflow, the loop consults
   * this before failing: a returned plan buys exactly one retry with the
   * plan's transcript; absent/null — or a retry that still overflows — fails
   * the turn with ContextWindowOverflowError. Never loops.
   */
  recoverContextOverflow?: ContextOverflowRecoverer;
}
