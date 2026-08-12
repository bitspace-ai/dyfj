import {
  createMcpHandler,
  legacyStatelessFallback,
  McpServer,
} from "npm:@modelcontextprotocol/server@2.0.0";
import { z } from "npm:zod@4.4.3";
import {
  buildMemorySearch,
  type MemorySearchDiagnostic,
} from "./memory-search.ts";

const FIXTURE_TOOL = "fixture-search";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`,
    );
  }
}

function compatibilityForm(value: string): string {
  return [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x21 && code <= 0x7e
      ? String.fromCharCode(code + 0xfee0)
      : character;
  }).join("");
}

async function assertRejectsWithin(
  promise: Promise<unknown>,
  timeoutMs = 6_000,
): Promise<void> {
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error("recall failure exceeded its finite test bound")),
      timeoutMs,
    );
    promise.finally(() => clearTimeout(timer)).catch(() => {});
  });
  try {
    await Promise.race([promise, timeout]);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "recall failure exceeded its finite test bound"
    ) {
      throw error;
    }
    return;
  }
  throw new Error("expected recall to reject");
}

async function assertResolvesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("recall success exceeded its finite test bound")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface FixtureServerOptions {
  name?: string;
  version?: string;
  extensions?: Record<string, Record<string, never>>;
}

function fixtureServer(
  onCall: (query: string) => void | Promise<void>,
  options: FixtureServerOptions = {},
): McpServer {
  const server = new McpServer(
    {
      name: options.name ?? "fixture-memory",
      version: options.version ?? "1.2.3",
    },
    options.extensions === undefined
      ? undefined
      : { capabilities: { extensions: options.extensions } },
  );
  server.registerTool(
    FIXTURE_TOOL,
    { inputSchema: z.object({ query: z.string() }) },
    async ({ query }: { query: string }) => {
      await onCall(query);
      return { content: [{ type: "text" as const, text: `match:${query}` }] };
    },
  );
  return server;
}

interface LoopbackFixture {
  url: string;
  close(): Promise<void>;
}

function startLoopbackServer(
  handler: (request: Request) => Response | Promise<Response>,
): LoopbackFixture {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    handler,
  );
  const { port } = server.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => server.shutdown(),
  };
}

Deno.test(
  "modern recall negotiates 2026-07-28 and emits actual routing headers",
  async () => {
    const query = "modern-needle";
    const calls: string[] = [];
    const methods: string[] = [];
    const diagnostics: MemorySearchDiagnostic[] = [];
    const requests: Array<{
      arguments: unknown;
      method: string | null;
      name: string | null;
      version: string | null;
    }> = [];
    const mcp = createMcpHandler(
      () =>
        fixtureServer((value) => {
          calls.push(value);
        }, {
          extensions: { "fixture.extension": {} },
        }),
      { legacy: "reject" },
    );
    const http = startLoopbackServer(async (request) => {
      if (request.method === "POST") {
        const body = await request.clone().json() as {
          method?: string;
          params?: { arguments?: unknown };
        };
        if (typeof body.method === "string") methods.push(body.method);
        if (body.method === "tools/call") {
          requests.push({
            arguments: body.params?.arguments,
            method: request.headers.get("mcp-method"),
            name: request.headers.get("mcp-name"),
            version: request.headers.get("mcp-protocol-version"),
          });
        }
      }
      return mcp.fetch(request);
    });

    try {
      const recall = buildMemorySearch(
        { url: http.url, tool: FIXTURE_TOOL },
        (diagnostic) => diagnostics.push(diagnostic),
      );
      assertEquals(await recall(query), `match:${query}`);
    } finally {
      await mcp.close();
      await http.close();
    }

    assertEquals(calls, [query]);
    assert(methods.includes("tools/call"), "modern tool call was not observed");
    assertEquals(methods.includes("tools/list"), false);
    assertEquals(requests, [{
      arguments: { query },
      method: "tools/call",
      name: FIXTURE_TOOL,
      version: "2026-07-28",
    }]);
    assertEquals(diagnostics, [{
      era: "modern",
      revision: "2026-07-28",
      server: { name: "fixture-memory", version: "1.2.3" },
      extensions: ["fixture.extension"],
    }]);
  },
);

Deno.test(
  "tool responses may exceed the probe bound while remaining call-bounded",
  async () => {
    const mcp = createMcpHandler(
      () =>
        fixtureServer(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5_500));
        }),
      { legacy: "reject" },
    );
    const http = startLoopbackServer((request) => mcp.fetch(request));

    try {
      const recall = buildMemorySearch({ url: http.url, tool: FIXTURE_TOOL });
      assertEquals(
        await assertResolvesWithin(recall("slow-tool-needle"), 8_000),
        "match:slow-tool-needle",
      );
    } finally {
      await mcp.close();
      await http.close();
    }
  },
);

Deno.test(
  "a stalled diagnostic observer cannot delay the recall call",
  async () => {
    const mcp = createMcpHandler(
      () => fixtureServer(() => {}),
      { legacy: "reject" },
    );
    const http = startLoopbackServer((request) => mcp.fetch(request));

    try {
      const recall = buildMemorySearch(
        { url: http.url, tool: FIXTURE_TOOL },
        () => new Promise<never>(() => {}),
      );
      assertEquals(
        await assertResolvesWithin(recall("observer-stall-needle"), 2_000),
        "match:observer-stall-needle",
      );
    } finally {
      await mcp.close();
      await http.close();
    }
  },
);

Deno.test(
  "auto negotiation deliberately falls back through legacy initialize",
  async () => {
    const calls: string[] = [];
    const methods: string[] = [];
    const diagnostics: MemorySearchDiagnostic[] = [];
    const legacy = legacyStatelessFallback(() =>
      fixtureServer((query) => {
        calls.push(query);
      })
    );
    const http = startLoopbackServer(async (request) => {
      if (request.method === "POST") {
        const body = await request.clone().json() as { method?: string };
        if (typeof body.method === "string") methods.push(body.method);
      }
      return legacy(request);
    });

    try {
      const recall = buildMemorySearch(
        { url: http.url, tool: FIXTURE_TOOL },
        (diagnostic) => diagnostics.push(diagnostic),
      );
      assertEquals(await recall("legacy-needle"), "match:legacy-needle");
    } finally {
      await http.close();
    }

    assertEquals(calls, ["legacy-needle"]);
    assert(
      methods.includes("server/discover"),
      "modern probe was not observed",
    );
    assert(
      methods.includes("initialize"),
      "legacy initialize was not observed",
    );
    assert(methods.includes("tools/call"), "legacy tool call was not observed");
    assertEquals(diagnostics, [{
      era: "legacy",
      revision: "2025-11-25",
      server: { name: "fixture-memory", version: "1.2.3" },
      extensions: [],
    }]);
  },
);

Deno.test(
  "a stalled modern probe fails without legacy reinterpretation",
  async () => {
    const methods: string[] = [];
    let releaseProbe = () => {};
    const probeRelease = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const http = startLoopbackServer(async (request) => {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = await request.clone().json() as { method?: string };
      if (typeof body.method === "string") methods.push(body.method);
      if (body.method === "server/discover") {
        await probeRelease;
      }
      return new Response(null, { status: 503 });
    });

    try {
      const recall = buildMemorySearch({ url: http.url, tool: FIXTURE_TOOL });
      await assertRejectsWithin(recall("stalled-probe-needle"), 7_000);
    } finally {
      releaseProbe();
      await http.close();
    }

    assertEquals(
      methods.filter((method) => method === "server/discover").length,
      1,
    );
    assertEquals(
      methods.filter((method) => method === "initialize").length,
      0,
    );
    assertEquals(
      methods.filter((method) => method === "tools/call").length,
      0,
    );
  },
);

Deno.test(
  "a stalled legacy initialize is bounded before any tool call",
  async () => {
    const methods: string[] = [];
    let releaseInitialize = () => {};
    const initializeRelease = new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });
    const legacy = legacyStatelessFallback(() => fixtureServer(() => {}));
    const http = startLoopbackServer(async (request) => {
      if (request.method !== "POST") return legacy(request);
      const body = await request.clone().json() as { method?: string };
      if (typeof body.method === "string") methods.push(body.method);
      if (body.method === "initialize") {
        await initializeRelease;
      }
      return legacy(request);
    });
    let recallPromise: Promise<string> | undefined;

    try {
      const recall = buildMemorySearch({ url: http.url, tool: FIXTURE_TOOL });
      recallPromise = recall("stalled-initialize-needle");
      await assertRejectsWithin(recallPromise, 7_000);
    } finally {
      releaseInitialize();
      await recallPromise?.catch(() => {});
      await http.close();
    }

    assertEquals(
      methods.filter((method) => method === "server/discover").length,
      1,
    );
    assertEquals(
      methods.filter((method) => method === "initialize").length,
      1,
    );
    assertEquals(
      methods.filter((method) => method === "tools/call").length,
      0,
    );
  },
);

Deno.test(
  "strict modern fixture rejects a corrupted SDK routing header without replay",
  async () => {
    let toolCalls = 0;
    let corruptHeader = false;
    const observedMethods: string[] = [];
    const mcp = createMcpHandler(
      () =>
        fixtureServer(() => {
          toolCalls++;
        }),
      { legacy: "reject" },
    );
    const http = startLoopbackServer(async (request) => {
      if (request.method !== "POST") return mcp.fetch(request);
      const body = await request.clone().json() as { method?: string };
      if (typeof body.method === "string") observedMethods.push(body.method);
      if (body.method !== "tools/call") return mcp.fetch(request);

      const headers = new Headers(request.headers);
      if (corruptHeader) headers.set("mcp-method", "tools/list");
      return mcp.fetch(new Request(request, { headers }));
    });

    try {
      const controlRecall = buildMemorySearch({
        url: http.url,
        tool: FIXTURE_TOOL,
      });
      assertEquals(
        await controlRecall("control-needle"),
        "match:control-needle",
      );
      corruptHeader = true;
      const mismatchRecall = buildMemorySearch({
        url: http.url,
        tool: FIXTURE_TOOL,
      });
      await assertRejectsWithin(mismatchRecall("mismatch-needle"));
    } finally {
      await mcp.close();
      await http.close();
    }

    assertEquals(toolCalls, 1);
    assertEquals(
      observedMethods.filter((method) => method === "tools/call").length,
      2,
    );
    assertEquals(
      observedMethods.filter((method) => method === "initialize").length,
      0,
    );
  },
);

Deno.test(
  "redirect refusal contains both fixed token header modes on the SDK probe",
  async () => {
    let targetRequests = 0;
    const target = startLoopbackServer(() => {
      targetRequests++;
      return new Response("unexpected redirect target");
    });
    try {
      for (
        const tokenConfig of [
          {
            token: "standard-fixture-token",
            expectedHeader: "authorization",
            expectedValue: "Bearer standard-fixture-token",
          },
          {
            token: "custom-fixture-token",
            tokenHeader: "x-fixture-key",
            expectedHeader: "x-fixture-key",
            expectedValue: "custom-fixture-token",
          },
        ]
      ) {
        let sourceRequests = 0;
        let tokenHeaderObserved: string | null = null;
        const source = startLoopbackServer((request) => {
          sourceRequests++;
          tokenHeaderObserved = request.headers.get(tokenConfig.expectedHeader);
          return new Response(null, {
            status: 307,
            headers: { location: target.url },
          });
        });
        try {
          const recall = buildMemorySearch({
            url: source.url,
            tool: FIXTURE_TOOL,
            token: tokenConfig.token,
            tokenHeader: tokenConfig.tokenHeader,
          });
          await assertRejectsWithin(recall("redirect-needle"));
        } finally {
          await source.close();
        }
        assertEquals(sourceRequests, 1);
        assertEquals(tokenHeaderObserved, tokenConfig.expectedValue);
      }
    } finally {
      await target.close();
    }
    assertEquals(targetRequests, 0);
  },
);

Deno.test(
  "a broken modern response stream fails once without partial success or replay",
  async () => {
    const requestIds: unknown[] = [];
    const methods: string[] = [];
    const mcp = createMcpHandler(
      () =>
        fixtureServer(() => {
          throw new Error("broken stream must not reach the tool handler");
        }),
      { legacy: "reject" },
    );
    const encoder = new TextEncoder();
    const http = startLoopbackServer(async (request) => {
      if (request.method !== "POST") return mcp.fetch(request);
      const body = await request.clone().json() as {
        id?: unknown;
        method?: string;
      };
      if (typeof body.method === "string") methods.push(body.method);
      if (body.method !== "tools/call") return mcp.fetch(request);
      requestIds.push(body.id);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `event: message\ndata: {"jsonrpc":"2.0","id":${body.id},"result":{"content":[{"type":"text","text":"partial`,
              ),
            );
            queueMicrotask(() => controller.close());
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });

    try {
      const recall = buildMemorySearch({ url: http.url, tool: FIXTURE_TOOL });
      await assertRejectsWithin(recall("broken-stream-needle"), 32_000);
    } finally {
      await mcp.close();
      await http.close();
    }

    assertEquals(requestIds.length, 1);
    assert(requestIds[0] !== undefined, "tool request lacked a request ID");
    assertEquals(
      methods.filter((method) => method === "tools/call").length,
      1,
    );
    assertEquals(
      methods.filter((method) => method === "initialize").length,
      0,
    );
  },
);

