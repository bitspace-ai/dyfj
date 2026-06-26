import { describe, expect, test } from "vitest";
import { createWorkbenchHttpHandler } from "./http";
import { PAID_ESCALATION_REMOTE_DENIED } from "./turn-runner";
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

function parseSseFrames(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)));
}

/**
 * Simulate the ServeHandlerInfo Deno passes the handler. The TCP peer address
 * here — not the request URL / Host header — is what decides loopback vs remote.
 */
function serveInfo(hostname: string): Deno.ServeHandlerInfo {
  return {
    remoteAddr: { transport: "tcp", hostname, port: 54321 },
  } as Deno.ServeHandlerInfo;
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
    // inspector renders a formatted receipt (not raw JSON) with cache telemetry.
    expect(html).toContain("humanizeKey");
    expect(html).toContain("cacheRead");
    // the shell carries the project-grouped WORK pane wired to the
    // runtime REST surface (session list, select-to-resume, new session) and
    // renders events from Dolt truth rather than ephemeral client state.
    expect(html).toContain('id="work-list"');
    expect(html).toContain('id="new-session"');
    expect(html).toContain("/api/sessions");
    expect(html).toContain("loadSessionEvents");
    expect(html).toContain("startNewSession");
    expect(html).toContain("SESSION_POINTER");
    // capability-aware model picker — a populated model <select> from
    // /api/models, a capability filter, and the modelId>tier>hint cascade made
    // legible by disabling overridden controls.
    expect(html).toContain('id="model-id"');
    expect(html).toContain('id="cap-filter"');
    expect(html).toContain("/api/models");
    expect(html).toContain("loadModelsIntoPicker");
    expect(html).toContain("updateRoutingCascade");
    // (UI): per-turn paid-inference confirm dialog + budget override
    // inputs that drive the loopback-gated server fields.
    expect(html).toContain('id="paid-modal"');
    expect(html).toContain('id="paid-approve"');
    expect(html).toContain('id="budget-per-call"');
    expect(html).toContain("confirmPaidInference");
    expect(html).toContain("readBudgetOverride");
    expect(html).toContain("isPaidRiskSelection");
  });

  test("the served shell script parses (no outer-template escape corruption)", async () => {
    const handler = createWorkbenchHttpHandler({
      runRuntime: () => Promise.resolve(runtimeResult()),
    });
    const html = await (await handler(new Request("http://localhost/"))).text();
    const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    // The inline shell JS lives inside http.ts's outer HTML template literal, so
    // a source "\n" or /\s+/ is eaten by that literal before it reaches the
    // browser (a raw newline inside a string literal is a SyntaxError). The
    // handler unit tests only assert on the HTML string and never execute the
    // JS, so this guard compiles (parses, without running) the served script.
    expect(() => new Function(match![1])).not.toThrow();
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
    // toMatchObject (not toEqual): the boundary also injects env-derived runtime
    // defaults (principalId/rootOverride/budgetTallyMode) we don't pin here.
    expect(calls).toMatchObject([{
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

  test("streams a turn as SSE when the client accepts text/event-stream", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const handler = createWorkbenchHttpHandler({
      runRuntime: async (input) => {
        calls.push(input);
        await input.onRuntimeEvent?.({
          type: "modelSelected",
          sessionId: "01HTTPSESSION00000000000000",
          modelSlug: "gemma4:e2b",
          tier: 0,
          reason: "default",
        });
        input.onTextDelta?.("Workbench ");
        input.onTextDelta?.("says hello.");
        return runtimeResult();
      },
    });

    const response = await handler(
      new Request("http://localhost/api/turn", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "text/event-stream",
        },
        body: JSON.stringify({
          prompt: "hello",
          mode: "turn",
          routingOptions: {},
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // The streaming path wires onTextDelta; the buffered path does not.
    expect(calls[0]?.onTextDelta).toEqual(expect.any(Function));

    const frames = parseSseFrames(await response.text());
    expect(frames).toContainEqual({ t: "delta", text: "Workbench " });
    expect(frames).toContainEqual({ t: "delta", text: "says hello." });
    expect(frames).toContainEqual({
      t: "event",
      event: {
        type: "modelSelected",
        sessionId: "01HTTPSESSION00000000000000",
        modelSlug: "gemma4:e2b",
        tier: 0,
        reason: "default",
      },
    });
    const done = frames.find((frame) => frame.t === "done");
    expect(done?.result).toMatchObject({
      sessionId: "01HTTPSESSION00000000000000",
      text: "Workbench says hello.",
      model: { slug: "gemma4:e2b", tier: 0 },
    });
    // The terminal done frame is last.
    expect(frames[frames.length - 1]).toMatchObject({ t: "done" });
  });

  test("locks the turn receipt contract: identical receipt across in-process, JSON, and SSE paths", async () => {
    // The result the runtime produces in-process is the fidelity reference.
    const inProcess = runtimeResult();
    const handler = () =>
      createWorkbenchHttpHandler({
        runRuntime: () => Promise.resolve(inProcess),
      });
    const turnBody = JSON.stringify({
      prompt: "hi",
      mode: "turn",
      routingOptions: {},
    });

    // Buffered JSON path: body is the receipt plus the batched events array.
    const jsonResp = await handler()(
      new Request("http://localhost/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: turnBody,
      }),
    );
    const { events: _events, ...jsonReceipt } = await jsonResp.json();

    // Streaming SSE path: the receipt rides the terminal `done` frame.
    const sseResp = await handler()(
      new Request("http://localhost/api/turn", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "text/event-stream",
        },
        body: turnBody,
      }),
    );
    const done = parseSseFrames(await sseResp.text()).find((f) =>
      f.t === "done"
    );
    const sseReceipt = done?.result;

    // The receipt is faithful to the in-process result on both transports...
    expect(jsonReceipt).toEqual(inProcess);
    expect(sseReceipt).toEqual(inProcess);
    // ...and identical across the two transports.
    expect(sseReceipt).toEqual(jsonReceipt);
    // The drift that motivated this lock (client TurnResult had no `context`):
    // context.sources provenance must survive the wire on the streaming path.
    expect((sseReceipt as typeof inProcess).context.sources).toEqual(
      inProcess.context.sources,
    );
  });

  test("serializes concurrent same-session turns; never runs them in parallel", async () => {
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    const handler = createWorkbenchHttpHandler({
      fetchSessionEvents: () => Promise.resolve([]),
      runRuntime: async (input) => {
        active++;
        peak = Math.max(peak, active);
        order.push(`start:${input.sessionId}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end:${input.sessionId}`);
        active--;
        return runtimeResult({ sessionId: input.sessionId });
      },
    });
    const sessionId = "01ABCDEF0123456789ABCDEF01";
    const turn = () =>
      handler(
        new Request("http://localhost/api/turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: "x",
            mode: "turn",
            sessionId,
            routingOptions: {},
          }),
        }),
      );

    const [a, b] = await Promise.all([turn(), turn()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Never two same-session turns in flight at once (no split-brain on the log)...
    expect(peak).toBe(1);
    // ...and they ran in series, not interleaved.
    expect(order).toEqual([
      `start:${sessionId}`,
      `end:${sessionId}`,
      `start:${sessionId}`,
      `end:${sessionId}`,
    ]);
  });

  test("serializes the transcript read inside the lock: the second same-session read waits for the first turn", async () => {
    const trace: string[] = [];
    let fetchActive = 0;
    let fetchPeak = 0;
    const handler = createWorkbenchHttpHandler({
      fetchSessionEvents: async ({ sessionId }) => {
        fetchActive++;
        fetchPeak = Math.max(fetchPeak, fetchActive);
        trace.push(`fetch:${sessionId}`);
        await new Promise((resolve) => setTimeout(resolve, 2));
        fetchActive--;
        return [];
      },
      runRuntime: async (input) => {
        trace.push(`run:${input.sessionId}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        trace.push(`done:${input.sessionId}`);
        return runtimeResult({ sessionId: input.sessionId });
      },
    });
    const sessionId = "01ABCDEF0123456789ABCDEF01";
    const turn = () =>
      handler(
        new Request("http://localhost/api/turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: "x",
            mode: "turn",
            sessionId,
            routingOptions: {},
          }),
        }),
      );

    await Promise.all([turn(), turn()]);
    // The prior-event read is inside the per-session critical section: never two
    // reads at once, and the second turn reads only after the first has run and
    // appended its events (read-modify-append is atomic per session).
    expect(fetchPeak).toBe(1);
    expect(trace).toEqual([
      `fetch:${sessionId}`,
      `run:${sessionId}`,
      `done:${sessionId}`,
      `fetch:${sessionId}`,
      `run:${sessionId}`,
      `done:${sessionId}`,
    ]);
  });

  test("does not serialize independent (new-session) turns", async () => {
    let active = 0;
    let peak = 0;
    const handler = createWorkbenchHttpHandler({
      runRuntime: async (input) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return runtimeResult({ sessionId: input.sessionId });
      },
    });
    const turn = () =>
      handler(
        new Request("http://localhost/api/turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: "x",
            mode: "turn",
            routingOptions: {},
          }),
        }),
      );
    await Promise.all([turn(), turn()]);
    // New-session turns are independent — the lock is per-session, so they run
    // concurrently rather than being globally serialized.
    expect(peak).toBe(2);
  });

  test("streaming path reports request-shape errors as JSON before the stream opens", async () => {
    const handler = createWorkbenchHttpHandler({
      runRuntime: () => Promise.resolve(runtimeResult()),
    });
    const response = await handler(
      new Request("http://localhost/api/turn", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "text/event-stream",
        },
        body: JSON.stringify({ prompt: "" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: "prompt must be a non-empty string",
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

  test("rejects a cross-origin SSE turn before stream negotiation", async () => {
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
          "accept": "text/event-stream",
          "origin": "https://attacker.example",
        },
        body: JSON.stringify({ prompt: "drive local workbench" }),
      }),
    );

    // The shared origin gate runs before the Accept header is consulted: the
    // response is a JSON 403, not an event-stream, and the runtime is untouched.
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
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

  // paid inference over HTTP requires BOTH loopback transport AND an
  // explicit per-turn opt-in. A captured-verdict runtime stub exercises the
  // injected confirmPaidEscalation directly.
  const captureVerdict = (sink: { verdict?: unknown }) =>
    createWorkbenchHttpHandler({
      runRuntime: async (input) => {
        sink.verdict = await input.confirmPaidEscalation?.(
          "paid model selected",
        );
        return runtimeResult();
      },
    });
  const REMOTE_KEY = "test-workbench-key-0123456789abcdef";
  const REMOTE_HOST = "100.64.0.7";

  test("loopback caller that explicitly opts in gets paid approval", async () => {
    const sink: { verdict?: unknown } = {};
    const response = await captureVerdict(sink)(
      new Request("http://localhost/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "paid", approvePaidInference: true }),
      }),
    );
    expect(response.status).toBe(200);
    expect(sink.verdict).toEqual({ decision: "approve" });
  });

  test("loopback caller without an opt-in is denied", async () => {
    const sink: { verdict?: unknown } = {};
    await captureVerdict(sink)(
      new Request("http://localhost/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "paid" }),
      }),
    );
    expect(sink.verdict).toEqual({
      decision: "deny",
      reason: "paid inference was not approved for this turn",
    });
  });

  test("loopback inherits approvePaidDefault when the request omits opt-in", async () => {
    const sink: { verdict?: unknown } = {};
    const handler = createWorkbenchHttpHandler({
      engineConfig: {
        defaultCompanionModel: null,
        permissionLevel: "strict",
        approvePaidDefault: true,
        defaultSessionBudgetUsd: 1,
        defaultPerCallBudgetUsd: 0.1,
      },
      runRuntime: async (input) => {
        sink.verdict = await input.confirmPaidEscalation?.(
          "paid model selected",
        );
        return runtimeResult();
      },
    });
    await handler(
      new Request("http://localhost/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "paid" }),
      }),
    );
    expect(sink.verdict).toEqual({ decision: "approve" });
  });

  test("remote caller never inherits approvePaidDefault", async () => {
    let verdict: unknown;
    const handler = createWorkbenchHttpHandler({
      engineConfig: {
        defaultCompanionModel: null,
        permissionLevel: "strict",
        approvePaidDefault: true,
        defaultSessionBudgetUsd: 1,
        defaultPerCallBudgetUsd: 0.1,
      },
      runRuntime: async (input) => {
        verdict = await input.confirmPaidEscalation?.("paid model selected");
        return runtimeResult();
      },
      auth: { apiKey: REMOTE_KEY, allowedHosts: [REMOTE_HOST] },
    });
    await handler(
      new Request(`http://${REMOTE_HOST}:8787/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${REMOTE_KEY}`,
        },
        body: JSON.stringify({ prompt: "paid" }),
      }),
      serveInfo(REMOTE_HOST),
    );
    expect(verdict).toEqual({
      decision: "deny",
      reason: PAID_ESCALATION_REMOTE_DENIED,
    });
  });

  test("a remote caller is denied even WITH the opt-in flag", async () => {
    let verdict: unknown;
    const handler = createWorkbenchHttpHandler({
      runRuntime: async (input) => {
        verdict = await input.confirmPaidEscalation?.("paid model selected");
        return runtimeResult();
      },
      auth: { apiKey: REMOTE_KEY, allowedHosts: [REMOTE_HOST] },
    });
    const response = await handler(
      new Request(`http://${REMOTE_HOST}:8787/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${REMOTE_KEY}`,
        },
        body: JSON.stringify({ prompt: "paid", approvePaidInference: true }),
      }),
      serveInfo(REMOTE_HOST),
    );
    expect(response.status).toBe(200);
    // The opt-in is ignored over a remote transport — remote can never spend.
    expect(verdict).toEqual({
      decision: "deny",
      reason: "paid inference is not available to remote callers",
    });
  });

  test("per-turn budget override is applied on loopback", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const handler = createWorkbenchHttpHandler({
      runRuntime: async (input) => {
        calls.push(input);
        return runtimeResult();
      },
    });
    await handler(
      new Request("http://localhost/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "raise the cap",
          budget: { perCallLimitUsd: 5, sessionLimitUsd: 20 },
        }),
      }),
    );
    expect(calls[0].perCallLimitUsd).toBe(5);
    expect(calls[0].sessionLimitUsd).toBe(20);
  });

  test("a remote caller's budget override is ignored", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const handler = createWorkbenchHttpHandler({
      runRuntime: async (input) => {
        calls.push(input);
        return runtimeResult();
      },
      auth: { apiKey: REMOTE_KEY, allowedHosts: [REMOTE_HOST] },
    });
    await handler(
      new Request(`http://${REMOTE_HOST}:8787/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${REMOTE_KEY}`,
        },
        body: JSON.stringify({
          prompt: "raise the cap",
          budget: { perCallLimitUsd: 5 },
        }),
      }),
      serveInfo(REMOTE_HOST),
    );
    expect(calls[0].perCallLimitUsd).toBeUndefined();
  });

  test("rejects a non-boolean opt-in or malformed budget", async () => {
    const handler = createWorkbenchHttpHandler({
      runRuntime: () => Promise.resolve(runtimeResult()),
    });
    const bad = (body: unknown) =>
      handler(
        new Request("http://localhost/api/turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    expect((await bad({ prompt: "x", approvePaidInference: "yes" })).status)
      .toBe(400);
    expect((await bad({ prompt: "x", budget: { perCallLimitUsd: -1 } })).status)
      .toBe(400);
    expect(
      (await bad({ prompt: "x", budget: { perCallLimitUsd: 99999 } }))
        .status,
    ).toBe(400);
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
    const response = await authedHandler(calls)(
      turnRequest(remoteHost),
      serveInfo(remoteHost),
    );
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("rejects remote requests with a wrong bearer", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const response = await authedHandler(calls)(
      turnRequest(remoteHost, { authorization: "Bearer wrong-key" }),
      serveInfo(remoteHost),
    );
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("rejects an unauthenticated remote SSE turn before stream negotiation", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const response = await authedHandler(calls)(
      turnRequest(remoteHost, { accept: "text/event-stream" }),
      serveInfo(remoteHost),
    );
    // Bearer auth runs before stream negotiation: a JSON 401, no event-stream,
    // and the runtime is never reached.
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(calls).toEqual([]);
  });

  test("accepts remote requests with the configured bearer", async () => {
    const calls: WorkbenchRuntimeInput[] = [];
    const response = await authedHandler(calls)(
      turnRequest(remoteHost, { authorization: `Bearer ${apiKey}` }),
      serveInfo(remoteHost),
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

  test("a forged loopback Host from a remote peer still requires a bearer", async () => {
    // The classic bypass: a remote client sets Host: 127.0.0.1 to look local.
    // Loopback is decided by the TCP peer, so this is remote and needs a bearer.
    const calls: WorkbenchRuntimeInput[] = [];
    const response = await authedHandler(calls)(
      turnRequest("127.0.0.1"),
      serveInfo(remoteHost),
    );
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("a remote peer forging a loopback Host gets remote clearance, never loopback", async () => {
    // Even with a valid bearer, a forged loopback Host must not win the full
    // private-memory clearance that transport: "loopback" carries.
    const calls: WorkbenchRuntimeInput[] = [];
    const response = await authedHandler(calls)(
      turnRequest("127.0.0.1", { authorization: `Bearer ${apiKey}` }),
      serveInfo(remoteHost),
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.authContext.transport).toBe("remote");
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
      serveInfo(remoteHost),
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
      serveInfo(remoteHost),
    );
    expect(unauthenticated.status).toBe(401);

    const authenticated = await handler(
      new Request(`http://${remoteHost}:8787/api/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
      serveInfo(remoteHost),
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
      serveInfo("100.64.0.7"),
    );
    expect(response.status).toBe(401);
  });

  test("resumes a session on /api/turn with rebuilt conversation messages", async () => {
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
    expect(runtimeCalls[0].conversationMessages).toEqual([
      { role: "user", content: "earlier prompt" },
      { role: "assistant", content: "earlier answer" },
    ]);
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

  test("passes a string workspace through to the runtime as workspaceRoot", async () => {
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
        body: JSON.stringify({
          prompt: "hi",
          workspace: "/workspace/example-project",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(calls[0].workspaceRoot).toBe("/workspace/example-project");
  });

  test("rejects a non-string workspace on /api/turn", async () => {
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
        body: JSON.stringify({ prompt: "hi", workspace: { evil: true } }),
      }),
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
