// Which Workbench commands the tool bridge offers Codex, and under which
// names. The socket, shim and invocation cases live in
// workbench-tool-bridge-socket.test.ts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CommandDefinition } from "./tools/mod.ts";
import {
  bridgedToolName,
  bridgedTools,
  isBridgedCommand,
} from "./workbench-tool-bridge.ts";

function command(id: string): CommandDefinition {
  return {
    id,
    title: id,
    description: `the ${id} command`,
    inputSchema: { type: "object", properties: {} },
    permission: {
      effects: ["read.external"],
      defaultDecision: "allow",
      resources: [],
    },
    executor: () => Promise.resolve("ok"),
  };
}

describe("bridged tools", () => {
  it("offers the configured MCP commands and leaves the builtins off", () => {
    assert.equal(isBridgedCommand(command("mcp.linear.get_issue")), true);
    for (const id of ["bash", "read_file", "write_file", "read_memory"]) {
      assert.equal(isBridgedCommand(command(id)), false, id);
    }
  });

  it("maps a command id to OpenAI's function-name character set", () => {
    assert.equal(bridgedToolName("mcp.linear.get_issue"), "mcp_linear_get_issue");
    assert.equal(bridgedToolName("mcp.web:search/x"), "mcp_web_search_x");
    assert.match(bridgedToolName("mcp.a.b-c_d"), /^[A-Za-z0-9_-]+$/);
  });

  it("lists each admitted command once, with its description and schema", () => {
    assert.deepEqual(
      bridgedTools([command("bash"), command("mcp.linear.get_issue")]),
      [{
        name: "mcp_linear_get_issue",
        commandId: "mcp.linear.get_issue",
        description: "the mcp.linear.get_issue command",
        inputSchema: { type: "object", properties: {} },
      }],
    );
  });

  it("leaves out both commands when two ids map to one name", () => {
    const tools = bridgedTools([
      command("mcp.a.b"),
      command("mcp.a_b"),
      command("mcp.linear.get_issue"),
    ]);
    assert.deepEqual(tools.map((tool) => tool.commandId), [
      "mcp.linear.get_issue",
    ]);
  });
});
