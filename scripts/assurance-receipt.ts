/**
 * `dyfj.assurance.receipt/v1` schema validator.
 *
 * Validates the version-1 assurance evidence envelope fail-closed: unknown
 * decision values, absent required fields, unknown top-level fields, unknown
 * policy ids or versions, check ids or risk classes outside the controlled
 * vocabularies, a `repository.required_checks` receipt whose mandatory
 * check floor is incomplete, duplicated, or not marked required, subject
 * references not bound to the supplied immutable digest (for every subject
 * kind), subject/digest mismatches, non-UTC or non-absolute timestamps,
 * stale or future subject timestamps, negative finding counts, passing
 * decisions with failed, warned, or missing required checks, unconfirmed
 * redaction, unbounded payloads, mutable approval or bypass references,
 * runner identity without a revision, non-canonical model families, families
 * outside the closed family vocabulary, unknown keys inside any nested
 * object, receipts whose canonical serialization is past the aggregate size
 * bound or that exceed the nesting-depth bound, and independence claims
 * unsupported by runner-observed or operator-attested evidence are all
 * rejected.
 *
 * Violations are value-free rule identifiers drawn from a fixed vocabulary
 * defined here. Field content from a candidate receipt is never echoed into
 * a violation, so a hostile receipt cannot smuggle payloads through the
 * validator's diagnostics.
 *
 * This module is deliberately pure (no filesystem, no subprocess, no
 * environment) so the same validator can serve public CI and local tooling.
 */

export const RECEIPT_SCHEMA = "dyfj.assurance.receipt";
export const RECEIPT_VERSION = 1;

export const DECISIONS = [
  "allow",
  "warn",
  "needs-approval",
  "block",
  "bypass",
  "degraded",
  "unknown",
] as const;
export type Decision = (typeof DECISIONS)[number];

// The stable W0C pipeline policy set at version 1. Unknown policy ids and
// any policy version other than 1 are rejected outright; no future
// semantics are invented here. The reserved product-runtime authorization
// policy is deliberately absent: this envelope carries development-pipeline
// assurance evidence and never grants product runtime authority.
export const POLICY_IDS = [
  "assurance.subject_integrity",
  "repository.required_checks",
  "repository.diff_hygiene",
  "secret.stdout_discipline",
  "corpus.public_boundary",
  "command.risk",
  "dependency.minimum_release_age",
  "evidence.value_free",
  "review.independence",
  "publication.release",
] as const;

// The controlled value-free check-id vocabulary. Every check entry id must
// come from this set, and a `repository.required_checks` receipt must
// account for the full set: each id exactly once across
// executed/skipped/unavailable/failed, marked required.
export const MANDATORY_CHECK_IDS = [
  "subject.resolve",
  "subject.digest",
  "test.aggregate",
  "secret.tree",
  "secret.diff",
  "public.boundary",
  "diff.whitespace",
  "markdown.links",
  "shell.parse",
  "dependency.policy",
  "receipt.schema",
] as const;

// The controlled value-free risk-class vocabulary. Arbitrary strings are
// rejected, so a hostile receipt cannot smuggle payloads through this list.
export const RISK_CLASSES = [
  "secrets.credentials",
  "privacy.private_context",
  "egress.destination_provider",
  "corpus.public_contamination",
  "authority.amplification",
  "effect.destructive_external",
  "state.durability_migration",
  "execution.containment_interrupt",
  "supply_chain.mutation",
  "claim.public_credibility",
  "evidence.output_leakage",
  "economics.budget",
  "assurance.route_evidence_opacity",
] as const;

export const SUBJECT_KINDS = [
  "git-commit",
  "git-tree",
  "diff",
  "file",
  "artifact",
  "command",
  "deployment",
] as const;

export const INDEPENDENCE_STATUSES = [
  "independent",
  "absent",
  "forged",
  "same-family",
  "unknown",
] as const;

// Observation sources strong enough to support an independence claim. A
// model-authored or self-authored assertion is not.
export const SUPPORTING_OBSERVERS = [
  "runner-observed",
  "operator-attested",
] as const;

// Bounded sentinel family values: present-but-not-a-real-family. A claimed
// independent status can never rest on a sentinel implementer or verifier.
const SENTINEL_FAMILIES: readonly string[] = ["none", "unknown"];

