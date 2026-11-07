// The external ACP runner's durable evidence through real Dolt: a fixture-agent
// turn (scripts/acp-fixture-agent.ts, spawned by the runtime) journals its
// runner, permission and tool evidence, and the session replays from the
// isolated fixture database the integration lane starts.
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import process from "node:process";
import { describe, it } from "node:test";
import { runExternalAgentWorkbenchRuntime } from "./external-agent-runtime.ts";
import { main } from "./cli/main.ts";
import type { SessionEventsReadback } from "./cli/commands/sessions.ts";
import { buildConversationMessages } from "./context/mod.ts";
import { serveWorkbenchUnix } from "./server/main.ts";
import { type DoltStore, fetchWorkbenchSessionEvents } from "./store/mod.ts";
import {
  type FixtureSql,
  openFixtureSql,
  openFixtureStore,
} from "../testing/dolt/fixture-sql.ts";
import { fakeIo } from "../testing/fakes/fake-io.ts";
import { udsTestSocket } from "../testing/servers/uds-sockets.ts";

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
        workspaceRoot: process.cwd(),
      }, { store });

      try {
        const events = await fetchWorkbenchSessionEvents({
          sessionId: result.sessionId,
          events: store.events,
        });
        const eventTypes = events.map((event) => event.eventType);
        assert.deepStrictEqual(eventTypes, [
          "session_start",
          "runner_selected",
          "agent_permission",
          "agent_response",
          "session_end",
        ]);
        assert.ok(!eventTypes.includes("provider_call"));
        assert.ok(!eventTypes.includes("model_response"));

        const permission = events.find((event) =>
          event.eventType === "agent_permission"
        );
        assert.partialDeepStrictEqual(permission!, {
          permissionVerdict: "denied",
          runnerKind: "external_agent",
          runnerProfile: "fixture",
          runnerProtocol: "acp",
        });

        const response = events.find((event) =>
          event.eventType === "agent_response"
        );
        assert.partialDeepStrictEqual(response!, {
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
        assert.ok(
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
        workspaceRoot: process.cwd(),
      }, { store });

      try {
        const events = await fetchWorkbenchSessionEvents({
          sessionId: result.sessionId,
          events: store.events,
        });
        assert.deepStrictEqual(events.map((event) => event.eventType), [
          "session_start",
          "runner_selected",
          "tool_call",
          "agent_response",
          "session_end",
        ]);

        const tool = events.find((event) => event.eventType === "tool_call");
        assert.partialDeepStrictEqual(tool!, {
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

        assert.deepStrictEqual(buildConversationMessages(events), [
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

  it("reads a fixture external-agent turn with recorded, partial and rejected calls over UDS via 'dyfj sessions show <id> --events'", () =>
    withFixture(async (store, sql) => {
      const result = await runExternalAgentWorkbenchRuntime({
        mode: "turn",
        prompt: "FIXTURE_TOOL_HISTORY_MIXED",
        routingOptions: {},
        runner: { kind: "acp", profile: "fixture" },
        workspaceRoot: process.cwd(),
      }, { store });

      const socketPath = udsTestSocket("cli-sessions-events");
      let server: Awaited<ReturnType<typeof serveWorkbenchUnix>> | undefined;

      try {
        await unlink(socketPath).catch(() => {});
        server = await serveWorkbenchUnix(socketPath, { store });

        const textIo = fakeIo();
        const textCode = await main(
          [
            "--socket",
            socketPath,
            "sessions",
            "show",
            result.sessionId,
            "--events",
          ],
          textIo.io,
        );
        assert.strictEqual(textCode, 0);
        const textOut = textIo.stdout.join("");
        assert.ok(textOut.includes(`Session ${result.sessionId} (1 turn)`));
        assert.ok(textOut.includes("Prompt: FIXTURE_TOOL_HISTORY_MIXED"));
        assert.ok(textOut.includes("Reply:  recorded"));
        assert.ok(
          textOut.includes(
            "ACP tool evidence: 2 recorded, 2 partial (missing_raw_output 1, oversized_output 1), 1 rejected (credential_shaped) of 5",
          ),
        );
        assert.ok(
          textOut.includes(
            '1. [recorded] acp.execute · kind=execute · status=completed · title="Run npm run typecheck" · input={"command":["npm","run","typecheck"]}',
          ),
        );
        assert.ok(
          textOut.includes(
            '2. [partial] acp.execute · kind=execute · status=completed · reason=missing_raw_output · title="Run npm run typecheck" · input={"command":["npm","run","typecheck"]}',
          ),
        );
        assert.ok(
          textOut.includes(
            '3. [rejected] acp.execute · kind=execute · status=completed · reason=credential_shaped · title="Run fixture login"',
          ),
        );
        assert.ok(
          textOut.includes(
            '4. [partial] acp.execute · kind=execute · status=completed · reason=oversized_output · title="Run npm test" · input={"command":["npm","test"]}',
          ),
        );
        assert.ok(
          textOut.includes(
            '5. [recorded] acp.execute · kind=execute · status=failed · title="Run npm test" · input={"command":["npm","test"]}',
          ),
        );
        assert.ok(!textOut.includes("abcdefghijklmnopqrstuvwxyz012345"));
        assert.ok(!textOut.includes("tail-not-kept"));

        const jsonIo = fakeIo();
        const jsonCode = await main(
          [
            "--socket",
            socketPath,
            "sessions",
            "show",
            `workbench-${result.sessionId.toLowerCase()}`,
            "--events",
            "--json",
          ],
          jsonIo.io,
        );
        assert.strictEqual(jsonCode, 0);
        const jsonText = jsonIo.stdout.join("");
        assert.ok(!jsonText.includes("abcdefghijklmnopqrstuvwxyz012345"));
        assert.ok(!jsonText.includes("tail-not-kept"));
        const parsed = JSON.parse(jsonText) as SessionEventsReadback;
        assert.deepStrictEqual(parsed, {
          sessionId: result.sessionId,
          truncated: false,
          turns: [
            {
              turn: 1,
              traceId: result.traceId,
              runner: "external_agent",
              promptFirstLine: "FIXTURE_TOOL_HISTORY_MIXED",
              replyFirstLine: "recorded",
              toolEvidenceLine:
                "ACP tool evidence: 2 recorded, 2 partial (missing_raw_output 1, oversized_output 1), 1 rejected (credential_shaped) of 5",
              toolEvents: [
                {
                  toolCallId: "fixture-mixed-typecheck",
                  outcome: "recorded",
                  toolName: "acp.execute",
                  kind: "execute",
                  title: "Run npm run typecheck",
                  status: "completed",
                  reason: null,
                  input: '{"command":["npm","run","typecheck"]}',
                },
                {
                  toolCallId: "fixture-missing-output",
                  outcome: "partial",
                  toolName: "acp.execute",
                  kind: "execute",
                  title: "Run npm run typecheck",
                  status: "completed",
                  reason: "missing_raw_output",
                  input: '{"command":["npm","run","typecheck"]}',
                },
                {
                  toolCallId: "fixture-secret-input",
                  outcome: "rejected",
                  toolName: "acp.execute",
                  kind: "execute",
                  title: "Run fixture login",
                  status: "completed",
                  reason: "credential_shaped",
                  input: null,
                },
                {
                  toolCallId: "fixture-oversized-output",
                  outcome: "partial",
                  toolName: "acp.execute",
                  kind: "execute",
                  title: "Run npm test",
                  status: "completed",
                  reason: "oversized_output",
                  input: '{"command":["npm","test"]}',
                },
                {
                  toolCallId: "fixture-mixed-test",
                  outcome: "recorded",
                  toolName: "acp.execute",
                  kind: "execute",
                  title: "Run npm test",
                  status: "failed",
                  reason: null,
                  input: '{"command":["npm","test"]}',
                },
              ],
            },
          ],
        });
      } finally {
        await server?.close();
        await unlink(socketPath).catch(() => {});
        await deleteSession(sql, result.sessionId);
      }
    }));
});
