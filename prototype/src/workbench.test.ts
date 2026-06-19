import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  type BudgetTallyInput,
  buildBudgetTallyLine,
  buildNextWorkBrief,
  buildPaidEscalationPreflightBanner,
  buildWorkbenchReceipt,
  buildWorkspaceGrounding,
  buildWorkbenchRuntimeInput,
  buildWorkbenchShellBanner,
  formatMoney,
  isNextWorkMode,
  isWorkbenchShellExitCommand,
  isWorkbenchShellSessionCommand,
  MAX_TOOL_STEPS,
  maybeBuildPaidEscalationPreflightBanner,
  type PaidEscalationPreflightInput,
  promptPaidEscalationTty,
  resolveWorkbenchInvocation,
  runWorkbenchRuntime,
  shouldPrintBudgetTally,
  toolStepToMessages,
  validateNextWorkJson,
  type WorkbenchReceiptInput,
  workspaceRootForTransport,
} from "./workbench";

const runtimeMocks = vi.hoisted(() => {
  const model = {
    slug: "laguna-xs.2",
    displayName: "Laguna XS.2",
    provider: "ollama",
    api: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    tier: 0 as const,
    costInput: 0,
    costOutput: 0,
    capabilities: ["text", "reasoning"],
  };
  return {
    ulid: 0,
    writtenEvents: [] as Record<string, unknown>[],
    sessions: [] as Record<string, unknown>[],
    sessionUpdates: [] as Record<string, unknown>[],
    model,
    runWorkbenchTurn: vi.fn(),
    // BIT-139: when set, event writes for this event_type throw, to test the
    // integrity-required vs best-effort write policy.
    failEventType: null as string | null,
  };
});

vi.mock("./utils", () => ({
  generateULID: () => `01TEST${String(++runtimeMocks.ulid).padStart(20, "0")}`,
  generateTraceId: () => "0123456789abcdef0123456789abcdef",
  generateSpanId: () => "0123456789abcdef",
  writeEvent: async (event: Record<string, unknown>) => {
    if (event.event_type === runtimeMocks.failEventType) {
      throw new Error(`simulated write failure: ${String(event.event_type)}`);
    }
    runtimeMocks.writtenEvents.push(event);
  },
  writeModelSelectedEvent: async (params: Record<string, unknown>) => {
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
    });
  },
  closeDoltPool: async () => {},
}));

vi.mock("./provider", () => {
  const estimateExport = "estimateText" + "To" + "kens";
  return {
    defaultLocalWorkbenchModels: () => [runtimeMocks.model],
    [estimateExport]: (text: string) => Math.ceil(text.length / 4),
    loadWorkbenchModels: async () => [runtimeMocks.model],
    modelStreamsToolCalls: () => true,
    runWorkbenchTurn: runtimeMocks.runWorkbenchTurn,
    selectWorkbenchModel: () => ({
      selected: runtimeMocks.model,
      considered: [runtimeMocks.model.slug],
      reason: "default",
    }),
    withDefaultLocalWorkbenchModels: (models: unknown[]) => models,
  };
});

vi.mock("./prompts", () => ({
  loadCompanionBasePrompt: async () => "companion base prompt",
  DEFAULT_COMPANION_PROMPT: "companion base prompt",
}));

vi.mock("./repo-context", () => ({
  buildAskSystemPrompt: () => "repo system prompt",
  buildContextSourceLines: () => ["README.md Section 1 <README.md#section-1>"],
  loadAskRepoContext: async () => ({
    sources: [{
      kind: "file",
      label: "README.md Section 1",
      path: "README.md#section-1",
    }],
    sections: [],
    budget: {},
    profile: "beads-first",
  }),
}));

vi.mock("./memory", () => ({
  buildSystemPrompt: () => "memory system prompt",
  buildMemoryContextSourceLines: (
    core: Array<{ slug: string }>,
    index: Array<{ slug: string }>,
  ) => [...core, ...index].map((m) => `mem <memory:${m.slug}>`),
  loadMemoriesByType: async () => [{
    memoryId: "mem-user",
    slug: "user-context",
    type: "user",
    name: "User Context",
    description: "test",
    content: "test",
  }],
  loadMemoryIndex: async () => [{
    slug: "project-context",
    type: "project",
    name: "Project Context",
    description: "test",
  }],
  memoryClearanceFor: () => ["private", "shareable", "client_safe", "public"],
}));

