/**
 * The provider errors that cross the wire as trusted `DomainError`s, and the
 * field bounding every one of them applies to registry-sourced values.
 */
import { sanitizeBoundaryText } from "../kernel/mod.ts";
import { DomainError, summarizeError } from "../contract/mod.ts";

// DomainError messages are trusted up to MAX_ERROR_SUMMARY_BYTES by
// summarizeError, so every nonliteral field interpolated into one must be
// bounded and inert at construction. Model slugs, env-var names, and base
// URLs all originate in registry/config data — operator-authored in the
// normal case, but "operator-authored" is not "safe to relay": a registry
// row can carry an oversized identifier, control characters, or a
// credential-bearing URL, and none of that may ride a trusted message onto
// the wire, into runtime events, or into durable error rows.
const MAX_ERROR_FIELD_BYTES = 120;

function errorField(raw: string): string {
  return sanitizeBoundaryText(raw, MAX_ERROR_FIELD_BYTES);
}

/**
 * Describe a URL for an error message without relaying its sensitive parts:
 * scheme + host only — userinfo (credentials), path, query, and fragment are
 * all dropped structurally rather than pattern-matched. An unparseable value
 * yields a fixed placeholder, never the raw string.
 */
function errorUrlField(raw: string): string {
  try {
    const url = new URL(raw);
    return errorField(`${url.protocol}//${url.host}`);
  } catch {
    return "<unparseable url>";
  }
}

export class WorkbenchModelNotFoundError extends DomainError {
  constructor(public readonly slug: string) {
    super(`Model not found: ${errorField(slug)}`);
    this.name = "WorkbenchModelNotFoundError";
  }
}

export class WorkbenchModelFastSpeedUnsupportedError extends DomainError {
  constructor(public readonly slug: string) {
    super(`Model "${errorField(slug)}" does not support fast speed tier`);
    this.name = "WorkbenchModelFastSpeedUnsupportedError";
  }
}

export class HostedInferenceRequiresProviderError extends DomainError {
  constructor(public readonly slug: string) {
    super(`Unsupported hosted inference provider: ${errorField(slug)}`);
    this.name = "HostedInferenceRequiresProviderError";
  }
}

export class HostedProviderCredentialMissingError extends DomainError {
  constructor(public readonly slug: string, public readonly envVar: string) {
    super(
      `Hosted provider credential missing for ${errorField(slug)}: ` +
        `${errorField(envVar)} is not in the runtime's environment. ` +
        `Secrets resolve only at start: fix what \`dyfj status\` reports ` +
        `for it, or set it or declare it under [secrets], then restart the ` +
        `runtime (\`dyfj stop\`, then start it).`,
    );
    this.name = "HostedProviderCredentialMissingError";
  }
}

export class WorkbenchHostedProviderBaseUrlError extends DomainError {
  constructor(public readonly slug: string, public readonly baseUrl: string) {
    super(
      `Hosted provider baseUrl is not the provider's https endpoint for ` +
        `${errorField(slug)}: ${errorUrlField(baseUrl)}`,
    );
    this.name = "WorkbenchHostedProviderBaseUrlError";
  }
}

export class WorkbenchLocalProviderBaseUrlError extends DomainError {
  constructor(public readonly slug: string, public readonly baseUrl: string) {
    super(
      `Local provider baseUrl is not loopback-only for ${errorField(slug)}`,
    );
    this.name = "WorkbenchLocalProviderBaseUrlError";
  }
}

export class WorkbenchModelNotRoutableError extends DomainError {
  constructor(public readonly ref: string) {
    super(
      `Model not routable [${errorField(ref)}]: no catalog pricing row. ` +
        `Paid spend cannot be estimated, recorded, or bounded without prices; ` +
        `set cost_input and cost_output on the models row to route it.`,
    );
    this.name = "WorkbenchModelNotRoutableError";
  }
}

/** The provider and model a request was addressed to. */
export interface ProviderTarget {
  provider: string;
  slug: string;
}

/** The classes the adapters sort a provider's failures into. */
export type ProviderFailureKind =
  | "context_exceeded"
  | "authentication"
  | "rate_limited"
  | "model_not_found"
  | "unreachable"
  | "redirected"
  | "request_too_large"
  | "unclassified";

