import path from "node:path";
import { summarizeError } from "./turn-contract";

export interface ContextSource {
  kind: "file" | "command";
  label: string;
  path: string;
}

export type ContextBucket = "system" | "active_repo" | "derived_memory";

export interface ContextSection {
  title: string;
  body: string;
  bucket?: ContextBucket;
  source?: ContextSource;
  tokenEstimate?: number;
  originalTokenEstimate?: number;
  truncated?: boolean;
}

export interface LoadedRepoContext {
  sources: ContextSource[];
  sections: ContextSection[];
  budget: PackedContextSummary;
  profile: AskContextProfile;
}

export interface ContextBudget {
  totalTokens: number;
  systemPercent: number;
  activeRepoPercent: number;
  derivedMemoryPercent: number;
  headroomPercent: number;
}

export interface PackedContextSummary {
  totalTokens: number;
  usedTokens: number;
  headroomTokens: number;
  byBucket: Record<ContextBucket, {
    limitTokens: number;
    usedTokens: number;
  }>;
}

export interface PackedContext {
  sources: ContextSource[];
  sections: ContextSection[];
  summary: PackedContextSummary;
}

export type AskContextProfile = "compact" | "full";

const WORKBENCH_NOTE_PATHS = [
  "notes/workbench-mvp-loop.md",
  "notes/cost-visibility-surface.md",
  "notes/events-as-substrate.md",
];

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  totalTokens: 5_000,
  systemPercent: 0.2,
  activeRepoPercent: 0.5,
  derivedMemoryPercent: 0.2,
  headroomPercent: 0.1,
};

export const COMPACT_CONTEXT_BUDGET: ContextBudget = {
  totalTokens: 500,
  systemPercent: 0.4,
  activeRepoPercent: 0.5,
  derivedMemoryPercent: 0.0,
  headroomPercent: 0.1,
};

