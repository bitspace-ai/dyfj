/**
 * Unit tests for the recall config resolver (src/memory-search.ts).
 *
 * The live transport path (buildMemorySearch → MCP client → external endpoint)
 * is exercised by an operator integration test against a configured backend, not
 * here; these cover the pure, vendor-neutral config surface.
 */

import { describe, expect, test } from "vitest";
import {
  memoryAuthHeaders,
  memorySearchConfigFromEnv,
  recallRequestInit,
} from "./memory-search";

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

  test("a DNS name that merely starts with 127. is not loopback", () => {
    // 127/8 must be a strict IPv4 parse — 127.attacker.example is a routable
    // hostname, and classifying it loopback would license cleartext transport.
    for (
      const host of [
        "127.attacker.example",
        "127.example.com",
        "127.0.0.1.evil.example",
      ]
    ) {
      expect(() =>
        memorySearchConfigFromEnv({
          DYFJ_MEMORY_MCP_URL: `http://${host}/mcp`,
        })
      ).toThrow("https");
    }
    expect(
      memorySearchConfigFromEnv({
        DYFJ_MEMORY_MCP_URL: "http://127.1.2.3:9/mcp",
      })?.url,
    ).toBe("http://127.1.2.3:9/mcp");
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

describe("recallRequestInit", () => {
  const base = { url: "https://memory.example/mcp", tool: "search" };

  test("always refuses redirects, with or without a token", () => {
    // fetch preserves CUSTOM headers across redirects (only Authorization is
    // stripped cross-origin), so following a 307/308 https→http downgrade
    // would ship the token header and query body in cleartext. Every recall
    // request must carry redirect: "error".
    expect(recallRequestInit(base).redirect).toBe("error");
    expect(
      recallRequestInit({
        ...base,
        token: "fixture-token",
        tokenHeader: "x-fixture-key",
      }),
    ).toEqual({
      redirect: "error",
      headers: { "x-fixture-key": "fixture-token" },
    });
  });

  test("a redirecting endpoint rejects instead of being followed (live fetch)", async () => {
    // Regression for the https→http 307 downgrade: a loopback server answers
    // 307 to a same-host http URL; a fetch carrying the exact init recall
    // sends must reject rather than follow. (The full SDK transport path can't
    // run here — npm: specifiers don't resolve under the node-based runner —
    // but the redirect policy is enforced by fetch itself, which this
    // exercises for real.)
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      (req) =>
        new Response(null, {
          status: 307,
          headers: { location: new URL(req.url).href },
        }),
    );
    const { port } = server.addr as Deno.NetAddr;
    try {
      await expect(
        fetch(`http://127.0.0.1:${port}/mcp`, {
          ...recallRequestInit({
            ...base,
            token: "fixture-token",
            tokenHeader: "x-fixture-key",
          }),
          method: "POST",
          body: JSON.stringify({ query: "fixture" }),
        }),
      ).rejects.toThrow();
    } finally {
      await server.shutdown();
    }
  });
});
