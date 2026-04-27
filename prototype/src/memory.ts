/**
 * DYFJ Workbench — Memory retrieval and session context
 *
 * Implements the two-pass memory loading strategy for session startup:
 *
 *   Pass 1 (SQL, guaranteed):
 *     - Full content of all user + feedback memories — always loaded
 *     - slug/name/description index of all project + reference memories
 *
 *   Pass 2 (LLM-driven, via read_memory tool):
 *     - Model reads the index, infers relevance from task context
 *     - Calls read_memory(slug) for the entries it judges relevant
 *     - System fetches and returns full content from Dolt
 *
 * This fixes the 30% miss rate from the MEMORY.md era: SQL guarantees the
 * index is always in context; the model decides what to load from it.
 *
 * Identity injection:
 *   Agent identity memories (user_<name>_* slugs) are assembled into a dedicated
 *   "Your Identity" section at the TOP of the system prompt, before user context.
 *   This puts the agent's steering rules, voice, and self-identification first in
 *   context by design, not by accident. Order within identity: *_identity →
 *   *_voice → *_steering → any additional identity slugs.
 *
 * Pure functions (buildSystemPrompt, buildReadMemoryTool) are separated from
 * I/O functions (loadCoreMemories, loadMemoryIndex, executeReadMemory) so
 * they can be unit tested without Dolt.
 */

import { Type } from "@mariozechner/pi-ai";
import type { Tool, ToolResultMessage } from "@mariozechner/pi-ai";
import { doltQuery } from "./utils";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface Memory {
  memoryId:    string;
  slug:        string;
  type:        MemoryType;
  name:        string;
  description: string;
  content:     string;
}

export interface MemoryIndexEntry {
  slug:        string;
  type:        MemoryType;
  name:        string;
  description: string;
}

// ── SQL retrieval (I/O) ───────────────────────────────────────────────────────

/**
 * Load full memory rows for the given types.
 * user + feedback: always called at session start (full content guaranteed in context).
 */
export async function loadMemoriesByType(types: MemoryType[]): Promise<Memory[]> {
  if (types.length === 0) return [];
  const list = types.map(t => `'${t}'`).join(", ");
  const rows = await doltQuery(
    `SELECT memory_id, slug, type, name, description, content ` +
    `FROM memories WHERE type IN (${list}) ORDER BY type, slug;`
  );
  return rows.map(rowToMemory);
}

/**
 * Load index entries (no content) for the given types.
 * project + reference: loaded as a lightweight index; LLM pulls full content on demand.
 */
export async function loadMemoryIndex(types: MemoryType[]): Promise<MemoryIndexEntry[]> {
  if (types.length === 0) return [];
  const list = types.map(t => `'${t}'`).join(", ");
  const rows = await doltQuery(
    `SELECT slug, type, name, description ` +
    `FROM memories WHERE type IN (${list}) ORDER BY type, slug;`
  );
  return rows.map(rowToIndexEntry);
}

/**
 * Fetch the full content of a single memory by slug.
 * Called at tool-execution time when the model invokes read_memory().
 */
