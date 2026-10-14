import assert from "node:assert/strict";
import type { WorkbenchModel } from "../../providers/mod.ts";
import type { WorkbenchProjectSessions } from "../../store/mod.ts";
import { callRpc } from "../../../testing/builders/rpc.ts";
import { buildSurfaceHandlers } from "./surface.ts";

Deno.test("surface/snapshot bundles status, models, sessions, and tools", async () => {
  const result = await callRpc(
    buildSurfaceHandlers({
      loadModels: () =>
        Promise.resolve([{ slug: "local-x" }] as unknown as WorkbenchModel[]),
      listSessions: (o) =>
        Promise.resolve(
          [{
            project: o.project ?? null,
            sessions: [],
          }] as unknown as WorkbenchProjectSessions[],
        ),
    }),
    "surface/snapshot",
    { project: "dyfj", workspace: "/workspace" },
  ) as Record<string, unknown> & { tools: Array<{ id: string }> };
  assert.deepStrictEqual(typeof result.generatedAt, "string");
  assert.partialDeepStrictEqual(result.runtime as Record<string, unknown>, {
    transport: "uds",
  });
  assert.deepStrictEqual(result.models, [{ slug: "local-x" }]);
  assert.deepStrictEqual(result.projects, [{ project: "dyfj", sessions: [] }]);
  assert.ok(result.tools.some((tool) => tool.id === "read_file"));
});
