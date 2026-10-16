// The `ratchet.base` gate lane: the committed ratchet lists are compared with
// the same lists at the merge base, so an entry cannot grow, or appear,
// without that being visible in the change itself.
//
// The lanes that own each list check it against the tree in the same
// checkout (`runtime-neutral.ts`; `arch-imports.ts` with
// `arch-imports-size.ts`). That alone cannot stop a change from raising an
// entry together with the code that needs it. This lane closes that gap:
//
// - `scripts/runtime-neutral-exceptions.json` and
//   `scripts/arch-size-exceptions.json`: an entry whose `count` or `lines`
//   rose above its value at the base, or that is not at the base at all,
//   fails unless it carries a `growth_reason` that is new in this change (a
//   non-empty string that differs from the entry's `growth_reason` at the
//   base). Each accepted growth is printed with its reason, so review and the
//   publish gate see it.
// - `scripts/arch-imports-baseline.json`: empty, and it stays so. Any entry
//   that is not at the base fails, with no override.
//
// The base is the merge base of HEAD and the bound range base
// (`DYFJ_GATE_RANGE_BASE`, which CI always sets and validates as in
// `release-range.ts`). Without a binding the lane falls back to the merge
// base with `origin/main`. Either way it prints the commit and how it found
// it. When no base can be found (no `origin/main`, or a shallow clone
// without the shared history) it fails closed in CI and reports a skip in
// local runs.
//
// Written to node: builtins only.
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { type EnvReader, resolveRangeBase } from "./release-range.ts";
import { gitOutput, repoRootFromMeta, sanitizeForLog } from "./scan-lib.ts";

export const LABEL = "ratchet.base";
export const RUNTIME_NEUTRAL_PATH = "scripts/runtime-neutral-exceptions.json";
export const SIZE_EXCEPTIONS_PATH = "scripts/arch-size-exceptions.json";
export const ARCH_BASELINE_PATH = "scripts/arch-imports-baseline.json";

const FULL_SHA = /^[0-9a-f]{40}$/;
const FALLBACK_REF = "origin/main";

export interface GrowthResult {
  /** Growth that has no new `growth_reason`, and malformed reasons. */
  errors: string[];
  /** Growth that carries a new `growth_reason`, with the reason. */
  accepted: string[];
}

interface Measured {
  key: string;
  value: number;
  growthReason: unknown;
}

function objects(list: unknown): Record<string, unknown>[] {
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is Record<string, unknown> =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
  );
}

function reasonText(reason: string): string {
  return sanitizeForLog(reason, 300);
}

// Entries are matched by key. The owning lane rejects malformed and
// duplicate entries, so an entry without a usable key or value is skipped
// here rather than reported twice.
function growth(
  base: readonly Measured[],
  current: readonly Measured[],
  field: string,
): GrowthResult {
  const before = new Map(base.map((entry) => [entry.key, entry]));
  const errors: string[] = [];
  const accepted: string[] = [];
  for (const entry of current) {
    const previous = before.get(entry.key);
    if (previous !== undefined && entry.value <= previous.value) continue;
    const change = previous === undefined
      ? `${entry.key}: new entry (${entry.value})`
      : `${entry.key}: ${field} grew from ${previous.value} to ${entry.value}`;
    const reason = entry.growthReason;
    if (reason === undefined || reason === previous?.growthReason) {
      errors.push(
        `${change}; it may only shrink, unless the entry carries a ` +
          "growth_reason added in this change",
      );
    } else if (typeof reason !== "string" || reason.trim() === "") {
      errors.push(`${change}; its growth_reason must be a non-empty string`);
    } else {
      accepted.push(`${change}: ${reasonText(reason)}`);
    }
  }
  return { errors, accepted };
}

function measuredNeutral(list: unknown): Measured[] {
  return objects(list).flatMap((entry) =>
    typeof entry.path === "string" && Number.isSafeInteger(entry.count)
      ? [{
        key: entry.path,
        value: entry.count as number,
        growthReason: entry.growth_reason,
      }]
      : []
  );
}

function measuredSize(list: unknown): Measured[] {
  return objects(list).flatMap((entry) => {
    if (typeof entry.path !== "string" || !Number.isSafeInteger(entry.lines)) {
      return [];
    }
    const key = entry.kind === "function"
      ? `function ${entry.path} ${String(entry.name)}`
      : `module ${entry.path}`;
    return [{
      key,
      value: entry.lines as number,
      growthReason: entry.growth_reason,
    }];
  });
}

/** `runtime-neutral-exceptions.json` at the base against the current list. */
export function runtimeNeutralGrowth(
  base: unknown,
  current: unknown,
): GrowthResult {
  return growth(measuredNeutral(base), measuredNeutral(current), "count");
}

/** `arch-size-exceptions.json` at the base against the current list. */
export function sizeExceptionGrowth(
  base: unknown,
  current: unknown,
): GrowthResult {
  return growth(measuredSize(base), measuredSize(current), "lines");
}

function archEntries(baseline: unknown): Map<string, string> {
  const entries = new Map<string, string>();
  if (typeof baseline !== "object" || baseline === null) return entries;
  for (const [kind, list] of Object.entries(baseline)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const text = typeof item === "string" ? item : JSON.stringify(item);
      entries.set(`${kind} ${text}`, kind);
    }
  }
  return entries;
}