// The closed canonical family vocabulary. Family identity is a controlled
// value, not free-form text that merely looks canonical: a spelling check
// alone accepts `openai` and `gpt`, or `anthropic` and `claude`, as two
// families and lets one family satisfy the different-family independence
// requirement twice over. Only an id in this set — or an alias the closed
// table below resolves into it — names a family; every other spelling is
// rejected rather than admitted as a newly invented family.
//
// Every entry names a real model family. Placeholder identifiers are
// deliberately absent: a vocabulary that carries stand-in names lets a
// receipt claim two-family independent review without two real families
// ever having been involved, so fixtures exercise the family rules with
// real canonical ids like every other receipt.
export const MODEL_FAMILIES = [
  "anthropic",
  "openai",
  "google",
  "meta",
  "mistral",
  "deepseek",
  "alibaba",
  "xai",
  "amazon",
  "microsoft",
  "cohere",
] as const;

// The closed alias table: known second names for a vocabulary family, mapped
// to the canonical id they resolve to. Resolution is table-driven and total —
// an unlisted spelling resolves to nothing at all rather than to itself — so
// an alias can never be forged into a distinct family. Held in a Map, not an
// object literal, so an attacker-chosen lookup key cannot reach
// `Object.prototype` members.
const FAMILY_ALIASES = new Map<string, string>([
  ["claude", "anthropic"],
  ["gpt", "openai"],
  ["chatgpt", "openai"],
  ["gemini", "google"],
  ["deepmind", "google"],
  ["google-deepmind", "google"],
  ["palm", "google"],
  ["llama", "meta"],
  ["mixtral", "mistral"],
  ["codestral", "mistral"],
  ["qwen", "alibaba"],
  ["grok", "xai"],
  ["nova", "amazon"],
  ["titan", "amazon"],
  ["phi", "microsoft"],
  ["command", "cohere"],
]);

const KNOWN_FAMILIES = new Set<string>([
  ...SENTINEL_FAMILIES,
  ...MODEL_FAMILIES,
]);

// A model family is a canonical identifier, not free-form text: lowercase
// ASCII alphanumerics in hyphen-separated segments, short and bounded. Any
// other spelling — `Family-A`, `FAMILY_A`, ` family-a `, a confusable
// non-ASCII lookalike — is rejected outright rather than normalized, so two
// spellings of one family can never present themselves as two families.
const CANONICAL_FAMILY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_FAMILY = 64;

function isCanonicalFamily(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_FAMILY && CANONICAL_FAMILY.test(value);
}

// Resolves a canonical spelling to its vocabulary identity, or to `undefined`
// when the vocabulary does not name it. Families are compared through this
// identity, so an alias never reads as a family of its own, and an unresolved
// spelling supports no claim at all.
function resolveFamily(value: string): string | undefined {
  const canonical = FAMILY_ALIASES.get(value);
  if (canonical !== undefined) return canonical;
  return KNOWN_FAMILIES.has(value) ? value : undefined;
}

// Aggregate structural bounds, enforced before any canonicalization or digest
// work. Per-field bounds alone still admit a receipt whose nested objects
// carry megabytes of attacker-chosen content, and a deeply nested (or cyclic)
// payload would recurse during canonicalization.
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_DEPTH = 6;

// Absolute UTC instant: RFC 3339 with the explicit `Z` designator. A
// date-only, local, or numeric-offset shape does not pin one instant in the
// canonical form and is rejected even though Date.parse would accept it.
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

// The controlled executed-result vocabulary. `warn` records a check that ran
// and reported something short of a clean result; it is a legitimate result
// to carry, but it is not a pass, so it never satisfies a required check for
// a passing decision.
export const CHECK_RESULTS = ["pass", "fail", "warn"] as const;

// Decisions that a required deterministic gap must never accompany. A
// required check that was skipped, unavailable, failed, warned, or stale
// yields `unknown` or `block`; `bypass` cannot convert a deterministic
// failure into a pass and `degraded` never satisfies a mandatory check.
const PASSING_DECISIONS: readonly string[] = [
  "allow",
  "warn",
  "needs-approval",
  "bypass",
  "degraded",
];

