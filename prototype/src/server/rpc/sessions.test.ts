import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_SESSION_LINEAGE,
  type WorkbenchProjectSessions,
  type WorkbenchSessionSummary,
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
    fetchSessionLineage: () => Promise.resolve({ ...EMPTY_SESSION_LINEAGE }),
    countSessionEvents: () => Promise.resolve(0),
    ...overrides,
  });
}

test("sessions/list passes the project filter through", async () => {
  assert.deepStrictEqual(
    await callRpc(handlers(), "sessions/list", { project: "dyfj" }),
    { projects: [{ project: "dyfj", sessions: [] }] },
  );
});

test("sessions/list rejects a non-positive limit", async () => {
  const error = await rpcFailure(handlers(), "sessions/list", { limit: 0 });
  assert.deepStrictEqual(error, {
    code: RpcErrorCode.invalidParams,
    message: "sessions/list limit must be a positive integer",
  });
});

test("sessions/inspect returns session summary, workspace, recorded model, and event counts", async () => {
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
    parentSessionId: null,
    depth: null,
    label: null,
    effort: null,
    route: null,
    family: null,
    exists: true,
    eventCount: 1,
  });
});

test("sessions/inspect reports the lineage the session's first start recorded", async () => {
  const sessionIds: string[] = [];
  const result = await callRpc(
    handlers({
      fetchSessionLineage: ({ sessionId }) => {
        sessionIds.push(sessionId);
        return Promise.resolve({
          parentSessionId: "01COORDINATOR",
          depth: 1,
          label: "lineage-fields",
          effort: "high",
          route: "acp",
          family: "gpt",
        });
      },
    }),
    "sessions/inspect",
    { sessionId: "01TEST_SESSION" },
  ) as Record<string, unknown>;
  assert.deepStrictEqual(sessionIds, ["01TEST_SESSION"]);
  assert.deepStrictEqual(
    {
      parentSessionId: result.parentSessionId,
      depth: result.depth,
      label: result.label,
      effort: result.effort,
      route: result.route,
      family: result.family,
    },
    {
      parentSessionId: "01COORDINATOR",
      depth: 1,
      label: "lineage-fields",
      effort: "high",
      route: "acp",
      family: "gpt",
    },
  );
});

test("sessions/inspect rejects C1 control characters in identifiers", async () => {
  const error = await rpcFailure(handlers(), "sessions/inspect", {
    sessionId: "01TEST\u009BSESSION",
  });
  assert.deepStrictEqual(error.code, RpcErrorCode.invalidParams);
  assert.ok(
    error.message.includes("cannot contain control characters"),
    `expected error.message to include "cannot contain control characters"`,
  );
});

test("sessions/inspect names the runner when the session last ran on one", async () => {
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
