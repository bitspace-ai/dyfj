import { memoryClearanceFor, type MemoryVisibility } from "../src/memory";
import type { SqlParam } from "./dolt-config";

type MemoryType = "user" | "feedback" | "project" | "reference";

export type McpMemoryQuery = (
  sql: string,
  params?: SqlParam[],
) => Promise<Record<string, string>[]>;

export interface McpMemoryToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// A standalone stdio MCP connection has no authenticated principal. Until it
// does, it receives the same conservative clearance as every remote consumer.
const STANDALONE_MCP_MEMORY_CLEARANCE = memoryClearanceFor("remote");

function visibilityPlaceholders(
  visibility: readonly MemoryVisibility[],
): string {
  return visibility.map(() => "?").join(", ");
}

function markdownTableCell(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

export async function readMcpMemory(
  query: McpMemoryQuery,
  slug: string,
): Promise<McpMemoryToolResult> {
  const rows = await query(
    `SELECT memory_id, slug, type, name, description, content ` +
      `FROM memories WHERE slug = ? ` +
      `AND visibility IN (${
        visibilityPlaceholders(STANDALONE_MCP_MEMORY_CLEARANCE)
      }) LIMIT 1;`,
    [slug, ...STANDALONE_MCP_MEMORY_CLEARANCE],
  );
  if (rows.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "Memory not found. Use list_memories() to see valid slugs.",
        },
      ],
      isError: true,
    };
  }
  const memory = rows[0]!;
  return {
    content: [
      {
        type: "text",
        text: `# ${memory.name}\n\n${(memory.content ?? "").trim()}`,
      },
    ],
  };
}

export async function listMcpMemories(
  query: McpMemoryQuery,
  type?: MemoryType,
): Promise<McpMemoryToolResult> {
  const predicates = [
    `visibility IN (${
      visibilityPlaceholders(STANDALONE_MCP_MEMORY_CLEARANCE)
    })`,
  ];
  const params: SqlParam[] = [...STANDALONE_MCP_MEMORY_CLEARANCE];
  if (type) {
    predicates.push("type = ?");
    params.push(type);
  }
  const rows = await query(
    `SELECT slug, type, name, description FROM memories ` +
      `WHERE ${predicates.join(" AND ")} ORDER BY type, slug;`,
    params,
  );
  if (rows.length === 0) {
    return { content: [{ type: "text", text: "No memories found." }] };
  }

  const lines = [
    "| slug | type | name | description |",
    "|------|------|------|-------------|",
    ...rows.map((row) => {
      const description = markdownTableCell(
        row.description?.slice(0, 100) ?? "",
      );
      return `| ${markdownTableCell(row.slug)} | ${
        markdownTableCell(row.type)
      } | ${markdownTableCell(row.name)} | ${description} |`;
    }),
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
