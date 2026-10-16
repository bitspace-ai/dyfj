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
 *   Network-to-shell is judged on whole logical commands, not on physical
 *   lines: a YAML block or folded scalar, a backslash continuation, and a
 *   line ending in `|` all spread one command over several lines, and a
 *   line-at-a-time scan sees none of them. A `run:` value whose structure
 *   cannot be resolved safely is reported rather than skipped.
 * - `core/rust-toolchain.toml` must pin an exact toolchain version, so the
 *   Rust lanes build with the same compiler everywhere.
 * - Every tracked `package.json` must pin each dependency to an exact
 *   version, declare no `overrides` (rejected until a policy for them
 *   exists), sit beside a tracked `package-lock.json`, and sit beside a
 *   tracked `.npmrc` that disables install scripts and holds npm's release
 *   age at the 72-hour floor (`min-release-age` of at least 3 days), so the
 *   floor holds for anyone installing, not only in the operator's review.
 *   A workspace member (a directory a tracked `package.json` names in its
 *   `workspaces` list) is installed from its workspace root, so its lockfile
 *   and `.npmrc` are the root's. npm ignores a member's own `.npmrc` and
 *   lockfile, so a tracked one beside a member is rejected rather than left
 *   to look effective. `workspaces` must be a list of plain relative
 *   directory paths: globs and the object form are rejected until needed.
 * - `.github/dependabot.yml` must give every tracked `package.json` an npm
 *   update lane for its directory (for a workspace member, its workspace
 *   root's directory), using the `increase` versioning strategy
 *   so a bot bump keeps an exact pin exact, and its npm and deno lanes must
 *   declare a cooldown of at least 3 days with no `include` or `exclude`
 *   carve-out, so a bot pull request holds the same 72-hour floor. A lane
 *   key, or a value the policy decides on, that the scan cannot read is
 *   reported rather than skipped: an escaped double-quoted scalar, a flow
 *   collection, an anchor, alias, tag or block scalar. Settings the policy
 *   does not decide on, such as `schedule` and `ignore`, are not read.
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
const FETCH_COMMAND = /\b(?:curl|wget)\b/;

// Command names that execute their standard input as a script. Compared
// against the basename of a pipeline stage's command word.
const SHELL_COMMANDS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "ash",
]);

// Wrappers that run the command that follows them, so the shell they invoke
// is still the stage's effective command.
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "exec",
  "nohup",
  "time",
  "xargs",
]);

// Bounds on the workflow structure a single scan will reason about. A file
// past any of these is not understood rather than partially trusted.
const MAX_RUN_BLOCK_LINES = 500;
const MAX_SHELL_TEXT_CHARS = 100_000;
const MAX_SHELL_COMMANDS = 2000;

const UNPARSED_SHELL = "dependency.policy/unparsed-shell";
const PIPE_TO_SHELL = "dependency.policy/pipe-to-shell";

// A `run:` mapping key, with the sequence dash folded into the prefix so the
// key's own column — not the line's indentation — bounds the value's block.
const RUN_KEY = /^(\s*(?:-\s+)?)run:(?=$|\s)(.*)$/;

