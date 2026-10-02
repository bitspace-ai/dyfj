/**
 * The provider errors that cross the wire as trusted `DomainError`s, and the
 * field bounding every one of them applies to registry-sourced values.
 */
import { sanitizeBoundaryText } from "../kernel/mod.ts";
import { DomainError } from "../contract/mod.ts";

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
