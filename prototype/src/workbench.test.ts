import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  type ExternalAgentRunner,
  type NativeWorkbenchRuntimeResult,
  runWorkbenchRuntime as runtimeUnderTest,
  type WorkbenchRuntimeInput,
  type WorkbenchRuntimeResult,
  type WorkbenchRuntimeServices,
} from "./engine/mod.ts";
import {
  PaidEscalationDeclinedError,
  SessionOwners,
} from "./engine/mod.ts";
import { MemoryStore, type Store } from "./store/mod.ts";
import {
  DomainError,
  type ExternalAgentWorkbenchRuntimeResult,
} from "./contract/mod.ts";
import { runExternalAgentWorkbenchRuntime } from "./external-agent-runtime.ts";

const runtimeMocks = vi.hoisted(() => {
  const model = {
    slug: "laguna-xs.2",
    displayName: "Laguna XS.2",
    provider: "ollama",
    api: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    tier: 0 as 0 | 1 | 2,
    costInput: 0,
    costOutput: 0,
    capabilities: ["text", "reasoning"],
    contextWindow: undefined as number | undefined,
    maxOutputTokens: undefined as number | undefined,
  };
  return {
    ulid: 0,
    span: 0,
    writtenEvents: [] as Record<string, unknown>[],
    sessions: [] as Record<string, unknown>[],
    sessionUpdates: [] as Record<string, unknown>[],
    model,
    // When set, the model registry the runtime loads; otherwise the single
    // session model. Compression routing selects OVER this list, so a test can
    // offer a local alternative alongside a hosted row.
    registry: null as typeof model[] | null,
    runWorkbenchTurn: vi.fn(),
    // when set, event writes for this event_type throw, to test the
    // integrity-required vs best-effort write policy.
    failEventType: null as string | null,
    // when set, the simulated write failure throws this message instead of
    // the default templated one — lets a test mimic a driver rejection whose
    // message embeds a huge/sensitive rejected value (e.g. Dolt's "value too
    // large for column" error quoting the payload back).
    failEventMessage: null as string | null,
    // when set, the simulated write failure's thrown Error has its mutable
    // .name overridden to this — lets a test prove a caller reads
    // .constructor.name (real class identity) rather than the spoofable
    // .name property.
    failEventErrorName: null as string | null,
    // when true, a failed write STILL leaves its row durable — the ambiguous
    // "committed, acknowledgment lost" case the durability probe resolves.
    failedWriteLands: false,
    // when true, the durability probe itself throws: genuinely uncertain.
    failEventProbe: false,
    // whether the mocked adapter honors params.messages (transcript retry);
    // flip to false to exercise the Google-style no-retry path.
    supportsTranscriptRetry: true,
    // When set, the workspace path the session row hands back on resume —
    // exercises the persisted-workspace resolution path.
    sessionWorkspace: null as string | null,
    // When true, the resume-time workspace lookup throws — exercises the
    // lookup-error path, which must suppress elevation, not fall open.
    sessionWorkspaceThrows: false,
    // When set, what the mocked invokeCommandWithEvent returns — lets a test
    // exercise the loop's handling of a denied/failed tool call.
    commandResult: null as
      | null
      | {
        decision: string;
        isError: boolean;
        reason?: string;
        result?: string;
      },
    // When set, the mocked invokeCommandWithEvent throws this instead of
    // returning — exercises the agent loop's toolCallCompleted error path
    // (a call that fails outright, not merely a denied/errored result).
    commandThrows: null as Error | null,
    commandCalls: [] as string[],
    commandHook: null as (() => void | Promise<void>) | null,
    recallEnabled: false,
    recallObserver: null as
      | null
      | ((diagnostic: {
        era: "modern" | "legacy";
        revision: string;
        server?: { name: string; version: string };
        extensions: string[];
      }) => void | Promise<void>),
    memoryLoadError: null as Error | null,
    agentsInstructions: null as
      | null
      | {
        body: string;
        source: { kind: "file"; label: string; path: string };
      },
    askContextOptions: [] as Array<{
      repoRoot?: string;
      workspaceRootIdentity?: { dev: number | null; ino: number | null };
    }>,
    askContextError: null as Error | null,
    stubExternalAgent: false,
  };
});

vi.mock("./kernel/ids.ts", () => ({
  generateULID: () => `01TEST${String(++runtimeMocks.ulid).padStart(20, "0")}`,
  generateTraceId: () => "0123456789abcdef0123456789abcdef",
  generateSpanId: () => String(++runtimeMocks.span).padStart(16, "0"),
}));

vi.mock("./utils.ts", () => ({
  writeModelSelectedEvent: async (
    _journal: unknown,
    params: Record<string, unknown>,
  ) => {
    if (runtimeMocks.failEventType === "model_selected") {
      throw new Error("simulated write failure: model_selected");
    }
    runtimeMocks.writtenEvents.push({
      event_type: "model_selected",
      session_id: params.sessionId,
      trace_id: params.traceId,
      model_id: params.selected,
      provider: params.provider,
      api: params.api,
      parent_span_id: params.parentSpanId,
    });
  },
}));

