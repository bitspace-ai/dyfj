import { assertEquals, assertStringIncludes } from "@std/assert";
import { type MemorySeed, MemoryStore } from "../src/store/mod.ts";
import { listMcpMemories, readMcpMemory } from "./memory-tools.ts";

// Every visibility class, plus rows that stress the Markdown table rendering.
const seed: MemorySeed[] = [
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
    type: "project",
    visibility: "public",
    name: "Name\\path|part\nnext",
    description: `${"x".repeat(98)}\\|trailing\r\nnext`,
    content: "Adversarial content",
  },
];

const memories = () => new MemoryStore({ memories: seed }).memories;

Deno.test("standalone MCP memory projection lists and reads client-safe and public rows", async () => {
  const reader = memories();
  const listed = await listMcpMemories(reader);
  assertStringIncludes(listed.content[0]!.text, "client_safe_memory");
  assertStringIncludes(listed.content[0]!.text, "public_memory");
  assertStringIncludes(
    (await readMcpMemory(reader, "client_safe_memory")).content[0]!.text,
    "Client-safe content",
  );
  assertEquals(
    (await readMcpMemory(reader, "public_memory")).content[0]!.text,
    "# Public memory\n\nPublic content",
  );
});

Deno.test("standalone MCP memory projection does not list or read private and shareable rows", async () => {
  const reader = memories();
  const listed = await listMcpMemories(reader);
  assertEquals(listed.content[0]!.text.includes("private_memory"), false);
  assertEquals(listed.content[0]!.text.includes("shareable_memory"), false);
  const privateMemory = await readMcpMemory(reader, "private_memory");
  assertEquals(privateMemory, await readMcpMemory(reader, "shareable_memory"));
  assertEquals(privateMemory, {
    content: [{
      type: "text",
      text: "Memory not found. Use list_memories() to see valid slugs.",
    }],
    isError: true,
  });
});

Deno.test("standalone MCP memory projection makes private and nonexistent slugs indistinguishable", async () => {
  const reader = memories();
  assertEquals(
    await readMcpMemory(reader, "private_memory"),
    await readMcpMemory(reader, "does_not_exist"),
  );
  assertEquals(
    await readMcpMemory(reader, "private_memory' OR 1=1 --"),
    await readMcpMemory(reader, "does_not_exist"),
  );
});

Deno.test("standalone MCP memory projection filters by type within the clearance", async () => {
  const listed = await listMcpMemories(memories(), "project");
  assertStringIncludes(listed.content[0]!.text, "client_safe_memory");
  assertEquals(listed.content[0]!.text.includes("public_memory"), false);
});

Deno.test("standalone MCP memory projection preserves empty lists and escapes Markdown table cells", async () => {
  assertEquals(await listMcpMemories(memories(), "user"), {
    content: [{ type: "text", text: "No memories found." }],
  });

  const listed = await listMcpMemories(memories(), "project");
  const escaped = listed.content[0]!.text.split("\n").find((line) =>
    line.includes("escaped_memory")
  );
  assertEquals(
    escaped,
    `| escaped_memory | project | Escaped memory | ${"x".repeat(99)}\\| |`,
  );

  const adversarial = listed.content[0]!.text.split("\n").find((line) =>
    line.includes("path")
  );
  const escapedBackslash = "\\".repeat(2);
  const escapedPipe = "\\|";
  assertEquals(
    adversarial,
    `| slug${escapedBackslash}path${escapedPipe}part next | project | ` +
      `Name${escapedBackslash}path${escapedPipe}part next | ` +
      `${"x".repeat(98)}${escapedBackslash}${escapedPipe} |`,
  );
});
