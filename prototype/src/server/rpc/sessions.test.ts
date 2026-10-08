import { assertEquals, assertStringIncludes } from "@std/assert";
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
    fetchSessionModel: () => Promise.resolve(null),
    countSessionEvents: () => Promise.resolve(0),
    ...overrides,
  });
}

Deno.test("sessions/list passes the project filter through", async () => {
  assertEquals(
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
      fetchSessionModel: () => Promise.resolve("claude-sonnet-5"),
      countSessionEvents: () => Promise.resolve(1),
    }),
    "sessions/inspect",
    { sessionId: "01TEST_SESSION" },
  );
  assertEquals(result, {
    session,
    workspace: "/workspaces/project",
    model: "claude-sonnet-5",
    exists: true,
    eventCount: 1,
  });
});

Deno.test("sessions/inspect rejects C1 control characters in identifiers", async () => {
  const error = await rpcFailure(handlers(), "sessions/inspect", {
    sessionId: "01TEST\u009BSESSION",
  });
  assertEquals(error.code, RpcErrorCode.invalidParams);
  assertStringIncludes(error.message, "cannot contain control characters");
});