vi.mock("./providers/mod.ts", async (importOriginal) => {
  const estimateExport = "estimateText" + "To" + "kens";
  // Only the pure, side-effect-free error classes stay real — engine/errors.ts
  // imports them statically to build classifyErrorKind's known-class table.
  // Deliberately no `...actual` spread: the full namespace would silently carry
  // network-capable exports (fetchWithHeaderTimeout) into the mock.
  const {
    HostedInferenceRequiresProviderError,
    HostedProviderCredentialMissingError,
    WorkbenchHostedProviderBaseUrlError,
    WorkbenchLocalProviderBaseUrlError,
    WorkbenchModelFastSpeedUnsupportedError,
    WorkbenchModelNotFoundError,
    WorkbenchModelNotRoutableError,
  } = await importOriginal<typeof import("./providers/mod.ts")>();
  return {
    HostedInferenceRequiresProviderError,
    HostedProviderCredentialMissingError,
    WorkbenchHostedProviderBaseUrlError,
    WorkbenchLocalProviderBaseUrlError,
    WorkbenchModelFastSpeedUnsupportedError,
    WorkbenchModelNotFoundError,
    WorkbenchModelNotRoutableError,
    defaultLocalWorkbenchModels: () => [runtimeMocks.model],
    [estimateExport]: (text: string) => Math.ceil(text.length / 4),
    loadWorkbenchModels: async () =>
      runtimeMocks.registry ?? [runtimeMocks.model],
    modelRequestedOutputCap: (model: { maxOutputTokens?: number }) =>
      model.maxOutputTokens,
    modelStreamsToolCalls: () => true,
    modelSupportsTranscriptRetry: () => runtimeMocks.supportsTranscriptRetry,
    runWorkbenchTurn: runtimeMocks.runWorkbenchTurn,
    // Tier selection must honor the CANDIDATE LIST it is handed and throw on an
    // empty set, the way the real selector does — compression pre-filters that
    // list to on-machine rows, so a mock that ignored it would make routing
    // unobservable and pass under either behavior. Every other path keeps the
    // previous stub: the session model.
    selectWorkbenchModel: (
      models: typeof runtimeMocks.model[],
      options?: { tier?: number; modelId?: string },
      _defaultCompanionModel?: string | null,
    ) => {
      const candidates = models ??
        (runtimeMocks.registry ?? [runtimeMocks.model]);
      if (options?.modelId !== undefined) {
        const found = candidates.find(
          (candidate) => candidate.slug === options.modelId,
        );
        if (found) {
          return {
            selected: found,
            considered: [found.slug],
            reason: "explicit_model",
          };
        }
        if (options.modelId === "codex-chatgpt/gpt-5.6-sol") {
          const codexModel = {
            slug: "codex-chatgpt/gpt-5.6-sol",
            displayName: "GPT-5.6 Sol (Codex)",
            provider: "codex-chatgpt",
            api: "acp",
            tier: 2 as const,
            costInput: 0,
            costOutput: 0,
            capabilities: ["text", "code", "reasoning"],
          };
          return {
            selected: codexModel as unknown as typeof runtimeMocks.model,
            considered: [options.modelId],
            reason: "explicit_model",
          };
        }
        throw new WorkbenchModelNotFoundError(options.modelId);
      }
      if (options?.tier !== undefined) {
        const tierCandidates = candidates.filter(
          (candidate) => candidate.tier === options.tier,
        );
        const selected = tierCandidates[0];
        if (!selected) {
          throw new Error(`no model found for tier:${options.tier}`);
        }
        return {
          selected,
          considered: tierCandidates.map((candidate) => candidate.slug),
          reason: "explicit_tier",
        };
      }
      return {
        selected: runtimeMocks.model,
        considered: [runtimeMocks.model.slug],
        reason: "default",
      };
    },
    // Real-shaped locality predicate: local OpenAI-compatible provider on a
    // loopback base URL. Lets the compression tests flip the model to a tier-0
    // HOSTED row and prove compression declines rather than calling out.
    isLocalWorkbenchModel: (model: { provider: string; baseUrl: string }) => {
      if (!["ollama", "mlx-lm"].includes(model.provider)) return false;
      try {
        const host = new URL(model.baseUrl).hostname.toLowerCase();
        return host === "localhost" || host === "127.0.0.1" || host === "::1";
      } catch {
        return false;
      }
    },
    withDefaultLocalWorkbenchModels: (models: unknown[]) => models,
  };
});

vi.mock("./context/prompts.ts", () => ({
  loadCompanionBasePrompt: async () => "companion base prompt",
  DEFAULT_COMPANION_PROMPT: "companion base prompt",
}));

vi.mock("./context/repo-context.ts", () => ({
  buildAskSystemPrompt: () => "repo system prompt",
  buildContextSourceLines: (sources: Array<{ label: string; path: string }>) =>
    sources.map((source) => `${source.label} <${source.path}>`),
  loadAgentsInstructions: async () => runtimeMocks.agentsInstructions,
  loadAskRepoContext: async (options: {
    repoRoot?: string;
    workspaceRootIdentity?: { dev: number | null; ino: number | null };
  } = {}) => {
    runtimeMocks.askContextOptions.push(options);
    if (runtimeMocks.askContextError) throw runtimeMocks.askContextError;
    return {
      sources: [{
        kind: "file",
        label: "README.md Section 1",
        path: "README.md#section-1",
      }],
      sections: [],
      budget: {
        totalTokens: 100,
        usedTokens: 30,
        headroomTokens: 70,
        byBucket: {
          system: { limitTokens: 30, usedTokens: 10 },
          active_repo: { limitTokens: 50, usedTokens: 20 },
          derived_memory: { limitTokens: 20, usedTokens: 0 },
        },
      },
      profile: "compact",
    };
  },
}));