const REQUIRED_FIELDS = [
  "schema",
  "version",
  "receipt_id",
  "policy",
  "subject",
  "work_unit",
  "actor",
  "runner",
  "decision",
  "independence",
  "risk_classes",
  "findings",
  "checks",
  "source_revision",
  "tool_revision",
  "redaction",
  "occurred_at",
  "trace_refs",
  "evidence_digest",
  "known_unknowns",
  "degraded_conditions",
] as const;

const OPTIONAL_FIELDS = ["model", "approval_ref", "bypass_ref"] as const;

const MAX_STRING = 512;
const MAX_LIST = 64;
const MAX_CHECK_ENTRIES = 256;

// Every supported nested object is closed: its key set is exactly what this
// version defines. An unknown nested key is rejected for the same reason an
// unknown top-level key is — it is unvalidated attacker-chosen payload
// riding inside a sealed receipt.
const NESTED_FIELD_KEYS: Record<string, readonly string[]> = {
  policy: ["id", "version"],
  subject: ["kind", "ref", "digest"],
  actor: ["kind", "ref"],
  runner: ["id", "revision"],
  tool_revision: ["id", "revision"],
  model: ["provider", "model", "family", "observed_by"],
  independence: [
    "required",
    "status",
    "observed_by",
    "implementer_family",
    "verifier_family",
  ],
  source_revision: ["repository", "revision"],
  redaction: ["posture", "matched_values_recorded", "reason_values_recorded"],
  evidence_digest: ["algorithm", "value"],
  checks: ["executed", "skipped", "unavailable", "failed"],
};

const SUBJECT_DIGEST_KEYS: readonly string[] = ["algorithm", "value"];
const EXECUTED_CHECK_KEYS: readonly string[] = [
  "id",
  "result",
  "required",
  "evidence_ref",
];
const GAP_CHECK_KEYS: readonly string[] = ["id", "reason_class", "required"];
const FINDING_KEYS: readonly string[] = ["class", "count"];
const CONDITION_KEYS: Record<string, readonly string[]> = {
  known_unknowns: ["class", "evidence_needed"],
  degraded_conditions: ["class", "scope"],
};

export interface ValidationOptions {
  // Independently verified digest of the subject; a receipt whose
  // subject.digest.value differs is rejected as mismatched.
  verifiedSubjectDigest?: string;
  // Freshness window: with `nowMs` set, an `occurred_at` in the future is
  // rejected, and with `maxAgeMs` also set, one older than the window is
  // rejected as stale.
  nowMs?: number;
  maxAgeMs?: number;
}

export interface ValidationResult {
  valid: boolean;
  violations: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_STRING;
}

function isHex(value: string, length: number): boolean {
  return value.length === length && /^[0-9a-f]+$/.test(value);
}

function containsImmutableHex(value: string): boolean {
  return /[0-9a-f]{40}/.test(value);
}

// Every controlled subject kind requires an immutable reference bound to the
// supplied digest: a git subject's ref must carry that exact digest hex, and
// every other kind must carry the digest-qualified token
// `<algorithm>:<value>`. A movable name alone (HEAD, a branch, a tag, a bare
// label) never identifies a subject. A malformed digest is reported by the
// digest rule; ref binding is only checked against a well-formed digest.
function isMutableSubjectRef(
  kind: string,
  ref: string,
  digest: { algorithm: string; value: string } | undefined,
): boolean {
  if (ref === "HEAD" || ref.startsWith("refs/heads/")) return true;
  if (ref.startsWith("refs/tags/")) return true;
  if (digest === undefined) return false;
  if (kind === "git-commit" || kind === "git-tree") {
    return !ref.toLowerCase().includes(digest.value);
  }
  return !ref.toLowerCase().includes(`${digest.algorithm}:${digest.value}`);
}

// Closes one nested object against its defined key set. The violation names
// the containing field (drawn from this module's own vocabulary), never the
// unknown key, which is attacker-chosen.
function closeObject(
  object: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  violations: string[],
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      violations.push(`receipt.schema/unknown-nested-field:${field}`);
      return;
    }
  }
}

interface StructureBudget {
  bytes: number;
  overflow: boolean;
  tooDeep: boolean;
}

