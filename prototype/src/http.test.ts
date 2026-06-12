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
      authContext: {
        transport: "loopback",
        authnStatus: "unauthenticated",
        authnMechanism: "local_user",
        authnIssuerRef: "local_os",
        authzBasis: "policy:loopback-local",
      },
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
      error: "cross-origin workbench requests are not allowed",
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

describe("remote bearer auth", () => {
  const apiKey = "test-workbench-key-0123456789abcdef";
  const remoteHost = "100.64.0.7";

  function authedHandler(calls: WorkbenchRuntimeInput[] = []) {
    return createWorkbenchHttpHandler({
      runRuntime: async (input) => {
        calls.push(input);
        return runtimeResult();
      },
      loadModels: () => Promise.resolve([]),
      auth: { apiKey, allowedHosts: [remoteHost] },
    });
  }

  function turnRequest(
    host: string,
    headers: Record<string, string> = {},
  ): Request {
    return new Request(`http://${host}:8787/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ prompt: "remote turn" }),
    });
  }

  test("rejects remote requests without a bearer", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const response = await authedHandler(calls)(turnRequest(remoteHost));
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("rejects remote requests with a wrong bearer", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const response = await authedHandler(calls)(
      turnRequest(remoteHost, { authorization: "Bearer wrong-key" }),
    );
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("accepts remote requests with the configured bearer", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const response = await authedHandler(calls)(
      turnRequest(remoteHost, { authorization: `Bearer ${apiKey}` }),
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.authContext).toEqual({
      transport: "remote",
      authnStatus: "authenticated",
      authnMechanism: "api_key",
      authnIssuerRef: "workbench_api_key",
      authzBasis: "capability:workbench-api-key",
    });
  });

  test("rejects unknown non-loopback hosts even with the bearer", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const response = await authedHandler(calls)(
      turnRequest("workbench.example.com", {
        authorization: `Bearer ${apiKey}`,
      }),
    );
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("fails closed on remote hosts when no key is configured", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const handler = createWorkbenchHttpHandler({
      runRuntime: async (input) => {
        calls.push(input);
        return runtimeResult();
      },
      auth: { allowedHosts: [remoteHost] },
    });
    const response = await handler(
      turnRequest(remoteHost, { authorization: `Bearer ${apiKey}` }),
    );
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("rejects a wrong bearer even on loopback", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const response = await authedHandler(calls)(
      turnRequest("127.0.0.1", { authorization: "Bearer wrong-key" }),
    );
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("records api_key authn for a valid bearer on loopback", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const response = await authedHandler(calls)(
      turnRequest("127.0.0.1", { authorization: `Bearer ${apiKey}` }),
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.authContext).toMatchObject({
      transport: "loopback",
      authnStatus: "authenticated",
      authnMechanism: "api_key",
    });
  });

  test("allows same-host remote origins and rejects foreign origins", async () => {
    const handler = authedHandler();
    const sameHost = await handler(
      turnRequest(remoteHost, {
        authorization: `Bearer ${apiKey}`,
        origin: `http://${remoteHost}:8787`,
      }),
    );
    expect(sameHost.status).toBe(200);

    const foreign = await handler(
      turnRequest(remoteHost, {
        authorization: `Bearer ${apiKey}`,
        origin: "https://evil.example.com",
      }),
    );
    expect(foreign.status).toBe(403);
  });

  test("guards /api/models with the same bearer policy", async () => {
    const handler = authedHandler();
    const unauthenticated = await handler(
      new Request(`http://${remoteHost}:8787/api/models`),
    );
    expect(unauthenticated.status).toBe(401);

    const authenticated = await handler(
      new Request(`http://${remoteHost}:8787/api/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
    expect(authenticated.status).toBe(200);
  });

  test("serves the static shell on an allowed remote host without a bearer", async () => {
    const handler = authedHandler();
    const response = await handler(
      new Request(`http://${remoteHost}:8787/`),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("DYFJ Workbench");
  });
});