vi.mock("./memory.ts", () => ({
  buildSystemPrompt: () => "memory system prompt",
  buildMemoryContextSourceLines: (
    core: Array<{ slug: string }>,
    index: Array<{ slug: string }>,
  ) => [...core, ...index].map((m) => `mem <memory:${m.slug}>`),
  loadInjectedMemories: async () => {
    if (runtimeMocks.memoryLoadError !== null) {
      throw runtimeMocks.memoryLoadError;
    }
    return [{
      memoryId: "mem-user",
      slug: "user-context",
      type: "user",
      name: "User Context",
      description: "test",
      content: "test",
    }];
  },
  loadIndexedMemories: async () => [{
    slug: "project-context",
    type: "project",
    name: "Project Context",
    description: "test",
  }],
}));

vi.mock("./memory-search.ts", () => ({
  memorySearchConfigFromEnv: () =>
    runtimeMocks.recallEnabled
      ? { url: "http://127.0.0.1:43137/mcp", tool: "fixture-search" }
      : null,
  buildMemorySearch: (
    _config: unknown,
    observer: NonNullable<typeof runtimeMocks.recallObserver>,
  ) => {
    runtimeMocks.recallObserver = observer;
    return async () => "fixture-result";
  },
}));

vi.mock("./tools/mod.ts", () => ({
  createCommandRegistry: () => ({
    register: () => {},
    lookup: () => undefined,
    list: () => [],
    projectTools: () => [],
  }),
  buildToolCatalog: () => ({
    register: () => {},
    lookup: () => undefined,
    list: () => [],
    projectTools: () => [],
  }),
  executeReadMemory: async (_memories: unknown, slug: string) =>
    `memory ${slug}`,
  invokeCommandWithEvent: async (
    _registry: unknown,
    toolCall: { commandId: string; callId: string },
    context: {
      parentSpanId?: string;
      writeEvent?: (event: Record<string, unknown>) => Promise<void>;
    },
  ) => {
    runtimeMocks.commandCalls.push(toolCall.commandId);
    await runtimeMocks.commandHook?.();
    if (runtimeMocks.commandThrows) throw runtimeMocks.commandThrows;
    const result = runtimeMocks.commandResult ?? {
      decision: "allow",
      isError: false,
      result: "ok",
    };
    // Mirrors the real invokeCommandWithEvent (tools/invoke.ts): persists a
    // tool_call event through the caller-supplied writeEvent, so tests can
    // exercise the containment policy the agent loop applies to that write.
    await context.writeEvent?.({
      event_type: "tool_call",
      tool_name: toolCall.commandId,
      tool_call_id: toolCall.callId,
      tool_is_error: result.isError,
      tool_result: result.isError ? result.reason : result.result,
      parent_span_id: context.parentSpanId,
    });
    return result;
  },
}));

vi.mock("./store/sessions.ts", () => ({
  buildWorkbenchSessionContent: (input: Record<string, unknown>) =>
    JSON.stringify(input),
  buildWorkbenchSessionSlug: (sessionId: string) =>
    `workbench-${sessionId.toLowerCase()}`,
  createWorkbenchSession: async (input: Record<string, unknown>) => {
    runtimeMocks.sessions.push(input);
    if (typeof input.workspace === "string") {
      runtimeMocks.sessionWorkspace = input.workspace;
    }
  },
  fetchWorkbenchSessionWorkspace: async () => {
    if (runtimeMocks.sessionWorkspaceThrows) {
      throw new Error("session row unreadable");
    }
    return runtimeMocks.sessionWorkspace;
  },
  fetchWorkbenchSessionWorkspaceRecord: async () => {
    if (runtimeMocks.sessionWorkspaceThrows) {
      throw new Error("session row unreadable");
    }
    return {
      exists: true,
      workspace: runtimeMocks.sessionWorkspace,
    };
  },
  updateWorkbenchSession: async (input: Record<string, unknown>) => {
    runtimeMocks.sessionUpdates.push(input);
  },
}));

// The external-agent runner reaches the engine through its runner port, the
// same way the composition root binds it; the stub stands in for it when a
// test only needs the engine's routing and consent gates.
const externalAgentRunner: ExternalAgentRunner = {
  run: (input) => {
    if (!runtimeMocks.stubExternalAgent) {
      return runExternalAgentWorkbenchRuntime(input, { store: testStore });
    }
    // A partial receipt: the tests that stub the runner assert routing and
    // consent only, never the external-agent evidence fields.
    return Promise.resolve({
      sessionId: input.sessionId ?? "01ACPSTUB00000000000000001",
      traceId: "0123456789abcdef0123456789abcdef",
      stopReason: "stop" as const,
      text: "stubbed",
      receipt: "stubbed receipt",
      runner: {
        kind: "external_agent" as const,
        profile: input.runner.profile,
        protocol: "acp" as const,
        capabilities: [],
        workspace: input.workspaceRoot ?? Deno.cwd(),
        transport: "local_stdio" as const,
        costBasis: "unknown" as const,
        evidence: {
          source: "acp" as const,
          innerState: "opaque" as const,
          toolchainDirectoryCount: 0 as const,
        },
        elapsedMs: 1,
      },
      route: { reason: "explicit_external_agent" },
      context: { sources: [] },
    } as unknown as ExternalAgentWorkbenchRuntimeResult);
  },
};

/**
 * The store the engine runs against here: it records each committed event in
 * `runtimeMocks.writtenEvents` and can fail a write by event type, including
 * the rejected-but-committed case the compression durability probe reads.
 */
