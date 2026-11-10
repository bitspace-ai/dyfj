// The Workbench tool bridge end to end, from an MCP client through the real
// shim and the bridge's Unix socket to Workbench's own invoke path: the
// session a token binds, the active-turn requirement, the approval path and
// the `tool_call` event. Codex itself is not involved; the Codex canary is
// `workbench-tool-bridge-codex.test.ts`.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { unixSocketBindSkip } from "../testing/unix-socket-bind.ts";
import type { EventInsert } from "./store/mod.ts";
import type {
  CommandDefinition,
  ToolApprovalRequest,
  ToolApprovalVerdict,
} from "./tools/mod.ts";
import {
  type BridgeTurn,
  WORKBENCH_BRIDGE_SHIM_PATH,
  WORKBENCH_BRIDGE_TOKEN_ENV,
  WorkbenchToolBridge,
} from "./workbench-tool-bridge.ts";

const skip = await unixSocketBindSkip();

interface Ran {
  commandId: string;
  arguments: Record<string, unknown>;
}

function commands(ran: Ran[]): CommandDefinition[] {
  const define = (
    id: string,
    write: boolean,
  ): CommandDefinition<string> => ({
    id,
    title: id,
    description: `the ${id} command`,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    permission: {
      effects: [write ? "write.external" : "read.external", "emit.event"],
      defaultDecision: write ? "ask" : "allow",
      resources: [`mcp:${id}`],
      network: "configured-external",
      filesystem: "none",
      cost: "none",
    },
    executor: (call) => {
      ran.push({ commandId: call.commandId, arguments: call.arguments });
      return Promise.resolve(`${id} ran for ${String(call.arguments.id)}`);
    },
  });
  return [
    define("mcp.linear.get_issue", false),
    define("mcp.linear.save_comment", true),
    define("bash", true),
  ];
}

interface Turn {
  turn: BridgeTurn;
  ran: Ran[];
  events: EventInsert[];
  asked: ToolApprovalRequest[];
}

function turn(verdict: ToolApprovalVerdict = { decision: "deny" }): Turn {
  const ran: Ran[] = [];
  const events: EventInsert[] = [];
  const asked: ToolApprovalRequest[] = [];
  return {
    ran,
    events,
    asked,
    turn: {
      commands: commands(ran),
      confirmApproval: (request) => {
        asked.push(request);
        return Promise.resolve(verdict);
      },
      policy: { permissionLevel: "strict", loopback: true },
      traceId: "0".repeat(32),
      parentSpanId: "1".repeat(16),
      writeEvent: (event) => {
        events.push(event);
      },
    },
  };
}

async function connect(
  bridge: WorkbenchToolBridge,
  token: string,
): Promise<Client> {
  const client = new Client({ name: "bridge-test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [WORKBENCH_BRIDGE_SHIM_PATH, bridge.socketPath],
      env: { [WORKBENCH_BRIDGE_TOKEN_ENV]: token },
      stderr: "ignore",
    }),
  );
  return client;
}

function text(result: unknown): string {
  const content = (result as { content: Array<{ text: string }> }).content;
  return content.map((part) => part.text).join("");
}

