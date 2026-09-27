/**
 * Runtime contract: the plain-data half of a runtime turn.
 *
 * What a turn request carries, how its caller was authenticated, the lifecycle
 * events it emits, and the paid-escalation verdict. The engine's own runtime
 * input (`workbench.ts`) extends `WorkbenchRuntimeRequest` with the in-process
 * hooks and ports it needs (callbacks, tool registries, budget handlers);
 * those stay out of this module, because every type here must survive a
 * process seam as JSON (specs/01-architecture.md §10).
 */

import type {
  ExternalAgentTurnReceipt,
  HistoryOmissionProjection,
  SupersedingRetryStartedEvent,
  TurnAbortedEvent,
  UnparsedToolCallMarkupDetectedEvent,
} from "./turn.ts";

/** Which kind of turn the runtime runs. */
export type WorkbenchRuntimeMode = "ask" | "next-work" | "turn";

/** Explicit external-loop selection: run the turn through an ACP agent. */
export interface AcpRunnerSelection {
  kind: "acp";
  profile: "fixture" | "codex-chatgpt";
}

/**
 * How the caller of a runtime turn was identified and why the call was
 * permitted. Populated by transport layers (HTTP bearer auth); absent for
 * direct CLI invocation, which is authenticated by the local OS session.
 */
export interface WorkbenchAuthContext {
  transport: "loopback" | "remote";
  authnStatus: "authenticated" | "unauthenticated";
  authnMechanism: "local_user" | "api_key";
  authnIssuerRef: string;
  authzBasis: string;
}

/**
 * The plain-data fields of a runtime turn that every runner reads. Runners
 * extend this with the in-process hooks they consume; none of those hooks
 * belong here.
 */
export interface WorkbenchRuntimeRequest {
  mode: WorkbenchRuntimeMode;
  prompt: string;
  /** Explicit external-loop selection. When absent, the runtime selects native execution or ACP based on model routing. */
  runner?: AcpRunnerSelection;
  turnId?: string;
  authContext?: WorkbenchAuthContext;
  /**
   * Client-requested workspace root for the read-only file tools (e.g. the
   * directory the `dyfj` CLI was invoked in). Honored only for a loopback
   * operator — see workspaceRootForTransport. Absent => the server default
   * (DYFJ_ROOT or the server's cwd).
   */
  workspaceRoot?: string;
  /**
   * Standing operator elevation of the workspace's AGENTS.md into the
   * system prompt (engine config, default off; loopback only — resolved at
   * the transport boundary). Without it, no workspace instructions are
   * loaded or injected at all: selecting a workspace is not a trust
   * decision, setting this posture is.
   */
  trustWorkspaceInstructions?: boolean;
  /**
   * Resume an existing session: events append to this id and the session
   * row is updated rather than created. Omit for a fresh session.
   */
  sessionId?: string;
  /** Immutable-event omission facts computed by the resume projection. */
  historyOmission?: HistoryOmissionProjection;
  /**
   * Last runner-reported external session id recorded for this Workbench
   * session, assembled by the caller from prior events. Continuity evidence
   * only: it identifies the native session a replacement turn succeeds, and
   * never grants access to it.
   */
  priorExternalSessionId?: string;
  /**
   * Principal identity recorded on this turn's events. Lifted to the boundary
   * : entrypoints resolve it from DYFJ_PRINCIPAL_ID / USER via
   * resolveRuntimeEnvDefaults(); the core reads only this field (default
   * "user"), never the environment. A headless driver supplies its own.
   */
  principalId?: string;
  /**
   * Server/workspace root the read-only file tools fall back to when no loopback
   * workspace is bound. Lifted to the boundary: entrypoints pass
   * DYFJ_ROOT; the core falls back to Deno.cwd() when this is absent.
   */
  rootOverride?: string;
}

/**
 * Decide whether to honor a client-requested workspace root for the read-only
 * file tools. Only a loopback operator — who already has full local file access,
 * since the server runs as them — may steer the root to their own working
 * directory. A remote or shared consumer (even with the bearer key) is pinned to
 * the server default, so a crafted `workspace` can never aim the file tools at
 * arbitrary host paths. Returns the requested root for a loopback caller (or
 * undefined when none was sent), and undefined for any non-loopback transport.
 */
export function workspaceRootForTransport(
  requested: string | undefined,
  transport: WorkbenchAuthContext["transport"],
): string | undefined {
  return transport === "loopback" ? requested : undefined;
}

/**
 * Verdict returned by a paid-inference consent handler. A structured
 * value, not a throw, so a driver can express the third state — escalate — that
 * void/throw could not: the driver can't decide and an out-of-band operator
 * must. `approve` proceeds; `deny` and `escalate` both stop the turn.
 */