Deno.test(
  "diagnostics bound and sanitize server-controlled structured fields",
  async () => {
    const query = "private-query-fragment";
    const token = "private-token-fragment";
    const extensionEntries = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `extension-${index}-${"x".repeat(96)}${index === 0 ? query : ""}`,
        {},
      ]),
    );
    const diagnostics: MemorySearchDiagnostic[] = [];
    const mcp = createMcpHandler(
      () =>
        fixtureServer(() => {}, {
          name: `fixture-${compatibilityForm(query)}-${
            compatibilityForm(token)
          }`,
          version: `1.2.3\nforeign response prose ${query}`,
          extensions: extensionEntries,
        }),
      { legacy: "reject" },
    );
    const http = startLoopbackServer((request) => mcp.fetch(request));

    try {
      const recall = buildMemorySearch(
        { url: http.url, tool: FIXTURE_TOOL, token },
        (diagnostic) => diagnostics.push(diagnostic),
      );
      await recall(query);
    } finally {
      await mcp.close();
      await http.close();
    }

    assertEquals(diagnostics.length, 1);
    const diagnostic = diagnostics[0]!;
    const serialized = JSON.stringify(diagnostic);
    for (const forbidden of [query, token, http.url]) {
      assert(
        !serialized.includes(forbidden),
        "diagnostic retained private input",
      );
    }
    assertEquals(diagnostic.era, "modern");
    assertEquals(diagnostic.revision, "2026-07-28");
    assertEquals(diagnostic.extensions.length, 8);
    for (const identifier of diagnostic.extensions) {
      assert(
        new TextEncoder().encode(identifier).byteLength <= 64,
        "extension identifier exceeded its byte bound",
      );
    }
    assert(diagnostic.server !== undefined, "server identity was omitted");
    assert(
      diagnostic.server.name.includes("redacted"),
      "server name did not prove normalized redaction",
    );
    assert(
      diagnostic.server.version.includes("redacted"),
      "server version did not prove redaction",
    );
    for (const value of [diagnostic.server.name, diagnostic.server.version]) {
      assert(
        new TextEncoder().encode(value).byteLength <= 64,
        "server identity exceeded its byte bound",
      );
    }
  },
);

