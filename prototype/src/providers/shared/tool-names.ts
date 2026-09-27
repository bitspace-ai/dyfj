/**
 * Wire-safe tool names, shared by the adapters that offer tools.
 */
import type { WorkbenchToolDefinition } from "../types.ts";

// Anthropic tool names must match ^[a-zA-Z0-9_-]{1,64}$. DYFJ command ids
// use dots (memory.read), so the adapter maps names onto the wire and back.
/**
 * Map each tool's registry name to a wire-safe name matching `^[a-zA-Z0-9_-]+$`
 * (e.g. `memory.read` -> `memory_read`), truncated to 64 and de-duplicated. Both
 * the OpenAI-compatible and Anthropic adapters require this pattern — dotted
 * command ids are rejected (OpenAI returns HTTP 400). Returns `{wire, tool}`
 * pairs so the caller can map response tool calls back to the registry name it
 * dispatches on.
 */
export function toolWireNames(
  tools: WorkbenchToolDefinition[],
): Array<{ wire: string; tool: WorkbenchToolDefinition }> {
  const used = new Set<string>();
  return tools.map((tool) => {
    let wire = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    while (used.has(wire)) wire = `${wire.slice(0, 60)}_${used.size}`;
    used.add(wire);
    return { wire, tool };
  });
}

/** Map registry tool name -> sanitized wire name for assistant tool_calls. */
export function wireNameLookup(
  tools: WorkbenchToolDefinition[] | undefined,
): (name: string) => string {
  if (!tools || tools.length === 0) return (name) => name;
  const byName = new Map(
    toolWireNames(tools).map(({ wire, tool }) => [tool.name, wire]),
  );
  return (name) => byName.get(name) ?? name;
}
