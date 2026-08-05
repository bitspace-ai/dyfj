import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  createdSessions: [] as Array<Record<string, unknown>>,
  updatedSessions: [] as Array<Record<string, unknown>>,
  nextId: 0,
  failCreateSession: false,
  failUpdateSession: false,
  failEventType: undefined as string | undefined,
  sessionExists: true,
  sessionWorkspace: undefined as string | null | undefined,
}));

vi.mock("./utils", () => ({
  generateULID: () => `01ACP${String(++state.nextId).padStart(21, "0")}`,
  generateTraceId: () => "trace-acp",
  generateSpanId: () => `span-${++state.nextId}`,
  writeEvent: (event: Record<string, unknown>) => {
    if (event.event_type === state.failEventType) {
      return Promise.reject(new Error(`failed ${state.failEventType}`));
    }
    state.events.push(event);
    return Promise.resolve();
  },
}));

vi.mock("./sessions", () => ({
  buildWorkbenchSessionSlug: (sessionId: string) => `workbench-${sessionId}`,
  buildWorkbenchSessionContent: (input: Record<string, unknown>) =>
    String(input.receipt ?? "# Workbench Session"),
  createWorkbenchSession: (input: Record<string, unknown>) => {
    state.createdSessions.push(input);
    if (state.failCreateSession) {
      return Promise.reject(new Error("failed session creation"));
    }
    return Promise.resolve();
  },
  fetchWorkbenchSessionWorkspaceRecord: () =>
    Promise.resolve({
      exists: state.sessionExists,
      workspace: state.sessionExists
        ? state.sessionWorkspace === undefined
          ? Deno.cwd()
          : state.sessionWorkspace
        : null,
    }),
  updateWorkbenchSession: (input: Record<string, unknown>) => {
    state.updatedSessions.push(input);
    if (state.failUpdateSession) {
      return Promise.reject(new Error("failed session update"));
    }
    return Promise.resolve();
  },
}));

import {
  fixtureProfile,
  runExternalAgentWorkbenchRuntime,
} from "./external-agent-runtime";

