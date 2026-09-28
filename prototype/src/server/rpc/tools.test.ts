import { assertEquals, assertObjectMatch } from "@std/assert";
import type { CommandDefinition } from "../../tools/mod.ts";
import { RpcErrorCode } from "../../transport/mod.ts";
import { callRpc, rpcFailure } from "../../../testing/builders/rpc.ts";
import { buildToolsHandlers } from "./tools.ts";

const externalReadCommand: CommandDefinition<string> = {
  id: "mcp.linear.get_issue",
  title: "External MCP: linear/get_issue",
  description: "Configured external MCP read.",
  inputSchema: { type: "object", additionalProperties: true },
  permission: {
    effects: ["read.external", "emit.event"],
    defaultDecision: "allow",
    resources: ["mcp:linear/get_issue"],
    network: "configured-external",
    filesystem: "none",
    cost: "none",
  },
  minimumClearance: "loopback",
  executor: () => "result",
};

Deno.test("tools/list exposes a catalog without executing tools", async () => {
  const { tools } = await callRpc(
    buildToolsHandlers({ externalMcpCommands: [externalReadCommand] }),
    "tools/list",
    { workspace: "/workspace" },
  ) as { tools: Array<Record<string, unknown>> };
  assertEquals(tools.map((tool) => tool.id), [
    "memory.read",
    "read_file",
    "list_files",
    "grep_files",
    "glob_files",
    "write_file",
    "edit_file",
    "bash",
    "git",
    "mcp.linear.get_issue",
  ]);
  assertObjectMatch(tools.find((tool) => tool.id === "bash")!, {
    permission: { filesystem: "write", network: "external" },
    redactResult: true,
  });
});

Deno.test("tools/inspect returns one tool schema", async () => {
  const result = await callRpc(buildToolsHandlers({}), "tools/inspect", {
    workspace: "/workspace",
    commandId: "read_file",
  }) as { tool: Record<string, unknown> };
  assertObjectMatch(result.tool, {
    id: "read_file",
    inputSchema: { required: ["path"] },
    permission: { filesystem: "read" },
  });
});

Deno.test("tools/inspect rejects a missing or unknown command id", async () => {
  const handlers = buildToolsHandlers({});
  assertEquals(await rpcFailure(handlers, "tools/inspect", {}), {
    code: RpcErrorCode.invalidParams,
    message: "tools/inspect requires a string commandId",
  });
  assertEquals(
    await rpcFailure(handlers, "tools/inspect", { commandId: "nope" }),
    { code: RpcErrorCode.invalidParams, message: "unknown tool: nope" },
  );
});