export function extractReadmeSection1(readme: string): string {
  const start = readme.search(/^## 1\. Decisions\s*$/m);
  if (start === -1) {
    throw new Error("README.md Section 1 not found");
  }
  const rest = readme.slice(start);
  const next = rest.search(/^## 2\.\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

export function buildContextSourceLines(sources: ContextSource[]): string[] {
  return sources.map((source) => `${source.label} <${source.path}>`);
}

// basePrompt is the authored companion persona, loaded from the prompts table
// (see prompts.ts / schema/catalog/002_prompts.sql). This builder composes it
// with the live, untrusted repo context below — the persona is no longer
// hardcoded here.
export function buildAskSystemPrompt(
  basePrompt: string,
  context: LoadedRepoContext,
): string {
  const parts = [
    basePrompt.trim(),
    "",
    `Context budget: ${context.budget.usedTokens}/${context.budget.totalTokens} estimated tokens ` +
    `(${context.budget.headroomTokens} reserved headroom).`,
    "",
    "Context sources used:",
    ...buildContextSourceLines(context.sources).map((source) => `- ${source}`),
    "",
  ];

  for (const section of context.sections) {
    parts.push(`## ${section.title}`);
    parts.push(section.body.trim());
    parts.push("");
  }

  return parts.join("\n").trim();
}

export function estimateContextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function packContextSections(
  sections: ContextSection[],
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
): PackedContext {
  const summary: PackedContextSummary = buildBudgetSummary(budget);
  const packedSections: ContextSection[] = [];
  const sources: ContextSource[] = [];

  for (const section of sections) {
    const bucket = section.bucket ?? "active_repo";
    const bucketSummary = summary.byBucket[bucket];
    const remaining = bucketSummary.limitTokens - bucketSummary.usedTokens;
    if (remaining <= 0) continue;

    const originalTokenEstimate = estimateSectionTokens(
      section.title,
      section.body,
    );
    const body = originalTokenEstimate <= remaining
      ? section.body
      : truncateSectionBody(section.title, section.body, remaining);
    const tokenEstimate = estimateSectionTokens(section.title, body);
    if (
      body.trim().length === 0 || tokenEstimate <= 0 ||
      tokenEstimate > remaining
    ) continue;

    const packedSection = {
      ...section,
      bucket,
      body,
      tokenEstimate,
      originalTokenEstimate,
      truncated: tokenEstimate < originalTokenEstimate,
    };
    packedSections.push(packedSection);
    bucketSummary.usedTokens += tokenEstimate;
    summary.usedTokens += tokenEstimate;

    if (
      section.source &&
      !sources.some((source) =>
        source.label === section.source?.label &&
        source.path === section.source?.path
      )
    ) {
      sources.push(section.source);
    }
  }

  return { sources, sections: packedSections, summary };
}

function buildBudgetSummary(budget: ContextBudget): PackedContextSummary {
  return {
    totalTokens: budget.totalTokens,
    usedTokens: 0,
    headroomTokens: Math.floor(budget.totalTokens * budget.headroomPercent),
    byBucket: {
      system: {
        limitTokens: Math.floor(budget.totalTokens * budget.systemPercent),
        usedTokens: 0,
      },
      active_repo: {
        limitTokens: Math.floor(budget.totalTokens * budget.activeRepoPercent),
        usedTokens: 0,
      },
      derived_memory: {
        limitTokens: Math.floor(
          budget.totalTokens * budget.derivedMemoryPercent,
        ),
        usedTokens: 0,
      },
    },
  };
}

function estimateSectionTokens(title: string, body: string): number {
  return estimateContextTokens(`## ${title}\n${body.trim()}`);
}

function truncateSectionBody(
  title: string,
  body: string,
  limitTokens: number,
): string {
  const titleTokens = estimateContextTokens(`## ${title}\n`);
  const bodyTokenLimit = Math.max(0, limitTokens - titleTokens);
  return body.slice(0, bodyTokenLimit * 4).trimEnd();
}

export interface AgentsInstructions {
  body: string;
  source: ContextSource;
}

// The agent-mode instructions budget. Unlike ask-mode — where AGENTS.md rides
// the packed-section machinery under a shared ContextBudget — the companion
// injection is a single section, so it carries its own cap. The system prompt
// is never compressed (the compressor's contract covers conversation turns
// only), so an unbounded body here would be a silent per-turn tax for the
// session's whole life. 4,000 tokens (~16KB) passes real instruction files
// with room to spare; it exists to bound pathology, not to trim normal repos.
export const AGENTS_INSTRUCTIONS_TOKEN_LIMIT = 4_000;

// The read bound (advisory to the token cap): the file is read through a
// fixed-size buffer, never whole-file, so a pathological AGENTS.md cannot
// consume unbounded memory before truncation. 64KB is 4x the token cap's
// worst-case character count; a permissive-decode artifact at the clip
// boundary cannot survive, because the token truncation slices far below it.
export const AGENTS_INSTRUCTIONS_MAX_READ_BYTES = 64 * 1024;

async function readBoundedTextFrom(
  file: Deno.FsFile,
  maxBytes: number,
): Promise<string> {
  const buf = new Uint8Array(maxBytes);
  let filled = 0;
  while (filled < buf.length) {
    const n = await file.read(buf.subarray(filled));
    if (n === null) break;
    filled += n;
  }
  return new TextDecoder("utf-8").decode(buf.subarray(0, filled));
}

// Agent-mode (companion) instructions discovery — CONTAINED to the selected
// workspace root, deliberately narrower than ask-mode's repo walk-up:
//
// - No upward discovery. Only `<workspaceRoot>/AGENTS.md` is considered, so
//   content from outside the operator-selected workspace (an unrelated
//   marker-bearing ancestor) can never enter the model request. A workspace
//   that is a subdirectory of a larger repo degrades to graceful absence;
//   richer boundary semantics are a separate design question (walk-up vs
//   fence), not this loader's.
// - The root is canonicalized and the candidate is checked with lstat (a
//   symlinked AGENTS.md is rejected), and the check is coupled to the read:
//   the opened handle's device+inode must match the checked identity, so a
//   path swapped between check and open is refused. The receipt's
//   workspace-local provenance is verified, not assumed.
// - Absence (no file) is silent null. Any OTHER failure — permissions, I/O —
//   also returns null so the session proceeds, but logs a summarized warning:
//   a failure must not masquerade as "this workspace has no instructions".
// - The body is read through a bounded buffer and token-truncated; an
//   over-budget body carries an explicit marker and the source label flips to
//   "AGENTS.md excerpt" (the compact-profile precedent) so the receipt
//   reports what actually entered the prompt. A read clipped at the byte
//   bound is flagged as truncation in its own right: when the clipped window
//   ends in a whitespace run, the token slice and `trimEnd()` alone would
//   report the full file while content past the bound was dropped.
export async function loadAgentsInstructions(
  startDir: string,
): Promise<AgentsInstructions | null> {
  let candidate: string;
  let checked: Deno.FileInfo;
  try {
    const root = await Deno.realPath(startDir);
    candidate = path.join(root, "AGENTS.md");
    checked = await Deno.lstat(candidate);
    if (!checked.isFile) {
      // A symlink (or anything else non-regular) named AGENTS.md could point
      // outside the workspace; refusing it keeps discovery contained and the
      // receipt's workspace-local provenance honest.
      console.warn(
        "AGENTS.md skipped: not a regular file in the workspace root",
      );
      return null;
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    console.warn(`AGENTS.md discovery failed: ${summarizeError(err)}`);
    return null;
  }
  try {
    const file = await Deno.open(candidate, { read: true });
    let body: string;
    let readClipped: boolean;
    try {
      // TOCTOU guard: the no-follow lstat above and this open are two
      // operations on a PATHNAME, and a concurrent swap between them could
      // replace the checked regular file with a symlink the open would
      // follow. So the check is coupled to the opened file: the OPEN
      // HANDLE's identity (device + inode) must match what lstat checked,
      // or the file is refused. Identity unavailable (non-POSIX) also
      // refuses — fail closed rather than read an unverified file.
      const opened = await file.stat();
      if (
        checked.dev === null || checked.ino === null ||
        opened.dev !== checked.dev || opened.ino !== checked.ino
      ) {
        console.warn(
          "AGENTS.md skipped: file identity changed between check and open",
        );
        return null;
      }
      // The verified handle's size says whether the bounded read dropped
      // bytes. The string comparison below cannot detect this on its own:
      // if the clipped window ends in a whitespace run, `trimEnd()` erases
      // the evidence and the loader would report the full file.
      readClipped = opened.size > AGENTS_INSTRUCTIONS_MAX_READ_BYTES;
      body = await readBoundedTextFrom(
        file,
        AGENTS_INSTRUCTIONS_MAX_READ_BYTES,
      );
    } finally {
      file.close();
    }
    const capped = truncateSectionBody(
      "AGENTS.md",
      body,
      AGENTS_INSTRUCTIONS_TOKEN_LIMIT,
    );
    if (!readClipped && capped === body.trimEnd()) {
      return {
        body,
        source: { kind: "file", label: "AGENTS.md", path: "AGENTS.md" },
      };
    }
    // The marker states the excerpt's budget, not the cut location — the cut
    // may be the token cap or the byte bound, and both land here.
    return {
      body:
        `${capped}\n\n[AGENTS.md truncated to the ~${AGENTS_INSTRUCTIONS_TOKEN_LIMIT}-token instructions budget; read AGENTS.md in the workspace for the rest]`,
      source: { kind: "file", label: "AGENTS.md excerpt", path: "AGENTS.md" },
    };
  } catch (err) {
    console.warn(`AGENTS.md read failed: ${summarizeError(err)}`);
    return null;
  }
}

export async function findRepoRoot(startDir = Deno.cwd()): Promise<string> {
  let current = path.resolve(startDir);
  while (true) {
    try {
      const agents = await Deno.stat(path.join(current, "AGENTS.md"));
      const readme = await Deno.stat(path.join(current, "README.md"));
      if (agents.isFile && readme.isFile) return current;
    } catch {
      // Keep walking.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not find DYFJ repo root from ${startDir}`);
    }
    current = parent;
  }
}

export async function loadAskRepoContext(options: {
  repoRoot?: string;
  budget?: ContextBudget;
  profile?: AskContextProfile;
} = {}): Promise<LoadedRepoContext> {
  const repoRoot = options.repoRoot ?? await findRepoRoot();
  const profile = options.profile ?? askContextProfileFromEnv();
  const sections: ContextSection[] = [];

  const agents = await readRepoFile(repoRoot, "AGENTS.md");
  sections.push({
    title: profile === "compact" ? "AGENTS.md excerpt" : "AGENTS.md",
    body: profile === "compact" ? buildAgentsExcerpt(agents) : agents,
    bucket: "system",
    source: { kind: "file", label: "AGENTS.md", path: "AGENTS.md" },
  });

  const readme = await readRepoFile(repoRoot, "README.md");
  const readmeSection1 = extractReadmeSection1(readme);
  sections.push({
    title: profile === "compact"
      ? "README.md Section 1 excerpt"
      : "README.md Section 1",
    body: profile === "compact"
      ? buildReadmeSection1Excerpt(readmeSection1)
      : readmeSection1,
    bucket: "system",
    source: {
      kind: "file",
      label: "README.md Section 1",
      path: "README.md#section-1",
    },
  });

  for (const notePath of WORKBENCH_NOTE_PATHS) {
    const body = await readRepoFile(repoRoot, notePath);
    sections.push({
      title: profile === "compact" ? `${notePath} excerpt` : notePath,
      body: profile === "compact" ? buildNoteExcerpt(notePath, body) : body,
      bucket: "active_repo",
      source: { kind: "file", label: notePath, path: notePath },
    });
  }

  const packed = packContextSections(
    sections,
    options.budget ?? contextBudgetFromEnv(profile),
  );
  return {
    sources: packed.sources,
    sections: packed.sections,
    budget: packed.summary,
    profile,
  };
}

export function askContextProfileFromEnv(): AskContextProfile {
  const rawProfile = Deno.env.get("DYFJ_WORKBENCH_CONTEXT_PROFILE");
  return rawProfile === "full" ? "full" : "compact";
}

function contextBudgetFromEnv(profile: AskContextProfile): ContextBudget {
  const baseBudget = profile === "full"
    ? DEFAULT_CONTEXT_BUDGET
    : COMPACT_CONTEXT_BUDGET;
  const rawTotal = Deno.env.get("DYFJ_WORKBENCH_CONTEXT_TOKENS");
  const totalTokens = rawTotal === undefined
    ? baseBudget.totalTokens
    : Number(rawTotal);
  return {
    ...baseBudget,
    totalTokens: Number.isFinite(totalTokens) && totalTokens > 0
      ? Math.floor(totalTokens)
      : baseBudget.totalTokens,
  };
}

function buildAgentsExcerpt(agents: string): string {
  const projectDoc = agents.split("--- project-doc ---").at(1)?.trim() ??
    agents;
  return firstMatchingLines(projectDoc, [
    "README.md",
    "Section 1",
    "authoritative",
    "private tracker",
    "Acyclic",
    "DAGs",
  ], 280);
}

function buildReadmeSection1Excerpt(section: string): string {
  return firstMatchingLines(section, [
    "## 1. Decisions",
    "Layer 0",
    "Goal 1",
    "local-first",
    "policy",
    "authority",
    "boundaries",
  ], 450);
}

function buildNoteExcerpt(notePath: string, body: string): string {
  const hints = notePath.includes("cost")
    ? ["cost", "paid", "budget", "receipt", "tier"]
    : notePath.includes("events")
    ? ["event", "trace", "receipt", "session"]
    : ["workbench", "loop", "companion", "repo", "next"];
  return firstMatchingLines(body, hints, 500);
}

function firstMatchingLines(
  body: string,
  hints: string[],
  maxChars: number,
): string {
  const loweredHints = hints.map((hint) => hint.toLowerCase());
  const selected: string[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const lowered = trimmed.toLowerCase();
    if (loweredHints.some((hint) => lowered.includes(hint))) {
      selected.push(trimmed);
    }
    const joined = selected.join("\n");
    if (joined.length >= maxChars) return joined.slice(0, maxChars).trimEnd();
  }

  return body.trim().slice(0, maxChars).trimEnd();
}

async function readRepoFile(
  repoRoot: string,
  relativePath: string,
): Promise<string> {
  return await Deno.readTextFile(path.join(repoRoot, relativePath));
}
