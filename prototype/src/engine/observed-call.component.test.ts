/**
 * Component test for `observedProviderCall`: the real provider registry over a
 * `ScriptedHttpTransport`, a `MemoryStore` journal, the real `BudgetTracker`,
 * and a `ManualClock` for call durations. Each test checks the one
 * `provider_call` row the call writes, what reaches the store, and what the
 * tracker recorded.
 */

import {
  assert,
  assertEquals,
  assertObjectMatch,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { assertSpyCalls, stub } from "@std/testing/mock";
import { ManualClock } from "../../testing/fakes/manual-clock.ts";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import {
  type ScriptedExchange,
  ScriptedHttpTransport,
} from "../../testing/fakes/scripted-http-transport.ts";
import { type EventInsert, MemoryStore } from "../store/mod.ts";
import { BudgetTracker } from "../budget/mod.ts";
import {
  HostedProviderCredentialMissingError,
  type WorkbenchModel,
} from "../providers/mod.ts";
import { DomainError } from "../contract/mod.ts";
import {
  type ObservedCallContext,
  type ObservedCallRequest,
  observedProviderCall,
} from "./observed-call.ts";

const SESSION_ID = "01OBSERVEDCALLSESSION000000";
const TRACE_ID = "aabbccddeeff00112233445566778899";
const ROOT_SPAN_ID = "0000000000000001";
const AUTHN = {
  authn_status: "authenticated",
  authn_mechanism: "local_user",
  authn_issuer_ref: "local_os",
} as const;

const LOCAL: WorkbenchModel = {
  slug: "local-small",
  displayName: "Local Small",
  provider: "ollama",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:11434/v1",
  tier: 0,
  costInput: 0,
  costOutput: 0,
  capabilities: ["text"],
};

const HOSTED: WorkbenchModel = {
  slug: "claude-haiku-4-5",
  displayName: "Claude Haiku 4.5",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  tier: 1,
  costInput: 1,
  costOutput: 5,
  capabilities: ["text", "code"],
};

const MODELS = [LOCAL, HOSTED];

function openAIReply(content: string): ScriptedExchange {
  return {
    respond: {
      body: JSON.stringify({
        choices: [{ message: { content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }),
    },
  };
}

interface Harness {
  store: MemoryStore;
  budget: BudgetTracker;
  clock: ManualClock;
  written: EventInsert[];
  skipped: number;
  context: ObservedCallContext;
}

/**
 * A turn context over a fresh store. `rejectWrites` makes every event write
 * fail, the way a store outage would; the failure is counted, not thrown.
 */
function harness(options: { rejectWrites?: boolean } = {}): Harness {
  const clock = new ManualClock({ start: 1_000_000 });
  const store = new MemoryStore({}, { now: clock.date });
  const budget = new BudgetTracker(SESSION_ID, TRACE_ID, {
    sessionLimitUsd: 1,
    perCallLimitUsd: 0.1,
    dailyLimitUsd: 5,
  }, "operator");
  const h: Harness = {
    store,
    budget,
    clock,
    written: [],
    skipped: 0,
    context: {
      writeEvent: async (event) => {
        if (options.rejectWrites) throw new Error("store unavailable");
        h.written.push(event);
        await store.journal.commit({ events: [event] });
      },
      budget,
      clock,
      sessionId: SESSION_ID,
      traceId: TRACE_ID,
      principalId: "operator",
      turnRootSpanId: ROOT_SPAN_ID,
      authnEventFields: AUTHN,
      onSkippedEventWrite: () => {
        h.skipped++;
      },
    },
  };
  return h;
}

/** A request for `model`, whose transport advances the clock by `elapsedMs`. */
function callRequest(
  h: Harness,
  model: WorkbenchModel,
  exchanges: ScriptedExchange[],
  overrides: Partial<ObservedCallRequest> = {},
  elapsedMs = 250,
): { request: ObservedCallRequest; transport: ScriptedHttpTransport } {
  const transport = new ScriptedHttpTransport(
    exchanges.map((exchange) => ({
      ...exchange,
      expect: (recorded) => {
        h.clock.advance(elapsedMs);
        exchange.expect?.(recorded);
      },
    })),
  );
  const env = new MapEnv({ ANTHROPIC_API_KEY: "test-key-not-real" });
  return {
    transport,
    request: {
      params: {
        systemPrompt: "system",
        prompt: "hello",
        routing: { modelId: model.slug },
        models: MODELS,
        fetchFn: transport.fetch,
        getEnv: (name) => env.get(name),
      },
      model,
      order: 3,
      purpose: "initial",
      authzBasis: "policy:local-default",
      recordUnparsedToolCallMarkup: true,
      ...overrides,
    },
  };
}

Deno.test("observedProviderCall writes one provider_call row and records a local call's usage", async () => {
  const h = harness();
  const { request, transport } = callRequest(h, LOCAL, [
    openAIReply("hi there"),
  ]);

  const result = await observedProviderCall(h.context, request);

  transport.assertDone();
  assertEquals(result.turn.text, "hi there");
  assertStrictEquals(result.persisted, true);
  assertStrictEquals(result.recorded, true);
  assertEquals(h.written.length, 1);
  const [event] = h.written;
  assertEquals(event, {
    event_type: "provider_call",
    event_id: event.event_id,
    session_id: SESSION_ID,
    trace_id: TRACE_ID,
    span_id: result.providerSpanId,
    parent_span_id: ROOT_SPAN_ID,
    principal_id: "operator",
    principal_type: "agent",
    action: "invoke",
    resource: LOCAL.slug,
    authz_basis: "policy:local-default",
    model_id: LOCAL.slug,
    provider: LOCAL.provider,
    api: LOCAL.api,
    tokens_input: 12,
    tokens_output: 4,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    cost_total: 0,
    stop_reason: "stop",
    provider_call_order: 3,
    provider_call_purpose: "initial",
    content: null,
    thinking: null,
    duration_ms: 250,
    ...AUTHN,
  });
  assertEquals(h.skipped, 0);

  const stored = await h.store.events.bySession({
    sessionId: SESSION_ID,
    limit: 10,
    order: "asc",
  });
  assertEquals(stored.length, 1);
  assertObjectMatch(stored[0], {
    event_type: "provider_call",
    span_id: result.providerSpanId,
    provider_call_order: "3",
    provider_call_purpose: "initial",
  });

  assertEquals(h.budget.totalCalls, 1);
  assertEquals(h.budget.totalTokensInput, 12);
  assertEquals(h.budget.totalTokensOutput, 4);
  assertEquals(h.budget.totalCost, 0);
});

Deno.test("observedProviderCall records a paid call's cost with the tracker", async () => {
  const h = harness();
  const { request, transport } = callRequest(h, HOSTED, [{
    respond: {
      body: JSON.stringify({
        content: [{ type: "text", text: "paid answer" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1000, output_tokens: 200 },
      }),
    },
  }]);

  const result = await observedProviderCall(h.context, request);

  transport.assertDone();
  assertStrictEquals(result.recorded, true);
  const cost = result.turn.usage.cost.total;
  assert(cost > 0);
  assertObjectMatch(h.written[0], {
    model_id: HOSTED.slug,
    provider: "anthropic",
    tokens_input: 1000,
    tokens_output: 200,
    cost_total: cost,
  });
  assertEquals(h.budget.totalCost, cost);
  assertEquals(h.budget.getSummary().byTier["1"]?.calls, 1);
});

Deno.test("observedProviderCall writes the unparsed tool-call markup counts only when asked", async () => {
  // Two unmatched wrapper openings: the degraded shape the adapter reports.
  const markup = "<tool_call> first <tool_call> second";

  const loop = harness();
  const { request: loopRequest } = callRequest(loop, LOCAL, [
    openAIReply(markup),
  ]);
  const loopResult = await observedProviderCall(loop.context, loopRequest);
  assert(loopResult.turn.unparsedToolCallMarkup !== undefined);
  assertObjectMatch(loop.written[0], {
    unparsed_tool_call_count: loopResult.turn.unparsedToolCallMarkup.count,
    unparsed_tool_call_count_is_lower_bound:
      loopResult.turn.unparsedToolCallMarkup.countIsLowerBound,
  });

  const compression = harness();
  const { request: compressionRequest } = callRequest(compression, LOCAL, [
    openAIReply(markup),
  ], {
    purpose: "context_compression",
    authzBasis: "policy:local-compression",
    recordUnparsedToolCallMarkup: false,
  });
  await observedProviderCall(compression.context, compressionRequest);
  const row = compression.written[0];
  assertEquals("unparsed_tool_call_count" in row, false);
  assertEquals("unparsed_tool_call_count_is_lower_bound" in row, false);
  assertObjectMatch(row, {
    authz_basis: "policy:local-compression",
    provider_call_purpose: "context_compression",
  });
});

Deno.test("observedProviderCall writes an error row for a failed call and rethrows the mapped error", async () => {
  const h = harness();
  const mapped = new DomainError("provider failed");
  const { request, transport } = callRequest(h, LOCAL, [{
    respond: { status: 500, body: "upstream exploded" },
  }], {
    purpose: "tool_followup",
    mapProviderError: () => mapped,
  });

  const thrown = await assertRejects(() =>
    observedProviderCall(h.context, request)
  );
  assertStrictEquals(thrown, mapped);

  transport.assertDone();
  assertEquals(h.written.length, 1);
  const [event] = h.written;
  assertEquals(event, {
    event_type: "provider_call",
    event_id: event.event_id,
    session_id: SESSION_ID,
    trace_id: TRACE_ID,
    span_id: event.span_id,
    parent_span_id: ROOT_SPAN_ID,
    principal_id: "operator",
    principal_type: "agent",
    action: "invoke",
    resource: LOCAL.slug,
    authz_basis: "policy:local-default",
    model_id: LOCAL.slug,
    provider: LOCAL.provider,
    api: LOCAL.api,
    provider_call_order: 3,
    provider_call_purpose: "tool_followup",
    provider_error_class: "DomainError",
    content: null,
    thinking: null,
    stop_reason: "error",
    duration_ms: 250,
    ...AUTHN,
  });
  assertEquals(h.budget.totalCalls, 0);
});

Deno.test("observedProviderCall classifies an unmapped provider error by its own class", async () => {
  const h = harness();
  const { request, transport } = callRequest(
    h,
    HOSTED,
    [],
    {
      params: {
        systemPrompt: "system",
        prompt: "hello",
        routing: { modelId: HOSTED.slug },
        models: MODELS,
        getEnv: () => undefined,
      },
    },
  );

  await assertRejects(
    () => observedProviderCall(h.context, request),
    HostedProviderCredentialMissingError,
  );
  transport.assertDone();
  assertObjectMatch(h.written[0], {
    resource: HOSTED.slug,
    provider_error_class: "HostedProviderCredentialMissingError",
    stop_reason: "error",
  });
  assertEquals(h.budget.totalCalls, 0);
});

Deno.test("observedProviderCall does not record a request that was never dispatched", async () => {
  const h = harness();
  const aborted = new AbortController();
  aborted.abort();
  const { request, transport } = callRequest(h, LOCAL, [], {
    params: {
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: LOCAL.slug },
      models: MODELS,
      abortSignal: aborted.signal,
    },
  });

  const result = await observedProviderCall(h.context, request);

  transport.assertDone();
  assertStrictEquals(result.turn.requestDispatched, false);
  assertStrictEquals(result.recorded, false);
  assertEquals(h.written.length, 1);
  assertObjectMatch(h.written[0], { stop_reason: "aborted" });
  assertEquals(h.budget.totalCalls, 0);
});

Deno.test("observedProviderCall counts a failed event write and still records the usage", async () => {
  const h = harness({ rejectWrites: true });
  const warn = stub(console, "warn");
  let result;
  try {
    const { request } = callRequest(h, LOCAL, [openAIReply("hi")]);
    result = await observedProviderCall(h.context, request);
  } finally {
    warn.restore();
  }

  assertStrictEquals(result.persisted, false);
  assertStrictEquals(result.recorded, true);
  assertEquals(h.skipped, 1);
  assertSpyCalls(warn, 1);
  assertEquals(warn.calls[0].args, ["Event write skipped: Error"]);
  assertEquals(h.budget.totalCalls, 1);
});

Deno.test("observedProviderCall defaults the provider session to the turn's session", async () => {
  // The xAI adapter forwards the session as its conversation header, which
  // makes the defaulted session observable on the wire.
  const xai: WorkbenchModel = {
    slug: "grok-test",
    displayName: "Grok Test",
    provider: "xai",
    api: "openai-completions",
    baseUrl: "https://api.x.ai/v1",
    tier: 1,
    costInput: 1,
    costOutput: 5,
    capabilities: ["text"],
  };
  const h = harness();
  const env = new MapEnv({ XAI_API_KEY: "test-key-not-real" });
  const { request, transport } = callRequest(h, xai, [openAIReply("ok")], {
    params: {
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: xai.slug },
      models: [xai],
      getEnv: (name) => env.get(name),
    },
  });
  request.params.fetchFn = transport.fetch;
  await observedProviderCall(h.context, request);
  transport.assertDone();
  assertEquals(transport.requests[0].headers["x-grok-conv-id"], SESSION_ID);
});