/**
 * A provider request that failed, classified at the adapter. Every subclass
 * writes its own message from fixed literals, the bounded target and the
 * HTTP status: provider text is foreign input and never rides one. The
 * message ends with the recovery hint, so the operator line, the
 * `turnFailed` frame and the durable `error` event all say what to do next.
 */
export abstract class ProviderFailureError extends DomainError {
  readonly provider: string;
  readonly slug: string;
  constructor(
    readonly kind: ProviderFailureKind,
    target: ProviderTarget,
    /** The HTTP status the provider answered with; none when it never did. */
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.provider = target.provider;
    this.slug = target.slug;
  }
}

/** `provider/slug`, each bounded, for a message. */
function targetField(target: ProviderTarget): string {
  return `${errorField(target.provider)}/${errorField(target.slug)}`;
}

/**
 * The provider rejected the request as larger than the model's context
 * window (llama-server's HTTP 400 "exceeds the available context size",
 * OpenAI's `context_length_exceeded`, Anthropic's "prompt is too long",
 * Gemini's "input token count … exceeds"). The engine treats it as context
 * overflow and refits the request; a generic provider error would end the
 * turn. The message carries only the counts the provider stated, never its
 * body.
 */
export class ProviderContextExceededError extends ProviderFailureError {
  constructor(
    target: ProviderTarget,
    status: number,
    public readonly report: { requestedTokens?: number; limitTokens?: number },
  ) {
    const counts = report.requestedTokens !== undefined &&
        report.limitTokens !== undefined
      ? `; the request was ${report.requestedTokens} tokens against a ` +
        `${report.limitTokens}-token window`
      : report.limitTokens !== undefined
      ? `; the window is ${report.limitTokens} tokens`
      : report.requestedTokens !== undefined
      ? `; the request was ${report.requestedTokens} tokens`
      : "";
    super(
      "context_exceeded",
      target,
      status,
      `Context exceeded for ${targetField(target)}: the provider rejected ` +
        `the request as larger than its context window (HTTP ${status}` +
        `${counts}). Use a model with a larger context window, or start a ` +
        `new session.`,
    );
    this.name = "ProviderContextExceededError";
  }
}

/**
 * The provider refused the request's credential, or (HTTP 403) accepted it
 * but denied access to the model or operation. The two have different ways
 * out: a rejected key is fixed in the runtime's environment, denied access
 * at the provider's account or by choosing another model.
 */
export class ProviderAuthenticationError extends ProviderFailureError {
  constructor(target: ProviderTarget, status: number) {
    super(
      "authentication",
      target,
      status,
      status === 403
        ? `Access denied by ${errorField(target.provider)} for ` +
          `${errorField(target.slug)} (HTTP 403): the credential was ` +
          `accepted but is not allowed to use this model or operation. ` +
          `Check the account's access at the provider, or pick another ` +
          `model with /model.`
        : `Authentication failed for ${targetField(target)}: the provider ` +
          `rejected the request's credential (HTTP ${status}). Check the ` +
          `key the runtime holds for this provider (\`dyfj status\` names ` +
          `it), then restart the runtime (\`dyfj stop\`, then start it).`,
    );
    this.name = "ProviderAuthenticationError";
  }
}

/** Why the provider is refusing to serve the request right now. */
export type ProviderRateLimitReason = "rate_limit" | "quota" | "overloaded";

/** The provider is throttling, out of quota, or overloaded. */
export class ProviderRateLimitedError extends ProviderFailureError {
  constructor(
    target: ProviderTarget,
    status: number,
    public readonly reason: ProviderRateLimitReason,
  ) {
    const condition = reason === "quota"
      ? `Quota exhausted at ${errorField(target.provider)} for ` +
        `${errorField(target.slug)} (HTTP ${status}): the provider reports ` +
        `no remaining quota or credit. Add credit at the provider`
      : reason === "overloaded"
      ? `${errorField(target.provider)} is overloaded for ` +
        `${errorField(target.slug)} (HTTP ${status}). Wait a moment and ` +
        `send the turn again`
      : `Rate limited by ${errorField(target.provider)} for ` +
        `${errorField(target.slug)} (HTTP ${status}). Wait a moment and ` +
        `send the turn again`;
    super(
      "rate_limited",
      target,
      status,
      `${condition}, or switch to another model with /model.`,
    );
    this.name = "ProviderRateLimitedError";
  }
}

