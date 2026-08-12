import {
  Client,
  type FetchLike,
  StreamableHTTPClientTransport,
} from "npm:@modelcontextprotocol/client@2.0.0";
import {
  acceptedContent,
  completable,
  createMcpHandler,
  inputRequired,
  McpServer,
} from "npm:@modelcontextprotocol/server@2.0.0";
import { z } from "npm:zod@4.4.3";
import { buildMemorySearch } from "./memory-search.ts";
import { extractMcpTraceContext } from "./mcp-conformance.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function connectedFixture(
  factory: () => McpServer,
  client: Client,
  fetch?: FetchLike,
) {
  const mcp = createMcpHandler(factory, { legacy: "reject" });
  const http = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => mcp.fetch(request),
  );
  const { port } = http.addr as Deno.NetAddr;
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    fetch === undefined ? undefined : { fetch },
  );
  await client.connect(transport);
  return async () => {
    await Promise.all([client.close(), mcp.close(), http.shutdown()]);
  };
}

function modernClient(options: ConstructorParameters<typeof Client>[1] = {}): Client {
  return new Client({ name: "dyfj-conformance-client", version: "1.0.0" }, {
    ...options,
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  });
}

Deno.test("MCP recall injects and the server extracts canonical W3C context", async () => {
  let receivedMeta: Record<string, unknown> | undefined;
  const mcp = createMcpHandler(() => {
    const server = new McpServer({
      name: "dyfj-conformance-server",
      version: "1.0.0",
    });
    server.registerTool(
      "trace-read",
      { inputSchema: z.object({ query: z.string() }) },
      (_args, ctx) => {
        receivedMeta = ctx.mcpReq._meta;
        return { content: [{ type: "text", text: "traced" }] };
      },
    );
    return server;
  }, { legacy: "reject" });
  const http = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => mcp.fetch(request),
  );
  const { port } = http.addr as Deno.NetAddr;
  try {
    const recall = buildMemorySearch({
      url: `http://127.0.0.1:${port}/mcp`,
      tool: "trace-read",
    });
    const result = await recall("fixture", {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
      traceState: "vendor=value",
    });
    assert(result === "traced", "unexpected trace fixture result");
    const extracted = extractMcpTraceContext(receivedMeta);
    assert(extracted !== undefined, "server did not extract trace context");
    assert(extracted.traceId === "4bf92f3577b34da6a3ce929d0e0e4736", "trace id changed");
    assert(extracted.parentSpanId === "00f067aa0ba902b7", "parent span changed");
    assert(extracted.parentIsRemote, "remote-parent evidence was absent");
    assert(receivedMeta?.baggage === undefined, "raw baggage crossed the boundary");
  } finally {
    await Promise.all([mcp.close(), http.shutdown()]);
  }
});

