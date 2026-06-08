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
