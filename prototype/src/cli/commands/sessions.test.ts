import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkbenchSessionEvent } from "../../contract/mod.ts";
import { fakeIo } from "../../../testing/fakes/fake-io.ts";
import type { CliConfig } from "../args.ts";
import type { ConnectFn } from "../io.ts";
import {
  formatSessionEventsReadback,
  MAX_SESSION_EVENT_INPUT_BYTES,
  projectSessionEventsReadback,
  runSessionEvents,
  runSessions,
  type SessionEventsReadback,
} from "./sessions.ts";

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    socket: "/tmp/dyfj-test.sock",
    mode: "turn",
    color: false,
    ...overrides,
  };
}

describe("models/sessions over UDS", () => {
  function fakeConnect(responses: Record<string, unknown>): ConnectFn {
    return (_socketPath: string) =>
      Promise.resolve({
        request: (method: string) => Promise.resolve(responses[method]),
        close: () => {},
      });
  }

  it("runSessions groups by project", async () => {
    const { io, stdout } = fakeIo();
    const code = await runSessions(
      cfg(),
      io,
      fakeConnect({
        "sessions/list": {
          projects: [
            {
              project: "dyfj",
              sessions: [{ slug: "s-1", sessionName: "Build" }],
            },
          ],
        },
      }),
    );
    assert.strictEqual(code, 0);
    const out = stdout.join("");
    assert.ok(
      out.includes("dyfj"),
      `expected ${JSON.stringify(out)} to include "dyfj"`,
    );
    assert.ok(
      out.includes("s-1"),
      `expected ${JSON.stringify(out)} to include "s-1"`,
    );
    assert.ok(
      out.includes("Build"),
      `expected ${JSON.stringify(out)} to include "Build"`,
    );
  });

  it("runSessions shows when each session last moved and a resume hint", async () => {
    const { io, stdout, stderr } = fakeIo();
    const code = await runSessions(
      cfg(),
      io,
      fakeConnect({
        "sessions/list": {
          projects: [
            {
              project: "dyfj",
              sessions: [{
                slug: "workbench-01ktz1xwcn7jmgs5e8kakfezkr",
                sessionName: "Build",
                updatedAt: "2026-07-05 09:12:33.123456",
              }],
            },
          ],
        },
      }),
    );
    assert.strictEqual(code, 0);
    assert.ok(
      stdout.join("").includes("2026-07-05 09:12"),
      `expected stdout.join("") to include "2026-07-05 09:12"`,
    );
    assert.ok(
      stderr.join("\n").includes("resume one with: dyfj --session"),
      `expected stderr.join("\\n") to include "resume one with: dyfj --session"`,
    );
  });
});

function baseEvent(
  overrides: Partial<WorkbenchSessionEvent> &
    Pick<WorkbenchSessionEvent, "eventId" | "eventType" | "traceId">,
): WorkbenchSessionEvent {
  return {
    sessionId: "01KTZ1XWCN7JMGS5E8KAKFEZKR",
    spanId: "span-1",
    parentSpanId: null,
    traceFlags: null,
    traceState: null,
    spanKind: null,
    parentIsRemote: null,
    principalId: "user",
    modelId: null,
    provider: null,
    api: null,
    content: null,
    stopReason: null,
    tokensInput: null,
    tokensOutput: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    costTotal: null,
    costBasis: null,
    durationMs: null,
    providerCallOrder: null,
    providerCallPurpose: null,
    providerErrorClass: null,
    unparsedToolCallCount: null,
    unparsedToolCallCountIsLowerBound: null,
    runnerKind: null,
    runnerProfile: null,
    runnerProtocol: null,
    runnerProtocolVersion: null,
    runnerStopReason: null,
    runnerExternalSessionId: null,
    runnerAgentName: null,
    runnerAgentVersion: null,
    runnerTransport: null,
    runnerAccessRoute: null,
    runnerCostBasis: null,
    runnerWorkspace: null,
    runnerCapabilities: null,
    runnerEvidenceScope: null,
    runnerRouteSource: null,
    runnerAuthType: null,
    permissionVerdict: null,
    toolName: null,
    toolCallId: null,
    toolArguments: null,
    toolResult: null,
    toolIsError: null,
    toolHistoryValid: null,
    createdAt: "2026-11-05T10:00:00.000Z",
    ...overrides,
  };
}