function recordEvent(event: Record<string, unknown>): void {
  if (event.event_type === runtimeMocks.failEventType) {
    if (runtimeMocks.failedWriteLands) runtimeMocks.writtenEvents.push(event);
    const err = new Error(
      runtimeMocks.failEventMessage ??
        `simulated write failure: ${String(event.event_type)}`,
    );
    if (runtimeMocks.failEventErrorName) {
      err.name = runtimeMocks.failEventErrorName;
    }
    throw err;
  }
  runtimeMocks.writtenEvents.push(event);
}

const baseStore = new MemoryStore();
let testConfirmations = new SessionOwners();

const testStore: Store = {
  journal: {
    commit: (batch) => {
      for (const event of batch.events) recordEvent({ ...event });
      return Promise.resolve({
        eventIds: batch.events.map((e) => String(e.event_id)),
        mutations: batch.mutations?.length ?? 0,
      });
    },
  },
  events: {
    ...baseStore.events,
    exists: (eventId) => {
      if (runtimeMocks.failEventProbe) {
        return Promise.reject(new Error("simulated durability probe failure"));
      }
      return Promise.resolve(
        runtimeMocks.writtenEvents.some((e) => e.event_id === eventId),
      );
    },
  },
  sessions: baseStore.sessions,
  memories: baseStore.memories,
  models: baseStore.models,
  prompts: baseStore.prompts,
  // No prior spend on the books in unit tests.
  spend: {
    baselines: () =>
      Promise.resolve({
        sessionSpentUsd: 0,
        sessionSpentTodayUsd: 0,
        dailyOtherSessionsUsd: 0,
      }),
  },
  close: () => Promise.resolve(),
};

/** The engine under test, over the recording store unless a test passes one. */
function runWorkbenchRuntime(
  input: WorkbenchRuntimeInput & { runner?: undefined },
  services?: Partial<WorkbenchRuntimeServices>,
): Promise<NativeWorkbenchRuntimeResult>;
function runWorkbenchRuntime(
  input: WorkbenchRuntimeInput,
  services?: Partial<WorkbenchRuntimeServices>,
): Promise<WorkbenchRuntimeResult>;
function runWorkbenchRuntime(
  input: WorkbenchRuntimeInput,
  services: Partial<WorkbenchRuntimeServices> = {},
): Promise<WorkbenchRuntimeResult> {
  return runtimeUnderTest(input, {
    store: testStore,
    budgetScopes: testConfirmations,
    ...services,
  });
}

const runWithExternalAgentRunner = (
  input: Parameters<typeof runWorkbenchRuntime>[0],
) => runWorkbenchRuntime(input, { externalAgentRunner });

beforeEach(() => {
  // Ceiling confirmations persist per scope by design; tests need isolation.
  testConfirmations = new SessionOwners();
  runtimeMocks.supportsTranscriptRetry = true;
  runtimeMocks.commandResult = null;
  runtimeMocks.commandThrows = null;
  runtimeMocks.commandCalls.length = 0;
  runtimeMocks.commandHook = null;
  runtimeMocks.recallEnabled = false;
  runtimeMocks.recallObserver = null;
  runtimeMocks.memoryLoadError = null;
  runtimeMocks.agentsInstructions = null;
  runtimeMocks.askContextOptions.length = 0;
  runtimeMocks.askContextError = null;
  runtimeMocks.stubExternalAgent = false;
  runtimeMocks.sessionWorkspace = null;
  runtimeMocks.sessionWorkspaceThrows = false;
  runtimeMocks.failEventMessage = null;
  runtimeMocks.failEventErrorName = null;
  runtimeMocks.ulid = 0;
  runtimeMocks.span = 0;
  runtimeMocks.writtenEvents.length = 0;
  runtimeMocks.sessions.length = 0;
  runtimeMocks.sessionUpdates.length = 0;
  runtimeMocks.runWorkbenchTurn.mockReset();
  runtimeMocks.runWorkbenchTurn.mockResolvedValue({
    text: "runtime response",
    model: runtimeMocks.model,
    selection: {
      selected: runtimeMocks.model,
      considered: [runtimeMocks.model.slug],
      reason: "default",
    },
    usage: {
      input: 42,
      output: 7,
      cost: { total: 0 },
      cacheRead: 0,
      cacheWrite: 0,
    },
    stopReason: "stop",
    timings: {
      responseHeadersMs: 3,
      generationMs: 9,
      totalMs: 12,
    },
  });
});