Deno.test(
  "diagnostics bound normalization and retained extension processing",
  async () => {
    const sensitiveValue = "abcdefghijklmnopqrstuvwxyz".repeat(5).slice(0, 120);
    const extensions = Object.fromEntries([
      [`oversized-${"x".repeat(16_384)}`, {}],
      [`partial-${sensitiveValue.slice(0, 64)}`, {}],
      ...Array.from({ length: 6 }, (_, index) => [
        `z-extension-${index}`,
        {},
      ]),
      ["a-extension-after-the-bound", {}],
    ]);
    const diagnostics: MemorySearchDiagnostic[] = [];
    const mcp = createMcpHandler(
      () =>
        fixtureServer(() => {}, {
          name: `fixture-${sensitiveValue}`,
          version: sensitiveValue,
          extensions,
        }),
      { legacy: "reject" },
    );
    let http: LoopbackFixture | undefined;
    const originalNormalize = String.prototype.normalize;

    try {
      http = startLoopbackServer((request) => mcp.fetch(request));
      String.prototype.normalize = function (form?: string): string {
        const value = String(this);
        if (value.length > 256) {
          throw new Error("diagnostic normalized an over-limit identifier");
        }
        return originalNormalize.call(value, form);
      };
      const recall = buildMemorySearch(
        { url: http.url, tool: FIXTURE_TOOL, token: sensitiveValue },
        (diagnostic) => diagnostics.push(diagnostic),
      );
      await recall("bounded diagnostic probe");
    } finally {
      String.prototype.normalize = originalNormalize;
      const cleanup = await Promise.allSettled([
        mcp.close(),
        http?.close() ?? Promise.resolve(),
      ]);
      assert(
        cleanup.every((result) => result.status === "fulfilled"),
        "fixture cleanup failed",
      );
    }

    assertEquals(diagnostics.length, 1);
    assert(diagnostics[0]?.server !== undefined, "server identity was omitted");
    assert(
      !JSON.stringify(diagnostics[0]).includes(sensitiveValue.slice(0, 64)),
      "diagnostic retained the prefix of a redacted sensitive value",
    );
    assert(
      !JSON.stringify(diagnostics[0]).includes(sensitiveValue.slice(64)),
      "diagnostic retained the suffix of a redacted sensitive value",
    );
    assertEquals(
      diagnostics[0]?.extensions,
      Array.from({ length: 6 }, (_, index) => `z-extension-${index}`),
    );
  },
);

