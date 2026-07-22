import path from "node:path";

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

// Agent-mode (companion) injection: reuse the same walk-up discovery as
// ask-mode (findRepoRoot requires AGENTS.md + README.md sibling markers),
// but return only the AGENTS.md body — no README section, no notes, no
// profile/budget packing. Returns null when no AGENTS.md exists at/above
// startDir so callers can omit the source gracefully. An over-budget body is
// truncated with an explicit marker, and the source label flips to
// "AGENTS.md excerpt" (the compact-profile precedent) so the receipt reports
// what actually entered the prompt.
export async function loadAgentsInstructions(
  startDir: string,
): Promise<AgentsInstructions | null> {
  try {
    const repoRoot = await findRepoRoot(startDir);
    const body = await readRepoFile(repoRoot, "AGENTS.md");
    const capped = truncateSectionBody(
      "AGENTS.md",
      body,
      AGENTS_INSTRUCTIONS_TOKEN_LIMIT,
    );
    if (capped === body.trimEnd()) {
      return {
        body,
        source: { kind: "file", label: "AGENTS.md", path: "AGENTS.md" },
      };
    }
    return {
      body: `${capped}\n\n[AGENTS.md truncated at ~${AGENTS_INSTRUCTIONS_TOKEN_LIMIT} tokens; read AGENTS.md in the workspace for the rest]`,
      source: { kind: "file", label: "AGENTS.md excerpt", path: "AGENTS.md" },
    };
  } catch {
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