describe("runExternalAgentWorkbenchRuntime", () => {
  beforeEach(() => {
    state.events.length = 0;
    state.createdSessions.length = 0;
    state.updatedSessions.length = 0;
    state.nextId = 0;
    state.failCreateSession = false;
    state.failUpdateSession = false;
    state.failEventType = undefined;
    state.sessionExists = true;
    state.sessionWorkspace = undefined;
  });

  test("closes cancellation registration when rejecting a remote caller", async () => {
    let cancellationClosed = 0;
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      authContext: {
        transport: "remote",
        authnStatus: "authenticated",
        authnMechanism: "api_key",
        authnIssuerRef: "test",
        authzBasis: "policy",
      },
      onCancellationClosed: () => cancellationClosed++,
    })).rejects.toThrow("unavailable to remote callers");
    expect(cancellationClosed).toBe(1);
  });

  test("rejects an unknown supplied session before writing events", async () => {
    state.sessionExists = false;
    let cancellationClosed = 0;
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      sessionId: "01UNKNOWNSESSION00000000000",
      workspaceRoot: Deno.cwd(),
      onCancellationClosed: () => cancellationClosed++,
    })).rejects.toThrow("Workbench session not found");
    expect(cancellationClosed).toBe(1);
    expect(state.events).toEqual([]);
    expect(state.createdSessions).toEqual([]);
  });

  test("keeps a resumed external turn on its persisted workspace", async () => {
    const result = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      sessionId: "01EXISTINGSESSION0000000000",
      workspaceRoot: "/private/tmp",
    });
    expect(result.text).toContain(`cwd=${Deno.cwd()}`);
    expect(result.text).not.toContain("cwd=/private/tmp");
  });

  test("rejects a resumed session without persisted workspace evidence", async () => {
    state.sessionWorkspace = null;
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      sessionId: "01LEGACYSESSION000000000000",
      workspaceRoot: "/private/tmp",
    })).rejects.toThrow("no persisted workspace");
    expect(state.events).toEqual([]);
  });

  test("does not read or forward an ambient Deno cache path", () => {
    const original = Deno.env.get("DENO_DIR");
    try {
      Deno.env.set("DENO_DIR", "/tmp/acp-declared-deno-dir");
      expect(fixtureProfile(Deno.cwd()).environment).not.toHaveProperty(
        "DENO_DIR",
      );
      expect(fixtureProfile(Deno.cwd()).args).toEqual(
        expect.arrayContaining([
          "--node-modules-dir=manual",
          expect.stringMatching(/^--config=\/.*\/prototype\/deno\.json$/),
        ]),
      );
    } finally {
      if (original === undefined) Deno.env.delete("DENO_DIR");
      else Deno.env.set("DENO_DIR", original);
    }
  });

  test("runs the fixture from a workspace outside the prototype checkout", async () => {
    const workspace = await Deno.makeTempDir();
    try {
      const resolvedWorkspace = await Deno.realPath(workspace);
      const result = await runExternalAgentWorkbenchRuntime({
        mode: "turn",
        prompt: "ordered response",
        routingOptions: {},
        runner: { kind: "acp", profile: "fixture" },
        workspaceRoot: workspace,
      });
      expect(result.text).toContain(`cwd=${resolvedWorkspace}`);
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  });

  test("rejects an oversized prompt before writing session state", async () => {
    let cancellationClosed = 0;
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "x".repeat(60_001),
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onCancellationClosed: () => cancellationClosed++,
    })).rejects.toMatchObject({ phase: "prompt" });
    expect(cancellationClosed).toBe(1);
    expect(state.events).toEqual([]);
    expect(state.createdSessions).toEqual([]);
  });

  test("finalizes a session-creation failure through the outer lifecycle", async () => {
    state.failCreateSession = true;
    const runtimeEvents: string[] = [];
    let cancellationClosed = 0;
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onCancellationClosed: () => cancellationClosed++,
      onRuntimeEvent: (event) => {
        runtimeEvents.push(event.type);
      },
    })).rejects.toThrow("failed session creation");
    expect(cancellationClosed).toBe(1);
    expect(runtimeEvents).toEqual([
      "sessionStart",
      "inputReceived",
      "turnFailed",
    ]);
    expect(state.events.map((event) => event.event_type)).toEqual([
      "session_start",
      "error",
      "session_end",
    ]);
  });

  test("finalizes a runner-selection write failure", async () => {
    state.failEventType = "runner_selected";
    const runtimeEvents: string[] = [];
    let cancellationClosed = 0;
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onCancellationClosed: () => cancellationClosed++,
      onRuntimeEvent: (event) => {
        runtimeEvents.push(event.type);
      },
    })).rejects.toThrow("failed runner_selected");
    expect(cancellationClosed).toBe(1);
    expect(runtimeEvents).toEqual([
      "sessionStart",
      "inputReceived",
      "turnFailed",
    ]);
    expect(state.events.map((event) => event.event_type)).toEqual([
      "session_start",
      "error",
      "session_end",
    ]);
  });

  test("keeps a successful turn authoritative when its session projection fails", async () => {
    state.failUpdateSession = true;
    const runtimeEvents: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runExternalAgentWorkbenchRuntime({
        mode: "turn",
        prompt: "ordered response",
        routingOptions: {},
        runner: { kind: "acp", profile: "fixture" },
        workspaceRoot: Deno.cwd(),
        onRuntimeEvent: (event) => {
          runtimeEvents.push(event.type);
        },
      });
      expect(result.stopReason).toBe("stop");
      expect(result.receipt).toContain("Session projection: update skipped");
      expect(warn).toHaveBeenCalledWith("Session projection update skipped");
      expect(runtimeEvents).toEqual([
        "sessionStart",
        "inputReceived",
        "turnCompleted",
      ]);
      expect(state.events.map((event) => event.event_type)).toEqual([
        "session_start",
        "runner_selected",
        "agent_response",
        "session_end",
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("preserves an agent failure when its error event cannot be written", async () => {
    state.failEventType = "error";
    const runtimeEvents: string[] = [];
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "FIXTURE_MALFORMED",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onRuntimeEvent: (event) => {
        runtimeEvents.push(event.type);
      },
    })).rejects.toThrow("ACP agent sent malformed protocol data");
    expect(runtimeEvents).toEqual([
      "sessionStart",
      "inputReceived",
      "turnFailed",
    ]);
    expect(state.events.map((event) => event.event_type)).toEqual([
      "session_start",
      "runner_selected",
      "session_end",
    ]);
  });

  test("does not project success when the response event fails", async () => {
    state.failEventType = "agent_response";
    const runtimeEvents: string[] = [];
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onRuntimeEvent: (event) => {
        runtimeEvents.push(event.type);
      },
    })).rejects.toThrow("failed agent_response");
    expect(state.updatedSessions).toEqual([
      expect.objectContaining({ content: "External-agent turn failed" }),
    ]);
    expect(runtimeEvents).toEqual([
      "sessionStart",
      "inputReceived",
      "turnFailed",
    ]);
    expect(state.events.map((event) => event.event_type)).toEqual([
      "session_start",
      "runner_selected",
      "error",
      "session_end",
    ]);
  });

  test("does not rewrite durable success when runtime observer delivery fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runExternalAgentWorkbenchRuntime({
        mode: "turn",
        prompt: "ordered response",
        routingOptions: {},
        runner: { kind: "acp", profile: "fixture" },
        workspaceRoot: Deno.cwd(),
        onRuntimeEvent: (event) => {
          if (event.type === "turnCompleted") {
            throw new Error("disconnected observer");
          }
        },
      });
      expect(result.stopReason).toBe("stop");
      expect(state.events.map((event) => event.event_type)).toEqual([
        "session_start",
        "runner_selected",
        "agent_response",
        "session_end",
      ]);
      expect(warn).toHaveBeenCalledWith("Runtime event delivery skipped");
    } finally {
      warn.mockRestore();
    }
  });

  test("does not project success when the durable session-end write fails", async () => {
    state.failEventType = "session_end";
    const runtimeEvents: string[] = [];
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onRuntimeEvent: (event) => {
        runtimeEvents.push(event.type);
      },
    })).rejects.toThrow("failed session_end");
    expect(state.updatedSessions).toEqual([
      expect.objectContaining({ content: "External-agent turn failed" }),
    ]);
    expect(state.events.map((event) => event.event_type)).toEqual([
      "session_start",
      "runner_selected",
      "agent_response",
      "error",
    ]);
    expect(runtimeEvents).toEqual([
      "sessionStart",
      "inputReceived",
      "turnFailed",
    ]);
  });

  test("retains ACP stop semantics and emits matching lifecycle events", async () => {
    const lengthEvents: string[] = [];
    const length = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "FIXTURE_MAX_TOKENS",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onRuntimeEvent: (event) => {
        lengthEvents.push(event.type);
      },
    });
    expect(length.stopReason).toBe("length");
    expect(length.runner.externalStopReason).toBe("max_tokens");
    expect(lengthEvents.at(-1)).toBe("turnCompleted");

    const refusalEvents: string[] = [];
    const refusal = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "FIXTURE_REFUSAL",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onRuntimeEvent: (event) => {
        refusalEvents.push(event.type);
      },
    });
    expect(refusal.stopReason).toBe("error");
    expect(refusal.runner.externalStopReason).toBe("refusal");
    expect(refusalEvents.at(-1)).toBe("turnFailed");
  });

  test("persists typed outer ACP evidence without native provider accounting", async () => {
    const result = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
    });

    expect(result.text).toBe(`first|cwd=${Deno.cwd()}|last`);
    expect(result.runner).toMatchObject({
      kind: "external_agent",
      profile: "fixture",
      protocol: "acp",
      protocolVersion: 1,
      externalStopReason: "end_turn",
      transport: "local_stdio",
      accessRoute: "local_sidecar",
      costBasis: "local_free",
      evidence: { source: "acp", innerState: "opaque" },
    });
    expect(result).not.toHaveProperty("model");
    expect(result).not.toHaveProperty("tokens");
    expect(result).not.toHaveProperty("cost");
    expect(state.events.map((event) => event.event_type)).toEqual([
      "session_start",
      "runner_selected",
      "agent_response",
      "session_end",
    ]);
    expect(state.events.map((event) => event.event_type)).not.toContain(
      "model_response",
    );
    expect(state.events.map((event) => event.event_type)).not.toContain(
      "provider_call",
    );
    expect(state.events[2]).toMatchObject({
      runner_kind: "external_agent",
      runner_profile: "fixture",
      runner_protocol: "acp",
      runner_protocol_version: "1",
      runner_stop_reason: "end_turn",
      runner_external_session_id: "fixture-1",
      runner_transport: "local_stdio",
      runner_access_route: "local_sidecar",
      runner_cost_basis: "local_free",
      runner_evidence_scope: "outer_only",
      content: result.text,
    });
  });

  test("keeps a completed turn authoritative when cancellation cleanup throws", async () => {
    const result = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      onCancellationClosed: () => {
        throw new Error("cleanup failed");
      },
    });
    expect(result.stopReason).toBe("stop");
    expect(state.events.map((event) => event.event_type)).toContain(
      "agent_response",
    );
  });

  test("records fail-closed permission denial", async () => {
    const result = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "FIXTURE_PERMISSION",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
    });

    expect(result.text).toBe("denied");
    expect(
      state.events.find((event) => event.event_type === "agent_permission"),
    )
      .toMatchObject({
        permission_verdict: "denied",
        principal_id: "dyfj-workbench",
        principal_type: "service",
        action: "enforce",
        runner_kind: "external_agent",
        runner_protocol: "acp",
      });
  });

  test("does not project success when a permission verdict cannot be recorded", async () => {
    state.failEventType = "agent_permission";
    await expect(runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "FIXTURE_PERMISSION_EARLY_TERMINAL",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      confirmExternalAgentPermission: async () => "approve",
    })).rejects.toMatchObject({ phase: "permission" });
    expect(state.events.map((event) => event.event_type)).not.toContain(
      "agent_response",
    );
  });

  test("preserves partial cancellation and permits the next outer turn", async () => {
    const controller = new AbortController();
    const runtimeEvents: string[] = [];
    let cancellationClosed = 0;
    const first = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "FIXTURE_CANCEL",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      workspaceRoot: Deno.cwd(),
      abortSignal: controller.signal,
      onTextDelta: () => controller.abort(),
      onCancellationClosed: () => {
        cancellationClosed += 1;
      },
      onRuntimeEvent: (event) => {
        runtimeEvents.push(event.type);
      },
    });
    expect(first).toMatchObject({ text: "partial\n", stopReason: "aborted" });
    expect(cancellationClosed).toBe(1);
    expect(runtimeEvents).toEqual([
      "sessionStart",
      "inputReceived",
      "turnAborted",
    ]);

    const second = await runExternalAgentWorkbenchRuntime({
      mode: "turn",
      prompt: "ordered response",
      routingOptions: {},
      runner: { kind: "acp", profile: "fixture" },
      sessionId: first.sessionId,
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.stopReason).toBe("stop");
    expect(second.text).toContain("first|");
  });
});