// A block scalar header: `|`, `>`, either chomping indicator, an explicit
// indentation indicator, and an optional trailing comment. Anything else
// after `run:` is not a block scalar.
const BLOCK_HEADER = /^([|>])(?:[+-]?\d*|\d*[+-]?)\s*(?:#.*)?$/;

/**
 * One workflow `run:` value, recovered as shell text.
 *
 * `understood` is false when the value's YAML structure could not be resolved
 * safely — an alias or tag in place of a script, a tab in the indentation, a
 * quoted scalar whose escapes are not modelled, or a block past the size
 * bound. Such a block is reported rather than scanned, because a policy that
 * silently skips what it cannot parse passes exactly the inputs an attacker
 * would choose.
 */
interface RunBlock {
  // 1-based line of the `run:` key, used for a not-understood diagnostic.
  line: number;
  // 1-based line the recovered shell text starts on.
  textLine: number;
  text: string;
  understood: boolean;
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/**
 * Recovers the shell text of every `run:` value in a workflow file.
 *
 * Structure, not appetite, decides how lines are joined: a literal block
 * (`|`) keeps its line breaks, because each line is its own command; a folded
 * block (`>`), a multi-line plain scalar, and a multi-line quoted scalar are
 * joined with a space, because that is what the YAML loader hands the shell.
 * Nothing is stripped from the recovered text — quotes and `#` keep their
 * shell meaning for the command parser to resolve.
 */
function runBlocks(content: string): RunBlock[] {
  const lines = content.split(/\r?\n/);
  const blocks: RunBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const key = RUN_KEY.exec(lines[index] ?? "");
    if (!key) {
      index++;
      continue;
    }
    const column = (key[1] ?? "").length;
    const inline = (key[2] ?? "").trim();
    const line = index + 1;
    // The value's continuation is every following line indented past the key.
    // Blank lines belong to it only when a more-indented line follows.
    const body: string[] = [];
    let last = index;
    let overflow = false;
    // YAML forbids tabs in indentation; one here means the block boundaries
    // this scan computes are not the loader's.
    let tabbed = leadingWhitespace(lines[index] ?? "").includes("\t");
    for (let scan = index + 1; scan < lines.length; scan++) {
      const text = lines[scan] ?? "";
      if (text.trim() === "") {
        body.push("");
        continue;
      }
      const indent = leadingWhitespace(text);
      if (indent.length <= column) break;
      if (indent.includes("\t")) tabbed = true;
      body.push(text);
      last = scan;
      if (body.length > MAX_RUN_BLOCK_LINES) {
        overflow = true;
        break;
      }
    }
    while (body.length > 0 && body[body.length - 1] === "") body.pop();
    index = last + 1;

    const unparsed = (): RunBlock => ({
      line,
      textLine: line,
      text: "",
      understood: false,
    });
    if (overflow || tabbed) {
      blocks.push(unparsed());
      continue;
    }
    const header = BLOCK_HEADER.exec(inline);
    if (header) {
      // An empty block scalar is not an empty script: it means the body was
      // not where this scan looked for it.
      if (body.length === 0) {
        blocks.push(unparsed());
        continue;
      }
      blocks.push({
        line,
        textLine: line + 1,
        text: header[1] === ">" ? body.join(" ") : body.join("\n"),
        understood: true,
      });
      continue;
    }
    if (inline === "") {
      if (body.length === 0) {
        blocks.push(unparsed());
        continue;
      }
      blocks.push({
        line,
        textLine: line + 1,
        text: body.join(" "),
        understood: true,
      });
      continue;
    }
    // An alias, anchor, or tag stands in for content this scan cannot resolve
    // from the file in front of it.
    if (/^[*&!]/.test(inline)) {
      blocks.push(unparsed());
      continue;
    }
    const folded = [inline, ...body].join(" ");
    if (inline.startsWith("'") || inline.startsWith('"')) {
      const scalar = quotedScalar(folded);
      blocks.push(
        scalar === undefined ? unparsed() : {
          line,
          textLine: line,
          text: scalar,
          understood: true,
        },
      );
      continue;
    }
    blocks.push({ line, textLine: line, text: folded, understood: true });
  }
  return blocks;
}

// Resolves a YAML quoted scalar to its content, or nothing when the quoting
// is not the plain case this scan models. A single-quoted scalar escapes only
// by doubling the quote; a double-quoted scalar carries backslash escapes
// whose expansion is not modelled here, so any backslash or interior quote is
// refused instead of guessed at.
function quotedScalar(value: string): string | undefined {
  const quote = value[0];
  if (quote !== "'" && quote !== '"') return undefined;
  if (value.length < 2 || !value.endsWith(quote)) return undefined;
  const inner = value.slice(1, -1);
  if (quote === '"') {
    return inner.includes("\\") || inner.includes('"') ? undefined : inner;
  }
  if ((inner.split("'").length - 1) % 2 !== 0) return undefined;
  return inner.replaceAll("''", "'");
}

/** One logical shell command, split into its pipeline stages. */
interface ShellCommand {
  // 1-based line the command starts on.
  line: number;
  stages: string[];
}

interface ParsedShell {
  commands: ShellCommand[];
  understood: boolean;
}

/**
 * Splits shell text into logical commands and pipeline stages.
 *
 * The scan is a quoting-aware single pass, not a line scan: a backslash
 * before a newline, a newline after a `|`, `&&`, or `||`, and a newline
 * inside a quote, a command substitution, or a backquote all continue the
 * same logical command. `#` opens a comment only at a word start outside
 * quotes, exactly as the shell reads it, so a `#` inside a URL or a quoted
 * string cannot be used to hide the rest of a pipeline from the policy.
 * Quotes are left in the stage text; only a stage's command word is unquoted,
 * and only to name it.
 *
 * `understood` is false when the text ends inside a quote, inside an
 * unclosed substitution, on a dangling escape or operator, or past the size
 * bound — states in which the remaining structure is a guess.
 */
function parseShellCommands(
  text: string,
  firstLine: number,
): ParsedShell {
  if (text.length > MAX_SHELL_TEXT_CHARS) {
    return { commands: [], understood: false };
  }
  const commands: ShellCommand[] = [];
  let stages: string[] = [];
  let stage = "";
  let line = firstLine;
  let commandLine = -1;
  let quote: "'" | '"' | "`" | null = null;
  let depth = 0;
  let pendingOperator = false;
  let danglingEscape = false;
  let bounded = false;

  const beginWord = (): void => {
    if (commandLine < 0) commandLine = line;
  };
  const endStage = (): void => {
    stages.push(stage);
    stage = "";
  };
  const endCommand = (): void => {
    endStage();
    if (stages.some((entry) => entry.trim() !== "")) {
      commands.push({ line: commandLine < 0 ? line : commandLine, stages });
    }
    stages = [];
    commandLine = -1;
  };

  for (let index = 0; index < text.length; index++) {
    if (commands.length >= MAX_SHELL_COMMANDS) {
      bounded = true;
      break;
    }
    const char = text[index] as string;
    const next = text[index + 1];
    if (quote !== null) {
      if (char === "\n") line++;
      // A single-quoted string has no escapes; the other two do.
      if (char === "\\" && quote !== "'" && next !== undefined) {
        if (next === "\n") line++;
        stage += char + next;
        index++;
        continue;
      }
      stage += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\\") {
      if (next === undefined) {
        danglingEscape = true;
        break;
      }
      // A backslash-newline is a line continuation: the logical command runs
      // straight on into the next physical line.
      if (next === "\n") {
        line++;
        index++;
        continue;
      }
      stage += char + next;
      index++;
      pendingOperator = false;
      beginWord();
      continue;
    }
    if (char === "#" && (stage === "" || /\s$/.test(stage))) {
      while (index + 1 < text.length && text[index + 1] !== "\n") index++;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      stage += char;
      pendingOperator = false;
      beginWord();
      continue;
    }
    if (char === "(") {
      depth++;
      stage += char;
      pendingOperator = false;
      beginWord();
      continue;
    }
    if (char === ")") {
      // Clamped, not signed: a `case` arm's unmatched `)` is ordinary syntax,
      // while an unclosed `$(` is the state worth refusing.
      if (depth > 0) depth--;
      stage += char;
      pendingOperator = false;
      beginWord();
      continue;
    }
    if (char === "|") {
      if (next === "|") {
        endCommand();
        index++;
      } else {
        endStage();
      }
      pendingOperator = true;
      continue;
    }
    if (char === "&") {
      if (next === "&") {
        endCommand();
        index++;
        pendingOperator = true;
        continue;
      }
      endCommand();
      pendingOperator = false;
      continue;
    }
    if (char === ";") {
      endCommand();
      pendingOperator = false;
      continue;
    }
    if (char === "\n") {
      line++;
      // A newline after a pipeline or list operator continues the command.
      if (pendingOperator) stage += " ";
      else endCommand();
      continue;
    }
    stage += char;
    if (!/\s/.test(char)) {
      pendingOperator = false;
      beginWord();
    }
  }
  endCommand();
  const understood = !bounded && !danglingEscape && !pendingOperator &&
    quote === null && depth === 0;
  return { commands, understood };
}

// The command word a pipeline stage runs, as a basename. Environment
// assignments and wrappers that exec what follows them are stepped over, and
// the word's own quoting and escaping are removed so `"sh"` and `s\h` name
// the shell they run. Unquoting happens here and nowhere else: it can only
// reveal a command name, never hide a pipeline operator.
function stageCommand(stage: string): string | undefined {
  const tokens = stage.trim().split(/\s+/);
  for (const token of tokens) {
    const bare = token.replace(/["'\\]/g, "");
    if (bare === "") continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(bare)) continue;
    if (bare.startsWith("-")) continue;
    const name = bare.slice(bare.lastIndexOf("/") + 1);
    if (COMMAND_WRAPPERS.has(name)) continue;
    return name;
  }
  return undefined;
}

// True when a fetch stage feeds a later stage that executes its input: the
// downloaded bytes are run as a script with no subject identity.
function pipesFetchIntoShell(command: ShellCommand): boolean {
  let fetched = false;
  for (const stage of command.stages) {
    if (fetched) {
      const name = stageCommand(stage);
      if (name !== undefined && SHELL_COMMANDS.has(name)) return true;
    }
    if (FETCH_COMMAND.test(stage)) fetched = true;
  }
  return false;
}

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
  /(^|\/)\.npmrc$/,
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
  "npm-registry",
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
  "npm-registry",
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
  "npm-registry": [...REGISTRY_EVIDENCE_CONTRACT, INSPECT_BEFORE_APPLY],
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
  const at = (line: number, rule: string): PublicSafetyHit => ({
    path: posixPath(path),
    line,
    rule,
  });
  // Action references and installer URLs are line-shaped: a `uses:` value is
  // one YAML scalar and a URL is one word, so a physical line is the whole
  // claim.
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const uses = USES_LINE.exec(line);
    if (uses) {
      const reference = (uses[1] ?? "")
        .split(/\s+#/)[0]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
      if (!DIGEST_PINNED.test(reference)) {
        hits.push(at(index + 1, "dependency.policy/unpinned-action"));
      }
    }
    if (MUTABLE_URLS.some((pattern) => pattern.test(line))) {
      hits.push(at(index + 1, "dependency.policy/mutable-installer-url"));
    }
    if (hits.length >= MAX_COLLECTED_HITS) break;
  }
  // Network-to-shell is command-shaped, not line-shaped: a YAML block scalar,
  // a folded scalar, and a backslash or trailing-operator continuation all
  // carry one command across several physical lines. Recover the shell text
  // and judge the logical command.
  for (const block of runBlocks(content)) {
    if (hits.length >= MAX_COLLECTED_HITS) break;
    if (!block.understood) {
      hits.push(at(block.line, UNPARSED_SHELL));
      continue;
    }
    const parsed = parseShellCommands(block.text, block.textLine);
    if (!parsed.understood) hits.push(at(block.line, UNPARSED_SHELL));
    for (const command of parsed.commands) {
      if (pipesFetchIntoShell(command)) {
        hits.push(at(command.line, PIPE_TO_SHELL));
      }
      if (hits.length >= MAX_COLLECTED_HITS) break;
    }
  }
  // One deterministic order for a file scanned in two passes.
  hits.sort((left, right) => left.line - right.line);
  return hits.slice(0, MAX_COLLECTED_HITS);
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

const PACKAGE_JSON_PATH = /(^|\/)package\.json$/;
const NPM_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
// An exact semver version, prerelease allowed. Ranges, tags, URLs, paths and
// build metadata are not exact pins.
const EXACT_NPM_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
// npm's `min-release-age` is in days; 3 days is the 72-hour registry floor.
const NPM_MINIMUM_RELEASE_AGE_DAYS = MINIMUM_REGISTRY_AGE_HOURS / 24;

// The effective `key=value` settings of an npmrc: the last assignment of a
// key wins, as npm reads it, and `#` or `;` lines are comments.
function npmrcSettings(content: string): Map<string, string> {
  const settings = new Map<string, string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    settings.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim());
  }
  return settings;
}