Deno.test("MCP fixture completes a bounded multi-round-trip request", async () => {
  const requestStates: string[] = [];
  const requestIds: unknown[] = [];
  const factory = () => {
    const server = new McpServer({
      name: "dyfj-conformance-server",
      version: "1.0.0",
    });
    server.registerTool(
      "confirm-read",
      { inputSchema: z.object({ query: z.string() }) },
      ({ query }, ctx) => {
        const state = ctx.mcpReq.requestState<string>();
        if (state !== undefined) requestStates.push(state);
        const accepted = acceptedContent<{ confirm: boolean }>(
          ctx.mcpReq.inputResponses,
          "confirm",
        );
        if (accepted?.confirm !== true) {
          return inputRequired({
            requestState: "fixture-state-v1",
            inputRequests: {
              confirm: inputRequired.elicit({
                message: "Confirm the deterministic read",
                requestedSchema: {
                  type: "object",
                  properties: { confirm: { type: "boolean" } },
                  required: ["confirm"],
                },
              }),
            },
          });
        }
        return { content: [{ type: "text", text: `confirmed:${query}` }] };
      },
    );
    return server;
  };

  const client = modernClient({
    capabilities: { elicitation: {} },
    inputRequired: { maxRounds: 2 },
  });
  client.setRequestHandler("elicitation/create", () => ({
    action: "accept",
    content: { confirm: true },
  }));
  const recordingFetch: FetchLike = async (input, init) => {
    if (typeof init?.body === "string") {
      const request = JSON.parse(init.body) as { id?: unknown; method?: string };
      if (request.method === "tools/call") requestIds.push(request.id);
    }
    return await fetch(input, init);
  };
  const close = await connectedFixture(factory, client, recordingFetch);
  try {
    const result = await client.callTool({
      name: "confirm-read",
      arguments: { query: "fixture" },
    });
    assert(result.content[0]?.type === "text", "fixture result was not text");
    assert(result.content[0].text === "confirmed:fixture", "unexpected fixture result");
    assert(
      requestStates.length === 1 && requestStates[0] === "fixture-state-v1",
      "requestState was not echoed byte-exactly",
    );
    assert(
      requestIds.length === 2 && requestIds[0] !== requestIds[1],
      "multi-round trip did not use a fresh request ID",
    );
  } finally {
    await close();
  }
});

Deno.test("MCP fixture returns deterministic completion candidates", async () => {
  const factory = () => {
    const server = new McpServer({
      name: "dyfj-conformance-server",
      version: "1.0.0",
    });
    server.registerPrompt(
      "fixture-prompt",
      {
        argsSchema: z.object({
          language: completable(z.string(), (value) =>
            ["rust", "typescript", "zig"].filter((entry) => entry.startsWith(value))
          ),
        }),
      },
      ({ language }) => ({
        messages: [{ role: "user", content: { type: "text", text: language } }],
      }),
    );
    return server;
  };
  const client = modernClient();
  const close = await connectedFixture(factory, client);
  try {
    const result = await client.complete({
      ref: { type: "ref/prompt", name: "fixture-prompt" },
      argument: { name: "language", value: "t" },
    });
    assert(result.completion.values.join(",") === "typescript", "unexpected completions");
  } finally {
    await close();
  }
});

Deno.test("MCP fixture propagates cancellation through the request stream", async () => {
  const handlerEntered = Promise.withResolvers<void>();
  const serverCancelled = Promise.withResolvers<void>();
  const factory = () => {
    const server = new McpServer({
      name: "dyfj-conformance-server",
      version: "1.0.0",
    });
    server.registerTool(
      "wait",
      { inputSchema: z.object({}) },
      (_args, ctx) => new Promise((resolve) => {
        handlerEntered.resolve();
        ctx.mcpReq.signal.addEventListener("abort", () => {
          serverCancelled.resolve();
          resolve({
            resultType: "complete",
            isError: true,
            content: [{ type: "text", text: "cancelled" }],
          });
        }, { once: true });
      }),
    );
    return server;
  };
  const mcp = createMcpHandler(factory, { legacy: "reject" });
  const client = modernClient();
  const transport = new StreamableHTTPClientTransport(
    new URL("http://mcp-conformance.invalid/mcp"),
    {
      fetch: (input, init) => mcp.fetch(new Request(input, init)),
    },
  );
  await client.connect(transport);
  const controller = new AbortController();
  try {
    const call = client.callTool(
      { name: "wait", arguments: {} },
      { signal: controller.signal, timeout: 1_000 },
    );
    await withDeadline(
      handlerEntered.promise,
      1_000,
      "server handler was not entered",
    );
    controller.abort();
    await call.then(
      () => {
        throw new Error("cancelled call unexpectedly completed");
      },
      (error) =>
        assert(
          error instanceof Error && /abort|cancel/i.test(error.message),
          "unexpected cancellation error",
        ),
    );
    await withDeadline(
      serverCancelled.promise,
      1_000,
      "server did not observe cancellation",
    );
  } finally {
    await Promise.all([client.close(), mcp.close()]);
  }
});