// Conservative lower-bound estimate of the serialized size, accumulated with
// early exit so an oversized or cyclic payload is never fully walked, let
// alone serialized. This estimate under-counts JSON escaping and multi-byte
// encoding, so passing it does not mean a receipt is within the aggregate
// bound: it only bounds the work spent reaching the binding check, which
// `canonicalByteLength` performs on the real serialization below. Rejecting
// here is still sound, because the estimate never exceeds the real length.
function measureStructure(
  value: unknown,
  depth: number,
  budget: StructureBudget,
): void {
  if (budget.overflow || budget.tooDeep) return;
  if (depth > MAX_DEPTH) {
    budget.tooDeep = true;
    return;
  }
  if (Array.isArray(value)) {
    budget.bytes += 2 + Math.max(0, value.length - 1);
    for (const entry of value) {
      if (budget.overflow || budget.tooDeep) return;
      measureStructure(entry, depth + 1, budget);
    }
  } else if (isPlainObject(value)) {
    const keys = Object.keys(value);
    budget.bytes += 2 + Math.max(0, keys.length - 1);
    for (const key of keys) {
      if (budget.overflow || budget.tooDeep) return;
      budget.bytes += key.length + 3;
      if (budget.bytes > MAX_RECEIPT_BYTES) {
        budget.overflow = true;
        return;
      }
      measureStructure(value[key], depth + 1, budget);
    }
  } else if (typeof value === "string") {
    budget.bytes += value.length + 2;
  } else {
    budget.bytes += 8;
  }
  if (budget.bytes > MAX_RECEIPT_BYTES) budget.overflow = true;
}

function isBoundedStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_LIST &&
    value.every((entry) => isBoundedString(entry));
}

