/**
 * Dependency policy check: `dependency.policy`.
 *
 * Deterministic supply-chain rules that public CI can enforce from a clean
 * checkout:
 *
 * - Every workflow `uses:` reference must be pinned to a full commit digest.
 *   Tag and branch references are mutable and rejected.
 * - Workflow files must not fetch mutable installer URLs (`releases/latest`,
 *   raw branch content) and must not pipe a downloaded script into a shell:
 *   an unpinned remote script is arbitrary code with no subject identity.
 * - `core/rust-toolchain.toml` must pin an exact toolchain version, so the
 *   Rust lanes build with the same compiler everywhere.
 * - The committed `dyfj.dependency.policy.manifest/v1` declaration
 *   (`scripts/dependency-policy-manifest.json`) must validate fail-closed:
 *   known schema and version, no unknown fields, unique surface ids,
 *   normalized repository-relative paths, explicit lock paths (empty when
 *   none), an age policy bound to the source class (registry surfaces must
 *   declare the >=72-hour floor and can never opt out; each non-registry
 *   surface must declare exactly its own not-applicable reason class), a
 *   per-source-class required evidence contract, mutable references
 *   prohibited, and nonempty integrity, provenance, and clean-room check
 *   declarations. Every tracked dependency surface must be matched by a
 *   declaration, as must every dependency path the release range changes —
 *   deletions included, so a deleted dependency surface stays visible as a
 *   mutation. The check emits only the manifest's canonical SHA-256 content
 *   digest plus a bounded status.
 *
 * The manifest declares evidence classes; it does not carry artifact
 * hashes, signatures, publication dates, or upstream verification results.
 * For the exact-version Deno and Dolt release archives, the workflow checks
 * a repository-committed SHA-256 before unpacking, so `archive-checksum` is
 * claimed evidence; release signatures are still not verified and stay
 * declared as a known missing evidence class.
 *
 * Every source class must also require `operator-inspect-before-apply`:
 * the accepted contract admits no dependency source that may be applied
 * without an operator inspecting the change first. Inspection is a
 * precondition, never a substitute for integrity or provenance proof, so an
 * inspect class may not be declared as integrity or provenance evidence.
 *
 * Dependency-surface mutations in the release range (manifests, lockfiles,
 * workflow and update configuration) are surfaced as a visible value-free
 * notice. The inspect-before-apply and release-age evidence for applying a
 * dependency update is a local/private control owned by the operator; this
 * check validates the committed declaration deterministically and does not
 * claim that private approval happened.
 *
 * Diagnostics are value-free: rule id, path, and line only (see
 * `scan-lib.ts`).
 */

import {
  MAX_COLLECTED_HITS,
  posixPath,
  readTrackedFile,
  repoRootFromMeta,
  sanitizeForLog,
  trackedFiles,
} from "./scan-lib.ts";
import {
  changedFilesIncludingDeleted,
  type ReleaseRange,
  resolveReleaseRange,
} from "./release-range.ts";
import { formatHits, type PublicSafetyHit } from "./public-safety-scan.ts";
import { canonicalJson, MANDATORY_CHECK_IDS } from "./assurance-receipt.ts";

const LABEL = "dependency policy";

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const TOOLCHAIN_PATH = "core/rust-toolchain.toml";

const USES_LINE = /^\s*(?:-\s+)?uses:\s*(.+?)\s*$/;
const DIGEST_PINNED = /^[\w./-]+@[0-9a-f]{40}$/;
const MUTABLE_URLS = [
  /releases\/latest\//,
  /\/latest\/download\//,
  /raw\.githubusercontent\.com\/\S+\/(main|master)\//,
];
const PIPE_TO_SHELL =
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?\S*\b(sh|bash|zsh|dash)\b/;

// Surfaces whose mutation is a dependency/configuration change requiring
// operator-side inspect-before-apply evidence.
export const DEPENDENCY_SURFACES: readonly RegExp[] = [
  /^\.github\/workflows\//,
  /^\.github\/dependabot\.yml$/,
  /(^|\/)deno\.jsonc?$/,
  /(^|\/)deno\.lock$/,
  /(^|\/)Cargo\.toml$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)rust-toolchain\.toml$/,
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /^scripts\/dependency-policy-manifest\.json$/,
];

export function isDependencySurface(path: string): boolean {
  const normalized = posixPath(path);
  return DEPENDENCY_SURFACES.some((pattern) => pattern.test(normalized));
}

