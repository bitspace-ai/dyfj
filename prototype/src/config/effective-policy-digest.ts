/**
 * The effective policy digest: `sha256:<hex>` over the UTF-8 bytes of
 * `dyfj-effective-policy/v1`, a NUL byte, and the canonical JSON of the policy
 * without its own `identity.digest`. A Rust helper must match it byte for
 * byte; `testing/fixtures/effective-policy` pins both to one test vector.
 *
 * Canonical JSON: no whitespace; object keys sorted recursively by their UTF-8
 * bytes; keys whose value is `undefined` left out; integers only (spend is
 * integer micro-USD, so float formatting never reaches a digest); `null` kept,
 * because it means "not requested" or "unbounded". Every array is treated as
 * a set: its elements are canonicalized first, then sorted by the UTF-8 bytes
 * of each element's canonical JSON, so composition order never reaches the
 * digest. Duplicates are kept here; `parseEffectivePolicy` refuses them, so a
 * parsed policy's arrays are sets.
 *
 * This module is pure: it opens no file and reads no clock, environment or
 * randomness. It takes the policy as plain data and imports nothing from the
 * policy type, so the type module can use it to stamp a composed policy.
 */

import { createHash } from "node:crypto";

/** The domain prefix: it separates this digest from any other sha256 use. */
const DOMAIN_PREFIX = "dyfj-effective-policy/v1\0";

const DIGEST_SHAPE = /^sha256:[0-9a-f]{64}$/;

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function canonicalize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new Error(
          `effective policy: ${path} must be an integer (got a non-integer number)`,
        );
      }
      return String(value);
    case "object": {
      if (Array.isArray(value)) {
        // An explicit index walk: `map` would skip a hole, and a sparse
        // array would then hash like a shorter one.
        const elements: string[] = [];
        for (let index = 0; index < value.length; index++) {
          if (!(index in value)) {
            throw new Error(`effective policy: ${path}[${index}] is missing`);
          }
          elements.push(canonicalize(value[index], `${path}[${index}]`));
        }
        elements.sort(compareBytes);
        return `[${elements.join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const members = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort(compareBytes)
        .map((key) =>
          `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`)}`
        );
      return `{${members.join(",")}}`;
    }
    default:
      throw new Error(
        `effective policy: ${path} is not JSON data (${typeof value})`,
      );
  }
}

/** `policy` without `identity.digest`, as a shallow-copied plain value. */
function withoutDigest(policy: unknown): unknown {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    return policy;
  }
  const record = policy as Record<string, unknown>;
  const identity = record["identity"];
  if (
    identity === null || typeof identity !== "object" || Array.isArray(identity)
  ) {
    return policy;
  }
  const { digest: _digest, ...rest } = identity as Record<string, unknown>;
  return { ...record, identity: rest };
}

/** The canonical JSON of `policy`, without its own digest. */
export function canonicalPolicyJson(policy: unknown): string {
  return canonicalize(withoutDigest(policy), "policy");
}

/** `sha256:<hex>` of `policy`, ignoring any digest it already carries. */
export function policyDigest(policy: unknown): string {
  const hash = createHash("sha256");
  hash.update(DOMAIN_PREFIX + canonicalPolicyJson(policy), "utf8");
  return `sha256:${hash.digest("hex")}`;
}

/**
 * True when `policy.identity.digest` is the digest of the rest of the policy.
 * A digest of the wrong shape, or a policy that cannot be hashed, is false;
 * this never throws.
 */
export function verifyDigest(
  policy: { readonly identity: { readonly digest: string } },
): boolean {
  try {
    const claimed = policy.identity.digest;
    return typeof claimed === "string" && DIGEST_SHAPE.test(claimed) &&
      claimed === policyDigest(policy);
  } catch {
    return false;
  }
}
