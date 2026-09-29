// The `surface` namespace: one snapshot bundling the runtime posture, the
// model catalog, the session list and the tool catalog, so a surface can
// render its first frame from a single request.

import type { WorkbenchModel } from "../../providers/mod.ts";
import type { WorkbenchProjectSessions } from "../../store/mod.ts";
import { asRecord, type RpcHandlers } from "../../transport/mod.ts";
import {
  type RuntimePosture,
  runtimeStatus,
  type WorkbenchRuntimeStatus,
} from "./runtime.ts";
import type { ListSessions } from "./sessions.ts";
import {
  listToolCatalog,
  type ToolsHandlerDeps,
  type WorkbenchToolSummary,
} from "./tools.ts";

export interface WorkbenchSurfaceSnapshot {
  generatedAt: string;
  runtime: WorkbenchRuntimeStatus;
  models: WorkbenchModel[];
  projects: WorkbenchProjectSessions[];
  tools: WorkbenchToolSummary[];
}

export interface SurfaceHandlerDeps extends RuntimePosture, ToolsHandlerDeps {
  loadModels: () => Promise<WorkbenchModel[]>;
  listSessions: ListSessions;
}

export function buildSurfaceHandlers(deps: SurfaceHandlerDeps): RpcHandlers {
  return {
    "surface/snapshot": async (params) => {
      const record = asRecord(params);
      const project = record.project;
      const [models, projects] = await Promise.all([
        deps.loadModels(),
        deps.listSessions({
          project: typeof project === "string" ? project : undefined,
        }),
      ]);
      return {
        generatedAt: new Date().toISOString(),
        runtime: runtimeStatus(deps, models),
        models,
        projects,
        tools: listToolCatalog(params, deps.externalMcpCommands),
      } satisfies WorkbenchSurfaceSnapshot;
    },
  };
}