// Canonical JSON: object keys sorted recursively, no whitespace. The
// evidence digest is computed over this form with `evidence_digest` removed.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const body = keys.map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    );
    return `{${body.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// Byte length of the canonical serialization — the form the evidence digest
// is computed over, measured in the UTF-8 bytes a reader actually receives.
// Escapes and multi-byte characters count for what they cost, so a receipt
// whose real canonical form overruns the aggregate bound cannot present a
// smaller estimate.
function canonicalByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).length;
}

export async function computeEvidenceDigest(
  receipt: Record<string, unknown>,
): Promise<{ algorithm: string; value: string }> {
  const { evidence_digest: _omitted, ...payload } = receipt;
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const value = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { algorithm: "sha256", value };
}

interface CheckIdOccurrence {
  count: number;
  allRequired: boolean;
}

function checkEntryViolations(
  entries: unknown,
  kind: "executed" | "gap",
  violations: string[],
  seen: Map<string, CheckIdOccurrence>,
): { requiredGap: boolean; executedFailure: boolean; executedWarn: boolean } {
  let requiredGap = false;
  let executedFailure = false;
  let executedWarn = false;
  if (!Array.isArray(entries) || entries.length > MAX_CHECK_ENTRIES) {
    violations.push("receipt.schema/invalid:checks");
    return { requiredGap, executedFailure, executedWarn };
  }
  for (const entry of entries) {
    if (!isPlainObject(entry) || !isBoundedString(entry.id)) {
      violations.push("receipt.schema/invalid:checks");
      continue;
    }
    closeObject(
      entry,
      kind === "executed" ? EXECUTED_CHECK_KEYS : GAP_CHECK_KEYS,
      "checks",
      violations,
    );
    // Value-free controlled vocabulary: an id outside the stable set is
    // rejected and (being attacker-chosen) never echoed.
    if (!(MANDATORY_CHECK_IDS as readonly string[]).includes(entry.id)) {
      violations.push("receipt.schema/unknown-check-id");
      continue;
    }
    const occurrence = seen.get(entry.id) ?? { count: 0, allRequired: true };
    occurrence.count++;
    occurrence.allRequired = occurrence.allRequired &&
      entry.required === true;
    seen.set(entry.id, occurrence);
    if (typeof entry.required !== "boolean") {
      violations.push("receipt.schema/invalid:checks");
      continue;
    }
    if (kind === "executed") {
      const result = entry.result;
      if (
        typeof result !== "string" ||
        !(CHECK_RESULTS as readonly string[]).includes(result)
      ) {
        violations.push("receipt.schema/invalid:checks");
        continue;
      }
      if ("evidence_ref" in entry && !isBoundedString(entry.evidence_ref)) {
        violations.push("receipt.schema/invalid:checks");
        continue;
      }
      if (result === "fail" && entry.required) executedFailure = true;
      // A required check that only warned did not deliver the assurance it
      // was required for. It is recorded, not repaired: the decision rule
      // below refuses to call it a pass.
      if (result === "warn" && entry.required) executedWarn = true;
    } else {
      if (!isBoundedString(entry.reason_class)) {
        violations.push("receipt.schema/invalid:checks");
        continue;
      }
      if (entry.required) requiredGap = true;
    }
  }
  return { requiredGap, executedFailure, executedWarn };
}

function validateIdRevision(
  value: unknown,
  field: string,
  violations: string[],
): void {
  if (
    !isPlainObject(value) || !isBoundedString(value.id) ||
    !isBoundedString(value.revision)
  ) {
    violations.push(`receipt.schema/invalid:${field}`);
  }
}

export async function validateReceipt(
  value: unknown,
  options: ValidationOptions = {},
): Promise<ValidationResult> {
  const violations: string[] = [];
  if (!isPlainObject(value)) {
    return { valid: false, violations: ["receipt.schema/not-an-object"] };
  }

  // Aggregate structural bounds come first and short-circuit: an oversized
  // or over-nested payload is rejected before any field walk,
  // canonicalization, or digest work touches it.
  const budget: StructureBudget = {
    bytes: 0,
    overflow: false,
    tooDeep: false,
  };
  measureStructure(value, 1, budget);
  if (budget.tooDeep) {
    return {
      valid: false,
      violations: ["receipt.schema/excessive-nesting-depth"],
    };
  }
  if (budget.overflow) {
    return { valid: false, violations: ["receipt.schema/excessive-size"] };
  }
  // The binding aggregate bound: the real canonical serialization, in bytes.
  // The estimate above is a lower bound, so a payload of escape-heavy or
  // multi-byte strings can sit under it while the serialized receipt is
  // multiples of the bound. Measured here, before the field walk and before
  // any digest is computed or accepted.
  if (canonicalByteLength(value) > MAX_RECEIPT_BYTES) {
    return { valid: false, violations: ["receipt.schema/excessive-size"] };
  }

  const known = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
  for (const key of Object.keys(value)) {
    // Value-free: the unknown key name is attacker-chosen and not echoed.
    if (!known.has(key)) violations.push("receipt.schema/unknown-field");
  }
  // Every supported nested object is closed against its defined key set, so
  // an unvalidated member cannot ride inside a sealed receipt.
  for (const [field, allowed] of Object.entries(NESTED_FIELD_KEYS)) {
    const nested = value[field];
    if (isPlainObject(nested)) closeObject(nested, allowed, field, violations);
  }
  const subjectDigest = isPlainObject(value.subject)
    ? value.subject.digest
    : undefined;
  if (isPlainObject(subjectDigest)) {
    closeObject(
      subjectDigest,
      SUBJECT_DIGEST_KEYS,
      "subject-digest",
      violations,
    );
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in value)) {
      violations.push(`receipt.schema/missing:${field}`);
    }
  }

  if (value.schema !== RECEIPT_SCHEMA) {
    violations.push("receipt.schema/wrong-schema");
  }
  if (value.version !== RECEIPT_VERSION) {
    violations.push("receipt.schema/unsupported-version");
  }
  if ("receipt_id" in value && !isBoundedString(value.receipt_id)) {
    violations.push("receipt.schema/invalid:receipt_id");
  }
  if ("work_unit" in value && !isBoundedString(value.work_unit)) {
    violations.push("receipt.schema/invalid:work_unit");
  }

  const policy = value.policy;
  if (
    !isPlainObject(policy) || !isBoundedString(policy.id) ||
    !Number.isInteger(policy.version)
  ) {
    violations.push("receipt.schema/invalid:policy");
  } else {
    if (!(POLICY_IDS as readonly string[]).includes(policy.id as string)) {
      violations.push("receipt.schema/unknown-policy");
    }
    if (policy.version !== 1) {
      violations.push("receipt.schema/unsupported-policy-version");
    }
  }

  const subject = value.subject;
  if (
    !isPlainObject(subject) || typeof subject.kind !== "string" ||
    !(SUBJECT_KINDS as readonly string[]).includes(subject.kind) ||
    !isBoundedString(subject.ref)
  ) {
    violations.push("receipt.schema/invalid:subject");
  } else {
    const digest = subject.digest;
    let verifiedDigest: { algorithm: string; value: string } | undefined;
    if (
      !isPlainObject(digest) || typeof digest.value !== "string" ||
      (digest.algorithm !== "sha1" && digest.algorithm !== "sha256") ||
      !isHex(digest.value as string, digest.algorithm === "sha1" ? 40 : 64)
    ) {
      violations.push("receipt.schema/invalid:subject-digest");
    } else {
      verifiedDigest = {
        algorithm: digest.algorithm as string,
        value: digest.value as string,
      };
      if (
        options.verifiedSubjectDigest !== undefined &&
        options.verifiedSubjectDigest !== digest.value
      ) {
        violations.push("receipt.schema/subject-digest-mismatch");
      }
    }
    if (
      isMutableSubjectRef(
        subject.kind as string,
        subject.ref as string,
        verifiedDigest,
      )
    ) {
      violations.push("receipt.schema/mutable-subject-ref");
    }
  }

  const actor = value.actor;
  if (
    !isPlainObject(actor) || !isBoundedString(actor.kind) ||
    !isBoundedString(actor.ref)
  ) {
    violations.push("receipt.schema/invalid:actor");
  }
  // Runner identity alone is not enough evidence of what actually ran; the
  // runner's revision is required alongside its id.
  validateIdRevision(value.runner, "runner", violations);
  if ("model" in value) {
    const model = value.model;
    if (
      !isPlainObject(model) || !isBoundedString(model.provider) ||
      !isBoundedString(model.model) || !isBoundedString(model.family) ||
      !isBoundedString(model.observed_by)
    ) {
      violations.push("receipt.schema/invalid:model");
    } else if (!isCanonicalFamily(model.family)) {
      // Value-free: the rejected spelling is attacker-chosen, so the rule
      // identifier says only that the family is not canonical.
      violations.push("receipt.schema/non-canonical-family");
    } else if (resolveFamily(model.family) === undefined) {
      // Canonical in form but not a family this version names: rejected
      // rather than admitted as a new family, and never echoed.
      violations.push("receipt.schema/unknown-family");
    }
  }

  const decision = value.decision;
  const decisionKnown = typeof decision === "string" &&
    (DECISIONS as readonly string[]).includes(decision);
  if ("decision" in value && !decisionKnown) {
    violations.push("receipt.schema/unknown-decision");
  }

  // The accepted independence object always carries required,
  // implementer_family, verifier_family, status, and observed_by — even when
  // independence is not required, with explicit bounded sentinels such as
  // `none` rather than omission.
  const independence = value.independence;
  let independenceShapeOk = false;
  // Vocabulary identities of the two families, left undefined when the
  // receipt names a family this version does not.
  let implementerFamily: string | undefined;
  let verifierFamily: string | undefined;
  if (
    !isPlainObject(independence) ||
    typeof independence.required !== "boolean" ||
    typeof independence.status !== "string" ||
    !(INDEPENDENCE_STATUSES as readonly string[])
      .includes(independence.status) ||
    !isBoundedString(independence.observed_by) ||
    !isBoundedString(independence.implementer_family) ||
    !isBoundedString(independence.verifier_family)
  ) {
    violations.push("receipt.schema/invalid:independence");
  } else if (
    !isCanonicalFamily(independence.implementer_family) ||
    !isCanonicalFamily(independence.verifier_family)
  ) {
    // Fail closed: a non-canonical family is never repaired into a claim,
    // because `Family-A` versus `family-a` would otherwise read as two
    // families and satisfy the different-family requirement.
    violations.push("receipt.schema/non-canonical-family");
  } else {
    implementerFamily = resolveFamily(independence.implementer_family);
    verifierFamily = resolveFamily(independence.verifier_family);
    if (implementerFamily === undefined || verifierFamily === undefined) {
      // Canonical in form but outside the closed vocabulary. A family this
      // version cannot name is not a family: it is rejected here, and the
      // independence rule below refuses to rest a claim on it.
      violations.push("receipt.schema/unknown-family");
    }
    independenceShapeOk = true;
  }

  const riskClasses = value.risk_classes;
  if (!isBoundedStringList(riskClasses)) {
    violations.push("receipt.schema/invalid:risk_classes");
  } else {
    for (const riskClass of riskClasses) {
      if (!(RISK_CLASSES as readonly string[]).includes(riskClass)) {
        violations.push("receipt.schema/unknown-risk-class");
      }
    }
  }

  const findings = value.findings;
  if (!Array.isArray(findings) || findings.length > MAX_CHECK_ENTRIES) {
    violations.push("receipt.schema/invalid:findings");
  } else {
    for (const finding of findings) {
      if (
        !isPlainObject(finding) || !isBoundedString(finding.class) ||
        !Number.isInteger(finding.count)
      ) {
        violations.push("receipt.schema/invalid:findings");
      } else {
        closeObject(finding, FINDING_KEYS, "findings", violations);
        if ((finding.count as number) < 0) {
          violations.push("receipt.schema/negative-finding-count");
        }
      }
    }
  }

  let requiredGap = false;
  let executedFailure = false;
  let executedWarn = false;
  const seenCheckIds = new Map<string, CheckIdOccurrence>();
  const checks = value.checks;
  if (
    !isPlainObject(checks) || !("executed" in checks) ||
    !("skipped" in checks) || !("unavailable" in checks) ||
    !("failed" in checks)
  ) {
    violations.push("receipt.schema/invalid:checks");
  } else {
    const executed = checkEntryViolations(
      checks.executed,
      "executed",
      violations,
      seenCheckIds,
    );
    executedFailure = executed.executedFailure;
    executedWarn = executed.executedWarn;
    for (const key of ["skipped", "unavailable", "failed"] as const) {
      const gap = checkEntryViolations(
        checks[key],
        "gap",
        violations,
        seenCheckIds,
      );
      requiredGap = requiredGap || gap.requiredGap;
    }
  }
  // A check id may occur once across all four buckets: a duplicated entry
  // could report one result while hiding another.
  for (const occurrence of seenCheckIds.values()) {
    if (occurrence.count > 1) {
      violations.push("receipt.schema/duplicate-check-id");
    }
  }
  // The mandatory floor for a `repository.required_checks` receipt: every
  // stable check id must be accounted for and marked required. An omitted
  // or optional mandatory check can never validate.
  if (isPlainObject(policy) && policy.id === "repository.required_checks") {
    for (const id of MANDATORY_CHECK_IDS) {
      const occurrence = seenCheckIds.get(id);
      if (occurrence === undefined) {
        violations.push("receipt.schema/mandatory-check-missing");
      } else if (!occurrence.allRequired) {
        violations.push("receipt.schema/mandatory-check-not-required");
      }
    }
  }

  const source = value.source_revision;
  if (
    !isPlainObject(source) || !isBoundedString(source.repository) ||
    !isBoundedString(source.revision)
  ) {
    violations.push("receipt.schema/invalid:source_revision");
  }
  validateIdRevision(value.tool_revision, "tool_revision", violations);

  const redaction = value.redaction;
  if (!isPlainObject(redaction) || !isBoundedString(redaction.posture)) {
    violations.push("receipt.schema/invalid:redaction");
  } else if (
    redaction.matched_values_recorded !== false ||
    redaction.reason_values_recorded !== false
  ) {
    violations.push("receipt.schema/redaction-not-confirmed");
  }

  const occurredAt = value.occurred_at;
  if (
    typeof occurredAt !== "string" || !UTC_TIMESTAMP.test(occurredAt) ||
    Number.isNaN(Date.parse(occurredAt))
  ) {
    violations.push("receipt.schema/invalid:occurred_at");
  } else if (options.nowMs !== undefined) {
    const at = Date.parse(occurredAt);
    if (at > options.nowMs + 5 * 60_000) {
      violations.push("receipt.schema/future-timestamp");
    } else if (
      options.maxAgeMs !== undefined && at < options.nowMs - options.maxAgeMs
    ) {
      violations.push("receipt.schema/stale-subject");
    }
  }

  if (!isBoundedStringList(value.trace_refs)) {
    violations.push("receipt.schema/invalid:trace_refs");
  }
  // Each entry pairs a value-free class with its bounded companion field:
  // the evidence a known unknown still needs, or the scope a degraded
  // condition covers. Omitting the companion is not a smaller claim — it is
  // rejected.
  const conditionCompanions = {
    known_unknowns: "evidence_needed",
    degraded_conditions: "scope",
  } as const;
  for (const field of ["known_unknowns", "degraded_conditions"] as const) {
    const list = value[field];
    if (!Array.isArray(list) || list.length > MAX_LIST) {
      violations.push(`receipt.schema/invalid:${field}`);
      continue;
    }
    for (const entry of list) {
      if (
        !isPlainObject(entry) || !isBoundedString(entry.class) ||
        !isBoundedString(entry[conditionCompanions[field]])
      ) {
        violations.push(`receipt.schema/invalid:${field}`);
      } else {
        closeObject(entry, CONDITION_KEYS[field], field, violations);
      }
    }
  }

  // A grant reference must itself be immutable evidence: a bounded string
  // carrying a content-addressed hex token. A bare mutable label cannot
  // anchor an approval or a bypass.
  for (const field of ["approval_ref", "bypass_ref"] as const) {
    if (field in value) {
      const ref = value[field];
      if (
        !isBoundedString(ref) || !containsImmutableHex(ref.toLowerCase())
      ) {
        violations.push(`receipt.schema/invalid:${field}`);
      }
    }
  }

  // Any claim of achieved independence must itself be supported — even when
  // independence is not required: runner-observed or operator-attested, with
  // two differing non-sentinel families. A sentinel such as `none` marks the
  // absence of a family and can never carry an independent status.
  if (
    independenceShapeOk && isPlainObject(independence) &&
    independence.status === "independent"
  ) {
    // Families are compared through their vocabulary identity, so an alias
    // (`gpt` for `openai`) never reads as a second family, and a spelling the
    // vocabulary does not resolve supports nothing.
    const supported = (SUPPORTING_OBSERVERS as readonly string[])
      .includes(independence.observed_by as string) &&
      implementerFamily !== undefined && verifierFamily !== undefined &&
      !SENTINEL_FAMILIES.includes(implementerFamily) &&
      !SENTINEL_FAMILIES.includes(verifierFamily) &&
      implementerFamily !== verifierFamily;
    if (!supported) {
      violations.push("receipt.schema/unsupported-independence");
    }
  }

  if (decisionKnown) {
    const isPassing = PASSING_DECISIONS.includes(decision as string);
    if (isPassing && requiredGap) {
      violations.push("receipt.schema/passing-with-required-gap");
    }
    if (isPassing && executedFailure) {
      violations.push("receipt.schema/passing-with-failed-checks");
    }
    // `warn` is a legitimate recorded result, but it is not the executed
    // `pass` a required check exists to produce. Under
    // `repository.required_checks` every mandatory id is required and
    // executed, so a passing decision there needs a clean pass on all of
    // them; under any policy, a required check that only warned cannot be
    // spent as satisfied assurance.
    if (isPassing && executedWarn) {
      violations.push("receipt.schema/passing-with-warned-checks");
    }
    if (decision === "bypass" && !isBoundedString(value.bypass_ref)) {
      violations.push("receipt.schema/missing-bypass-ref");
    }
    // Required independence on a passing decision needs the achieved status;
    // the supported-claim rule above already vets that status's evidence.
    if (
      independenceShapeOk && isPlainObject(independence) &&
      independence.required === true &&
      (decision === "allow" || decision === "warn" ||
        decision === "degraded" || decision === "bypass") &&
      independence.status !== "independent"
    ) {
      violations.push("receipt.schema/unsupported-independence");
    }
  }

  const evidence = value.evidence_digest;
  if (
    !isPlainObject(evidence) || evidence.algorithm !== "sha256" ||
    typeof evidence.value !== "string" ||
    !isHex(evidence.value as string, 64)
  ) {
    violations.push("receipt.schema/invalid:evidence_digest");
  } else {
    const recomputed = await computeEvidenceDigest(value);
    if (recomputed.value !== evidence.value) {
      violations.push("receipt.schema/evidence-digest-mismatch");
    }
  }

  return { valid: violations.length === 0, violations };
}