export const MANIFEST_PATH = "scripts/dependency-policy-manifest.json";
export const MANIFEST_SCHEMA = "dyfj.dependency.policy.manifest";
export const MANIFEST_VERSION = 1;

// The registry age floor: a registry-published dependency surface may not
// declare a minimum application age below this.
export const MINIMUM_REGISTRY_AGE_HOURS = 72;

export const SOURCE_CLASSES = [
  "deno-registry",
  "cargo-registry",
  "rust-toolchain-release",
  "github-actions-config",
  "github-release-asset",
  "repository-owned-declaration",
] as const;

export type SourceClass = (typeof SOURCE_CLASSES)[number];

// The controlled value-free evidence-class vocabulary. The manifest names
// evidence classes only — never hashes, signatures, dates, or verification
// results — so an unknown class is rejected without being echoed.
export const EVIDENCE_CLASSES = [
  "exact-version-pin",
  "exact-version-url",
  "reported-version-check",
  "commit-digest-pin",
  "lockfile-integrity-hash",
  "archive-checksum",
  "archive-signature",
  "registry-source-provenance",
  "upstream-release-provenance",
  "repository-owned-content",
  "operator-inspect-before-apply",
  "canonical-manifest-digest",
  "inspect-result",
  "selected-version",
  "publication-timestamp",
  "minimum-release-age",
  "manifest-diff",
  "lock-diff",
  "clean-room-resolution",
  "immutable-upstream-revision",
  "source-identity",
  "exact-config-diff",
  "artifact-integrity-when-available",
  "provenance-class",
  "clean-room-version-check",
] as const;

export const AGE_REASON_CLASSES = [
  "repository-owned-content",
  "non-registry-versioned-release",
  "immutable-git-and-repository-config",
] as const;

// Age policy is bound to the source class, not merely shape-valid: a
// registry surface must declare the registry floor and can never opt out
// with a not-applicable reason, while each non-registry surface must
// declare exactly the not-applicable reason class matching its source.
const REGISTRY_SOURCE_CLASSES: readonly string[] = [
  "deno-registry",
  "cargo-registry",
];

const NOT_APPLICABLE_REASON_BY_SOURCE: Readonly<Record<string, string>> = {
  "rust-toolchain-release": "non-registry-versioned-release",
  "github-release-asset": "non-registry-versioned-release",
  "github-actions-config": "immutable-git-and-repository-config",
  "repository-owned-declaration": "repository-owned-content",
};

// Applying any dependency change requires an operator to have inspected it
// first, whatever the source class. This is stated once and folded into
// every contract below so no source class can be added without it.
export const INSPECT_BEFORE_APPLY = "operator-inspect-before-apply";

// Inspect evidence records that a human looked; it proves nothing about the
// bytes and grants no apply authority on its own. Declaring it as integrity
// or provenance evidence would launder review into proof.
const INSPECT_ONLY_CLASSES: readonly string[] = [
  INSPECT_BEFORE_APPLY,
  "inspect-result",
];

const REGISTRY_EVIDENCE_CONTRACT: readonly string[] = [
  "inspect-result",
  "selected-version",
  "publication-timestamp",
  "minimum-release-age",
  "manifest-diff",
  "lock-diff",
  "clean-room-resolution",
];

// The accepted dependency contract per source class: the evidence classes
// its `required_evidence_classes` must state, beyond any additional classes
// the surface also declares. Every class carries
// `operator-inspect-before-apply`. The repository-owned declaration must
// additionally keep `dependency.policy` among its clean-room checks.
export const REQUIRED_EVIDENCE_BY_SOURCE: Readonly<
  Record<SourceClass, readonly string[]>
> = {
  "deno-registry": [...REGISTRY_EVIDENCE_CONTRACT, INSPECT_BEFORE_APPLY],
  "cargo-registry": [...REGISTRY_EVIDENCE_CONTRACT, INSPECT_BEFORE_APPLY],
  "rust-toolchain-release": [
    "immutable-upstream-revision",
    "source-identity",
    "exact-version-pin",
    "provenance-class",
    "clean-room-version-check",
    INSPECT_BEFORE_APPLY,
  ],
  "github-actions-config": [
    "exact-config-diff",
    "commit-digest-pin",
    "source-identity",
    "provenance-class",
    "clean-room-resolution",
    INSPECT_BEFORE_APPLY,
  ],
  "github-release-asset": [
    "immutable-upstream-revision",
    "source-identity",
    "artifact-integrity-when-available",
    "archive-checksum",
    "provenance-class",
    "clean-room-version-check",
    INSPECT_BEFORE_APPLY,
  ],
  "repository-owned-declaration": [
    "exact-config-diff",
    "canonical-manifest-digest",
    "provenance-class",
    INSPECT_BEFORE_APPLY,
  ],
};

