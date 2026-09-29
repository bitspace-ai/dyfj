/**
 * Unit tests for the recall config resolver (src/memory-search.ts).
 *
 * The live transport path (buildMemorySearch → MCP client → external endpoint)
 * and the live redirect refusal are exercised by
 * memory-search.integration.test.ts; these cover the pure, vendor-neutral
 * config surface.
 */

import {
  assertEquals,
  assertFalse,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { MapEnv } from "../testing/fakes/map-env.ts";
import {
  memoryAuthHeaders,
  memorySearchConfigFromEnv,
  recallRequestInit,
} from "./memory-search.ts";

describe("memorySearchConfigFromEnv", () => {
  it("returns null when no endpoint is configured (capability disabled)", () => {
    assertStrictEquals(memorySearchConfigFromEnv(new MapEnv({})), null);
    assertStrictEquals(
      memorySearchConfigFromEnv(new MapEnv({ DYFJ_MEMORY_MCP_URL: "" })),
      null,
    );
  });

  it("defaults the tool to 'search' and omits the token when only URL is set", () => {
    assertEquals(
      memorySearchConfigFromEnv(
        new MapEnv({
          DYFJ_MEMORY_MCP_URL: "https://memory.example/mcp",
        }),
      ),
      {
        url: "https://memory.example/mcp",
        tool: "search",
        token: undefined,
        tokenHeader: undefined,
      },
    );
  });

  it("honors tool + token overrides — backend vocabulary stays config", () => {
    const cfg = memorySearchConfigFromEnv(
      new MapEnv({
        DYFJ_MEMORY_MCP_URL: "https://memory.example/mcp",
        DYFJ_MEMORY_MCP_TOOL: "search_thoughts",
        DYFJ_MEMORY_MCP_TOKEN: "fixture-token",
      }),
    );
    assertStrictEquals(cfg?.url, "https://memory.example/mcp");
    assertStrictEquals(cfg?.tool, "search_thoughts");
    assertStrictEquals(cfg?.token, "fixture-token");
  });

  it("refuses an endpoint that would carry the token in cleartext", () => {
    // https anywhere; plain http only to loopback. Fail-closed at config
    // resolution, before any request could ship the token.
    assertThrows(
      () =>
        memorySearchConfigFromEnv(
          new MapEnv({
            DYFJ_MEMORY_MCP_URL: "http://memory.example/mcp",
          }),
        ),
      Error,
      "https",
    );
    assertStrictEquals(
      memorySearchConfigFromEnv(
        new MapEnv({
          DYFJ_MEMORY_MCP_URL: "http://127.0.0.1:8080/mcp",
        }),
      )?.url,
      "http://127.0.0.1:8080/mcp",
    );
    assertStrictEquals(
      memorySearchConfigFromEnv(
        new MapEnv({
          DYFJ_MEMORY_MCP_URL: "http://localhost:8080/mcp",
        }),
      )?.url,
      "http://localhost:8080/mcp",
    );
  });

  it("rejects credentials embedded in https and loopback http URLs", () => {
    for (
      const url of [
        "https://fixture-user:fixture-pass@memory.example/mcp",
        "http://fixture-user:fixture-pass@127.0.0.1:8080/mcp",
        "https://fixture-user@memory.example/mcp",
      ]
    ) {
      assertThrows(
        () =>
          memorySearchConfigFromEnv(new MapEnv({ DYFJ_MEMORY_MCP_URL: url })),
        Error,
        "DYFJ_MEMORY_MCP_URL must not include credentials",
      );
    }
  });

  it("credential diagnostic does not echo the URL or its userinfo", () => {
    const username = "fixture-user";
    const password = "fixture-pass";
    const url = `https://${username}:${password}@memory.example/mcp`;

    let message = "";
    try {
      memorySearchConfigFromEnv(new MapEnv({ DYFJ_MEMORY_MCP_URL: url }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    assertStringIncludes(message, "DYFJ_MEMORY_MCP_URL");
    assertFalse(message.includes(username));
    assertFalse(message.includes(password));
    assertFalse(message.includes(url));
  });

  it("a DNS name that merely starts with 127. is not loopback", () => {
    // 127/8 must be a strict IPv4 parse — 127.attacker.example is a routable
    // hostname, and classifying it loopback would license cleartext transport.
    for (
      const host of [
        "127.attacker.example",
        "127.example.com",
        "127.0.0.1.evil.example",
      ]
    ) {
      assertThrows(
        () =>
          memorySearchConfigFromEnv(
            new MapEnv({
              DYFJ_MEMORY_MCP_URL: `http://${host}/mcp`,
            }),
          ),
        Error,
        "https",
      );
    }
    assertStrictEquals(
      memorySearchConfigFromEnv(
        new MapEnv({
          DYFJ_MEMORY_MCP_URL: "http://127.1.2.3:9/mcp",
        }),
      )?.url,
      "http://127.1.2.3:9/mcp",
    );
  });

  it("resolves the token header name; empty means unset", () => {
    const named = memorySearchConfigFromEnv(
      new MapEnv({
        DYFJ_MEMORY_MCP_URL: "https://memory.example/mcp",
        DYFJ_MEMORY_MCP_TOKEN: "fixture-token",
        DYFJ_MEMORY_MCP_TOKEN_HEADER: "x-fixture-key",
      }),
    );
    assertStrictEquals(named?.tokenHeader, "x-fixture-key");
    const empty = memorySearchConfigFromEnv(
      new MapEnv({
        DYFJ_MEMORY_MCP_URL: "https://memory.example/mcp",
        DYFJ_MEMORY_MCP_TOKEN_HEADER: "",
      }),
    );
    assertStrictEquals(empty?.tokenHeader, undefined);
  });
});

describe("memoryAuthHeaders", () => {
  const base = { url: "https://memory.example/mcp", tool: "search" };

  it("no token → no auth headers (header name alone is meaningless)", () => {
    assertStrictEquals(memoryAuthHeaders(base), undefined);
    assertStrictEquals(memoryAuthHeaders({ ...base, token: "" }), undefined);
    assertStrictEquals(
      memoryAuthHeaders({ ...base, tokenHeader: "x-fixture-key" }),
      undefined,
    );
  });

  it("token without a header name → standard Authorization: Bearer", () => {
    assertEquals(memoryAuthHeaders({ ...base, token: "fixture-token" }), {
      Authorization: "Bearer fixture-token",
    });
  });

  it("token with a header name → raw token under the named header", () => {
    assertEquals(
      memoryAuthHeaders({
        ...base,
        token: "fixture-token",
        tokenHeader: "x-fixture-key",
      }),
      { "x-fixture-key": "fixture-token" },
    );
  });
});

describe("recallRequestInit", () => {
  const base = { url: "https://memory.example/mcp", tool: "search" };

  it("always refuses redirects, with or without a token", () => {
    // fetch preserves CUSTOM headers across redirects (only Authorization is
    // stripped cross-origin), so following a 307/308 https→http downgrade
    // would ship the token header and query body in cleartext. Every recall
    // request must carry redirect: "error".
    assertStrictEquals(recallRequestInit(base).redirect, "error");
    assertEquals(
      recallRequestInit({
        ...base,
        token: "fixture-token",
        tokenHeader: "x-fixture-key",
      }),
      {
        redirect: "error",
        headers: { "x-fixture-key": "fixture-token" },
      },
    );
  });
});
