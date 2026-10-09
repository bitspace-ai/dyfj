/**
 * The engine's error vocabulary: the domain errors the engine itself raises,
 * and `classifyErrorKind`, which labels any error with a fixed class-name
 * literal for event rows and console diagnostics without reading a string off
 * the error.
 */
import { sanitizeBoundaryText } from "../kernel/mod.ts";
import {
  DomainError,
  MAX_REASON_FIELD_BYTES,
  type PaidEscalationVerdict,
} from "../contract/mod.ts";
import {
  BudgetCeilingDeclinedError,
  BudgetExceededError,
  RunawayAnomalyHaltError,
} from "../budget/mod.ts";
import { ContextWindowOverflowError } from "../context/mod.ts";
import {
  HostedInferenceRequiresProviderError,
  HostedProviderCredentialMissingError,
  ProviderAuthenticationError,
  ProviderContextExceededError,
  ProviderModelNotFoundError,
  ProviderRateLimitedError,
  ProviderRedirectedError,
  ProviderRequestFailedError,
  ProviderRequestTooLargeError,
  ProviderUnreachableError,
  WorkbenchHostedProviderBaseUrlError,
  WorkbenchLocalProviderBaseUrlError,
  WorkbenchModelFastSpeedUnsupportedError,
  WorkbenchModelNotFoundError,
  WorkbenchModelNotRoutableError,
} from "../providers/mod.ts";
import { RpcError } from "../transport/mod.ts";

export class PaidEscalationDeclinedError extends DomainError {
  readonly verdict: Exclude<PaidEscalationVerdict, { decision: "approve" }>;
  // verdict.reason comes from the injected confirmPaidEscalation callback —
  // the turn runner's loopback posture today, potentially a remote approval
  // peer tomorrow. DomainError certifies the message THIS constructor builds,
  // not that field's content, so it's capped and control-char-stripped before it
  // reaches either the message or the stored `.verdict` (read directly by
  // the native runner's log branch, not just via .message).
  constructor(
    verdict: Exclude<PaidEscalationVerdict, { decision: "approve" }>,
  ) {
    const safeReason = verdict.reason === undefined
      ? undefined
      : sanitizeBoundaryText(verdict.reason, MAX_REASON_FIELD_BYTES);
    super(
      verdict.decision === "escalate"
        ? `Paid inference escalation required${
          safeReason ? `: ${safeReason}` : ""
        }`
        : `Paid inference consent declined${
          safeReason ? `: ${safeReason}` : ""
        }`,
    );
    this.verdict = { ...verdict, reason: safeReason };
    this.name = "PaidEscalationDeclinedError";
  }
}

/**
 * A resumed turn named no model, and the model its session last routed to
 * can no longer be routed: it left the catalog, was deactivated, or lost its
 * pricing. The turn refuses rather than falling back to the configured
 * default, whose window the session's history may not fit.
 */
export class SessionModelUnavailableError extends DomainError {
  constructor(
    public readonly slug: string,
    public readonly why: "not in the catalog" | "unpriced",
  ) {
    const safeSlug = sanitizeBoundaryText(slug, MAX_REASON_FIELD_BYTES);
    super(
      `This session last ran on "${safeSlug}", which is no longer routable ` +
        `(${why}); name a model to resume it on`,
    );
    this.slug = safeSlug;
    this.name = "SessionModelUnavailableError";
  }
}

/**
 * The compression event's write was rejected AND the follow-up probe that would
 * say whether the row is nonetheless durable also failed. Neither continuing
 * uncompressed nor adopting the summary is safe under that uncertainty — one
 * risks a resume that applies an event the live turn ignored, the other pins a
 * summary that may never have been stored — so the turn fails instead. Carries
 * only error CLASS names: this path handles a payload containing the summary,
 * and messages can quote it.
 */
export class ContextCompressionPersistenceUncertainError extends DomainError {
  constructor(
    public readonly writeErrorKind: string,
    public readonly probeErrorKind: string,
  ) {
    super(
      "Context compression persistence is uncertain: the event write failed " +
        `(${writeErrorKind}) and the durability probe also failed ` +
        `(${probeErrorKind}); failing the turn rather than risking a live ` +
        "transcript that diverges from resume",
    );
    this.name = "ContextCompressionPersistenceUncertainError";
  }
}

