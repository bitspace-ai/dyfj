// The external ACP runner's durable evidence through real Dolt: a fixture-agent
// turn (scripts/acp-fixture-agent.ts, spawned by the runtime) journals its
// runner, permission and tool evidence, and the session replays from the
// isolated fixture database the integration lane starts.
import {
  assert,
  assertEquals,
  assertFalse,
  assertObjectMatch,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { runExternalAgentWorkbenchRuntime } from "./external-agent-runtime.ts";
import { buildConversationMessages } from "./context/mod.ts";
import { type DoltStore, fetchWorkbenchSessionEvents } from "./store/mod.ts";
import {
  type FixtureSql,
  openFixtureSql,
  openFixtureStore,
} from "../testing/dolt/fixture-sql.ts";

// Each test opens its own fixture handles and closes them before returning, so
// no pooled connection outlives the test that opened it.
async function withFixture(
  fn: (store: DoltStore, sql: FixtureSql) => Promise<void>,
): Promise<void> {
  const sql = openFixtureSql();
  const store = openFixtureStore();
  try {
    await fn(store, sql);
  } finally {
    await sql.close();
    await store.close();
  }
}

async function deleteSession(sql: FixtureSql, sessionId: string) {
  await sql.query("DELETE FROM events WHERE session_id = ?", [sessionId]);
  await sql.query("DELETE FROM sessions WHERE session_id = ?", [sessionId]);
}

describe("external ACP runner persistence (integration)", () => {
  it("round-trips typed runner and permission evidence through Dolt", () =>
    withFixture(async (store, sql) => {
      const result = await runExternalAgentWorkbenchRuntime({
        mode: "turn",
        prompt: "FIXTURE_PERMISSION",
        routingOptions: {},
        runner: { kind: "acp", profile: "fixture" },
        workspaceRoot: Deno.cwd(),
      }, { store });

      try {
        const events = await fetchWorkbenchSessionEvents({
          sessionId: result.sessionId,
          events: store.events,
        });
        const eventTypes = events.map((event) => event.eventType);
        assertEquals(eventTypes, [
          "session_start",
          "runner_selected",
          "agent_permission",
          "agent_response",
          "session_end",
        ]);
        assertFalse(eventTypes.includes("provider_call"));
        assertFalse(eventTypes.includes("model_response"));

        const permission = events.find((event) =>
          event.eventType === "agent_permission"
        );
        assertObjectMatch(permission!, {
          permissionVerdict: "denied",
          runnerKind: "external_agent",
          runnerProfile: "fixture",
          runnerProtocol: "acp",
        });

        const response = events.find((event) =>
          event.eventType === "agent_response"
        );
        assertObjectMatch(response!, {
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
        assert(
          response?.runnerCapabilities?.includes("sessionCapabilities.close"),
        );
      } finally {
        await deleteSession(sql, result.sessionId);
      }
    }));

  it("round-trips ACP tool arguments through Dolt into reconstructed messages", () =>
    withFixture(async (store, sql) => {
      const result = await runExternalAgentWorkbenchRuntime({
        mode: "turn",
        prompt: "FIXTURE_TOOL_HISTORY",
        routingOptions: {},
        runner: { kind: "acp", profile: "fixture" },
        workspaceRoot: Deno.cwd(),
      }, { store });

      try {
        const events = await fetchWorkbenchSessionEvents({
          sessionId: result.sessionId,
          events: store.events,
        });
        assertEquals(events.map((event) => event.eventType), [
          "session_start",
          "runner_selected",
          "tool_call",
          "agent_response",
          "session_end",
        ]);

        const tool = events.find((event) => event.eventType === "tool_call");
        assertObjectMatch(tool!, {
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

        assertEquals(buildConversationMessages(events), [
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
        await deleteSession(sql, result.sessionId);
      }
    }));
});