export type PaidEscalationVerdict =
  | { decision: "approve" }
  | { decision: "deny"; reason?: string }
  | { decision: "escalate"; reason?: string };

export type LengthStopClassification =
  | "output_budget_exhausted"
  | "context_overflow";

export type LengthRecoveryOutcome =
  | "recovered"
  | "still_truncated"
  | "retry_refused_budget"
  /** The adapter cannot run a transcript retry (modelSupportsTranscriptRetry). */
  | "retry_unsupported"
  /**
   * Both the output cap and the context window bound this stop: the
   * continuation (original transcript + partial answer + nudge) no longer fits
   * the window, so retrying would be a doomed over-window call. The capped
   * partial is delivered instead. Upgrade site for a future compressor:
   * compress-then-continue when both limits bind.
   */
  | "retry_would_overflow"
  /** The recovery hook or the retry call threw; the error surfaces after this. */
  | "retry_errored"
  | "overflow_failed";

export type WorkbenchRuntimeEvent =
  | { type: "sessionStart"; sessionId: string; traceId: string; mode: string }
  | { type: "inputReceived"; sessionId: string; promptLength: number }
  | {
    type: "contextBuilt";
    sessionId: string;
    sourceCount: number;
    profile?: unknown;
  }
  | {
    type: "modelSelected";
    sessionId: string;
    modelSlug: string;
    tier: 0 | 1 | 2;
    reason: string;
  }
  | {
    type: "beforeProviderRequest";
    sessionId: string;
    modelSlug: string;
    estimatedInputCount: number;
  }
  | {
    type: "afterProviderResponse";
    sessionId: string;
    modelSlug: string;
    inputCount: number;
    outputCount: number;
    totalMs?: number;
  }
  | {
    type: "toolStepStarted";
    sessionId: string;
    step: number;
    toolCallCount: number;
  }
  | {
    /** The configured tool-step limit was reached; a no-tools conclusion is attempted next. */
    type: "toolStepLimitReached";
    sessionId: string;
    maxSteps: number;
  }
  | {
    type: "toolCallStarted";
    sessionId: string;
    commandId: string;
    callId: string;
  }
  | {
    type: "toolCallCompleted";
    sessionId: string;
    commandId: string;
    callId: string;
    isError: boolean;
    durationMs: number;
    errorName?: string;
    errorMessage?: string;
  }
  | {
    /** Bounded, content-free protocol evidence for one external recall connection. */
    type: "memoryRecallNegotiated";
    sessionId: string;
    era: "modern" | "legacy";
    revision: string;
    server?: { name: string; version: string };
    extensions: string[];
  }
  | {
    /**
     * A provider call stopped with stopReason "length", classified from the
     * catalog limits + reported usage. severity is "warn" for output-budget
     * exhaustion (a bounded retry follows) and "error" for context overflow
     * (the turn is about to fail unless a recovery hook supplies a plan).
     */
    type: "lengthStopDetected";
    sessionId: string;
    modelSlug: string;
    classification: LengthStopClassification;
    severity: "warn" | "error";
    inputTokens: number;
    outputTokens: number;
    contextWindow?: number;
    maxOutputTokens?: number;
  }
  /**
   * A superseding retry is starting: everything streamed for this turn so far
   * is stale and the retry's answer replaces it. Shape pinned in the wire
   * contract (turn.ts) because streaming clients must act on it —
   * reset the rendered buffer — not merely display it.
   */
  | SupersedingRetryStartedEvent
  | TurnAbortedEvent
  | UnparsedToolCallMarkupDetectedEvent
  | {
    /** Terminal outcome of length recovery for one provider call. */
    type: "lengthRecoveryFinished";
    sessionId: string;
    modelSlug: string;
    outcome: LengthRecoveryOutcome;
    retriesUsed: number;
  }
  | {
    /**
     * Elder conversation turns were compressed into a named-section summary
     * (proactively at ~50% of the window, or reactively on overflow recovery).
     * Surfaced so compression is never invisible context surgery.
     */
    type: "contextCompressed";
    sessionId: string;
    compressorModelSlug: string;
    trigger: "proactive" | "context_overflow";
    turnsCompressed: number;
    tokensBeforeEstimate: number;
    tokensAfterEstimate: number;
  }
  | { type: "turnCompleted"; sessionId: string; traceId: string }
  | {
    type: "turnFailed";
    sessionId: string;
    traceId: string;
    errorName?: string;
    errorMessage: string;
  }
  | {
    /**
     * Ephemeral ACP reasoning/tool status for the interactive spinner.
     * Thought activity never carries raw model text. Not written to
     * durable session history.
     */
    type: "agentProgress";
    sessionId: string;
    kind: "thought" | "tool_call";
    title?: string;
    name?: string;
    status?: string;
  };

export type ExternalAgentWorkbenchRuntimeResult = ExternalAgentTurnReceipt;