describe("the Workbench tool bridge", { skip: skip ?? false }, () => {
  let parent = "";
  let bridge: WorkbenchToolBridge;

  before(async () => {
    parent = await mkdtemp(join(tmpdir(), "wb-"));
    bridge = await WorkbenchToolBridge.start(parent);
  });

  after(async () => {
    await bridge.close();
    await rm(parent, { recursive: true, force: true });
  });

  it("lists the active turn's MCP commands only", async () => {
    const t = turn();
    const release = bridge.activate("session-list", t.turn);
    const client = await connect(bridge, bridge.bind("session-list"));
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        "mcp_linear_get_issue",
        "mcp_linear_save_comment",
      ]);
    } finally {
      await client.close();
      release();
    }
  });

  it("runs an allowed command and records its tool_call under the bound session", async () => {
    const t = turn();
    const release = bridge.activate("session-read", t.turn);
    const client = await connect(bridge, bridge.bind("session-read"));
    try {
      const result = await client.callTool({
        name: "mcp_linear_get_issue",
        arguments: { id: "BIT-1" },
      });
      assert.equal(result.isError, false);
      assert.equal(text(result), "mcp.linear.get_issue ran for BIT-1");
      assert.deepEqual(t.ran, [{
        commandId: "mcp.linear.get_issue",
        arguments: { id: "BIT-1" },
      }]);
      assert.equal(t.asked.length, 0);
      assert.equal(t.events.length, 1);
      const event = t.events[0] as unknown as Record<string, unknown>;
      assert.equal(event.session_id, "session-read");
      assert.equal(event.tool_name, "mcp.linear.get_issue");
      assert.equal(event.trace_id, "0".repeat(32));
      assert.equal(event.parent_span_id, "1".repeat(16));
    } finally {
      await client.close();
      release();
    }
  });

  it("asks the turn's approver for an ask command and does not run it when denied", async () => {
    const t = turn({ decision: "deny", reason: "not now" });
    const release = bridge.activate("session-deny", t.turn);
    const client = await connect(bridge, bridge.bind("session-deny"));
    try {
      const result = await client.callTool({
        name: "mcp_linear_save_comment",
        arguments: { id: "BIT-1" },
      });
      assert.equal(result.isError, true);
      assert.match(text(result), /^approval_denied: /);
      assert.equal(t.asked.length, 1);
      assert.equal(t.asked[0].commandId, "mcp.linear.save_comment");
      assert.deepEqual(t.ran, []);
      const event = t.events[0] as unknown as Record<string, unknown>;
      assert.equal(event.authz_basis, "policy:deny:approval-denied");
    } finally {
      await client.close();
      release();
    }
  });

  it("runs an ask command once the turn's approver approves it", async () => {
    const t = turn({ decision: "approve" });
    const release = bridge.activate("session-approve", t.turn);
    const client = await connect(bridge, bridge.bind("session-approve"));
    try {
      const result = await client.callTool({
        name: "mcp_linear_save_comment",
        arguments: { id: "BIT-2" },
      });
      assert.equal(result.isError, false);
      assert.equal(t.asked.length, 1);
      assert.deepEqual(t.ran.map((each) => each.commandId), [
        "mcp.linear.save_comment",
      ]);
      const event = t.events[0] as unknown as Record<string, unknown>;
      assert.equal(event.authz_basis, "policy:allow:operator-approved");
    } finally {
      await client.close();
      release();
    }
  });

  it("treats an approval that arrives after the turn ended as a denial", async () => {
    const t = turn();
    let release = () => {};
    t.turn.confirmApproval = (request) => {
      t.asked.push(request);
      release();
      return Promise.resolve({ decision: "approve" });
    };
    release = bridge.activate("session-late", t.turn);
    const client = await connect(bridge, bridge.bind("session-late"));
    try {
      const result = await client.callTool({
        name: "mcp_linear_save_comment",
        arguments: { id: "BIT-4" },
      });
      assert.equal(result.isError, true);
      assert.match(text(result), /turn ended before the approval arrived/);
      assert.equal(t.asked.length, 1);
      assert.deepEqual(t.ran, []);
    } finally {
      await client.close();
    }
  });

  it("denies unanswered approvals when the turn ends, and caps a session's calls in progress", async () => {
    const t = turn();
    t.turn.confirmApproval = (request) => {
      t.asked.push(request);
      return new Promise(() => {});
    };
    const release = bridge.activate("session-pending", t.turn);
    const client = await connect(bridge, bridge.bind("session-pending"));
    try {
      const pending = Array.from({ length: 8 }, (_, index) =>
        client.callTool({
          name: "mcp_linear_save_comment",
          arguments: { id: `BIT-${index}` },
        }));
      const deadline = Date.now() + 10_000;
      while (t.asked.length < 8) {
        if (Date.now() > deadline) {
          throw new Error(`only ${t.asked.length} of 8 calls reached the approver`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const ninth = await client.callTool({
        name: "mcp_linear_get_issue",
        arguments: { id: "BIT-9" },
      });
      assert.equal(ninth.isError, true);
      assert.match(text(ninth), /Too many Workbench tool calls in progress/);
      release();
      for (const result of await Promise.all(pending)) {
        assert.equal(result.isError, true);
        assert.match(text(result), /turn ended before the approval arrived/);
      }
      assert.deepEqual(t.ran, []);
    } finally {
      await client.close();
      release();
    }
  });

  it("refuses a call when the session has no active turn", async () => {
    const t = turn();
    const release = bridge.activate("session-idle", t.turn);
    const client = await connect(bridge, bridge.bind("session-idle"));
    try {
      release();
      const result = await client.callTool({
        name: "mcp_linear_get_issue",
        arguments: { id: "BIT-1" },
      });
      assert.equal(result.isError, true);
      assert.match(text(result), /No Workbench turn is active/);
      assert.deepEqual(t.ran, []);
      assert.deepEqual(t.events, []);
    } finally {
      await client.close();
    }
  });

  it("refuses a command the bridge does not offer", async () => {
    const t = turn({ decision: "approve" });
    const release = bridge.activate("session-bash", t.turn);
    const client = await connect(bridge, bridge.bind("session-bash"));
    try {
      const result = await client.callTool({
        name: "bash",
        arguments: { id: "x" },
      });
      assert.equal(result.isError, true);
      assert.deepEqual(t.ran, []);
      assert.equal(t.asked.length, 0);
    } finally {
      await client.close();
      release();
    }
  });

  it("serves the session the token binds, whatever other session is active", async () => {
    const a = turn();
    const b = turn();
    const releaseA = bridge.activate("session-a", a.turn);
    const releaseB = bridge.activate("session-b", b.turn);
    const client = await connect(bridge, bridge.bind("session-a"));
    try {
      await client.callTool({
        name: "mcp_linear_get_issue",
        arguments: { id: "BIT-3" },
      });
      assert.equal(a.ran.length, 1);
      assert.equal(b.ran.length, 0);
      assert.equal(
        (a.events[0] as unknown as Record<string, unknown>).session_id,
        "session-a",
      );
    } finally {
      await client.close();
      releaseA();
      releaseB();
    }
  });

  it("keeps one token per session", () => {
    assert.equal(bridge.bind("session-same"), bridge.bind("session-same"));
    assert.notEqual(bridge.bind("session-same"), bridge.bind("session-other"));
  });

  it("closes a connection whose token is unknown", async () => {
    await assert.rejects(connect(bridge, "0".repeat(64)));
  });

  it("refuses a second active turn for one session", () => {
    const release = bridge.activate("session-twice", turn().turn);
    try {
      assert.throws(() => bridge.activate("session-twice", turn().turn));
    } finally {
      release();
    }
  });
});