// The archive evidence the workflow still does not gather for a GitHub
// release asset. The archive bytes are now checked against a
// repository-committed SHA-256 before unpacking, so the checksum gap is
// closed; no release signature is verified, and a release-asset surface must
// keep declaring that gap explicitly instead of implying it is covered.
const RELEASE_ASSET_GAPS = ["archive-signature"];

const MANIFEST_FIELDS: readonly string[] = ["schema", "version", "surfaces"];

const SURFACE_FIELDS: readonly string[] = [
  "id",
  "source_class",
  "manifest_paths",
  "lock_paths",
  "required_evidence_classes",
  "age_policy",
  "mutable_references_allowed",
  "integrity_evidence_classes",
  "provenance_evidence_classes",
  "clean_room_check_ids",
  "known_missing_evidence_classes",
];

const MAX_MANIFEST_SURFACES = 64;
const MAX_MANIFEST_LIST = 32;
const MAX_MANIFEST_STRING = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManifestString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_MANIFEST_STRING;
}

function isPathList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_MANIFEST_LIST &&
    value.every((entry) => isManifestString(entry));
}

// A declared path must be a normalized repository-relative POSIX path:
// relative, forward slashes only, no traversal or empty components, and no
// control bytes. A rejected path is never echoed.
function isRepositoryRelativePath(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  if (value.includes("\\") || value.startsWith("/")) return false;
  return value.split("/").every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  );
}

// Validates one evidence-class list and returns its entries for the
// cross-checks; a rejected list contributes no entries.
function classListEntries(
  value: unknown,
  field: string,
  vocabulary: readonly string[],
  emptyRule: string | undefined,
  violations: string[],
): string[] {
  if (
    !Array.isArray(value) || value.length > MAX_MANIFEST_LIST ||
    !value.every((entry) => isManifestString(entry))
  ) {
    violations.push(`dependency.manifest/invalid:${field}`);
    return [];
  }
  if (emptyRule !== undefined && value.length === 0) {
    violations.push(emptyRule);
  }
  for (const entry of value) {
    if (!vocabulary.includes(entry)) {
      violations.push(
        vocabulary === (MANDATORY_CHECK_IDS as readonly string[])
          ? "dependency.manifest/unknown-check-id"
          : "dependency.manifest/unknown-evidence-class",
      );
    }
  }
  return value;
}

function agePolicyViolations(
  value: unknown,
  sourceClass: SourceClass | undefined,
  violations: string[],
): void {
  if (!isPlainObject(value)) {
    violations.push("dependency.manifest/invalid:age_policy");
    return;
  }
  if (value.class === "registry-minimum-hours") {
    for (const key of Object.keys(value)) {
      if (key !== "class" && key !== "minimum_hours") {
        violations.push("dependency.manifest/unknown-field");
      }
    }
    if (!Number.isInteger(value.minimum_hours)) {
      violations.push("dependency.manifest/invalid:age_policy");
    } else if ((value.minimum_hours as number) < MINIMUM_REGISTRY_AGE_HOURS) {
      violations.push("dependency.manifest/age-below-minimum");
    }
    // Only a registry source may declare the registry floor.
    if (
      sourceClass !== undefined &&
      !REGISTRY_SOURCE_CLASSES.includes(sourceClass)
    ) {
      violations.push("dependency.manifest/age-policy-source-mismatch");
    }
    return;
  }
  if (value.class === "not-applicable") {
    for (const key of Object.keys(value)) {
      if (key !== "class" && key !== "reason_class") {
        violations.push("dependency.manifest/unknown-field");
      }
    }
    if (
      !isManifestString(value.reason_class) ||
      !(AGE_REASON_CLASSES as readonly string[]).includes(value.reason_class)
    ) {
      violations.push("dependency.manifest/missing-age-reason");
    }
    // A registry source can never opt out of the floor — even with a
    // well-formed reason — and a non-registry source must state exactly
    // its own reason class, not another source's.
    if (
      sourceClass !== undefined &&
      value.reason_class !== NOT_APPLICABLE_REASON_BY_SOURCE[sourceClass]
    ) {
      violations.push("dependency.manifest/age-policy-source-mismatch");
    }
    return;
  }
  violations.push("dependency.manifest/invalid:age_policy");
}