vi.mock("./commands", () => ({
  createCommandRegistry: () => ({
    register: () => {},
    lookup: () => undefined,
    list: () => [],
    projectTools: () => [],
  }),
  invokeCommandWithEvent: async () => ({
    decision: "allow",
    isError: false,
    result: "ok",
  }),
  registerCoreCommands: () => {},
}));

vi.mock("./sessions", () => ({
  buildWorkbenchSessionContent: (input: Record<string, unknown>) =>
    JSON.stringify(input),
  buildWorkbenchSessionSlug: (sessionId: string) =>
    `workbench-${sessionId.toLowerCase()}`,
  createWorkbenchSession: async (input: Record<string, unknown>) => {
    runtimeMocks.sessions.push(input);
  },
  fetchWorkbenchSessionWorkspace: async () => null,
  updateWorkbenchSession: async (input: Record<string, unknown>) => {
    runtimeMocks.sessionUpdates.push(input);
  },
}));

beforeEach(() => {
  runtimeMocks.ulid = 0;
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

const BASE_RECEIPT: WorkbenchReceiptInput = {
  sessionId: "01TESTSESSION00000000000000",
  traceId: "0123456789abcdef0123456789abcdef",
  modelName: "Gemma 4 E2B",
  modelSlug: "gemma4:e2b",
  tier: 0,
  routingReason: "default",
  totalCostUsd: 0,
  totalTokensInput: 1234,
  totalTokensOutput: 567,
  totalCalls: 1,
  contextBudget: {
    totalTokens: 5000,
    usedTokens: 4000,
    headroomTokens: 500,
    byBucket: {
      system: { limitTokens: 1000, usedTokens: 900 },
      active_repo: { limitTokens: 2500, usedTokens: 2100 },
      derived_memory: { limitTokens: 1000, usedTokens: 1000 },
    },
  },
  contextProfile: "beads-first",
  timings: {
    responseHeadersMs: 10,
    timeToFirstTokenMs: 42,
    generationMs: 8,
    timePerOutputTokenMs: 2,
    totalMs: 50,
  },
  contextSources: [
    "AGENTS.md <AGENTS.md>",
    "README.md Section 1 <README.md#section-1>",
    "bd ready <bd ready>",
  ],
  paidInferenceUsed: false,
  estimatedCostUsd: 0,
  workletId: "next-work.v0",
  validation: { ok: true, errors: [] },
};

const BASE_PREFLIGHT: PaidEscalationPreflightInput = {
  modelName: "Claude Sonnet",
  modelSlug: "claude-sonnet",
  tier: 1,
  routingReason: "explicit_tier",
  estimatedCostUsd: 0.0123456,
  sessionCostSoFarUsd: 0.05,
  sessionLimitUsd: 1,
  perCallLimitUsd: 0.1,
};

const BASE_TALLY: BudgetTallyInput = {
  turn: {
    tokensInput: 300,
    tokensOutput: 120,
    costUsd: 0.0123456,
    tier: 1,
  },
  session: {
    totalCostUsd: 0.0345678,
    totalTokensInput: 1300,
    totalTokensOutput: 620,
    paidCalls: 2,
    sessionLimitUsd: 1,
  },
};

describe("formatMoney", () => {
  test("formats sub-cent model costs with six decimal places", () => {
    expect(formatMoney(0.0001234)).toBe("$0.000123");
  });

  test("formats zero as an explicit dollar amount", () => {
    expect(formatMoney(0)).toBe("$0.000000");
  });
});

describe("buildWorkbenchReceipt", () => {
  test("includes session and trace audit pointers", () => {
    const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

    expect(receipt).toContain("Session: 01TESTSESSION00000000000000");
    expect(receipt).toContain("Trace:   0123456789abcdef0123456789abcdef");
  });

  test("includes model, tier, and routing reason", () => {
    const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

    expect(receipt).toContain("Model:   Gemma 4 E2B (gemma4:e2b, tier 0)");
    expect(receipt).toContain("Route:   default");
  });

  test("includes token and cost totals", () => {
    const receipt = buildWorkbenchReceipt({
      ...BASE_RECEIPT,
      totalCostUsd: 0.0123456,
      totalTokensInput: 3000,
      totalTokensOutput: 1200,
      totalCalls: 2,
    });

    expect(receipt).toContain("Actual cost:    $0.012346");
    expect(receipt).toContain("Tokens:  3000 in, 1200 out");
    expect(receipt).toContain("Calls:   2");
  });

  test("includes model call timing breakdown when available", () => {
    const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

    expect(receipt).toContain(
      "Timings: headers 10ms, TTFT 42ms, generation 8ms, TPOT 2ms/token, total 50ms",
    );
  });

  test("includes context budget allocation", () => {
    const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

    expect(receipt).toContain("Context profile: beads-first");
    expect(receipt).toContain(
      "Context budget: 4000/5000 tokens; system 900/1000, active 2100/2500, Beads 1000/1000, headroom 500",
    );
  });

  test("includes context sources and paid inference posture", () => {
    const receipt = buildWorkbenchReceipt(BASE_RECEIPT);

    expect(receipt).toContain("Context sources:");
    expect(receipt).toContain("- AGENTS.md <AGENTS.md>");
    expect(receipt).toContain("- README.md Section 1 <README.md#section-1>");
    expect(receipt).toContain("- bd ready <bd ready>");
    expect(receipt).toContain("Paid inference used: no");
    expect(receipt).toContain("Estimated cost: $0.000000");
    expect(receipt).toContain("Actual cost:    $0.000000");
  });

  test("includes next-work experiment routing and validation fields", () => {
    const receipt = buildWorkbenchReceipt({
      ...BASE_RECEIPT,
      routingReason: "default_local_next_work",
      validation: {
        ok: false,
        errors: ["missing required field: rationale"],
      },
    });

    expect(receipt).toContain("Worklet: next-work.v0");
    expect(receipt).toContain("Route:   default_local_next_work");
    expect(receipt).toContain("Validation: failed");
    expect(receipt).toContain("- missing required field: rationale");
  });
});

describe("buildNextWorkBrief", () => {
  test("requests strict JSON for the next-work worklet without private context", () => {
    const brief = buildNextWorkBrief({
      workletId: "next-work.v0",
      contextProfile: "beads-first",
      prompt: "what should I work on next here?",
    });

    expect(brief).toContain("worklet_id: next-work.v0");
    expect(brief).toContain("context_profile: beads-first");
    expect(brief).toContain("Return strict JSON only");
    expect(brief).toContain('"recommendation"');
    expect(brief).toContain('"confidence"');
  });
});

describe("toolStepToMessages", () => {
  test("emits the assistant tool-call turn followed by linked tool results", () => {
    const toolCalls = [
      { id: "call-memory", name: "memory.read", arguments: { slug: "project_dyfj" } },
    ];
    const messages = toolStepToMessages(
      "Let me read the project memory.",
      toolCalls,
      [
        {
          commandId: "memory.read",
          callId: "call-memory",
          isError: false,
          result: "# Project DYFJ\n\nPublic repo context",
        },
      ],
    );

    expect(messages).toHaveLength(2);
    // The assistant turn carries the model's own text + its tool-call intentions.
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: "Let me read the project memory.",
      toolCalls,
    });
    // The tool result is linked back to the call by id (toolCallId === call id).
    expect(messages[1]).toMatchObject({
      role: "tool",
      toolCallId: "call-memory",
      name: "memory.read",
      content: "# Project DYFJ\n\nPublic repo context",
    });
  });

  test("emits one tool message per result, preserving order and errors", () => {
    const messages = toolStepToMessages(
      "",
      [
        { id: "c1", name: "list_files", arguments: { path: "." } },
        { id: "c2", name: "memory.read", arguments: { slug: "missing" } },
      ],
      [
        { commandId: "list_files", callId: "c1", isError: false, result: "a.ts" },
        {
          commandId: "memory.read",
          callId: "c2",
          isError: true,
          result: "slug does not match required pattern",
        },
      ],
    );

    expect(messages.map((m) => m.role)).toEqual(["assistant", "tool", "tool"]);
    expect(messages[1]).toMatchObject({ toolCallId: "c1", content: "a.ts" });
    expect(messages[2]).toMatchObject({
      toolCallId: "c2",
      content: "slug does not match required pattern",
    });
  });
});