Deno.test(
  "diagnostics are omitted when a sensitive input exceeds the scan bound",
  async () => {
    const longQuery = `${"q".repeat(256)}distinct-sensitive-suffix`;
    const diagnostics: MemorySearchDiagnostic[] = [];
    const mcp = createMcpHandler(
      () =>
        fixtureServer(() => {}, {
          version: longQuery.slice(256),
        }),
      { legacy: "reject" },
    );
    let http: LoopbackFixture | undefined;

    try {
      http = startLoopbackServer((request) => mcp.fetch(request));
      const recall = buildMemorySearch(
        { url: http.url, tool: FIXTURE_TOOL },
        (diagnostic) => diagnostics.push(diagnostic),
      );
      await recall(longQuery);
    } finally {
      const cleanup = await Promise.allSettled([
        mcp.close(),
        http?.close() ?? Promise.resolve(),
      ]);
      assert(
        cleanup.every((result) => result.status === "fulfilled"),
        "fixture cleanup failed",
      );
    }

    assertEquals(diagnostics, []);
  },
);

Deno.test(
  "diagnostics omit identifiers that collide with the redaction marker",
  async () => {
    const diagnostics: MemorySearchDiagnostic[] = [];
    const mcp = createMcpHandler(
      () =>
        fixtureServer(() => {}, {
          extensions: { redacted: {} },
        }),
      { legacy: "reject" },
    );
    let http: LoopbackFixture | undefined;

    try {
      http = startLoopbackServer((request) => mcp.fetch(request));
      const recall = buildMemorySearch(
        { url: http.url, tool: FIXTURE_TOOL },
        (diagnostic) => diagnostics.push(diagnostic),
      );
      await recall("redacted");
    } finally {
      const cleanup = await Promise.allSettled([
        mcp.close(),
        http?.close() ?? Promise.resolve(),
      ]);
      assert(
        cleanup.every((result) => result.status === "fulfilled"),
        "fixture cleanup failed",
      );
    }

    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0]?.extensions, []);
  },
);