// The 1-based line of a dependency's entry, for the diagnostic; line 1 when
// the key cannot be found textually.
function entryLine(content: string, name: string): number {
  const key = JSON.stringify(name);
  const index = content.split(/\r?\n/).findIndex((line) =>
    line.trimStart().startsWith(`${key}:`)
  );
  return index < 0 ? 1 : index + 1;
}

/**
 * Checks one npm package manifest and the files that must sit beside it.
 * `siblings` says whether a `package-lock.json` is tracked in the same
 * directory, and gives the tracked `.npmrc` there, if any.
 */
export function scanNpmPackage(
  path: string,
  content: string,
  siblings: { lockfile: boolean; npmrc: string | undefined },
): PublicSafetyHit[] {
  const at = (line: number, rule: string): PublicSafetyHit => ({
    path: posixPath(path),
    line,
    rule,
  });
  const hits: PublicSafetyHit[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [at(1, "dependency.policy/npm-unparsed-manifest")];
  }
  if (!isPlainObject(parsed)) {
    return [at(1, "dependency.policy/npm-unparsed-manifest")];
  }
  // Overrides replace versions anywhere in the tree, so the exact pins below
  // prove nothing about what they select. Rejected until a policy for them
  // exists.
  if (parsed.overrides !== undefined) {
    hits.push(
      at(
        entryLine(content, "overrides"),
        "dependency.policy/npm-overrides-unsupported",
      ),
    );
  }
  for (const field of NPM_DEPENDENCY_FIELDS) {
    const entries = parsed[field];
    if (entries === undefined) continue;
    if (!isPlainObject(entries)) {
      return [at(1, "dependency.policy/npm-unparsed-manifest")];
    }
    for (const [name, version] of Object.entries(entries)) {
      if (typeof version !== "string" || !EXACT_NPM_VERSION.test(version)) {
        hits.push(
          at(entryLine(content, name), "dependency.policy/npm-range-version"),
        );
      }
      if (hits.length >= MAX_COLLECTED_HITS) return hits;
    }
  }
  if (!siblings.lockfile) {
    hits.push(at(1, "dependency.policy/npm-missing-lockfile"));
  }
  const settings = npmrcSettings(siblings.npmrc ?? "");
  if (settings.get("ignore-scripts") !== "true") {
    hits.push(at(1, "dependency.policy/npm-install-scripts"));
  }
  const age = settings.get("min-release-age") ?? "";
  if (
    !/^\d+$/.test(age) || Number(age) < NPM_MINIMUM_RELEASE_AGE_DAYS
  ) {
    hits.push(at(1, "dependency.policy/npm-release-age"));
  }
  return hits;
}