function surfaceViolations(
  surface: unknown,
  seenIds: Set<string>,
  violations: string[],
): void {
  if (!isPlainObject(surface)) {
    violations.push("dependency.manifest/invalid:surface");
    return;
  }
  for (const key of Object.keys(surface)) {
    // Value-free: the unknown key name is untrusted and never echoed.
    if (!SURFACE_FIELDS.includes(key)) {
      violations.push("dependency.manifest/unknown-field");
    }
  }
  if (!isManifestString(surface.id)) {
    violations.push("dependency.manifest/invalid:id");
  } else if (seenIds.has(surface.id)) {
    violations.push("dependency.manifest/duplicate-surface-id");
  } else {
    seenIds.add(surface.id);
  }
  const sourceClass = isManifestString(surface.source_class) &&
      (SOURCE_CLASSES as readonly string[]).includes(surface.source_class)
    ? surface.source_class as SourceClass
    : undefined;
  if (sourceClass === undefined) {
    violations.push("dependency.manifest/unknown-source-class");
  }
  if (
    !isPathList(surface.manifest_paths) ||
    surface.manifest_paths.length === 0
  ) {
    violations.push("dependency.manifest/invalid:manifest_paths");
  }
  // Lock paths must be declared explicitly even when there are none: an
  // absent field is not the same claim as an explicit empty list.
  if (!isPathList(surface.lock_paths)) {
    violations.push("dependency.manifest/invalid:lock_paths");
  }
  for (const field of ["manifest_paths", "lock_paths"] as const) {
    const paths = surface[field];
    if (!isPathList(paths)) continue;
    for (const path of paths) {
      if (!isRepositoryRelativePath(path)) {
        violations.push("dependency.manifest/invalid-path");
      }
    }
  }
  const required = classListEntries(
    surface.required_evidence_classes,
    "required_evidence_classes",
    EVIDENCE_CLASSES,
    "dependency.manifest/missing-required-evidence",
    violations,
  );
  agePolicyViolations(surface.age_policy, sourceClass, violations);
  if (surface.mutable_references_allowed !== false) {
    violations.push(
      surface.mutable_references_allowed === true
        ? "dependency.manifest/mutable-references-allowed"
        : "dependency.manifest/invalid:mutable_references_allowed",
    );
  }
  const integrity = classListEntries(
    surface.integrity_evidence_classes,
    "integrity_evidence_classes",
    EVIDENCE_CLASSES,
    "dependency.manifest/missing-integrity-evidence",
    violations,
  );
  const provenance = classListEntries(
    surface.provenance_evidence_classes,
    "provenance_evidence_classes",
    EVIDENCE_CLASSES,
    "dependency.manifest/missing-provenance-evidence",
    violations,
  );
  const cleanRoom = classListEntries(
    surface.clean_room_check_ids,
    "clean_room_check_ids",
    MANDATORY_CHECK_IDS,
    "dependency.manifest/missing-clean-room-checks",
    violations,
  );
  const knownMissing = classListEntries(
    surface.known_missing_evidence_classes,
    "known_missing_evidence_classes",
    EVIDENCE_CLASSES,
    undefined,
    violations,
  );
  // A class cannot be both claimed as evidence and declared missing.
  for (const entry of knownMissing) {
    if (
      required.includes(entry) || integrity.includes(entry) ||
      provenance.includes(entry)
    ) {
      violations.push("dependency.manifest/contradictory-evidence");
    }
  }
  // Inspection is a precondition for applying a change, not evidence about
  // the artifact: it may be required, but it can never stand in for
  // integrity or provenance proof.
  for (const entry of INSPECT_ONLY_CLASSES) {
    if (integrity.includes(entry) || provenance.includes(entry)) {
      violations.push("dependency.manifest/inspect-as-artifact-evidence");
    }
  }
  if (surface.source_class === "github-release-asset") {
    for (const gap of RELEASE_ASSET_GAPS) {
      if (!knownMissing.includes(gap)) {
        violations.push("dependency.manifest/unverified-archive-claim");
      }
    }
  }
  if (sourceClass !== undefined) {
    // The accepted contract for this source class must be stated in full;
    // a generic inspect label alone is not the contract.
    for (const entry of REQUIRED_EVIDENCE_BY_SOURCE[sourceClass]) {
      if (!required.includes(entry)) {
        violations.push("dependency.manifest/missing-contract-evidence");
      }
    }
    if (
      sourceClass === "repository-owned-declaration" &&
      !cleanRoom.includes("dependency.policy")
    ) {
      violations.push("dependency.manifest/missing-contract-evidence");
    }
  }
}