describe("runSessionEvents over UDS", () => {
  const sessionId = "01KTZ1XWCN7JMGS5E8KAKFEZKR";

  function fakeEventsConnect(events: WorkbenchSessionEvent[]): {
    connect: ConnectFn;
    calls: Array<{ method: string; params: unknown }>;
  } {
    const calls: Array<{ method: string; params: unknown }> = [];
    const connect: ConnectFn = (_socketPath: string) =>
      Promise.resolve({
        request: (method: string, params?: unknown) => {
          calls.push({ method, params });
          return Promise.resolve({ events });
        },
        close: () => {},
      });
    return { connect, calls };
  }

  it("prints external-agent and native turns with recorded, partial and rejected tool calls", async () => {
    const oversizedCmd = "x".repeat(MAX_SESSION_EVENT_INPUT_BYTES + 40);
    const events: WorkbenchSessionEvent[] = [
      baseEvent({
        eventId: "e1",
        eventType: "session_start",
        traceId: "trace-acp-1",
        content: "Audit the repo\nSecond prompt line",
      }),
      baseEvent({
        eventId: "e2",
        eventType: "runner_selected",
        traceId: "trace-acp-1",
        runnerKind: "external_agent",
        runnerProfile: "fixture",
        runnerProtocol: "acp",
      }),
      baseEvent({
        eventId: "e3",
        eventType: "tool_call",
        traceId: "trace-acp-1",
        runnerKind: "external_agent",
        runnerProfile: "fixture",
        runnerProtocol: "acp",
        toolName: "acp.execute",
        toolCallId: "call-rec",
        toolArguments: {
          title: "Run typecheck",
          kind: "execute",
          input: { command: ["npm", "run", "typecheck"] },
        },
        toolResult: '{"exitCode":0}',
        toolIsError: false,
        toolHistoryValid: true,
      }),
      baseEvent({
        eventId: "e4",
        eventType: "tool_call",
        traceId: "trace-acp-1",
        runnerKind: "external_agent",
        runnerProfile: "fixture",
        runnerProtocol: "acp",
        toolName: "acp.history_unavailable",
        toolCallId: "gap-e4",
        toolArguments: {
          outcome: "partial",
          reason: "missing_raw_output",
          toolCallId: "call-part",
          toolName: "acp.execute",
          title: "Run lint",
          kind: "execute",
          status: "completed",
          input: { command: ["npm", "run", "lint"], payload: oversizedCmd },
        },
        toolResult: "",
        toolIsError: true,
        toolHistoryValid: true,
      }),
      baseEvent({
        eventId: "e5",
        eventType: "tool_call",
        traceId: "trace-acp-1",
        runnerKind: "external_agent",
        runnerProfile: "fixture",
        runnerProtocol: "acp",
        toolName: "acp.history_unavailable",
        toolCallId: "gap-e5",
        toolArguments: {
          outcome: "rejected",
          reason: "credential_shaped",
          toolCallId: "call-rej",
          toolName: "acp.execute",
          title: "Run login",
          kind: "execute",
          status: "completed",
        },
        toolResult: "",
        toolIsError: true,
        toolHistoryValid: true,
      }),
      baseEvent({
        eventId: "e6",
        eventType: "agent_response",
        traceId: "trace-acp-1",
        runnerKind: "external_agent",
        runnerProfile: "fixture",
        runnerProtocol: "acp",
        content: "Checks finished.\nDetails omitted.",
      }),
      baseEvent({
        eventId: "e7",
        eventType: "session_end",
        traceId: "trace-acp-1",
      }),
      baseEvent({
        eventId: "e8",
        eventType: "session_start",
        traceId: "trace-native-2",
        content: "Read README.md",
      }),
      baseEvent({
        eventId: "e9",
        eventType: "tool_call",
        traceId: "trace-native-2",
        toolName: "read_file",
        toolCallId: "native-call-1",
        toolArguments: { path: "README.md" },
        toolResult: "# README",
        toolIsError: false,
        toolHistoryValid: true,
      }),
      baseEvent({
        eventId: "e10",
        eventType: "model_response",
        traceId: "trace-native-2",
        content: "README read.\nExtra line.",
      }),
      baseEvent({
        eventId: "e11",
        eventType: "session_end",
        traceId: "trace-native-2",
      }),
    ];

    const { connect, calls } = fakeEventsConnect(events);
    const { io, stdout } = fakeIo();
    const code = await runSessionEvents(sessionId, cfg(), io, false, connect);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(calls, [
      { method: "events/query", params: { sessionId, limit: 1000 } },
    ]);

    const text = stdout.join("");
    assert.ok(text.includes(`Session ${sessionId} (2 turns)`));
    assert.ok(text.includes("Prompt: Audit the repo"));
    assert.ok(!text.includes("Second prompt line"));
    assert.ok(text.includes("Reply:  Checks finished."));
    assert.ok(
      text.includes(
        "ACP tool evidence: 1 recorded, 1 partial (missing_raw_output), 1 rejected (credential_shaped) of 3",
      ),
    );
    assert.ok(
      text.includes(
        '1. [recorded] acp.execute · kind=execute · status=completed · title="Run typecheck" · input={"command":["npm","run","typecheck"]}',
      ),
    );
    assert.ok(
      text.includes(
        '2. [partial] acp.execute · kind=execute · status=completed · reason=missing_raw_output · title="Run lint" · input=',
      ),
    );
    assert.ok(
      text.includes(
        '3. [rejected] acp.execute · kind=execute · status=completed · reason=credential_shaped · title="Run login"',
      ),
    );
    assert.ok(
      text.includes("Native tool evidence: 1 recorded (1 ok, 0 error) of 1"),
    );
    assert.ok(
      text.includes(
        '1. [recorded] read_file · status=completed · input={"path":"README.md"}',
      ),
    );

    const jsonIo = fakeIo();
    const jsonCode = await runSessionEvents(
      sessionId,
      cfg(),
      jsonIo.io,
      true,
      connect,
    );
    assert.strictEqual(jsonCode, 0);
    const parsed = JSON.parse(jsonIo.stdout.join("")) as SessionEventsReadback;
    assert.strictEqual(parsed.sessionId, sessionId);
    assert.strictEqual(parsed.truncated, false);
    assert.strictEqual(parsed.turns.length, 2);
    assert.strictEqual(parsed.turns[0].promptFirstLine, "Audit the repo");
    assert.strictEqual(parsed.turns[0].replyFirstLine, "Checks finished.");
    assert.strictEqual(
      parsed.turns[0].toolEvidenceLine,
      "ACP tool evidence: 1 recorded, 1 partial (missing_raw_output), 1 rejected (credential_shaped) of 3",
    );
    assert.strictEqual(parsed.turns[0].toolEvents[1].input?.endsWith("…"), true);
    assert.strictEqual(
      Buffer.byteLength(parsed.turns[0].toolEvents[1].input ?? "", "utf8"),
      MAX_SESSION_EVENT_INPUT_BYTES,
    );
    assert.strictEqual(parsed.turns[0].toolEvents[2].reason, "credential_shaped");
    assert.strictEqual(parsed.turns[0].toolEvents[2].input, null);
    assert.strictEqual(parsed.turns[1].runner, "native");
    assert.strictEqual(parsed.turns[1].toolEvents[0].toolName, "read_file");
    assert.strictEqual(
      parsed.turns[1].toolEvents[0].input,
      '{"path":"README.md"}',
    );
  });

  it("reports truncated readback and preserves recorded counts alongside an unavailable marker", () => {
    const events: WorkbenchSessionEvent[] = [
      baseEvent({
        eventId: "u1",
        eventType: "session_start",
        traceId: "trace-mixed-unavail",
        content: "Run checks",
      }),
      baseEvent({
        eventId: "u2",
        eventType: "tool_call",
        traceId: "trace-mixed-unavail",
        runnerKind: "external_agent",
        runnerProtocol: "acp",
        toolName: "acp.execute",
        toolCallId: "call-1",
        toolArguments: {
          title: "Run check",
          kind: "execute",
          input: { command: ["npm", "test"] },
        },
        toolResult: '{"exitCode":0}',
        toolIsError: false,
        toolHistoryValid: true,
      }),
      baseEvent({
        eventId: "u3",
        eventType: "tool_call",
        traceId: "trace-mixed-unavail",
        runnerKind: "external_agent",
        runnerProtocol: "acp",
        toolName: "acp.history_unavailable",
        toolCallId: "gap-u3",
        toolArguments: {},
        toolResult: "",
        toolIsError: true,
        toolHistoryValid: true,
      }),
    ];
    const readback = projectSessionEventsReadback(sessionId, events, 3);
    assert.strictEqual(readback.truncated, true);
    assert.strictEqual(
      readback.turns[0].toolEvidenceLine,
      "ACP tool evidence: 1 recorded, 0 partial, 0 rejected of 1 (1 unavailable)",
    );
    const rendered = formatSessionEventsReadback(readback);
    assert.ok(
      rendered.includes(
        `Session ${sessionId} (1 turn; truncated at event query limit, final turn may be incomplete)`,
      ),
    );
  });

  it("exits 1 and emits JSON error when a session has no recorded events", async () => {
    const { connect } = fakeEventsConnect([]);
    const { io, stdout, stderr } = fakeIo();
    const code = await runSessionEvents(sessionId, cfg(), io, true, connect);
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(JSON.parse(stdout.join("")), {
      error: `no recorded events for session ${sessionId}`,
    });
    assert.match(stderr.join("\n"), /no recorded events for session/);
  });
});