// A workspace entry npm reads as one directory: relative, no glob, no
// backslash, and no empty, `.` or `..` segment anywhere in the path.
function isWorkspaceDirectory(entry: unknown): boolean {
  return typeof entry === "string" &&
    entry.split("/").every((segment) =>
      /^[A-Za-z0-9._@-]+$/.test(segment) && segment !== "." &&
      segment !== ".."
    );
}

export interface NpmWorkspaces {
  /** Member package.json path to its workspace root's directory prefix. */
  owners: Map<string, string>;
  hits: PublicSafetyHit[];
}

/**
 * Resolves npm workspace membership among the tracked `package.json` files.
 * `packages` maps each tracked package.json path to its content. A member is
 * checked against its workspace root's lockfile and `.npmrc`, because npm
 * installs every workspace from the root and ignores a member's own.
 */
export function npmWorkspaces(
  packages: ReadonlyMap<string, string>,
  tracked: ReadonlySet<string>,
): NpmWorkspaces {
  const owners = new Map<string, string>();
  const hits: PublicSafetyHit[] = [];
  for (const [path, content] of packages) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue; // scanNpmPackage reports the unparsed manifest.
    }
    if (!isPlainObject(parsed) || parsed.workspaces === undefined) continue;
    const dir = path.slice(0, path.length - "package.json".length);
    const entries = parsed.workspaces;
    if (
      !Array.isArray(entries) ||
      !entries.every(isWorkspaceDirectory)
    ) {
      hits.push({
        path,
        line: entryLine(content, "workspaces"),
        rule: "dependency.policy/npm-workspaces-unsupported",
      });
      continue;
    }
    for (const entry of entries as string[]) {
      const member = `${dir}${entry}/package.json`;
      if (packages.has(member)) owners.set(member, dir);
    }
  }
  for (const member of owners.keys()) {
    const memberDir = member.slice(0, member.length - "package.json".length);
    for (const name of [".npmrc", "package-lock.json"]) {
      if (tracked.has(`${memberDir}${name}`)) {
        hits.push({
          path: `${memberDir}${name}`,
          line: 1,
          rule: "dependency.policy/npm-workspace-member-config",
        });
      }
    }
  }
  return { owners, hits };
}