/** The provider does not serve the model the registry row names. */
export class ProviderModelNotFoundError extends ProviderFailureError {
  constructor(target: ProviderTarget, status: number) {
    super(
      "model_not_found",
      target,
      status,
      `Model not found at ${errorField(target.provider)}: it does not ` +
        `serve ${errorField(target.slug)} (HTTP ${status}). Check the model ` +
        `id on its registry row and the provider's base URL, or pick ` +
        `another model with /model.`,
    );
    this.name = "ProviderModelNotFoundError";
  }
}

/** How the connection to the provider failed. */
export type ProviderUnreachableReason =
  | "refused"
  | "dns"
  | "network"
  | "timeout";

/**
 * No response arrived: the connection was refused, the host did not
 * resolve, the network failed, or the header deadline passed in silence.
 */
export class ProviderUnreachableError extends ProviderFailureError {
  constructor(
    target: ProviderTarget,
    public readonly reason: ProviderUnreachableReason,
    budget?: { timeoutMs: number; mode: "streaming" | "buffered" },
  ) {
    const field = targetField(target);
    super(
      "unreachable",
      target,
      undefined,
      reason === "refused"
        ? `Provider unreachable: ${errorField(target.provider)} refused the ` +
          `connection for ${errorField(target.slug)}. Check that the server ` +
          `is running at the registry's base URL.`
        : reason === "dns"
        ? `Provider unreachable: the host for ${field} could not be ` +
          `resolved. Check the registry's base URL and the network.`
        : reason === "timeout"
        ? `Provider unreachable or stalled: ${field} sent no response ` +
          `headers within ${budget?.timeoutMs ?? 0}ms (${
            budget?.mode ?? "streaming"
          } request exceeded its budget). Check that the server is running ` +
          `and responsive at the registry's base URL.`
        : `Provider unreachable: the connection to ${field} failed. Check ` +
          `the network and the registry's base URL.`,
    );
    this.name = "ProviderUnreachableError";
  }
}

/**
 * The provider answered with a redirect, which no adapter follows: only
 * the validated base URL may receive the request body.
 */
export class ProviderRedirectedError extends ProviderFailureError {
  constructor(target: ProviderTarget) {
    super(
      "redirected",
      target,
      undefined,
      `Provider request refused for ${targetField(target)}: the provider ` +
        `answered with a redirect, which Workbench does not follow (the ` +
        `request goes only to the validated base URL). Check the ` +
        `registry's base URL.`,
    );
    this.name = "ProviderRedirectedError";
  }
}

/** The provider refused the request by its byte size, not its token count. */
export class ProviderRequestTooLargeError extends ProviderFailureError {
  constructor(target: ProviderTarget, status: number) {
    super(
      "request_too_large",
      target,
      status,
      `Request too large for ${targetField(target)}: the provider refused ` +
        `the request by its size (HTTP ${status}), not by token count. ` +
        `Shorten the prompt or the tool results it carries, or start a new ` +
        `session.`,
    );
    this.name = "ProviderRequestTooLargeError";
  }
}

/**
 * A failure the classifier does not recognise. The message keeps today's
 * opaque treatment of the foreign part (a byte count for a response body,
 * the `summarizeError` label for a transport throw) and adds what is not
 * foreign: the provider, the model and the HTTP status.
 */
export class ProviderRequestFailedError extends ProviderFailureError {
  constructor(
    target: ProviderTarget,
    failure: { status: number; bodyBytes: number } | { cause: unknown },
  ) {
    const field = targetField(target);
    super(
      "unclassified",
      target,
      "status" in failure ? failure.status : undefined,
      "status" in failure
        ? `Provider request failed for ${field}: HTTP ${failure.status} ` +
          `(response body withheld, ${failure.bodyBytes} bytes). The ` +
          `provider's own log has the body.`
        : `Provider request failed for ${field}: no response ` +
          `(${summarizeError(failure.cause)}). The provider's own log may ` +
          `say why.`,
    );
    this.name = "ProviderRequestFailedError";
  }
}
