import { describe, expect, test } from "vitest";
import { runExternalAgentWorkbenchRuntime } from "./external-agent-runtime";
import {
  buildConversationMessages,
  fetchWorkbenchSessionEvents,
} from "./sessions";
import { doltExec } from "./utils";

describe("external ACP runner persistence (integration)", () => {
  test(
    "round-trips typed runner and permission evidence through Dolt",
    async () => {
      const result = await runExternalAgentWorkbenchRuntime({
        mode: "turn",
        prompt: "FIXTURE_PERMISSION",
        routingOptions: {},
        runner: { kind: "acp", profile: "fixture" },
        workspaceRoot: Deno.cwd(),
      });

      try {
        const events = await fetchWorkbenchSessionEvents({
          sessionId: result.sessionId,
        });
        expect(events.map((event) => event.eventType)).toEqual([
          "session_start",
          "runner_selected",
          "agent_permission",
          "agent_response",
          "session_end",
        ]);
        expect(events.map((event) => event.eventType)).not.toContain(
          "provider_call",
        );
        expect(events.map((event) => event.eventType)).not.toContain(
          "model_response",
        );

        const permission = events.find((event) =>
          event.eventType === "agent_permission"
        );
        expect(permission).toMatchObject({
          permissionVerdict: "denied",
          runnerKind: "external_agent",
          runnerProfile: "fixture",
          runnerProtocol: "acp",
        });

        const response = events.find((event) =>
          event.eventType === "agent_response"
        );
        expect(response).toMatchObject({
          content: "denied",
          stopReason: "stop",
          runnerKind: "external_agent",
          runnerProfile: "fixture",
          runnerProtocol: "acp",
          runnerProtocolVersion: "1",
          runnerStopReason: "end_turn",
          runnerExternalSessionId: "fixture-1",
          runnerTransport: "local_stdio",
          runnerAccessRoute: "local_sidecar",
          runnerCostBasis: "local_free",
          runnerEvidenceScope: "outer_only",
        });
        expect(response?.runnerCapabilities).toContain(
          "sessionCapabilities.close",
        );
      } finally {
        await doltExec("DELETE FROM events WHERE session_id = ?", [
          result.sessionId,
        ]);
        await doltExec("DELETE FROM sessions WHERE session_id = ?", [
          result.sessionId,
        ]);
      }
    },
    30_000,
  );

  test(
    "round-trips ACP tool arguments through Dolt into reconstructed messages",
    async () => {
      const result = await runExternalAgentWorkbenchRuntime({
        mode: "turn",
        prompt: "FIXTURE_TOOL_HISTORY",
        routingOptions: {},
        runner: { kind: "acp", profile: "fixture" },
        workspaceRoot: Deno.cwd(),
      });

      try {
        const events = await fetchWorkbenchSessionEvents({
          sessionId: result.sessionId,
        });
        expect(events.map((event) => event.eventType)).toEqual([
          "session_start",
          "runner_selected",
          "tool_call",
          "agent_response",
          "session_end",
        ]);

        const tool = events.find((event) => event.eventType === "tool_call");
        expect(tool).toMatchObject({
          toolName: "acp.read",
          toolCallId: "fixture-history-call",
          toolArguments: {
            title: "Read fixture history",
            kind: "read",
            input: { path: "fixture-history.txt" },
          },
          toolResult: '{"text":"codename=zephyr-quill-7"}',
          toolIsError: false,
          toolHistoryValid: true,
        });

        expect(buildConversationMessages(events)).toEqual([
          { role: "user", content: "FIXTURE_TOOL_HISTORY" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "fixture-history-call",
              name: "acp.read",
              arguments: {
                title: "Read fixture history",
                kind: "read",
                input: { path: "fixture-history.txt" },
              },
            }],
          },
          {
            role: "tool",
            toolCallId: "fixture-history-call",
            name: "acp.read",
            content: '{"text":"codename=zephyr-quill-7"}',
          },
          { role: "assistant", content: "recorded" },
        ]);
      } finally {
        await doltExec("DELETE FROM events WHERE session_id = ?", [
          result.sessionId,
        ]);
        await doltExec("DELETE FROM sessions WHERE session_id = ?", [
          result.sessionId,
        ]);
      }
    },
    30_000,
  );
});
