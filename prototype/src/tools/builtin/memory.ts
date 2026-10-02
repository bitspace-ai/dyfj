/**
 * The memory tools: `memory.read` loads one Dolt-backed memory by slug, within
 * the turn's clearance, and `memory.search` recalls from an operator-configured
 * external memory endpoint. Both are read-only; the policy auto-allows them.
 */

import type { MemoryReader, MemoryVisibility } from "../../store/mod.ts";
import { formatUntrustedMemoryRecord, rowToMemory } from "./memory-records.ts";
import type { CommandDefinition, CommandTraceContext } from "../definition.ts";

export interface MemoryReadDependencies {
  /**
   * Backs `memory.read`. A registry built only to list the catalog may omit
   * it; executing `memory.read` without it fails.
   */
  readMemory?: (slug: string) => Promise<string> | string;
  /** The slugs `memory.read` accepts; any slug when absent. */
  allowedMemorySlugs?: readonly string[];
}

/**
 * Execute a read_memory tool call. Returns formatted memory content, or a
 * helpful not-found message if the slug doesn't exist (graceful — the model
 * may occasionally hallucinate a slug) or is outside the turn's clearance.
 */
export async function executeReadMemory(
  memories: MemoryReader,
  slug: string,
  clearance: readonly MemoryVisibility[],
): Promise<string> {
  const row = await memories.bySlug(slug, clearance);
  const memory = row === null ? null : rowToMemory(row);
  if (!memory) {
    return (
      `Memory not found: '${slug}'. ` +
      `Check the Context Index in your system prompt for valid slugs.`
    );
  }
  return formatUntrustedMemoryRecord(memory);
}

export function defineMemoryRead(
  deps: MemoryReadDependencies = {},
): CommandDefinition<string> {
  const readMemory = deps.readMemory ?? (() => {
    throw new Error("memory.read has no memory reader configured");
  });
  const slugPattern = buildMemorySlugPattern(deps.allowedMemorySlugs);
  return {
    id: "memory.read",
    title: "Read Memory",
    description: "Load one Dolt-backed memory by slug.",
    inputSchema: {
      type: "object",
      required: ["slug"],
      properties: {
        slug: {
          type: "string",
          pattern: slugPattern,
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["read.memory", "emit.event"],
      defaultDecision: "allow",
      resources: ["memory:*"],
      network: "local",
      filesystem: "none",
      cost: "none",
    },
    executor: async (call) => readMemory(String(call.arguments.slug)),
  };
}

export function defineMemorySearch(
  search: (
    query: string,
    traceContext?: CommandTraceContext,
  ) => Promise<string> | string,
): CommandDefinition<string> {
  return {
    id: "memory.search",
    title: "Search Memory",
    description:
      "Search long-term external memory by meaning and return relevant " +
      "entries. Use when the operator refers to past context — decisions, " +
      "people, ideas, or events — that may have been captured before.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "What to recall, in natural language.",
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["read.memory", "emit.event"],
      defaultDecision: "allow",
      resources: ["memory:external"],
      network: "recall",
      filesystem: "none",
      cost: "none",
    },
    spanKind: "client",
    executor: async (call, context) =>
      search(
        String(call.arguments.query),
        context.traceId !== undefined && context.spanId !== undefined
          ? {
            traceId: context.traceId,
            spanId: context.spanId,
            traceFlags: context.traceFlags ?? 0,
            ...(context.traceState === undefined
              ? {}
              : { traceState: context.traceState }),
          }
          : undefined,
      ),
  };
}

function buildMemorySlugPattern(allowedSlugs?: readonly string[]): string {
  if (allowedSlugs === undefined) return "^[a-z0-9][a-z0-9_-]*$";
  if (allowedSlugs.length === 0) return "a^";
  return `^(${allowedSlugs.map(escapeRegex).join("|")})$`;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
