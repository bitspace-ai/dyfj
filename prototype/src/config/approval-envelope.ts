/**
 * The approval envelope (BIT-736): what a contained executor may do without a
 * prompt, derived from its effective policy alone. It adds no list of its own.
 * Hosts, roots and limits all come from the policy. The only constants here
 * are the properties the policy must have for its commands to need no
 * per-call approval: no network, no broker operations, no database, no
 * secrets, and no writable root over the whole filesystem or a forbidden
 * path.
 *
 * Whether the envelope applies is the attestation's business
 * (`tools/builtin/containment.ts`) and the operator's grant, which names the
 * policy's digest. This module is pure: no clock and no I/O.
 */

import { verifyDigest } from "./effective-policy-digest.ts";
import type { EffectivePolicy } from "./effective-policy.ts";

export interface ApprovalEnvelope {
  readonly route: "linux-isolated";
  /** The executor policy's `identity.digest`; a grant must name it. */
  readonly policyDigest: string;
  readonly run: string;
  /** The supervisor instance that attested it; exec requests bind to it. */
  readonly instance: string;
  /** The mount targets a command may write: writable roots and scratch. */
  readonly writable: readonly string[];
  /** The longest command deadline allowed without a prompt, in ms. */
  readonly commandTimeoutMs: number;
  readonly expiresAt: string;
}

export type EnvelopeDerivation =
  | { readonly envelope: ApprovalEnvelope }
  | { readonly refusal: string };

/** `path` is `root` or lies beneath it. */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * The longest command deadline the envelope allows without a prompt, in ms:
 * the tool's default `defaultCommandTimeoutMs`, or the policy's
 * `limits.timeMs` when that is lower.
 */
export function envelopeCommandTimeoutMs(
  policy: EffectivePolicy,
  defaultCommandTimeoutMs: number,
): number {
  const timeMs = policy.effects.limits.timeMs;
  return timeMs === null
    ? defaultCommandTimeoutMs
    : Math.min(timeMs, defaultCommandTimeoutMs);
}

/**
 * The envelope for `policy`, attested by supervisor `instance` at `now`, or
 * why the policy cannot have one. `defaultCommandTimeoutMs` is the tool's own
 * default deadline; the envelope never allows more than that, nor more than
 * the policy's `limits.timeMs` when it sets one.
 */
export function deriveApprovalEnvelope(
  policy: EffectivePolicy,
  instance: string,
  now: Date,
  defaultCommandTimeoutMs: number,
): EnvelopeDerivation {
  if (!verifyDigest(policy)) {
    return { refusal: "the executor policy's digest does not verify" };
  }
  const expires = Date.parse(policy.identity.expiresAt);
  if (!Number.isFinite(expires) || expires <= now.getTime()) {
    return { refusal: "the executor policy has expired" };
  }
  if (
    policy.network.entries.length > 0 ||
    policy.network.brokerOperations.length > 0 ||
    policy.network.dolt !== null
  ) {
    return { refusal: "the executor policy grants network access" };
  }
  if (policy.secrets.length > 0) {
    return { refusal: "the executor policy grants secrets" };
  }
  const writableRoots = policy.filesystem.roots.filter((root) =>
    root.rights.includes("write")
  );
  for (const root of writableRoots) {
    if (root.source === "/" || root.target === "/") {
      return { refusal: "the executor policy makes the whole filesystem writable" };
    }
    if (
      policy.filesystem.forbiddenPaths.some((path) =>
        within(path, root.source) || within(root.source, path)
      )
    ) {
      return { refusal: `the writable root ${root.name} overlaps a forbidden path` };
    }
  }
  return {
    envelope: {
      route: "linux-isolated",
      policyDigest: policy.identity.digest,
      run: policy.identity.run,
      instance,
      writable: [
        ...writableRoots.map((root) => root.target),
        ...(policy.filesystem.scratch === null ? [] : [policy.filesystem.scratch]),
      ],
      commandTimeoutMs: envelopeCommandTimeoutMs(policy, defaultCommandTimeoutMs),
      expiresAt: policy.identity.expiresAt,
    },
  };
}
