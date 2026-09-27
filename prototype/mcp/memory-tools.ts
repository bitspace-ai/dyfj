import {
  MCP_STDIO_MEMORY_CLEARANCE,
  type MemoryReader,
  type MemoryType,
} from "../src/store/mod.ts";

export interface McpMemoryToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function markdownTableCell(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

// A standalone stdio MCP connection has no authenticated principal, so it
// reads with the store's stdio clearance (the remote consumer's).
export async function readMcpMemory(
  memories: MemoryReader,
  slug: string,
): Promise<McpMemoryToolResult> {
  const memory = await memories.bySlug(slug, MCP_STDIO_MEMORY_CLEARANCE);
  if (memory === null) {
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
  memories: MemoryReader,
  type?: MemoryType,
): Promise<McpMemoryToolResult> {
  const rows = await memories.list(
    MCP_STDIO_MEMORY_CLEARANCE,
    type ? { type } : {},
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
