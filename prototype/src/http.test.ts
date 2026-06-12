import { describe, expect, test } from "vitest";
import { createWorkbenchHttpHandler } from "./http";
import type {
  WorkbenchRuntimeInput,
  WorkbenchRuntimeResult,
} from "./workbench";

function runtimeResult(overrides: Partial<WorkbenchRuntimeResult> = {}) {
  return {
    sessionId: "01HTTPSESSION00000000000000",
    traceId: "0123456789abcdef0123456789abcdef",
    text: "Workbench says hello.",
    receipt: "Workbench receipt\nSession: 01HTTPSESSION00000000000000",
    model: {
      displayName: "Gemma 4 E2B",
      slug: "gemma4:e2b",
      provider: "ollama",
      api: "openai-compatible",
      tier: 0,
    },
    route: {
      reason: "default",
    },
    cost: {
      estimatedUsd: 0,
      totalUsd: 0,
      paidInferenceUsed: false,
    },
    tokens: {
      input: 10,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      totalCalls: 1,
    },
    context: {
      sources: ["README.md Section 1 <README.md#section-1>"],
    },
    ...overrides,
  } satisfies WorkbenchRuntimeResult;
}

describe("createWorkbenchHttpHandler", () => {
  test("serves a minimal human-readable Workbench surface", async () => {
    const handler = createWorkbenchHttpHandler({
      runRuntime: () => Promise.resolve(runtimeResult()),
    });

    const response = await handler(new Request("http://localhost/"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("DYFJ Workbench");
    expect(html).toContain("/api/turn");
    expect(html).toContain("Timeline");
    expect(html).toContain("Inspector");
  });

  test("runs a JSON turn through the injected runtime", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const handler = createWorkbenchHttpHandler({
      runRuntime: async (input) => {
        calls.push(input);
        await input.onRuntimeEvent?.({
          type: "sessionStart",
          sessionId: "01HTTPSESSION00000000000000",
          traceId: "0123456789abcdef0123456789abcdef",
          mode: "turn",
        });
        await input.onRuntimeEvent?.({
          type: "modelSelected",
          sessionId: "01HTTPSESSION00000000000000",
          modelSlug: "gemma4:e2b",
          tier: 0,
          reason: "default",
        });
        return runtimeResult();
      },
    });

    const response = await handler(
      new Request("http://localhost/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "summarize the repo",
          mode: "turn",
          routingOptions: { modelId: "gemma4:e2b", tier: 0 },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      mode: "turn",
      prompt: "summarize the repo",
      routingOptions: { modelId: "gemma4:e2b", tier: 0 },
      onRuntimeEvent: expect.any(Function),
      confirmPaidEscalation: expect.any(Function),
    }]);
    expect(body).toMatchObject({
      sessionId: "01HTTPSESSION00000000000000",
      traceId: "0123456789abcdef0123456789abcdef",
      text: "Workbench says hello.",
      model: { slug: "gemma4:e2b", tier: 0 },
      route: { reason: "default" },
      cost: { totalUsd: 0, paidInferenceUsed: false },
      tokens: { input: 10, output: 4, totalCalls: 1 },
      receipt: "Workbench receipt\nSession: 01HTTPSESSION00000000000000",
      events: [
        {
          type: "sessionStart",
          sessionId: "01HTTPSESSION00000000000000",
          traceId: "0123456789abcdef0123456789abcdef",
          mode: "turn",
        },
        {
          type: "modelSelected",
          sessionId: "01HTTPSESSION00000000000000",
          modelSlug: "gemma4:e2b",
          tier: 0,
          reason: "default",
        },
      ],
    });
  });

  test("rejects cross-origin turn requests before runtime dispatch", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const handler = createWorkbenchHttpHandler({
      runRuntime: async (input) => {
        calls.push(input);
        return runtimeResult();
      },
    });

    const response = await handler(
      new Request("http://localhost/api/turn", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "origin": "https://attacker.example",
        },
        body: JSON.stringify({ prompt: "drive local workbench" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: "cross-origin workbench turn requests are not allowed",
    });
    expect(calls).toEqual([]);
  });

  test("rejects non-JSON turn requests before runtime dispatch", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const handler = createWorkbenchHttpHandler({
      runRuntime: async (input) => {
        calls.push(input);
        return runtimeResult();
      },
    });

    const response = await handler(
      new Request("http://localhost/api/turn", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ prompt: "drive local workbench" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: "content-type must be application/json" });
    expect(calls).toEqual([]);
  });

  test("fails closed when the runtime asks HTTP for paid inference consent", async () => {
    const handler = createWorkbenchHttpHandler({
      runRuntime: async (input) => {
        await input.confirmPaidEscalation?.("paid model selected");
        return runtimeResult();
      },
    });

    const response = await handler(
      new Request("http://localhost/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "use paid inference" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "paid inference requires an explicit CLI consent flow",
    });
  });
});

describe("GET /api/models", () => {
  const pickerModels = [
    {
      slug: "mlx-community/Qwen3.5-4B-8bit",
      displayName: "Qwen3.5 4B MLX",
      provider: "mlx-lm",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18080/v1",
      tier: 0 as const,
      costInput: 0,
      costOutput: 0,
      capabilities: ["text", "code", "reasoning"],
    },
    {
      slug: "claude-opus-4-8",
      displayName: "Claude Opus 4.8",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      tier: 2 as const,
      costInput: 5,
      costOutput: 25,
      capabilities: ["text", "code", "reasoning"],
    },
  ];

  test("returns the registry for the picker", async () => {
    const handler = createWorkbenchHttpHandler({
      runRuntime: () => Promise.resolve(runtimeResult()),
      loadModels: () => Promise.resolve(pickerModels),
    });
    const response = await handler(
      new Request("http://127.0.0.1:8787/api/models"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.models).toHaveLength(2);
    expect(body.models[1]).toMatchObject({
      slug: "claude-opus-4-8",
      tier: 2,
      costInput: 5,
    });
  });

  test("rejects non-loopback hosts", async () => {
    const handler = createWorkbenchHttpHandler({
      runRuntime: () => Promise.resolve(runtimeResult()),
      loadModels: () => Promise.resolve(pickerModels),
    });
    const response = await handler(
      new Request("http://workbench.example.com:8787/api/models"),
    );
    expect(response.status).toBe(403);
  });

  test("rejects cross-origin reads", async () => {
    const handler = createWorkbenchHttpHandler({
      runRuntime: () => Promise.resolve(runtimeResult()),
      loadModels: () => Promise.resolve(pickerModels),
    });
    const response = await handler(
      new Request("http://127.0.0.1:8787/api/models", {
        headers: { origin: "https://evil.example.com" },
      }),
    );
    expect(response.status).toBe(403);
  });
});