describe("session REST surface", () => {
  const sessionId = "01ABCDEF0123456789ABCDEF01";
  const sampleEvent = {
    eventId: "01EVENT",
    eventType: "session_start",
    traceId: "trace",
    principalId: "chris",
    modelId: null,
    provider: null,
    content: "earlier prompt",
    stopReason: null,
    tokensInput: null,
    tokensOutput: null,
    costTotal: null,
    createdAt: "2026-06-12 10:00:00",
  };

  test("lists sessions grouped by project", async () => {
    const calls: Array<{ project?: string }> = [];
    const handler = createWorkbenchHttpHandler({
      runRuntime: () => Promise.resolve(runtimeResult()),
      listSessions: (options) => {
        calls.push(options);
        return Promise.resolve([{
          project: "dyfj",
          sessions: [],
        }]);
      },
    });
    const response = await handler(
      new Request("http://127.0.0.1:8787/api/sessions?project=dyfj"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projects: [{ project: "dyfj", sessions: [] }],
    });
    expect(calls).toEqual([{ project: "dyfj" }]);
  });

  test("creates a project-bound session", async () => {
    const handler = createWorkbenchHttpHandler({
      runRuntime: () => Promise.resolve(runtimeResult()),
      createSession: (input) =>
        Promise.resolve({
          sessionId,
          slug: "workbench-x",
          project: input.project ?? null,
        }),
    });
    const response = await handler(
      new Request("http://127.0.0.1:8787/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: "dyfj" }),
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sessionId, project: "dyfj" });
  });

  test("fetches session events with an asOf passthrough", async () => {
    const calls: Array<{ sessionId: string; asOf?: string }> = [];
    const handler = createWorkbenchHttpHandler({
      runRuntime: () => Promise.resolve(runtimeResult()),
      fetchSessionEvents: (input) => {
        calls.push(input);
        return Promise.resolve([sampleEvent]);
      },
    });
    const response = await handler(
      new Request(
        `http://127.0.0.1:8787/api/sessions/${sessionId}/events?asOf=2026-06-12 10:00:00`,
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.events).toHaveLength(1);
    expect(calls).toEqual([{ sessionId, asOf: "2026-06-12 10:00:00" }]);
  });

  test("rejects malformed session ids and asOf values", async () => {
    const handler = createWorkbenchHttpHandler({
      runRuntime: () => Promise.resolve(runtimeResult()),
      fetchSessionEvents: () => Promise.resolve([]),
    });
    const badId = await handler(
      new Request("http://127.0.0.1:8787/api/sessions/not-a-ulid/events"),
    );
    expect(badId.status).toBe(400);
    const badAsOf = await handler(
      new Request(
        `http://127.0.0.1:8787/api/sessions/${sessionId}/events?asOf=yesterday`,
      ),
    );
    expect(badAsOf.status).toBe(400);
  });

  test("guards session endpoints with the bearer policy", async () => {
    const handler = createWorkbenchHttpHandler({
      runRuntime: () => Promise.resolve(runtimeResult()),
      listSessions: () => Promise.resolve([]),
      auth: { apiKey: "k", allowedHosts: ["100.64.0.7"] },
    });
    const response = await handler(
      new Request("http://100.64.0.7:8787/api/sessions"),
    );
    expect(response.status).toBe(401);
  });

  test("resumes a session on /api/turn with rebuilt conversation context", async () => {
    const runtimeCalls: WorkbenchRuntimeInput[] = [];
    const handler = createWorkbenchHttpHandler({
      runRuntime: (input) => {
        runtimeCalls.push(input);
        return Promise.resolve(runtimeResult());
      },
      fetchSessionEvents: () =>
        Promise.resolve([
          sampleEvent,
          {
            ...sampleEvent,
            eventType: "model_response",
            content: "earlier answer",
          },
        ]),
    });
    const response = await handler(
      new Request("http://127.0.0.1:8787/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "continue", sessionId }),
      }),
    );
    expect(response.status).toBe(200);
    expect(runtimeCalls[0].sessionId).toBe(sessionId);
    expect(runtimeCalls[0].conversationContext).toContain(
      "Operator: earlier prompt",
    );
    expect(runtimeCalls[0].conversationContext).toContain(
      "Assistant: earlier answer",
    );
  });

  test("rejects a malformed sessionId on /api/turn", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const handler = createWorkbenchHttpHandler({
      runRuntime: (input) => {
        calls.push(input);
        return Promise.resolve(runtimeResult());
      },
    });
    const response = await handler(
      new Request("http://127.0.0.1:8787/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "continue", sessionId: "nope" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