/** A capped tool loop's no-tools conclusion failed before completion. */
export class ToolStepLimitConclusionError extends DomainError {
  constructor() {
    super(
      "The no-tools conclusion after the tool-step limit could not be completed.",
    );
    this.name = "ToolStepLimitConclusionError";
  }
}

/** The selected workspace could not safely supply request-time repo context. */
export class WorkspaceContextUnavailableError extends DomainError {
  constructor() {
    super(
      "The selected workspace is unavailable; repository context was not loaded.",
    );
    this.name = "WorkspaceContextUnavailableError";
  }
}

// Every DomainError subclass this codebase defines, paired with a fixed
// string literal — one WE wrote, never one read off an instance — that
// classifyErrorKind returns for it. `instanceof DomainError` alone is not
// enough to safely read `.constructor.name`: instanceof walks the prototype
// chain, but `.constructor` is an ordinary, independently-writable property
// — a real DomainError subclass instance with `.constructor` reassigned
// (`Object.defineProperty(e, "constructor", { value: { name: "..." } })`)
// still passes `instanceof DomainError` and then yields the shadowed name.
// So no branch anywhere in classifyErrorKind reads a string off the
// candidate; every returned value is a literal, selected purely by which
// instanceof check matched. Extend this table when a new DomainError
// subclass is added — an unlisted one still classifies safely, to the
// generic "DomainError" literal below, just without per-class fidelity.
const KNOWN_DOMAIN_ERROR_CLASSES: ReadonlyArray<
  // deno-lint-ignore no-explicit-any
  readonly [new (...args: any[]) => DomainError, string]
> = [
  [BudgetExceededError, "BudgetExceededError"],
  [BudgetCeilingDeclinedError, "BudgetCeilingDeclinedError"],
  [RunawayAnomalyHaltError, "RunawayAnomalyHaltError"],
  [ContextWindowOverflowError, "ContextWindowOverflowError"],
  [PaidEscalationDeclinedError, "PaidEscalationDeclinedError"],
  [SessionModelUnavailableError, "SessionModelUnavailableError"],
  [
    ContextCompressionPersistenceUncertainError,
    "ContextCompressionPersistenceUncertainError",
  ],
  [ToolStepLimitConclusionError, "ToolStepLimitConclusionError"],
  [WorkspaceContextUnavailableError, "WorkspaceContextUnavailableError"],
  [RpcError, "RpcError"],
  [WorkbenchModelNotFoundError, "WorkbenchModelNotFoundError"],
  [
    HostedInferenceRequiresProviderError,
    "HostedInferenceRequiresProviderError",
  ],
  [
    HostedProviderCredentialMissingError,
    "HostedProviderCredentialMissingError",
  ],
  [WorkbenchHostedProviderBaseUrlError, "WorkbenchHostedProviderBaseUrlError"],
  [WorkbenchLocalProviderBaseUrlError, "WorkbenchLocalProviderBaseUrlError"],
  [
    WorkbenchModelFastSpeedUnsupportedError,
    "WorkbenchModelFastSpeedUnsupportedError",
  ],
  [WorkbenchModelNotRoutableError, "WorkbenchModelNotRoutableError"],
  [ProviderContextExceededError, "ProviderContextExceededError"],
  [ProviderAuthenticationError, "ProviderAuthenticationError"],
  [ProviderRateLimitedError, "ProviderRateLimitedError"],
  [ProviderModelNotFoundError, "ProviderModelNotFoundError"],
  [ProviderUnreachableError, "ProviderUnreachableError"],
  [ProviderRedirectedError, "ProviderRedirectedError"],
  [ProviderRequestTooLargeError, "ProviderRequestTooLargeError"],
  [ProviderRequestFailedError, "ProviderRequestFailedError"],
];

/**
 * Classify `candidate` for a content-free-by-convention diagnostic string
 * (e.g. ContextCompressionPersistenceUncertainError's writeErrorKind),
 * WITHOUT ever reading a string property off the candidate itself — see
 * KNOWN_DOMAIN_ERROR_CLASSES above for why `.constructor.name` is not safe
 * even behind an `instanceof DomainError` check. Every returned value is a
 * fixed literal this function selects; none is derived from the candidate.
 */
export function classifyErrorKind(candidate: unknown): string {
  for (const [cls, label] of KNOWN_DOMAIN_ERROR_CLASSES) {
    if (candidate instanceof cls) return label;
  }
  if (candidate instanceof DomainError) return "DomainError";
  if (candidate instanceof Error) return "Error";
  return "unknown";
}
