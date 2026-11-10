// Which Workbench commands the tool bridge offers Codex, and under which
// names. The socket, shim and invocation cases live in
// workbench-tool-bridge-socket.test.ts.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { CommandDefinition } from "./tools/mod.ts";
import type { SocketHost } from "./transport/mod.ts";
import {
  bridgedToolName,
  bridgedTools,
  isBridgedCommand,
  WorkbenchToolBridge,
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

describe("a bridge whose listener fails", () => {
  it("closes itself and removes its directory when accept rejects", async () => {
    const parent = await mkdtemp(join(tmpdir(), "bridge-fail-"));
    let fail!: (error: Error) => void;
    const host: SocketHost = {
      connect: () => Promise.reject(new Error("not used")),
      listen: () =>
        Promise.resolve({
          accept: () => new Promise((_, reject) => (fail = reject)),
          close: () => {},
        }),
    };
    const quiet = console.error;
    console.error = () => {};
    try {
      const bridge = await WorkbenchToolBridge.start(parent, host);
      assert.equal(bridge.closed, false);
      fail(new Error("listener I/O failure"));
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const gone = await stat(dirname(bridge.socketPath)).then(() => false, () => true);
        if (bridge.closed && gone) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(bridge.closed, true);
      await assert.rejects(stat(dirname(bridge.socketPath)));
    } finally {
      console.error = quiet;
      await rm(parent, { recursive: true, force: true });
    }
  });
});
