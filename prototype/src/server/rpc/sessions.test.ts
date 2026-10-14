import assert from "node:assert/strict";
import { assertEquals } from "@std/assert";
import type {
  WorkbenchProjectSessions,
  WorkbenchSessionSummary,
} from "../../store/mod.ts";
import { RpcErrorCode } from "../../transport/mod.ts";
import { callRpc, rpcFailure } from "../../../testing/builders/rpc.ts";
import { buildSessionsHandlers, type SessionsHandlerDeps } from "./sessions.ts";

function handlers(overrides: Partial<SessionsHandlerDeps> = {}) {
  return buildSessionsHandlers({
    listSessions: (o) =>
      Promise.resolve(
        [{
          project: o.project ?? null,
          sessions: [],
        }] as unknown as WorkbenchProjectSessions[],
      ),
    fetchSessionRecord: () => Promise.resolve(null),
    fetchSessionWorkspaceRecord: () =>
      Promise.resolve({ exists: false, workspace: null }),
    fetchSessionLastRun: () => Promise.resolve(null),
    countSessionEvents: () => Promise.resolve(0),
    ...overrides,
  });
}

Deno.test("sessions/list passes the project filter through", async () => {
  assert.deepStrictEqual(
    await callRpc(handlers(), "sessions/list", { project: "dyfj" }),
    { projects: [{ project: "dyfj", sessions: [] }] },
  );
});

Deno.test("sessions/list rejects a non-positive limit", async () => {
  const error = await rpcFailure(handlers(), "sessions/list", { limit: 0 });
  assertEquals(error, {
    code: RpcErrorCode.invalidParams,
    message: "sessions/list limit must be a positive integer",
  });
});

Deno.test("sessions/inspect returns session summary, workspace, recorded model, and event counts", async () => {
  const session: WorkbenchSessionSummary = {
    sessionId: "01TEST_SESSION",
    slug: "workbench-01test_session",
    sessionName: null,
    taskDescription: "Explore neutral sessions",
    project: "DYFJ Context",
    status: "active",
    createdAt: "2026-08-15T12:00:00Z",
    updatedAt: "2026-08-15T12:00:00Z",
  } as WorkbenchSessionSummary;
  const result = await callRpc(
    handlers({
      fetchSessionRecord: () => Promise.resolve(session),
      fetchSessionWorkspaceRecord: () =>
        Promise.resolve({ exists: true, workspace: "/workspaces/project" }),
      fetchSessionLastRun: () =>
        Promise.resolve({ kind: "model", slug: "claude-sonnet-5" }),
      countSessionEvents: () => Promise.resolve(1),
    }),
    "sessions/inspect",
    { sessionId: "01TEST_SESSION" },
  );
  assert.deepStrictEqual(result, {
    session,
    workspace: "/workspaces/project",
    model: "claude-sonnet-5",
    runner: null,
    exists: true,
    eventCount: 1,
  });
});

Deno.test("sessions/inspect rejects C1 control characters in identifiers", async () => {
  const error = await rpcFailure(handlers(), "sessions/inspect", {
    sessionId: "01TEST\u009BSESSION",
  });
  assert.deepStrictEqual(error.code, RpcErrorCode.invalidParams);
  assert.ok(error.message.includes("cannot contain control characters"), `expected error.message to include "cannot contain control characters"`);
});

Deno.test("sessions/inspect names the runner when the session last ran on one", async () => {
  const result = await callRpc(
    handlers({
      fetchSessionLastRun: () =>
        Promise.resolve({ kind: "runner", profile: "codex-chatgpt" }),
    }),
    "sessions/inspect",
    { sessionId: "01TEST_SESSION" },
  ) as { model: string | null; runner: string | null };
  assert.deepStrictEqual(result.model, null);
  assert.deepStrictEqual(result.runner, "codex-chatgpt");
});