export function manifestViolations(value: unknown): string[] {
  if (!isPlainObject(value)) {
    return ["dependency.manifest/not-an-object"];
  }
  const violations: string[] = [];
  for (const key of Object.keys(value)) {
    if (!MANIFEST_FIELDS.includes(key)) {
      violations.push("dependency.manifest/unknown-field");
    }
  }
  if (value.schema !== MANIFEST_SCHEMA) {
    violations.push("dependency.manifest/wrong-schema");
  }
  if (value.version !== MANIFEST_VERSION) {
    violations.push("dependency.manifest/unsupported-version");
  }
  const surfaces = value.surfaces;
  if (
    !Array.isArray(surfaces) || surfaces.length === 0 ||
    surfaces.length > MAX_MANIFEST_SURFACES
  ) {
    violations.push("dependency.manifest/invalid:surfaces");
    return violations;
  }
  const seenIds = new Set<string>();
  for (const surface of surfaces) {
    surfaceViolations(surface, seenIds, violations);
  }
  return violations;
}

export interface ManifestLoad {
  manifest?: Record<string, unknown>;
  violations: string[];
}

export async function loadManifest(root: string): Promise<ManifestLoad> {
  let text: string;
  try {
    const bytes = await readTrackedFile(root, MANIFEST_PATH, LABEL);
    text = new TextDecoder().decode(bytes);
  } catch {
    return { violations: ["dependency.manifest/unreadable"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { violations: ["dependency.manifest/invalid-json"] };
  }
  const violations = manifestViolations(parsed);
  if (violations.length > 0) return { violations };
  return { manifest: parsed as Record<string, unknown>, violations: [] };
}

// Canonical deterministic content digest: SHA-256 over the sorted-key
// canonical JSON form, so byte-level reformatting does not shift it while
// any value change does. The hex digest is safe to log.
export async function manifestDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function declaredSurfacePaths(
  manifest: Record<string, unknown>,
): Set<string> {
  const declared = new Set<string>();
  const surfaces = Array.isArray(manifest.surfaces) ? manifest.surfaces : [];
  for (const surface of surfaces) {
    if (!isPlainObject(surface)) continue;
    for (const field of ["manifest_paths", "lock_paths"] as const) {
      const paths = surface[field];
      if (!Array.isArray(paths)) continue;
      for (const path of paths) {
        if (typeof path === "string") declared.add(posixPath(path));
      }
    }
  }
  return declared;
}

// Every tracked dependency surface, and every dependency path the release
// range changes, must be matched by a manifest declaration; an unmatched
// path fails closed rather than passing silently.
export function coverageHits(
  tracked: readonly string[],
  changed: readonly string[],
  declared: ReadonlySet<string>,
): PublicSafetyHit[] {
  const hits: PublicSafetyHit[] = [];
  for (const path of tracked) {
    const normalized = posixPath(path);
    if (isDependencySurface(normalized) && !declared.has(normalized)) {
      hits.push({
        path: normalized,
        line: 1,
        rule: "dependency.policy/undeclared-surface",
      });
    }
    if (hits.length >= MAX_COLLECTED_HITS) return hits;
  }
  for (const path of changed) {
    const normalized = posixPath(path);
    if (isDependencySurface(normalized) && !declared.has(normalized)) {
      hits.push({
        path: normalized,
        line: 1,
        rule: "dependency.policy/unmatched-surface-change",
      });
    }
    if (hits.length >= MAX_COLLECTED_HITS) return hits;
  }
  return hits;
}

export function scanWorkflowText(
  path: string,
  content: string,
): PublicSafetyHit[] {
  const hits: PublicSafetyHit[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const uses = USES_LINE.exec(line);
    if (uses) {
      const reference = (uses[1] ?? "")
        .split(/\s+#/)[0]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
      if (!DIGEST_PINNED.test(reference)) {
        hits.push({
          path: posixPath(path),
          line: index + 1,
          rule: "dependency.policy/unpinned-action",
        });
      }
    }
    if (MUTABLE_URLS.some((pattern) => pattern.test(line))) {
      hits.push({
        path: posixPath(path),
        line: index + 1,
        rule: "dependency.policy/mutable-installer-url",
      });
    }
    if (PIPE_TO_SHELL.test(line)) {
      hits.push({
        path: posixPath(path),
        line: index + 1,
        rule: "dependency.policy/pipe-to-shell",
      });
    }
    if (hits.length >= MAX_COLLECTED_HITS) break;
  }
  return hits;
}

export function scanToolchainText(
  path: string,
  content: string,
): PublicSafetyHit[] {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = /^channel\s*=\s*"([^"]*)"/.exec(lines[index] ?? "");
    if (!match) continue;
    if (/^\d+\.\d+\.\d+$/.test(match[1] ?? "")) return [];
    return [{
      path: posixPath(path),
      line: index + 1,
      rule: "dependency.policy/unpinned-toolchain",
    }];
  }
  return [{
    path: posixPath(path),
    line: 1,
    rule: "dependency.policy/unpinned-toolchain",
  }];
}

