/**
 * Unit tests for the recall config resolver (src/memory-search.ts).
 *
 * The live transport path (buildMemorySearch → MCP client → external endpoint)
 * is exercised by an operator integration test against a configured backend, not
 * here; these cover the pure, vendor-neutral config surface.
 */

import { describe, expect, test } from "vitest";
import { memoryAuthHeaders, memorySearchConfigFromEnv } from "./memory-search";

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
      tokenHeader: undefined,
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

  test("refuses an endpoint that would carry the token in cleartext", () => {
    // https anywhere; plain http only to loopback. Fail-closed at config
    // resolution, before any request could ship the token.
    expect(() =>
      memorySearchConfigFromEnv({
        DYFJ_MEMORY_MCP_URL: "http://memory.example/mcp",
      })
    ).toThrow("https");
    expect(
      memorySearchConfigFromEnv({
        DYFJ_MEMORY_MCP_URL: "http://127.0.0.1:8080/mcp",
      })?.url,
    ).toBe("http://127.0.0.1:8080/mcp");
    expect(
      memorySearchConfigFromEnv({
        DYFJ_MEMORY_MCP_URL: "http://localhost:8080/mcp",
      })?.url,
    ).toBe("http://localhost:8080/mcp");
  });

  test("resolves the token header name; empty means unset", () => {
    const named = memorySearchConfigFromEnv({
      DYFJ_MEMORY_MCP_URL: "https://memory.example/mcp",
      DYFJ_MEMORY_MCP_TOKEN: "fixture-token",
      DYFJ_MEMORY_MCP_TOKEN_HEADER: "x-fixture-key",
    });
    expect(named?.tokenHeader).toBe("x-fixture-key");
    const empty = memorySearchConfigFromEnv({
      DYFJ_MEMORY_MCP_URL: "https://memory.example/mcp",
      DYFJ_MEMORY_MCP_TOKEN_HEADER: "",
    });
    expect(empty?.tokenHeader).toBeUndefined();
  });
});

describe("memoryAuthHeaders", () => {
  const base = { url: "https://memory.example/mcp", tool: "search" };

  test("no token → no auth headers (header name alone is meaningless)", () => {
    expect(memoryAuthHeaders(base)).toBeUndefined();
    expect(memoryAuthHeaders({ ...base, token: "" })).toBeUndefined();
    expect(
      memoryAuthHeaders({ ...base, tokenHeader: "x-fixture-key" }),
    ).toBeUndefined();
  });

  test("token without a header name → standard Authorization: Bearer", () => {
    expect(memoryAuthHeaders({ ...base, token: "fixture-token" })).toEqual({
      Authorization: "Bearer fixture-token",
    });
  });

  test("token with a header name → raw token under the named header", () => {
    expect(
      memoryAuthHeaders({
        ...base,
        token: "fixture-token",
        tokenHeader: "x-fixture-key",
      }),
    ).toEqual({ "x-fixture-key": "fixture-token" });
  });
});