/** New entries in `arch-imports-baseline.json`; there is no override. */
export function archBaselineGrowth(base: unknown, current: unknown): string[] {
  const before = archEntries(base);
  const errors: string[] = [];
  for (const [key, kind] of archEntries(current)) {
    if (before.has(key)) continue;
    errors.push(
      `new ${kind} entry in ${ARCH_BASELINE_PATH}; the baseline must stay ` +
        "empty: fix the violation instead of recording it",
    );
  }
  return errors;
}

export type BaseResolution =
  | { kind: "resolved"; commit: string; source: "env" | "origin/main" }
  | { kind: "unresolved"; reason: string };

async function mergeBase(
  root: string,
  ref: string,
  gitCommand: string,
): Promise<string | undefined> {
  const result = await gitOutput(
    root,
    ["merge-base", ref, "HEAD"],
    LABEL,
    gitCommand,
  );
  if (!result.success) return undefined;
  const commit = new TextDecoder().decode(result.stdout).trim();
  return FULL_SHA.test(commit) ? commit : undefined;
}

/**
 * The commit the lists are compared against. A malformed binding, or a CI
 * run without one, throws (value-free) through `resolveRangeBase`.
 */
export async function resolveRatchetBase(
  root: string,
  env: EnvReader,
  gitCommand = "git",
): Promise<BaseResolution> {
  const { base } = resolveRangeBase(env);
  if (base !== undefined) {
    const commit = await mergeBase(root, base, gitCommand);
    return commit === undefined
      ? {
        kind: "unresolved",
        reason: `no merge base of DYFJ_GATE_RANGE_BASE ${base} and HEAD ` +
          "(a shallow clone, or unrelated history)",
      }
      : { kind: "resolved", commit, source: "env" };
  }
  const commit = await mergeBase(root, FALLBACK_REF, gitCommand);
  return commit === undefined
    ? {
      kind: "unresolved",
      reason: `DYFJ_GATE_RANGE_BASE is unset and there is no merge base ` +
        `with ${FALLBACK_REF}`,
    }
    : { kind: "resolved", commit, source: "origin/main" };
}

async function listAt(
  root: string,
  commit: string,
  path: string,
  gitCommand: string,
): Promise<unknown> {
  const exists = await gitOutput(
    root,
    ["cat-file", "-e", `${commit}:${path}`],
    LABEL,
    gitCommand,
  );
  // A list the base does not have yet compares as empty: every entry is new.
  if (!exists.success) return [];
  const shown = await gitOutput(
    root,
    ["show", `${commit}:${path}`],
    LABEL,
    gitCommand,
  );
  if (!shown.success) {
    throw new Error(`${LABEL}: cannot read ${path} at the base`);
  }
  return parseList(
    new TextDecoder().decode(shown.stdout),
    `${path} at the base`,
  );
}

async function listNow(root: string, path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(`${root}/${path}`, "utf8");
  } catch {
    // The owning lane fails on a missing list; here it has nothing to grow.
    return [];
  }
  return parseList(text, path);
}

function parseList(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${LABEL}: ${where} is not valid JSON`);
  }
}

function describeBase(resolution: { commit: string; source: string }): string {
  return resolution.source === "env"
    ? "merge base of DYFJ_GATE_RANGE_BASE and HEAD"
    : `merge base of ${FALLBACK_REF} and HEAD; DYFJ_GATE_RANGE_BASE is ` +
      "unset, so this is the local fallback";
}

export async function runRatchetBase(
  root: string,
  env: EnvReader,
  out: Pick<Console, "log" | "error"> = console,
  gitCommand = "git",
): Promise<number> {
  const ci = env("GITHUB_ACTIONS") === "true";
  let resolution: BaseResolution;
  try {
    resolution = await resolveRatchetBase(root, env, gitCommand);
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error));
    out.error(`${LABEL}: no base to compare against; failing closed`);
    return 1;
  }
  if (resolution.kind === "unresolved") {
    const reason = sanitizeForLog(resolution.reason, 300);
    if (ci) {
      out.error(`${LABEL}: ${reason}; failing closed`);
      return 1;
    }
    out.log(
      `${LABEL}: skipped: ${reason}. Local feedback only; CI fails closed ` +
        "here",
    );
    return 0;
  }
  out.log(
    `${LABEL}: comparing against ${resolution.commit} ` +
      `(${describeBase(resolution)})`,
  );
  const errors: string[] = [];
  const accepted: string[] = [];
  const compare = async (
    path: string,
    check: (base: unknown, current: unknown) => GrowthResult,
  ) => {
    const result = check(
      await listAt(root, resolution.commit, path, gitCommand),
      await listNow(root, path),
    );
    errors.push(...result.errors.map((error) => `${path}: ${error}`));
    accepted.push(...result.accepted.map((line) => `${path}: ${line}`));
  };
  await compare(RUNTIME_NEUTRAL_PATH, runtimeNeutralGrowth);
  await compare(SIZE_EXCEPTIONS_PATH, sizeExceptionGrowth);
  errors.push(
    ...archBaselineGrowth(
      await listAt(root, resolution.commit, ARCH_BASELINE_PATH, gitCommand),
      await listNow(root, ARCH_BASELINE_PATH),
    ),
  );
  for (const line of accepted) {
    out.log(`${LABEL}: accepted growth: ${line}`);
  }
  if (errors.length > 0) {
    for (const error of errors) out.error(`${LABEL}: ${error}`);
    return 1;
  }
  out.log(
    `${LABEL}: no entry grew without a growth_reason ` +
      `(${accepted.length} accepted)`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runRatchetBase(
      repoRootFromMeta(),
      (name) => process.env[name],
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