describe("workspaceRootForTransport", () => {
  test("honors a loopback operator's requested workspace root", () => {
    expect(workspaceRootForTransport("/workspace/example-project", "loopback"))
      .toBe("/workspace/example-project");
  });

  test("returns undefined for a loopback caller that sent no root", () => {
    expect(workspaceRootForTransport(undefined, "loopback")).toBeUndefined();
  });

  test("ignores a remote caller's requested root (pinned to server default)", () => {
    // A crafted cwd from a remote/shared consumer must not steer the file tools.
    expect(workspaceRootForTransport("/etc", "remote")).toBeUndefined();
    expect(workspaceRootForTransport("/", "remote")).toBeUndefined();
  });
});

describe("buildWorkspaceGrounding", () => {
  test("steers the model to the tools without leaking the absolute host path", () => {
    const grounding = buildWorkspaceGrounding();
    expect(grounding).toContain("list_files");
    expect(grounding).toContain("relative to that root");
    expect(grounding).toMatch(/instead of guessing/i);
    // Must not embed an absolute host path (public source + hosted egress).
    expect(grounding).not.toMatch(/\/Users\//);
    expect(grounding).not.toMatch(/\/home\//);
  });
});

describe("validateNextWorkJson", () => {
  test("accepts a complete strict JSON next-work result", () => {
    const result = validateNextWorkJson(JSON.stringify({
      worklet_id: "next-work.v0",
      context_profile: "beads-first",
      recommendation: "Work dyfj-2fl.8.2 next.",
      rationale: "It is the ready routing experiment slice.",
      evidence: ["bd show dyfj-2fl.8.2"],
      risks: ["Local model output may drift."],
      next_commands: ["deno task test"],
      confidence: "medium",
    }));

    expect(result).toEqual({
      ok: true,
      value: {
        worklet_id: "next-work.v0",
        context_profile: "beads-first",
        recommendation: "Work dyfj-2fl.8.2 next.",
        rationale: "It is the ready routing experiment slice.",
        evidence: ["bd show dyfj-2fl.8.2"],
        risks: ["Local model output may drift."],
        next_commands: ["deno task test"],
        confidence: "medium",
      },
      errors: [],
    });
  });

  test("rejects prose or incomplete JSON before trusting the model result", () => {
    expect(validateNextWorkJson("Work on the routing bead next."))
      .toMatchObject({
        ok: false,
        errors: ["model output was not strict JSON"],
      });

    const incomplete = validateNextWorkJson(JSON.stringify({
      worklet_id: "next-work.v0",
      context_profile: "beads-first",
      recommendation: "Work dyfj-2fl.8.2 next.",
    }));

    expect(incomplete).toMatchObject({
      ok: false,
      errors: [
        "missing required field: rationale",
        "missing required field: evidence",
        "missing required field: risks",
        "missing required field: next_commands",
        "missing required field: confidence",
      ],
    });
  });
});

describe("buildPaidEscalationPreflightBanner", () => {
  test("shows paid escalation call shape before inference", () => {
    const banner = buildPaidEscalationPreflightBanner(BASE_PREFLIGHT);

    expect(banner).toContain("Paid inference preflight");
    expect(banner).toContain("Model:           Claude Sonnet (claude-sonnet)");
    expect(banner).toContain("Tier:            1");
    expect(banner).toContain("Route:           explicit_tier");
    expect(banner).toContain("Estimated cost:  $0.012346");
    expect(banner).toContain("Session spent:   $0.050000 / $1.000000");
    expect(banner).toContain("Session headroom: $0.950000");
    expect(banner).toContain("Per-call limit:  $0.100000");
  });

  test("Tier 0 remains prompt-free", () => {
    expect(maybeBuildPaidEscalationPreflightBanner({
      ...BASE_PREFLIGHT,
      tier: 0,
      estimatedCostUsd: 0,
    })).toBeNull();
  });
});

describe("promptPaidEscalationTty (BIT-149 consent verdict)", () => {
  test("escalates instead of prompting in a non-interactive session", async () => {
    // The test process has no TTY: the CLI driver must escalate (defer to an
    // out-of-band operator), not throw or block.
    const verdict = await promptPaidEscalationTty("paid model selected");
    expect(verdict).toEqual({
      decision: "escalate",
      reason: expect.any(String),
    });
  });
});

describe("resolveWorkbenchInvocation", () => {
  test("keeps generic ask separate from the measured next-work worklet", () => {
    expect(isNextWorkMode("ask")).toBe(false);
    expect(isNextWorkMode("next-work")).toBe(true);
  });

  test("treats next-work as the measured local-first worklet path", () => {
    const invocation = resolveWorkbenchInvocation(["next-work"], {});

    expect(invocation).toEqual({
      mode: "next-work",
      prompt: "what should I work on next here?",
      routingOptions: {},
    });
  });

  test("treats shell as an interactive harness mode", () => {
    const invocation = resolveWorkbenchInvocation(["shell"], {});

    expect(invocation).toEqual({
      mode: "shell",
      prompt: "",
      routingOptions: {},
    });
  });

  test("loads routing defaults from environment", () => {
    const invocation = resolveWorkbenchInvocation(["ask", "next?"], {
      DYFJ_WORKBENCH_MODEL: "qwen3:32b",
      DYFJ_WORKBENCH_HINT: "code",
      DYFJ_WORKBENCH_TIER: "0",
    });

    expect(invocation).toEqual({
      mode: "ask",
      prompt: "next?",
      routingOptions: {
        modelId: "qwen3:32b",
        hint: "code",
        tier: 0,
      },
    });
  });

  test("CLI routing flags override environment defaults", () => {
    const invocation = resolveWorkbenchInvocation(
      [
        "ask",
        "--model",
        "gemma4:e2b",
        "--tier",
        "0",
        "--hint",
        "reasoning",
        "next?",
      ],
      {
        DYFJ_WORKBENCH_MODEL: "qwen3:32b",
        DYFJ_WORKBENCH_HINT: "code",
        DYFJ_WORKBENCH_TIER: "1",
      },
    );

    expect(invocation.routingOptions).toEqual({
      modelId: "gemma4:e2b",
      hint: "reasoning",
      tier: 0,
    });
  });
});

describe("buildWorkbenchRuntimeInput", () => {
  test("maps non-shell invocations into a shared runtime input", () => {
    const input = buildWorkbenchRuntimeInput({
      mode: "turn",
      prompt: "summarize the repo",
      routingOptions: { modelId: "gemma4:e2b", tier: 0 },
    });

    expect(input).toEqual({
      mode: "turn",
      prompt: "summarize the repo",
      routingOptions: { modelId: "gemma4:e2b", tier: 0 },
    });
  });

  test("keeps shell mode outside the single-turn runtime boundary", () => {
    const input = buildWorkbenchRuntimeInput({
      mode: "shell",
      prompt: "",
      routingOptions: {},
    });

    expect(input).toBeNull();
  });
});

describe("runWorkbenchRuntime observer events", () => {
  test("emits the runtime spine event sequence without leaking full prompt or response text", async () => {
    const events: unknown[] = [];

    const result = await runWorkbenchRuntime({
      mode: "turn",
      prompt: "summarize this sensitive prompt body",
      routingOptions: {},
      onRuntimeEvent: (event) => {
        events.push(event);
      },
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

  test("agent loop iterates model<->tools until the model stops requesting tools", async () => {
    const base = {
      model: runtimeMocks.model,
      selection: {
        selected: runtimeMocks.model,
        considered: [runtimeMocks.model.slug],
        reason: "default",
      },
      usage: { input: 10, output: 2, cost: { total: 0 }, cacheRead: 0, cacheWrite: 0 },
      stopReason: "tool_use",
      timings: { responseHeadersMs: 1, totalMs: 2 },
    };
    const toolTurn = (id: string) => ({
      ...base,
      text: "",
      toolCalls: [{ id, name: "list_files", arguments: { path: "." } }],
    });
    runtimeMocks.runWorkbenchTurn
      .mockResolvedValueOnce(toolTurn("c1"))
      .mockResolvedValueOnce(toolTurn("c2"))
      .mockResolvedValueOnce({ ...base, text: "done exploring", stopReason: "stop" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await runWorkbenchRuntime({
        mode: "turn",
        prompt: "explore the repo",
        routingOptions: {},
      });
      expect(result.text).toBe("done exploring");
      // step 0 (initial) + two follow-up gather calls = three model calls
      expect(runtimeMocks.runWorkbenchTurn).toHaveBeenCalledTimes(3);
    } finally {
      log.mockRestore();
    }
  });

  test("agent loop stops at MAX_TOOL_STEPS and forces a no-tools concluding answer", async () => {
    const base = {
      model: runtimeMocks.model,
      selection: {
        selected: runtimeMocks.model,
        considered: [runtimeMocks.model.slug],
        reason: "default",
      },
      usage: { input: 10, output: 2, cost: { total: 0 }, cacheRead: 0, cacheWrite: 0 },
      stopReason: "tool_use",
      timings: { responseHeadersMs: 1, totalMs: 2 },
    };
    // The model never stops requesting tools; the loop must bound it.
    runtimeMocks.runWorkbenchTurn.mockResolvedValue({
      ...base,
      text: "forced conclusion",
      toolCalls: [{ id: "c", name: "list_files", arguments: {} }],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await runWorkbenchRuntime({
        mode: "turn",
        prompt: "loop without stopping",
        routingOptions: {},
      });
      expect(result.text).toBe("forced conclusion");
      // step 0 + MAX_TOOL_STEPS gather calls, then the loop exits
      expect(runtimeMocks.runWorkbenchTurn).toHaveBeenCalledTimes(1 + MAX_TOOL_STEPS);
      // the final forced call dropped tools to make the model conclude
      const lastCall = runtimeMocks.runWorkbenchTurn.mock.calls.at(-1)![0];
      expect(lastCall.tools).toBeUndefined();
      // an earlier gather call still offered tools (so the model could continue)
      const firstFollowUp = runtimeMocks.runWorkbenchTurn.mock.calls[1][0];
      expect(Array.isArray(firstFollowUp.tools)).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test("agent loop forces a conclusion when the model repeats prior tool calls", async () => {
    const base = {
      model: runtimeMocks.model,
      selection: {
        selected: runtimeMocks.model,
        considered: [runtimeMocks.model.slug],
        reason: "default",
      },
      usage: { input: 10, output: 2, cost: { total: 0 }, cacheRead: 0, cacheWrite: 0 },
      stopReason: "tool_use",
      timings: { responseHeadersMs: 1, totalMs: 2 },
    };
    const repeat = {
      ...base,
      text: "",
      toolCalls: [{ id: "c", name: "list_files", arguments: { path: "." } }],
    };
    runtimeMocks.runWorkbenchTurn
      .mockResolvedValueOnce(repeat) // step 0
      .mockResolvedValueOnce(repeat) // step 1 gather — identical call
      .mockResolvedValueOnce({ ...base, text: "done", stopReason: "stop" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await runWorkbenchRuntime({
        mode: "turn",
        prompt: "explore",
        routingOptions: {},
      });
      expect(result.text).toBe("done");
      // step 0 + one gather + the forced conclusion — not the full step cap
      expect(runtimeMocks.runWorkbenchTurn).toHaveBeenCalledTimes(3);
      // the repeat was detected (step 2) and tools dropped to force a conclusion
      const forcedCall = runtimeMocks.runWorkbenchTurn.mock.calls[2][0];
      expect(forcedCall.tools).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });

  test("budgets and records every provider call so the receipt aggregates the whole turn", async () => {
    const base = {
      model: runtimeMocks.model,
      selection: {
        selected: runtimeMocks.model,
        considered: [runtimeMocks.model.slug],
        reason: "default",
      },
      usage: { input: 10, output: 2, cost: { total: 0 }, cacheRead: 0, cacheWrite: 0 },
      stopReason: "tool_use",
      timings: { responseHeadersMs: 1, totalMs: 2 },
    };
    const toolTurn = (id: string) => ({
      ...base,
      text: "",
      toolCalls: [{ id, name: "list_files", arguments: {} }],
    });
    runtimeMocks.runWorkbenchTurn
      .mockResolvedValueOnce(toolTurn("c1"))
      .mockResolvedValueOnce(toolTurn("c2"))
      .mockResolvedValueOnce({ ...base, text: "done", stopReason: "stop" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await runWorkbenchRuntime({
        mode: "turn",
        prompt: "explore",
        routingOptions: {},
      });
      // Three provider calls, each 10 in / 2 out -> aggregated, not just the last.
      expect(result.tokens.input).toBe(30);
      expect(result.tokens.output).toBe(6);
      expect(result.tokens.totalCalls).toBe(3);
      const modelResponse = runtimeMocks.writtenEvents.find(
        (e) => e.event_type === "model_response",
      );
      expect(modelResponse?.tokens_input).toBe(30);
      expect(modelResponse?.tokens_output).toBe(6);
    } finally {
      log.mockRestore();
    }
  });

  test("rejects an over-budget follow-up call before invoking the provider (tier 1)", async () => {
    const prevTier = runtimeMocks.model.tier;
    const prevCost = runtimeMocks.model.costInput;
    const prevSession = process.env.DYFJ_BUDGET_SESSION_USD;
    (runtimeMocks.model as { tier: number }).tier = 1;
    runtimeMocks.model.costInput = 0; // estimate 0; the session limit catches accumulated recorded cost
    process.env.DYFJ_BUDGET_SESSION_USD = "0.02";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const events: unknown[] = [];
    try {
      const base = {
        model: runtimeMocks.model,
        selection: {
          selected: runtimeMocks.model,
          considered: [runtimeMocks.model.slug],
          reason: "default",
        },
        usage: { input: 10, output: 2, cost: { total: 0.03 }, cacheRead: 0, cacheWrite: 0 },
        stopReason: "tool_use",
        timings: { responseHeadersMs: 1, totalMs: 2 },
      };
      // Always wants another tool step; the loop must stop on budget, not the cap.
      runtimeMocks.runWorkbenchTurn.mockResolvedValue({
        ...base,
        text: "",
        toolCalls: [{ id: "c", name: "list_files", arguments: {} }],
      });
      const result = await runWorkbenchRuntime({
        mode: "turn",
        prompt: "explore",
        routingOptions: {},
        confirmPaidEscalation: async () => ({ decision: "approve" as const }),
        onRuntimeEvent: (event) => events.push(event),
      });
      expect(result.text).toBe("");
      expect((events.at(-1) as { type: string }).type).toBe("turnFailed");
      expect((events.at(-1) as { errorName: string }).errorName).toBe(
        "BudgetExceededError",
      );
      // Step 0 spent $0.03 (over the $0.02 session limit); the first follow-up
      // is rejected before a second provider call — well short of MAX_TOOL_STEPS.
      expect(runtimeMocks.runWorkbenchTurn).toHaveBeenCalledTimes(1);
    } finally {
      (runtimeMocks.model as { tier: number }).tier = prevTier;
      runtimeMocks.model.costInput = prevCost;
      if (prevSession === undefined) delete process.env.DYFJ_BUDGET_SESSION_USD;
      else process.env.DYFJ_BUDGET_SESSION_USD = prevSession;
      log.mockRestore();
    }
  });

  test("emits turnFailed when the provider request fails", async () => {
    runtimeMocks.runWorkbenchTurn.mockRejectedValueOnce(
      new Error("local model unavailable"),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const events: unknown[] = [];
    try {
      const result = await runWorkbenchRuntime({
        mode: "turn",
        prompt: "summarize",
        routingOptions: {},
        onRuntimeEvent: (event) => {
          events.push(event);
        },
      });

      expect(result.text).toBe("");
      expect(events.at(-1)).toEqual({
        type: "turnFailed",
        sessionId: "01TEST00000000000000000001",
        traceId: "0123456789abcdef0123456789abcdef",
        errorName: "Error",
        errorMessage: "local model unavailable",
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
      expect(warn).toHaveBeenCalledWith(
        "Runtime observer skipped: observer sink down",
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("workbench shell helpers", () => {
  test("recognizes explicit shell exit commands", () => {
    expect(isWorkbenchShellExitCommand(":quit")).toBe(true);
    expect(isWorkbenchShellExitCommand(":q")).toBe(true);
    expect(isWorkbenchShellExitCommand("exit")).toBe(true);
    expect(isWorkbenchShellExitCommand("read project memory")).toBe(false);
  });

  test("recognizes the shell session pointer command", () => {
    expect(isWorkbenchShellSessionCommand(":session")).toBe(true);
    expect(isWorkbenchShellSessionCommand("session")).toBe(false);
  });

  test("shows the barebones shell commands in the banner", () => {
    const banner = buildWorkbenchShellBanner();

    expect(banner).toContain("DYFJ Workbench Shell");
    expect(banner).toContain(":session");
    expect(banner).toContain(":quit");
  });
});

describe("buildBudgetTallyLine", () => {
  test("shows turn and session cost and token totals", () => {
    const tally = buildBudgetTallyLine(BASE_TALLY);

    expect(tally).toBe(
      "Budget tally: $0.012346 this turn (300 in, 120 out) · " +
        "$0.034568 session (1300 in, 620 out, 3.5% of $1.000000)",
    );
  });
});

describe("shouldPrintBudgetTally", () => {
  test("default paid mode stays quiet before paid usage", () => {
    expect(
      shouldPrintBudgetTally("paid", { ...BASE_TALLY.session, paidCalls: 0 }),
    ).toBe(false);
  });

  test("default paid mode prints after paid usage", () => {
    expect(shouldPrintBudgetTally("paid", BASE_TALLY.session)).toBe(true);
  });

  test("on mode prints even without paid usage", () => {
    expect(
      shouldPrintBudgetTally("on", { ...BASE_TALLY.session, paidCalls: 0 }),
    ).toBe(true);
  });

  test("off mode always stays quiet", () => {
    expect(shouldPrintBudgetTally("off", BASE_TALLY.session)).toBe(false);
  });
});

describe("runWorkbenchRuntime event-write integrity policy (BIT-139)", () => {
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

  test("integrity event (session_start) write failure fails the turn", async () => {
    runtimeMocks.failEventType = "session_start";
    try {
      await expect(run("turn")).rejects.toThrow(
        "simulated write failure: session_start",
      );
    } finally {
      runtimeMocks.failEventType = null;
    }
  });

  test("integrity events fail the turn in ask mode too — decoupled from mode (previously silently swallowed)", async () => {
    runtimeMocks.failEventType = "session_start";
    try {
      await expect(run("ask")).rejects.toThrow(
        "simulated write failure: session_start",
      );
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
});

describe("runWorkbenchRuntime reads runtime config from input, not env (BIT-148)", () => {
  test("principalId comes from the input struct and flows to events", async () => {
    const before = runtimeMocks.writtenEvents.length;
    await runWorkbenchRuntime({
      mode: "turn",
      prompt: "probe",
      routingOptions: {},
      principalId: "custom-principal",
    });
    const principals = runtimeMocks.writtenEvents
      .slice(before)
      .map((event) => event.principal_id)
      .filter((p): p is string => typeof p === "string");
    expect(principals.length).toBeGreaterThan(0);
    // Every event is attributed to the input principal, not the env/OS user.
    expect(new Set(principals)).toEqual(new Set(["custom-principal"]));
  });
});
