// The `sessions` namespace: the bounded, activity-ordered session list and
// one session's summary, workspace and event count.

import {
  compareSessionActivity,
  type WorkbenchProjectSessions,
  type WorkbenchSessionSummary,
} from "../../store/mod.ts";
import {
  RpcError,
  RpcErrorCode,
  type RpcHandlers,
} from "../../transport/mod.ts";
import {
  asRecord,
  sanitizeRpcIdentifier,
  sanitizeRpcString,
} from "./params.ts";

export type ListSessions = (
  options: { project?: string; limit?: number },
) => Promise<WorkbenchProjectSessions[]>;

export type FetchSessionWorkspaceRecord = (
  input: { sessionId: string },
) => Promise<{ exists: boolean; workspace: string | null }>;

export interface SessionsHandlerDeps {
  listSessions: ListSessions;
  fetchSessionRecord: (
    input: { sessionId: string },
  ) => Promise<WorkbenchSessionSummary | null>;
  fetchSessionWorkspaceRecord: FetchSessionWorkspaceRecord;
  countSessionEvents: (input: { sessionId: string }) => Promise<number>;
}

export function buildSessionsHandlers(deps: SessionsHandlerDeps): RpcHandlers {
  return {
    "sessions/list": async (params) => {
      const record = asRecord(params);
      const project = sanitizeRpcString(record.project, "project", {
        maxLen: 256,
      });
      if (
        record.limit !== undefined &&
        (typeof record.limit !== "number" ||
          !Number.isInteger(record.limit) ||
          record.limit <= 0)
      ) {
        throw new RpcError(
          RpcErrorCode.invalidParams,
          "sessions/list limit must be a positive integer",
        );
      }
      const limit = typeof record.limit === "number" && record.limit > 0
        ? Math.min(record.limit, 1000)
        : 100;
      const fetchLimit = Math.min(Math.max(limit * 4, 100), 1000);
      const projects = await deps.listSessions({
        project,
        limit: fetchLimit,
      });
      const topSessions: Array<{
        projectIdx: number;
        session: WorkbenchSessionSummary;
      }> = [];
      for (let i = 0; i < projects.length; i++) {
        const p = projects[i];
        if (Array.isArray(p.sessions)) {
          for (let j = 0; j < p.sessions.length; j++) {
            const s = p.sessions[j];
            if (topSessions.length < limit) {
              topSessions.push({ projectIdx: i, session: s });
              topSessions.sort((a, b) =>
                compareSessionActivity(a.session, b.session)
              );
            } else if (
              compareSessionActivity(
                s,
                topSessions[topSessions.length - 1].session,
              ) < 0
            ) {
              topSessions[topSessions.length - 1] = {
                projectIdx: i,
                session: s,
              };
              topSessions.sort((a, b) =>
                compareSessionActivity(a.session, b.session)
              );
            }
          }
        }
      }
      const projectMap = new Map<number, WorkbenchSessionSummary[]>();
      for (const item of topSessions) {
        let list = projectMap.get(item.projectIdx);
        if (!list) {
          list = [];
          projectMap.set(item.projectIdx, list);
        }
        list.push(item.session);
      }
      const boundedProjects: WorkbenchProjectSessions[] = [];
      for (
        let i = 0;
        i < projects.length && boundedProjects.length < limit;
        i++
      ) {
        const matching = projectMap.get(i);
        if (matching && matching.length > 0) {
          boundedProjects.push({
            project: projects[i].project,
            sessions: matching,
          });
        } else if (project !== undefined) {
          boundedProjects.push({
            project: projects[i].project,
            sessions: [],
          });
        }
      }
      if (
        boundedProjects.length === 0 && topSessions.length === 0 &&
        projects.length > 0
      ) {
        return { projects: projects.slice(0, limit) };
      }
      return { projects: boundedProjects };
    },

    "sessions/inspect": async (params) => {
      const record = asRecord(params);
      const sessionId = sanitizeRpcIdentifier(record.sessionId, "sessionId", {
        required: true,
        maxLen: 256,
      })!;
      const [session, workspaceRec, eventCount] = await Promise.all([
        deps.fetchSessionRecord({ sessionId }),
        deps.fetchSessionWorkspaceRecord({ sessionId }),
        deps.countSessionEvents({ sessionId }),
      ]);
      return {
        session,
        workspace: workspaceRec.workspace,
        exists: session !== null || workspaceRec.exists,
        eventCount,
      };
    },
  };
}