describe("runWorkbenchRuntime external-agent invariants", () => {
  test("fails closed when an explicit ACP route has no runner bound", async () => {
    // Typed through the general overload: a direct caller that omits the
    // runner service must get the fixed error, never a lazily loaded runner.
    const input: WorkbenchRuntimeInput = {
      mode: "turn",
      prompt: "inspect",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      trustWorkspaceInstructions: true,
    };
    await expect(runWorkbenchRuntime(input)).rejects.toThrow(
      new DomainError("No external-agent runner is configured"),
    );
  });

  test("fails closed when model selection routes to ACP with no runner bound", async () => {
    const prevRegistry = runtimeMocks.registry;
    runtimeMocks.registry = [
      {
        slug: "fixture",
        displayName: "ACP Fixture",
        provider: "fixture",
        api: "acp",
        baseUrl: "local_stdio",
        tier: 0 as const,
        costInput: 0,
        costOutput: 0,
        capabilities: ["text"],
        contextWindow: undefined,
        maxOutputTokens: undefined,
      },
    ];
    try {
      await expect(runWorkbenchRuntime({
        mode: "turn",
        prompt: "inspect",
        routingOptions: { modelId: "fixture" },
        trustWorkspaceInstructions: true,
      })).rejects.toThrow("No external-agent runner is configured");
    } finally {
      runtimeMocks.registry = prevRegistry;
    }
  });

  test("rejects the Codex ChatGPT route without explicit workspace trust", async () => {
    await expect(runWithExternalAgentRunner({
      mode: "turn",
      prompt: "inspect",
      routingOptions: {},
      runner: { kind: "acp", profile: "codex-chatgpt" },
      trustWorkspaceInstructions: false,
    })).rejects.toThrow("codex-chatgpt requires explicit workspace trust");
  });

  test("rejects the Codex ChatGPT route via model selection without explicit workspace trust", async () => {
    await expect(runWithExternalAgentRunner({
      mode: "turn",
      prompt: "inspect",
      routingOptions: { modelId: "codex-chatgpt/gpt-5.6-sol" },
      trustWorkspaceInstructions: false,
    })).rejects.toThrow("codex-chatgpt requires explicit workspace trust");
  });

  test("rejects an unapproved explicit Codex ChatGPT runner request with PaidEscalationDeclinedError", async () => {
    await expect(runWithExternalAgentRunner({
      mode: "turn",
      prompt: "inspect",
      routingOptions: {},
      runner: { kind: "acp", profile: "codex-chatgpt" },
      trustWorkspaceInstructions: true,
    })).rejects.toThrow(PaidEscalationDeclinedError);
  });

  test("allows an explicit Codex ChatGPT runner request when paid escalation is confirmed", async () => {
    runtimeMocks.stubExternalAgent = true;
    const result = await runWithExternalAgentRunner({
      mode: "turn",
      prompt: "inspect",
      routingOptions: {},
      runner: { kind: "acp", profile: "codex-chatgpt" },
      trustWorkspaceInstructions: true,
      confirmPaidEscalation: () =>
        Promise.resolve({ decision: "approve" as const }),
    });
    expect(result).toBeDefined();
    expect(result.sessionId).toBeDefined();
  });

  test("rejects an unapproved tier-2 ACP request with PaidEscalationDeclinedError", async () => {
    runtimeMocks.registry = [
      {
        slug: "codex-chatgpt/gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        provider: "codex-chatgpt",
        api: "acp",
        baseUrl: "local_stdio",
        tier: 2 as const,
        costInput: 0,
        costOutput: 0,
        capabilities: ["text", "fast-speed"],
        contextWindow: 1050000,
        maxOutputTokens: 128000,
      },
    ];
    await expect(runWithExternalAgentRunner({
      mode: "turn",
      prompt: "test unapproved paid",
      routingOptions: { modelId: "codex-chatgpt/gpt-5.6-terra" },
      trustWorkspaceInstructions: true,
    })).rejects.toThrow(PaidEscalationDeclinedError);
  });

  test("allows a tier-2 ACP request when paid escalation is confirmed", async () => {
    runtimeMocks.stubExternalAgent = true;
    runtimeMocks.registry = [
      {
        slug: "codex-chatgpt/gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        provider: "codex-chatgpt",
        api: "acp",
        baseUrl: "local_stdio",
        tier: 2 as const,
        costInput: 0,
        costOutput: 0,
        capabilities: ["text", "fast-speed"],
        contextWindow: 1050000,
        maxOutputTokens: 128000,
      },
    ];
    const result = await runWithExternalAgentRunner({
      mode: "turn",
      prompt: "test approved paid",
      routingOptions: { modelId: "codex-chatgpt/gpt-5.6-terra" },
      trustWorkspaceInstructions: true,
      confirmPaidEscalation: () =>
        Promise.resolve({ decision: "approve" as const }),
    });
    expect(result).toBeDefined();
    expect(result.sessionId).toBeDefined();
  });

  test("routes an ACP model selection to the external agent runner", async () => {
    runtimeMocks.registry = [
      {
        slug: "fixture",
        displayName: "ACP Fixture",
        provider: "fixture",
        api: "acp",
        baseUrl: "local_stdio",
        tier: 0 as const,
        costInput: 0,
        costOutput: 0,
        capabilities: ["text"],
        contextWindow: undefined,
        maxOutputTokens: undefined,
      },
    ];
    const result = await runWithExternalAgentRunner({
      mode: "turn",
      prompt: "test acp dispatch",
      routingOptions: { modelId: "fixture" },
      trustWorkspaceInstructions: true,
    });
    expect(result).toBeDefined();
    expect(result.sessionId).toBeDefined();
    expect("runner" in result && result.runner).toMatchObject({
      kind: "external_agent",
      profile: "fixture",
    });
    expect("receipt" in result && result.receipt).toContain("fixture");
  });

  test("allows resumed session turns on the external agent runner", async () => {
    runtimeMocks.registry = [
      {
        slug: "fixture",
        displayName: "ACP Fixture",
        provider: "fixture",
        api: "acp",
        baseUrl: "local_stdio",
        tier: 0 as const,
        costInput: 0,
        costOutput: 0,
        capabilities: ["text"],
        contextWindow: undefined,
        maxOutputTokens: undefined,
      },
    ];
    const first = await runWithExternalAgentRunner({
      mode: "turn",
      prompt: "first turn",
      routingOptions: { modelId: "fixture" },
      trustWorkspaceInstructions: true,
    });
    const second = await runWithExternalAgentRunner({
      mode: "turn",
      prompt: "second turn",
      routingOptions: { modelId: "fixture" },
      trustWorkspaceInstructions: true,
      sessionId: first.sessionId,
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect("runner" in second && second.runner).toMatchObject({
      kind: "external_agent",
      profile: "fixture",
    });
    const sessionEvents = runtimeMocks.writtenEvents.filter(
      (e) => e.session_id === first.sessionId,
    );
    expect(sessionEvents.length).toBeGreaterThanOrEqual(4);
    const prompts = sessionEvents
      .filter((e) => e.event_type === "session_start")
      .map((e) => e.content);
    expect(prompts).toEqual(["first turn", "second turn"]);
  });
});

describe("runWorkbenchRuntime observer events", () => {
  test("emits the runtime spine event sequence without leaking full prompt or response text", async () => {
    const events: unknown[] = [];

    const result = await runWorkbenchRuntime({
      mode: "turn",
      prompt: "summarize this sensitive prompt body",
      routingOptions: {},
      onRuntimeEvent: (event) => void events.push(event),
    });

    expect(result.text).toBe("runtime response");
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "sessionStart",
      "inputReceived",
      "contextBuilt",
      "modelSelected",
      "beforeProviderRequest",
      "afterProviderResponse",
      "turnCompleted",
    ]);
    expect(events).toEqual([
      {
        type: "sessionStart",
        sessionId: "01TEST00000000000000000001",
        traceId: "0123456789abcdef0123456789abcdef",
        mode: "turn",
      },
      {
        type: "inputReceived",
        sessionId: "01TEST00000000000000000001",
        promptLength: 36,
      },
      {
        type: "contextBuilt",
        sessionId: "01TEST00000000000000000001",
        sourceCount: 2,
      },
      {
        type: "modelSelected",
        sessionId: "01TEST00000000000000000001",
        modelSlug: "laguna-xs.2",
        tier: 0,
        reason: "default",
      },
      {
        type: "beforeProviderRequest",
        sessionId: "01TEST00000000000000000001",
        modelSlug: "laguna-xs.2",
        estimatedInputCount: expect.any(Number),
      },
      {
        type: "afterProviderResponse",
        sessionId: "01TEST00000000000000000001",
        modelSlug: "laguna-xs.2",
        inputCount: 42,
        outputCount: 7,
        totalMs: 12,
      },
      {
        type: "turnCompleted",
        sessionId: "01TEST00000000000000000001",
        traceId: "0123456789abcdef0123456789abcdef",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(
      "summarize this sensitive prompt body",
    );
    expect(JSON.stringify(events)).not.toContain("runtime response");
  });

  test("an aborted turn finalizes partial text and usage without dispatching tools", async () => {
    const abortController = new AbortController();
    const events: Record<string, unknown>[] = [];
    const base = {
      model: runtimeMocks.model,
      selection: {
        selected: runtimeMocks.model,
        considered: [runtimeMocks.model.slug],
        reason: "default",
      },
      usage: {
        input: 17,
        output: 3,
        cost: { total: 0 },
        cacheRead: 0,
        cacheWrite: 0,
      },
      timings: { responseHeadersMs: 1, totalMs: 4 },
    };
    runtimeMocks.runWorkbenchTurn
      .mockImplementationOnce(async (params) => {
        expect(params.abortSignal).toBe(abortController.signal);
        abortController.abort();
        return {
          ...base,
          text: "partial answer",
          stopReason: "aborted",
          toolCalls: [{
            id: "c1",
            name: "list_files",
            arguments: { path: "." },
          }],
        };
      })
      .mockResolvedValueOnce({
        ...base,
        text: "next answer",
        stopReason: "stop",
      });

    const first = await runWorkbenchRuntime({
      mode: "turn",
      prompt: "start",
      routingOptions: {},
      turnId: "123e4567-e89b-42d3-a456-426614174000",
      abortSignal: abortController.signal,
      onRuntimeEvent: (event) => void events.push(event),
    });

    expect(first).toMatchObject({
      text: "partial answer",
      stopReason: "aborted",
      tokens: { input: 17, output: 3, totalCalls: 1 },
    });
    expect(runtimeMocks.writtenEvents).toContainEqual(
      expect.objectContaining({
        event_type: "model_response",
        content: "partial answer",
        stop_reason: "aborted",
        tokens_input: 17,
        tokens_output: 3,
      }),
    );
    expect(
      runtimeMocks.writtenEvents.some((event) =>
        event.event_type === "tool_call"
      ),
    ).toBe(false);
    expect(events).toContainEqual({
      type: "turnAborted",
      sessionId: first.sessionId,
      traceId: first.traceId,
      turnId: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(events.some((event) => event.type === "turnCompleted")).toBe(false);

    const next = await runWorkbenchRuntime({
      mode: "turn",
      prompt: "continue",
      routingOptions: {},
      sessionId: first.sessionId,
    });
    expect(next).toMatchObject({
      text: "next answer",
      stopReason: "stop",
    });
  });

  test("an aborted next-work turn preserves partial text without validating it", async () => {
    const abortController = new AbortController();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    runtimeMocks.runWorkbenchTurn.mockImplementationOnce(async () => {
      abortController.abort();
      return {
        text: '{"worklet_id":"next-work.v0"',
        model: runtimeMocks.model,
        selection: {
          selected: runtimeMocks.model,
          considered: [runtimeMocks.model.slug],
          reason: "default",
        },
        usage: {
          input: 17,
          output: 3,
          cost: { total: 0 },
          cacheRead: 0,
          cacheWrite: 0,
        },
        stopReason: "aborted",
        timings: { responseHeadersMs: 1, totalMs: 4 },
      };
    });

    try {
      const result = await runWorkbenchRuntime({
        mode: "next-work",
        prompt: "what should I do next?",
        routingOptions: {},
        turnId: "123e4567-e89b-42d3-a456-426614174000",
        abortSignal: abortController.signal,
      });

      expect(result).toMatchObject({
        text: '{"worklet_id":"next-work.v0"',
        stopReason: "aborted",
      });
      expect(result.context).not.toHaveProperty("validation");
      expect(
        log.mock.calls.flat().some((part) =>
          String(part).includes("Next-work validation failed")
        ),
      ).toBe(false);
      const response = runtimeMocks.writtenEvents.find((event) =>
        event.event_type === "model_response"
      );
      expect(JSON.parse(String(response?.content))).toEqual({
        worklet_id: "next-work.v0",
        raw: '{"worklet_id":"next-work.v0"',
      });
    } finally {
      log.mockRestore();
    }
  });

  test("a provider terminal error outranks a concurrent cancellation", async () => {
    const abortController = new AbortController();
    const events: Record<string, unknown>[] = [];
    runtimeMocks.runWorkbenchTurn.mockImplementationOnce(async () => {
      abortController.abort();
      return {
        model: runtimeMocks.model,
        selection: {
          selected: runtimeMocks.model,
          considered: [runtimeMocks.model.slug],
          reason: "default",
        },
        usage: {
          input: 10,
          output: 2,
          cost: { total: 0 },
          cacheRead: 0,
          cacheWrite: 0,
        },
        timings: { responseHeadersMs: 1, totalMs: 2 },
        text: "provider refusal",
        stopReason: "error",
      };
    });

    const result = await runWorkbenchRuntime({
      mode: "turn",
      prompt: "start",
      routingOptions: {},
      abortSignal: abortController.signal,
      onRuntimeEvent: (event) => void events.push(event),
    });

    expect(result.stopReason).toBe("error");
    expect(runtimeMocks.writtenEvents).toContainEqual(
      expect.objectContaining({
        event_type: "model_response",
        stop_reason: "error",
      }),
    );
    expect(events.some((event) => event.type === "turnAborted")).toBe(false);
  });

  test("closes cancellation acceptance before terminal finalization", async () => {
    let cancellationClosed = false;
    runtimeMocks.runWorkbenchTurn.mockResolvedValueOnce({
      model: runtimeMocks.model,
      selection: {
        selected: runtimeMocks.model,
        considered: [runtimeMocks.model.slug],
        reason: "default",
      },
      usage: {
        input: 10,
        output: 2,
        cost: { total: 0 },
        cacheRead: 0,
        cacheWrite: 0,
      },
      timings: { responseHeadersMs: 1, totalMs: 2 },
      text: "done",
      stopReason: "stop",
    });

    const result = await runWorkbenchRuntime({
      mode: "turn",
      prompt: "finish",
      routingOptions: {},
      onCancellationClosed: () => {
        cancellationClosed = true;
      },
      onRuntimeEvent: (event) => {
        if (event.type === "turnCompleted") {
          expect(cancellationClosed).toBe(true);
        }
      },
    });

    expect(result.stopReason).toBe("stop");
    expect(cancellationClosed).toBe(true);
  });

  test("surfaces the error and emits turnFailed when the provider request fails", async () => {
    runtimeMocks.runWorkbenchTurn.mockRejectedValueOnce(
      new Error("local model unavailable"),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const events: unknown[] = [];
    try {
      // An unexpected provider error (e.g. a missing hosted credential) now
      // propagates to the caller instead of being swallowed into a benign empty
      // receipt; the turnFailed runtime event is still emitted before it surfaces.
      // The re-thrown exception the caller sees carries the real message
      // (asserted below); the wire-facing runtime event does not — a plain
      // Error is "foreign" under the provenance policy (not a DomainError
      // this codebase authored), so its errorMessage renders as class + byte
      // count only.
      await expect(runWorkbenchRuntime({
        mode: "turn",
        prompt: "summarize",
        routingOptions: {},
        onRuntimeEvent: (event) => void events.push(event),
      })).rejects.toThrow("local model unavailable");

      expect(events.at(-1)).toEqual({
        type: "turnFailed",
        sessionId: "01TEST00000000000000000001",
        traceId: "0123456789abcdef0123456789abcdef",
        errorName: "Error",
        errorMessage: "[Error, 23 bytes]",
      });
    } finally {
      error.mockRestore();
    }
  });

  test("treats observer failures as best-effort and preserves the turn result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runWorkbenchRuntime({
        mode: "turn",
        prompt: "summarize",
        routingOptions: {},
        onRuntimeEvent: () => {
          throw new Error("observer sink down");
        },
      });

      expect(result.text).toBe("runtime response");
      // Provenance-summarized, never raw: an observer failure is a foreign
      // error, so the console line carries a fixed label + byte count, not
      // the message (which can embed payload content).
      expect(warn).toHaveBeenCalledWith(
        "Runtime observer skipped: [Error, 18 bytes]",
      );
      for (const args of warn.mock.calls) {
        expect(String(args[0])).not.toContain("observer sink down");
      }
    } finally {
      warn.mockRestore();
    }
  });

});

describe("runWorkbenchRuntime event-write integrity policy", () => {
  const run = (mode: "turn" | "ask") =>
    runWorkbenchRuntime({ mode, prompt: "policy probe", routingOptions: {} });

  test("best-effort event write failure is swallowed (turn still completes)", async () => {
    runtimeMocks.failEventType = "model_selected";
    try {
      const result = await run("turn");
      expect(result.text).toBe("runtime response");
    } finally {
      runtimeMocks.failEventType = null;
    }
  });

  test("integrity event inside the runtime try (model_response) also fails the turn — not masked by the final receipt", async () => {
    runtimeMocks.failEventType = "model_response";
    try {
      await expect(run("turn")).rejects.toThrow(
        "simulated write failure: model_response",
      );
    } finally {
      runtimeMocks.failEventType = null;
    }
  });

  test("provider_call write failure preserves aggregate accounting and the replay response", async () => {
    runtimeMocks.failEventType = "provider_call";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await run("turn");
      expect(result.tokens).toMatchObject({
        input: 42,
        output: 7,
        totalCalls: 1,
      });
      expect(runtimeMocks.writtenEvents).toContainEqual(
        expect.objectContaining({
          event_type: "model_response",
          content: "runtime response",
          tokens_input: 42,
          tokens_output: 7,
        }),
      );
      expect(
        runtimeMocks.writtenEvents.some((event) =>
          event.event_type === "provider_call"
        ),
      ).toBe(false);
      expect(result.receipt).toContain("audit log has gaps");
    } finally {
      runtimeMocks.failEventType = null;
      warn.mockRestore();
    }
  });

  test("a clean session's receipt carries no audit-gap warning", async () => {
    const result = await runWorkbenchRuntime({
      mode: "turn",
      prompt: "hello",
      routingOptions: {},
    });
    expect(result.receipt).not.toContain("audit log has gaps");
  });

  // A failed model_response INTEGRITY write still fails the turn (that
  // contract stands, untouched here), but its error's message can embed the
  // whole rejected value (a Dolt "value too large for column" rejection
  // quotes the offending content back), and that message must not fan out
  // raw via the turnFailed runtime event (relayed verbatim to every
  // connected client by uds-server.ts), the durable `error` event's
  // `content` field, or the injected presenter's `log` call.
  test("a failed model_response integrity write sanitizes its message before it reaches turnFailed, the durable error event, and the presenter", async () => {
    const hugePayload = "SELECT ".repeat(20_000); // well over 100KB
    runtimeMocks.failEventType = "model_response";
    runtimeMocks.failEventMessage =
      `insert failed: value '${hugePayload}' is too large for column 'content'`;
    const runtimeEvents: Array<{ type: string; [k: string]: unknown }> = [];
    const logged: string[] = [];
    try {
      await expect(runWorkbenchRuntime({
        mode: "turn",
        prompt: "policy probe",
        routingOptions: {},
        onRuntimeEvent: (event) => {
          runtimeEvents.push(event as { type: string; [k: string]: unknown });
        },
        log: (...parts: unknown[]) => {
          logged.push(parts.map(String).join(" "));
        },
      })).rejects.toThrow();

      // The integrity contract is unchanged: the write failure still fails
      // the turn (asserted above via rejects.toThrow).

      const turnFailed = runtimeEvents.find((e) => e.type === "turnFailed");
      expect(turnFailed).toBeDefined();
      const wireMessage = String(turnFailed?.errorMessage);
      expect(wireMessage).not.toContain(hugePayload);
      expect(wireMessage.length).toBeLessThan(1000);

      const errorEvent = runtimeMocks.writtenEvents.find(
        (e) => e.event_type === "error",
      );
      expect(errorEvent).toBeDefined();
      expect(String(errorEvent?.content)).not.toContain(hugePayload);

      const presenterOutput = logged.join("\n");
      expect(presenterOutput).not.toContain(hugePayload);
    } finally {
      runtimeMocks.failEventType = null;
      runtimeMocks.failEventMessage = null;
    }
  });

  // toolCallCompleted's errorMessage field: a tool call that throws outright
  // (not merely returns a denied/errored result) must not forward the raw
  // error to the runtime event.
});

// ── Catch-block instanceof, not mutable .name ────────────────────────────────
//
// The catch block used to branch on err.name — a plain mutable string any
// Error can be given — and once matched, wrote the raw .message straight to
// the durable event and the presenter. A foreign error simply naming itself
// after one of these classes bypassed the whole containment policy. Now it
// branches on instanceof, so a same-named foreign error falls through to the
// generic branch instead (class + byte count only).
describe("runWorkbenchRuntime catch block — instanceof, not spoofable .name", () => {
  test("a foreign Error named after ContextWindowOverflowError does not get its raw message written", async () => {
    const hugePayload = "SELECT ".repeat(20_000);
    const spoofed = new Error(hugePayload);
    spoofed.name = "ContextWindowOverflowError";
    runtimeMocks.runWorkbenchTurn.mockRejectedValueOnce(spoofed);
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const logged: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(
      () => {},
    );
    try {
      await expect(runWorkbenchRuntime({
        mode: "turn",
        prompt: "probe",
        routingOptions: {},
        onRuntimeEvent: (event) => {
          events.push(event as { type: string; [k: string]: unknown });
        },
        log: (...parts: unknown[]) => {
          logged.push(parts.map(String).join(" "));
        },
      })).rejects.toThrow();

      const errorEvent = runtimeMocks.writtenEvents.find(
        (e) => e.event_type === "error",
      );
      expect(errorEvent).toBeDefined();
      // A real ContextWindowOverflowError writes stop_reason "length"; the
      // spoofed foreign error must fall through to the generic branch
      // instead, which writes "error" — proof the instanceof check, not the
      // spoofed name, decided the branch.
      expect(errorEvent?.stop_reason).toBe("error");
      expect(String(errorEvent?.content)).not.toContain(hugePayload);
      expect(logged.join("\n")).not.toContain(hugePayload);
    } finally {
      consoleError.mockRestore();
    }
  });
});
