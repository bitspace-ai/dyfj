/**
 * Unit tests for the recall config resolver (src/memory-search.ts).
 *
 * The live transport path (buildMemorySearch → MCP client → external endpoint)
 * is exercised by an operator integration test against a configured backend, not
 * here; these cover the pure, vendor-neutral config surface.
 */

import { describe, expect, test } from "vitest";
import { memorySearchConfigFromEnv } from "./memory-search";

describe("memorySearchConfigFromEnv", () => {
  test("returns null when no endpoint is configured (capability disabled)", () => {
    expect(memorySearchConfigFromEnv({})).toBeNull();
    expect(memorySearchConfigFromEnv({ DYFJ_MEMORY_MCP_URL: "" })).toBeNull();
  });

  test("defaults the tool to 'search' and omits the token when only URL is set", () => {
    expect(
      memorySearchConfigFromEnv({
        DYFJ_MEMORY_MCP_URL: "https://memory.example/mcp",
      }),
    ).toEqual({
      url: "https://memory.example/mcp",
      tool: "search",
      token: undefined,
    });
  });

  test("honors tool + token overrides — backend vocabulary stays config", () => {
    const cfg = memorySearchConfigFromEnv({
      DYFJ_MEMORY_MCP_URL: "https://memory.example/mcp",
      DYFJ_MEMORY_MCP_TOOL: "search_thoughts",
      DYFJ_MEMORY_MCP_TOKEN: "fixture-token",
    });
    expect(cfg?.url).toBe("https://memory.example/mcp");
    expect(cfg?.tool).toBe("search_thoughts");
    expect(cfg?.token).toBe("fixture-token");
  });
});