export async function dependencyPolicyHits(
  root: string,
  trackedPaths?: readonly string[],
): Promise<PublicSafetyHit[]> {
  const tracked = trackedPaths ?? await trackedFiles(root, LABEL);
  const hits: PublicSafetyHit[] = [];
  for (const path of tracked) {
    if (!WORKFLOW_PATH.test(posixPath(path))) continue;
    const bytes = await readTrackedFile(root, path, LABEL);
    hits.push(...scanWorkflowText(path, new TextDecoder().decode(bytes)));
    if (hits.length >= MAX_COLLECTED_HITS) return hits;
  }
  if (tracked.some((path) => posixPath(path) === TOOLCHAIN_PATH)) {
    const bytes = await readTrackedFile(root, TOOLCHAIN_PATH, LABEL);
    hits.push(
      ...scanToolchainText(TOOLCHAIN_PATH, new TextDecoder().decode(bytes)),
    );
  } else {
    hits.push({
      path: TOOLCHAIN_PATH,
      line: 1,
      rule: "dependency.policy/unpinned-toolchain",
    });
  }
  return hits;
}

export async function mutatedSurfaces(
  root: string,
  range: ReleaseRange,
): Promise<string[]> {
  // Deletions included: removing a tracked dependency manifest is itself a
  // dependency mutation and must not vanish from range detection.
  const changed = await changedFilesIncludingDeleted(root, range);
  return changed.filter((path) => isDependencySurface(path));
}

export async function runDependencyPolicy(
  root: string,
  env: (name: string) => string | undefined,
  out: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  const range = await resolveReleaseRange(root, env);
  const mutated = await mutatedSurfaces(root, range);
  if (mutated.length > 0) {
    const shown = mutated.slice(0, 20)
      .map((path) => sanitizeForLog(path, 300)).join(", ");
    const more = mutated.length > 20 ? ", …" : "";
    out.log(
      `dependency.policy: ${mutated.length} dependency-surface change(s) ` +
        `in range: ${shown}${more} (apply approval stays a local/private ` +
        "control)",
    );
  }
  const load = await loadManifest(root);
  if (load.manifest === undefined) {
    out.error("dependency.policy: dependency manifest rejected:");
    out.error(formatHits(
      load.violations.map((rule) => ({ path: MANIFEST_PATH, line: 1, rule })),
    ));
    return 1;
  }
  // Bounded status plus the safe canonical content digest; nothing else
  // from the manifest reaches the log.
  const digest = await manifestDigest(load.manifest);
  out.log(`dependency.policy: manifest ok (sha256:${digest})`);
  const tracked = await trackedFiles(root, LABEL);
  const declared = declaredSurfacePaths(load.manifest);
  const hits = [
    ...coverageHits(tracked, mutated, declared),
    ...await dependencyPolicyHits(root, tracked),
  ];
  if (hits.length > 0) {
    out.error("dependency.policy: mutable or unpinned dependency shapes:");
    out.error(formatHits(hits));
    return 1;
  }
  out.log("dependency.policy: clean");
  return 0;
}

if (import.meta.main) {
  let code: number;
  try {
    code = await runDependencyPolicy(
      repoRootFromMeta(),
      (name) => Deno.env.get(name),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    code = 1;
  }
  Deno.exit(code);
}
