import { assert, assertEquals, assertObjectMatch } from "@std/assert";
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
  assertEquals(typeof result.generatedAt, "string");
  assertObjectMatch(result.runtime as Record<string, unknown>, {
    transport: "uds",
  });
  assertEquals(result.models, [{ slug: "local-x" }]);
  assertEquals(result.projects, [{ project: "dyfj", sessions: [] }]);
  assert(result.tools.some((tool) => tool.id === "read_file"));
});