const DEPENDABOT_PATH = ".github/dependabot.yml";
// Dependabot's `cooldown` is in days; 3 days is the 72-hour registry floor.
const DEPENDABOT_COOLDOWN_MINIMUM_DAYS = MINIMUM_REGISTRY_AGE_HOURS / 24;
// The update lanes whose registries the release-age floor governs here.
const COOLDOWN_ECOSYSTEMS: ReadonlySet<string> = new Set(["npm", "deno"]);
// The cooldown keys that set a period. `include` and `exclude` narrow which
// dependencies the cooldown covers, so a lane declaring either lets some
// dependency skip the floor and is rejected.
const COOLDOWN_DAY_KEYS: ReadonlySet<string> = new Set([
  "default-days",
  "semver-major-days",
  "semver-minor-days",
  "semver-patch-days",
]);
const DEPENDABOT_KEY = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/;
// Values that open YAML structure this scan does not follow: flow
// collections, anchors, aliases, tags and block scalars.
const UNFOLLOWED_YAML_VALUE = /^[{[&*!|>]/;
const DEPENDABOT_UNPARSED = "dependency.policy/dependabot-unparsed";

// What may follow a closing quote: nothing, or a comment.
const AFTER_QUOTED_SCALAR = /^(?:\s+#.*)?$/;

/**
 * A plain or quoted YAML scalar with any trailing comment removed, or
 * `undefined` when the scan does not read it. A double-quoted scalar that
 * contains a backslash is not read: YAML decodes escapes there, so
 * `"de\u006eo"` names `deno`, and comparing the undecoded text would let a
 * lane skip the policy. A single-quoted scalar's only escape, `''`, is
 * decoded. A plain scalar has no escapes, but one opening a flow
 * collection, anchor, alias, tag or block scalar is not followed either.
 */
function dependabotScalar(raw: string): string | undefined {
  const value = raw.trim();
  if (value.startsWith('"')) {
    const end = value.indexOf('"', 1);
    if (end < 0) return undefined;
    const text = value.slice(1, end);
    if (text.includes("\\")) return undefined;
    return AFTER_QUOTED_SCALAR.test(value.slice(end + 1)) ? text : undefined;
  }
  if (value.startsWith("'")) {
    let text = "";
    for (let index = 1; index < value.length; index++) {
      const char = value[index];
      if (char !== "'") {
        text += char;
      } else if (value[index + 1] === "'") {
        text += "'";
        index++;
      } else {
        return AFTER_QUOTED_SCALAR.test(value.slice(index + 1))
          ? text
          : undefined;
      }
    }
    return undefined;
  }
  if (UNFOLLOWED_YAML_VALUE.test(value)) return undefined;
  return value.replace(/\s+#.*$/, "");
}

interface UpdateLane {
  line: number;
  keys: Map<string, string>;
  cooldown: Map<string, string> | undefined;
}

/**
 * Reads the `updates` lanes of a Dependabot config. The scan follows only
 * the block-style shape this repository writes: a top-level `updates:`
 * sequence of mappings, scalar values, and one nested `cooldown:` mapping.
 * A lane key, a cooldown key, or a scalar value outside that shape is
 * reported as not understood rather than skipped. Blocks nested under any
 * other lane key (`schedule`, `ignore`, `groups`) are not read, because no
 * policy decision depends on them.
 */
function dependabotLanes(
  content: string,
): { lanes: UpdateLane[]; unparsedLines: number[] } {
  const lanes: UpdateLane[] = [];
  const unparsedLines: number[] = [];
  const lines = content.split(/\r?\n/);
  let inUpdates = false;
  let sawUpdates = false;
  let entryIndent = -1;
  let keyIndent = -1;
  let cooldownIndent = -1;
  let lane: UpdateLane | undefined;
  let lastField: string | undefined;

  const readKey = (text: string, lineNumber: number): void => {
    const match = DEPENDABOT_KEY.exec(text);
    if (!lane || !match) {
      unparsedLines.push(lineNumber);
      return;
    }
    const key = match[1] ?? "";
    const value = dependabotScalar(match[2] ?? "");
    if (lane.keys.has(key) || value === undefined) {
      unparsedLines.push(lineNumber);
      return;
    }
    if (key === "cooldown") {
      if (value !== "") unparsedLines.push(lineNumber);
      lane.cooldown = new Map();
      cooldownIndent = -1;
    }
    lane.keys.set(key, value);
    lastField = key;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indentText = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (indentText.includes("\t")) {
      unparsedLines.push(lineNumber);
      continue;
    }
    const indent = indentText.length;
    if (indent === 0) {
      lane = undefined;
      inUpdates = /^updates:/.test(trimmed);
      if (inUpdates) {
        sawUpdates = true;
        if (dependabotScalar(trimmed.slice("updates:".length)) !== "") {
          unparsedLines.push(lineNumber);
          inUpdates = false;
        }
      }
      continue;
    }
    if (!inUpdates) continue;
    const dash = /^(\s*-\s+)(.*)$/.exec(line);
    if (dash && (entryIndent < 0 || indent === entryIndent)) {
      entryIndent = indent;
      keyIndent = (dash[1] ?? "").length;
      lane = { line: lineNumber, keys: new Map(), cooldown: undefined };
      lanes.push(lane);
      lastField = undefined;
      readKey((dash[2] ?? "").trim(), lineNumber);
      continue;
    }
    if (indent === keyIndent) {
      readKey(trimmed, lineNumber);
      continue;
    }
    if (indent < keyIndent || !lane) {
      unparsedLines.push(lineNumber);
      continue;
    }
    // Nested under the lane's last key. Only `cooldown` is read; the
    // nested lists of its `include` and `exclude` keys sit deeper still.
    if (lastField !== "cooldown" || !lane.cooldown) continue;
    if (cooldownIndent < 0) cooldownIndent = indent;
    if (indent > cooldownIndent) continue;
    const match = DEPENDABOT_KEY.exec(trimmed);
    const value = dependabotScalar(match?.[2] ?? "");
    if (
      indent < cooldownIndent || !match ||
      lane.cooldown.has(match[1] ?? "") || value === undefined
    ) {
      unparsedLines.push(lineNumber);
      continue;
    }
    lane.cooldown.set(match[1] ?? "", value);
  }
  if (!sawUpdates || lanes.length === 0) unparsedLines.push(1);
  for (const each of lanes) {
    if (!each.keys.get("package-ecosystem")) unparsedLines.push(each.line);
  }
  return { lanes, unparsedLines };
}

// A cooldown holds the floor when it sets a default period and every period
// it sets is at least the floor, with no dependency carved out of it.
function cooldownHoldsFloor(
  cooldown: Map<string, string> | undefined,
): boolean {
  if (!cooldown || !cooldown.has("default-days")) return false;
  for (const [key, value] of cooldown) {
    if (!COOLDOWN_DAY_KEYS.has(key)) return false;
    if (
      !/^\d+$/.test(value) || Number(value) < DEPENDABOT_COOLDOWN_MINIMUM_DAYS
    ) {
      return false;
    }
  }
  return true;
}

// The Dependabot `directory` that watches a package.json at this path.
function dependabotDirectoryFor(packagePath: string): string {
  const dir = posixPath(packagePath).slice(0, -"package.json".length);
  return `/${dir.replace(/\/$/, "")}`;
}

/**
 * Checks the Dependabot update configuration against the npm surfaces it
 * must watch. Every tracked `package.json` needs an npm lane for its
 * directory, so the shipped dependency tree gets update pull requests. The
 * npm and deno lanes must declare a cooldown of at least the 72-hour
 * registry floor, so a bot pull request never proposes a release younger
 * than `min-release-age` would install. The npm lane must use the
 * `increase` versioning strategy, which rewrites an exact pin to the new
 * exact version, so a bot pull request keeps the exact-pin rule above.
 */
export function scanDependabotText(
  path: string,
  content: string,
  packagePaths: readonly string[],
): PublicSafetyHit[] {
  const at = (file: string, line: number, rule: string): PublicSafetyHit => ({
    path: posixPath(file),
    line,
    rule,
  });
  const { lanes, unparsedLines } = dependabotLanes(content);
  // One diagnostic per line, however many ways the line was not understood.
  const hits: PublicSafetyHit[] = [...new Set(unparsedLines)]
    .map((line) => at(path, line, DEPENDABOT_UNPARSED));
  const npmDirectories = new Set<string>();
  for (const lane of lanes) {
    const ecosystem = lane.keys.get("package-ecosystem") ?? "";
    if (
      COOLDOWN_ECOSYSTEMS.has(ecosystem) && !cooldownHoldsFloor(lane.cooldown)
    ) {
      hits.push(at(path, lane.line, "dependency.policy/dependabot-cooldown"));
    }
    if (ecosystem !== "npm") continue;
    if (lane.keys.get("versioning-strategy") !== "increase") {
      hits.push(
        at(path, lane.line, "dependency.policy/dependabot-versioning-strategy"),
      );
    }
    const directory = lane.keys.get("directory") ?? "";
    npmDirectories.add(directory === "/" ? "/" : directory.replace(/\/$/, ""));
  }
  for (const packagePath of packagePaths) {
    if (!npmDirectories.has(dependabotDirectoryFor(packagePath))) {
      hits.push(
        at(packagePath, 1, "dependency.policy/dependabot-npm-unwatched"),
      );
    }
  }
  hits.sort((left, right) =>
    left.path === right.path
      ? left.line - right.line
      : left.path < right.path
      ? -1
      : 1
  );
  return hits.slice(0, MAX_COLLECTED_HITS);
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
  const trackedSet = new Set(tracked.map((path) => posixPath(path)));
  const packages = new Map<string, string>();
  for (const path of [...trackedSet].sort()) {
    if (!PACKAGE_JSON_PATH.test(path)) continue;
    packages.set(
      path,
      new TextDecoder().decode(await readTrackedFile(root, path, LABEL)),
    );
  }
  const workspaces = npmWorkspaces(packages, trackedSet);
  hits.push(...workspaces.hits);
  for (const [path, content] of packages) {
    // A workspace member installs from its root: the root's lockfile and
    // npmrc are the ones npm uses.
    const dir = workspaces.owners.get(path) ??
      path.slice(0, path.length - "package.json".length);
    const npmrcPath = `${dir}.npmrc`;
    const npmrc = trackedSet.has(npmrcPath)
      ? new TextDecoder().decode(
        await readTrackedFile(root, npmrcPath, LABEL),
      )
      : undefined;
    hits.push(...scanNpmPackage(path, content, {
      lockfile: trackedSet.has(`${dir}package-lock.json`),
      npmrc,
    }));
    if (hits.length >= MAX_COLLECTED_HITS) return hits;
  }
  // Dependabot's npm lane for a workspace root also updates its members, so
  // only packages outside every workspace need a lane of their own.
  const packagePaths = [...packages.keys()]
    .filter((path) => !workspaces.owners.has(path));
  const dependabot = trackedSet.has(DEPENDABOT_PATH)
    ? new TextDecoder().decode(
      await readTrackedFile(root, DEPENDABOT_PATH, LABEL),
    )
    : "";
  hits.push(...scanDependabotText(DEPENDABOT_PATH, dependabot, packagePaths));
  return hits.slice(0, MAX_COLLECTED_HITS);
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
