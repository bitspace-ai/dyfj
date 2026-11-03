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
  summarizeError,
} from "../contract/mod.ts";
import {
  BudgetCeilingDeclinedError,
  BudgetExceededError,
} from "../budget/mod.ts";
import { ContextWindowOverflowError } from "../context/mod.ts";
import {
  HostedInferenceRequiresProviderError,
  HostedProviderCredentialMissingError,
  ProviderAuthenticationError,
  ProviderContextExceededError,
  ProviderModelNotFoundError,
  ProviderPriceCapRefusedError,
  ProviderRateLimitedError,
  ProviderEgressRefusedError,
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
 * A resumed turn named no model, and the model its session last ran on (its
 * latest completed provider call or model response) can no longer be
 * routed: it left the catalog, was deactivated, or lost its pricing. The turn refuses rather than falling back to the configured
 * default, whose window the session's history may not fit.
 */
export class SessionModelUnavailableError extends DomainError {
  public readonly slug: string;
  public readonly why: "not in the catalog" | "unpriced";
  constructor(slug: string, why: "not in the catalog" | "unpriced") {
    const safeSlug = sanitizeBoundaryText(slug, MAX_REASON_FIELD_BYTES);
    super(
      `This session last ran on "${safeSlug}", which is no longer routable ` +
        `(${why}); name a model to resume it on`,
    );
    this.slug = safeSlug;
    this.why = why;
    this.name = "SessionModelUnavailableError";
  }
}

/**
 * A resumed turn named no model, and its session last ran on an external
 * agent runner, whose own model the log does not record. The turn refuses
 * rather than route the runner's conversation to an older native model.
 */
export class SessionRunnerNotRestorableError extends DomainError {
  public readonly profile: string;
  constructor(profile: string) {
    const safeProfile = sanitizeBoundaryText(profile, MAX_REASON_FIELD_BYTES);
    super(
      `This session last ran on the external agent runner "${safeProfile}", ` +
        `which cannot be resumed automatically; name a model or runner to ` +
        `resume it on`,
    );
    this.profile = safeProfile;
    this.name = "SessionRunnerNotRestorableError";
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
  public readonly writeErrorKind: string;
  public readonly probeErrorKind: string;
  constructor(writeErrorKind: string, probeErrorKind: string) {
    super(
      "Context compression persistence is uncertain: the event write failed " +
        `(${writeErrorKind}) and the durability probe also failed ` +
        `(${probeErrorKind}); failing the turn rather than risking a live ` +
        "transcript that diverges from resume",
    );
    this.writeErrorKind = writeErrorKind;
    this.probeErrorKind = probeErrorKind;
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

/**
 * The step-limit handoff call answered, but its reply was not a handoff: it
 * lacked one of the Done, Next and Uncommitted state labels.
 */
export class StepLimitHandoffIncompleteError extends DomainError {
  constructor() {
    super(
      "The step-limit handoff reply lacked the Done, Next and Uncommitted state labels.",
    );
    this.name = "StepLimitHandoffIncompleteError";
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

/**
 * A turn failed on an error this codebase did not write: a driver's, a
 * dependency's, or a throw of something that is not an Error. Its message
 * never crosses the wire (see `summarizeError`), so the operator is told
 * that it is unclassified, its class and size, and what to do next. The seam
 * that throws this logs `describeErrorForLog` first.
 */
export class UnexpectedTurnError extends DomainError {
  constructor(cause: unknown) {
    super(
      `The turn failed on an unclassified error (${
        summarizeError(cause).replace(/^\[(.*)\]$/, "$1")
      }); its message is withheld. The runtime log records its class, and ` +
        "its code when it has one. Retry the turn; if it fails again, run `dyfj status` to " +
        "check the store and the runtime",
      { cause },
    );
    this.name = "UnexpectedTurnError";
  }
}

/** A short error field (`code`, `errno`, `syscall`) when it is a literal. */
function literalField(error: object, name: string): string | undefined {
  const value = (error as Record<string, unknown>)[name];
  if (typeof value === "string" && /^[A-Za-z0-9_]{1,40}$/.test(value)) {
    return value;
  }
  return typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : undefined;
}

/**
 * A foreign error as the runtime log may carry it: the class label and its
 * `code`, `errno` and `syscall` when they are well-formed literals, then,
 * when `error` is an `Error`, the same for one level of its `cause`. Never
 * its message, which can embed a
 * rejected payload or a credential: the same discipline as `[turn-error]`.
 */
export function describeErrorForLog(error: unknown): string {
  const describe = (candidate: unknown): string => {
    const label = classifyErrorKind(candidate);
    const fields = typeof candidate === "object" && candidate !== null
      ? ["code", "errno", "syscall"].flatMap((name) => {
        const value = literalField(candidate, name);
        return value === undefined ? [] : [`${name}=${value}`];
      })
      : [];
    return fields.length === 0 ? label : `${label} (${fields.join(", ")})`;
  };
  try {
    const cause = error instanceof Error ? error.cause : undefined;
    return cause === undefined
      ? describe(error)
      : `${describe(error)}; cause: ${describe(cause)}`;
  } catch {
    return "unknown";
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
  readonly [new (...args: any[]) => DomainError, string]
> = [
  [BudgetExceededError, "BudgetExceededError"],
  [BudgetCeilingDeclinedError, "BudgetCeilingDeclinedError"],
  [ContextWindowOverflowError, "ContextWindowOverflowError"],
  [PaidEscalationDeclinedError, "PaidEscalationDeclinedError"],
  [SessionModelUnavailableError, "SessionModelUnavailableError"],
  [SessionRunnerNotRestorableError, "SessionRunnerNotRestorableError"],
  [
    ContextCompressionPersistenceUncertainError,
    "ContextCompressionPersistenceUncertainError",
  ],
  [ToolStepLimitConclusionError, "ToolStepLimitConclusionError"],
  [StepLimitHandoffIncompleteError, "StepLimitHandoffIncompleteError"],
  [WorkspaceContextUnavailableError, "WorkspaceContextUnavailableError"],
  [UnexpectedTurnError, "UnexpectedTurnError"],
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
  [ProviderEgressRefusedError, "ProviderEgressRefusedError"],
  [ProviderRequestTooLargeError, "ProviderRequestTooLargeError"],
  [ProviderPriceCapRefusedError, "ProviderPriceCapRefusedError"],
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
