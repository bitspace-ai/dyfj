import { describe, expect, test } from "vitest";
import type { SqlParam } from "./dolt-config";
import {
  listMcpMemories,
  type McpMemoryQuery,
  readMcpMemory,
} from "./memory-tools";

type Visibility = "private" | "shareable" | "client_safe" | "public";

interface QueryCall {
  sql: string;
  params: SqlParam[];
}

const rows = [
  {
    memory_id: "1",
    slug: "client_safe_memory",
    type: "project",
    visibility: "client_safe",
    name: "Client-safe memory",
    description: "Visible to every MCP consumer",
    content: "Client-safe content",
  },
  {
    memory_id: "2",
    slug: "public_memory",
    type: "reference",
    visibility: "public",
    name: "Public memory",
    description: "Public description",
    content: "Public content",
  },
  {
    memory_id: "3",
    slug: "private_memory",
    type: "user",
    visibility: "private",
    name: "Private memory",
    description: "Private description",
    content: "Private content",
  },
  {
    memory_id: "4",
    slug: "shareable_memory",
    type: "user",
    visibility: "shareable",
    name: "Shareable memory",
    description: "Shareable description",
    content: "Shareable content",
  },
  {
    memory_id: "5",
    slug: "escaped_memory",
    type: "project",
    visibility: "public",
    name: "Escaped memory",
    description: `${"x".repeat(99)}|\nmore`,
    content: "Escaped content",
  },
  {
    memory_id: "6",
    slug: "slug\\path|part\r\nnext",
    type: "project\\type|part\rnext",
    visibility: "public",
    name: "Name\\path|part\nnext",
    description: `${"x".repeat(98)}\\|trailing\r\nnext`,
    content: "Adversarial content",
  },
];

function queryFixture(calls: QueryCall[]): McpMemoryQuery {
  return async (sql, params = []) => {
    calls.push({ sql, params: [...params] });
    const allowed = sql.includes("visibility IN")
      ? new Set(
        params.filter((param): param is Visibility =>
          ["private", "shareable", "client_safe", "public"].includes(
            String(param),
          )
        ),
      )
      : null;
    const requestedSlug = sql.includes("slug = ?")
      ? String(params[0])
      : undefined;
    const requestedType = sql.includes("type = ?")
      ? String(params[params.length - 1])
      : undefined;
    return rows.filter((row) =>
      (!requestedSlug || row.slug === requestedSlug) &&
      (!requestedType || row.type === requestedType) &&
      (!allowed || allowed.has(row.visibility as Visibility))
    );
  };
}

describe("standalone MCP memory projection", () => {
  test("lists and reads client-safe and public rows", async () => {
    const calls: QueryCall[] = [];
    const query = queryFixture(calls);
    const listed = await listMcpMemories(query);
    const clientSafe = await readMcpMemory(query, "client_safe_memory");
    const publicMemory = await readMcpMemory(query, "public_memory");

    expect(listed.content[0]?.text).toContain("client_safe_memory");
    expect(listed.content[0]?.text).toContain("public_memory");
    expect(clientSafe.content[0]?.text).toContain("Client-safe content");
    expect(publicMemory.content[0]?.text).toContain("Public content");
    expect(calls[0]).toMatchObject({
      sql: expect.stringContaining("visibility IN (?, ?)"),
      params: ["client_safe", "public"],
    });
    expect(calls[1]).toEqual({
      sql: "SELECT memory_id, slug, type, name, description, content " +
        "FROM memories WHERE slug = ? AND visibility IN (?, ?) LIMIT 1;",
      params: ["client_safe_memory", "client_safe", "public"],
    });
  });

  test("does not list or read private and shareable rows", async () => {
    const calls: QueryCall[] = [];
    const query = queryFixture(calls);
    const listed = await listMcpMemories(query);
    const privateMemory = await readMcpMemory(query, "private_memory");
    const shareableMemory = await readMcpMemory(query, "shareable_memory");

    expect(listed.content[0]?.text).not.toContain("private_memory");
    expect(listed.content[0]?.text).not.toContain("shareable_memory");
    expect(privateMemory).toEqual(shareableMemory);
    expect(privateMemory).toEqual({
      content: [{
        type: "text",
        text: "Memory not found. Use list_memories() to see valid slugs.",
      }],
      isError: true,
    });
  });

  test("makes private and nonexistent slugs indistinguishable", async () => {
    const query = queryFixture([]);
    expect(await readMcpMemory(query, "private_memory")).toEqual(
      await readMcpMemory(query, "does_not_exist"),
    );
  });

  test("composes the optional type filter after bound visibility values", async () => {
    const calls: QueryCall[] = [];
    const listed = await listMcpMemories(queryFixture(calls), "project");

    expect(listed.content[0]?.text).toContain("client_safe_memory");
    expect(listed.content[0]?.text).not.toContain("public_memory");
    expect(calls).toEqual([{
      sql: expect.stringMatching(
        /WHERE visibility IN \(\?, \?\) AND type = \? ORDER BY type, slug;/,
      ),
      params: ["client_safe", "public", "project"],
    }]);
  });

  test("binds slug and type values instead of interpolating them into SQL", async () => {
    const calls: QueryCall[] = [];
    const query = queryFixture(calls);
    const injectedSlug = "private_memory' OR 1=1 --";
    await readMcpMemory(query, injectedSlug);
    await listMcpMemories(query, "project");

    expect(calls[0]).toMatchObject({
      sql: expect.not.stringContaining(injectedSlug),
      params: [injectedSlug, "client_safe", "public"],
    });
    expect(calls[1]).toMatchObject({
      sql: expect.not.stringContaining("project"),
      params: ["client_safe", "public", "project"],
    });
  });

  test("preserves empty lists and escapes Markdown table cells before rendering", async () => {
    await expect(listMcpMemories(queryFixture([]), "user")).resolves.toEqual({
      content: [{ type: "text", text: "No memories found." }],
    });

    const listed = await listMcpMemories(queryFixture([]), "project");
    const escaped = listed.content[0]?.text.split("\n").find((line) =>
      line.includes("escaped_memory")
    );
    expect(escaped).toBe(
      `| escaped_memory | project | Escaped memory | ${"x".repeat(99)}\\| |`,
    );

    const allMemories = await listMcpMemories(queryFixture([]));
    const adversarial = allMemories.content[0]?.text.split("\n").find((line) =>
      line.includes("path")
    );
    const escapedBackslash = "\\".repeat(2);
    const escapedPipe = "\\|";
    expect(adversarial).toBe(
      `| slug${escapedBackslash}path${escapedPipe}part next | ` +
        `project${escapedBackslash}type${escapedPipe}part next | ` +
        `Name${escapedBackslash}path${escapedPipe}part next | ` +
        `${"x".repeat(98)}${escapedBackslash}${escapedPipe} |`,
    );
  });
});
