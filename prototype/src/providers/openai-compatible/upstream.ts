/**
 * The provider's own account of who answered: which upstream served the call,
 * and the provider's generation id for it.
 *
 * An aggregator routes one request to any of several upstreams, and its
 * `provider` column in the catalog names only the aggregator. Prompt caches
 * live behind a single upstream, so a call routed elsewhere reads nothing from
 * the cache it should have hit. That makes "which upstream answered" the
 * question an operator asks when a cheap turn suddenly costs full input price.
 *
 * Both values are provider-supplied text and neither is trusted: each is read
 * only when it really is a string, then bounded and stripped of control
 * characters before it can reach an event row. A value that is absent, empty,
 * or of another type is recorded as absent rather than as a placeholder.
 */
import { sanitizeBoundaryText } from "../../kernel/mod.ts";
import type { ProviderUpstreamEvidence } from "../types.ts";

export type { ProviderUpstreamEvidence };

/** `events.upstream_provider` is `VARCHAR(64)`; bound to its UTF-8 bytes. */
export const MAX_UPSTREAM_PROVIDER_BYTES = 64;
/** `events.provider_generation_id` is `VARCHAR(128)`. */
export const MAX_PROVIDER_GENERATION_ID_BYTES = 128;

/**
 * Read one provider-supplied identifier: a string only, sanitized and bounded,
 * or `undefined` when it is absent, not a string, or sanitizes to nothing.
 */
export function readUpstreamIdentifier(
  value: unknown,
  maxBytes: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = sanitizeBoundaryText(value, maxBytes);
  return sanitized.length > 0 ? sanitized : undefined;
}

/**
 * The evidence a response or one stream frame carries. An absent field is
 * omitted, so a frame that says nothing does not erase what an earlier frame
 * said — the streaming reader keeps the first value it sees.
 */
export function readUpstreamEvidence(frame: {
  id?: unknown;
  provider?: unknown;
}): ProviderUpstreamEvidence {
  const upstreamProvider = readUpstreamIdentifier(
    frame.provider,
    MAX_UPSTREAM_PROVIDER_BYTES,
  );
  const providerGenerationId = readUpstreamIdentifier(
    frame.id,
    MAX_PROVIDER_GENERATION_ID_BYTES,
  );
  return {
    ...(upstreamProvider === undefined ? {} : { upstreamProvider }),
    ...(providerGenerationId === undefined ? {} : { providerGenerationId }),
  };
}

/**
 * Fold a later observation into the evidence seen so far, keeping the first
 * value for each field. Streaming providers repeat the identity on frames; the
 * first one that reported it is the one that answered.
 */
export function mergeUpstreamEvidence(
  previous: ProviderUpstreamEvidence | undefined,
  incoming: ProviderUpstreamEvidence | undefined,
): ProviderUpstreamEvidence | undefined {
  const upstreamProvider = previous?.upstreamProvider ??
    incoming?.upstreamProvider;
  const providerGenerationId = previous?.providerGenerationId ??
    incoming?.providerGenerationId;
  return upstreamProvider === undefined && providerGenerationId === undefined
    ? undefined
    : {
      ...(upstreamProvider === undefined ? {} : { upstreamProvider }),
      ...(providerGenerationId === undefined ? {} : { providerGenerationId }),
    };
}