export async function getMemoryBySlug(slug: string): Promise<Memory | null> {
  const safe = slug.replace(/'/g, "''");
  const rows = await doltQuery(
    `SELECT memory_id, slug, type, name, description, content ` +
    `FROM memories WHERE slug = '${safe}' LIMIT 1;`
  );
  return rows.length > 0 ? rowToMemory(rows[0]!) : null;
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function rowToMemory(row: Record<string, string>): Memory {
  return {
    memoryId:    row['memory_id'] ?? '',
    slug:        row['slug'] ?? '',
    type:        (row['type'] ?? '') as MemoryType,
    name:        row['name'] ?? '',
    description: row['description'] ?? '',
    content:     row['content'] ?? '',
  };
}

function rowToIndexEntry(row: Record<string, string>): MemoryIndexEntry {
  return {
    slug:        row['slug'] ?? '',
    type:        (row['type'] ?? '') as MemoryType,
    name:        row['name'] ?? '',
    description: row['description'] ?? '',
  };
}

// ── System prompt builder (pure) ──────────────────────────────────────────────

export interface SystemPromptOptions {
  /**
   * Slug prefix for agent identity memories. Memories with this prefix are
   * assembled into a dedicated top section before user context, ensuring
   * identity/steering rules are first in context by design.
   *
   * Conventionally: "user_<agentname>_" — e.g. "user_myagent_"
   * Omit or set to "" to disable identity injection.
   */
  identitySlugPrefix?: string;
  /**
   * Section heading for the main user context block.
   * Default: "About the User"
   */
  userSectionTitle?: string;
}

/**
 * Assemble the session system prompt from loaded memories and index.
 *
 * Structure:
 *   1. Nudge — instructs the model to call read_memory() before starting work
 *   2. Your Identity — agent identity memories (identitySlugPrefix slugs), assembled first
 *   3. About the User — remaining user memories (full content)
 *   4. Working Preferences — feedback memories (full content)
 *   5. Context Index — project + reference index table (slug / name / description)
 *
 * Identity memories are split from user memories and assembled first so the
 * agent's steering rules, voice, and self-identification are always first in
 * context — identity by design, not by accident of insertion order.
 *
 * The nudge is omitted when the index is empty (no project/reference memories
 * exist or were requested), since there's nothing to pull.
 */
export function buildSystemPrompt(
  coreMemories: Memory[],
  index: MemoryIndexEntry[],
  options: SystemPromptOptions = {},
): string {
  const identityPrefix = options.identitySlugPrefix ?? "";
  const userTitle      = options.userSectionTitle   ?? "About the User";

  // Split user memories: agent identity vs user context
  const identity = identityPrefix
    ? coreMemories.filter(m => m.type === "user" && m.slug.startsWith(identityPrefix))
    : [];
  const user     = identityPrefix
    ? coreMemories.filter(m => m.type === "user" && !m.slug.startsWith(identityPrefix))
    : coreMemories.filter(m => m.type === "user");
  const feedback = coreMemories.filter(m => m.type === "feedback");
  const parts: string[] = [];

  // ── Agent Identity (assembled first — identity by design) ─────────────────
  // Canonical order: identity → voice → steering — remaining by insertion order
  const IDENTITY_CORE = ["identity", "voice", "steering"].map(s => `${identityPrefix}${s}`);
  const identitySorted = [
    ...IDENTITY_CORE.map(slug => identity.find(m => m.slug === slug)).filter((m): m is Memory => m !== undefined),
    ...identity.filter(m => !IDENTITY_CORE.includes(m.slug)),
  ];

  if (identitySorted.length > 0) {
    for (const m of identitySorted) {
      parts.push(m.content.trim());
      parts.push("");
    }
    parts.push("---");
    parts.push("");
  }

  // Nudge — only when there's an index to consult
  if (index.length > 0) {
    parts.push(
      "**Before starting any task:** scan the Context Index at the end of this prompt " +
      "and call `read_memory()` for any project or reference entries relevant to the work at hand. " +
      "Do this before you begin — working without pulling context first means working blind."
    );
    parts.push("");
  }

  // User context
  if (user.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push(`## ${userTitle}`);
    parts.push("");
    for (const m of user) {
      parts.push(`### ${m.name}`);
      parts.push(m.content.trim());
      parts.push("");
    }
  }

  // Feedback / working preferences
  if (feedback.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("## Working Preferences");
    parts.push("");
    for (const m of feedback) {
      parts.push(`### ${m.name}`);
      parts.push(m.content.trim());
      parts.push("");
    }
  }

  // Project + reference index
  if (index.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("## Context Index");
    parts.push("");
    parts.push(
      "The following project and reference memories are available. " +
      "Call `read_memory(slug)` to load full content for any that are relevant."
    );
    parts.push("");
    parts.push("| slug | type | name | description |");
    parts.push("|------|------|------|-------------|");
    for (const entry of index) {
      // Sanitise for markdown table: collapse newlines, escape pipes, cap length
      const desc = entry.description
        .replace(/\n/g, " ")
        .replace(/\|/g, "\\|")
        .slice(0, 120);
      const name = entry.name.replace(/\|/g, "\\|");
      parts.push(`| ${entry.slug} | ${entry.type} | ${name} | ${desc} |`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

// ── read_memory tool (pure) ───────────────────────────────────────────────────

/** Build the pi-ai Tool definition for read_memory. */
export function buildReadMemoryTool(): Tool {
  return {
    name: "read_memory",
    description:
      "Load the full content of a project or reference memory from the knowledge base. " +
      "Call this before starting work to pull relevant context. " +
      "Available slugs are listed in the Context Index in your system prompt.",
    parameters: Type.Object({
      slug: Type.String({
        description:
          "The memory slug to retrieve, e.g. 'project_dyfj' or 'reference_1password_cli'",
      }),
    }),
  };
}

// ── Tool execution (I/O) ──────────────────────────────────────────────────────

/**
 * Execute a read_memory tool call. Returns formatted memory content, or a
 * helpful not-found message if the slug doesn't exist (graceful — the model
 * may occasionally hallucinate a slug).
 */
export async function executeReadMemory(slug: string): Promise<string> {
  const memory = await getMemoryBySlug(slug);
  if (!memory) {
    return (
      `Memory not found: '${slug}'. ` +
      `Check the Context Index in your system prompt for valid slugs.`
    );
  }
  return `# ${memory.name}\n\n${memory.content.trim()}`;
}

/**
 * Build a ToolResultMessage for a completed read_memory call.
 * Attaches to the context before the next model turn.
 */
export function buildToolResult(
  toolCallId: string,
  toolName: string,
  content: string,
  isError = false,
): ToolResultMessage {
  return {
    role:        "toolResult",
    toolCallId,
    toolName,
    content:     [{ type: "text", text: content }],
    isError,
    timestamp:   Date.now(),
  };
}
