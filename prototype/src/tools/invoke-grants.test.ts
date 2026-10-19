// The "allow this exact command for the rest of the session" answer
// (BIT-707): how invokeCommand asks, records and reuses a session grant.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  CommandCall,
  CommandDefinition,
  SessionGrants,
  ToolApprovalRequest,
  ToolApprovalVerdict,
} from "./definition.ts";
import { invokeCommand } from "./invoke.ts";
import { createCommandRegistry } from "./registry.ts";

function shell(overrides: Partial<CommandDefinition<string>> = {}): CommandDefinition<string> {
  return {
    id: "bash",
    title: "Run",
    description: "run",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: { command: { type: "string" }, cwd: { type: "string" } },
      additionalProperties: false,
    },
    permission: {
      effects: ["run.process"],
      defaultDecision: "allow",
      resources: ["process:run"],
      network: "external",
      filesystem: "write",
      cost: "none",
    },
    grantable: true,
    executor: () => Promise.resolve("ran"),
    ...overrides,
  };
}

const call = (args: Record<string, unknown>): CommandCall => ({
  commandId: "bash",
  callId: "c",
  caller: { principalId: "workbench", principalType: "agent" },
  arguments: args,
});

function memoryGrants(): SessionGrants & { keys: Set<string> } {
  const keys = new Set<string>();
  return { keys, has: (k) => keys.has(k), add: (k) => void keys.add(k) };
}

function approver(verdict: ToolApprovalVerdict, asked: ToolApprovalRequest[]) {
  return (request: ToolApprovalRequest) => {
    asked.push(request);
    return Promise.resolve(verdict);
  };
}

describe("session grants", () => {
  it("offers the grant on a grantable call and records it when chosen", async () => {
    const registry = createCommandRegistry([shell()]);
    const grants = memoryGrants();
    const asked: ToolApprovalRequest[] = [];
    const first = await invokeCommand(
      registry,
      call({ command: "npm test" }),
      approver({ decision: "approve", scope: "session" }, asked),
      { sessionGrants: grants },
    );
    assert.equal(asked.length, 1);
    assert.equal(asked[0].grantable, true);
    assert.equal(first.authzBasis, "policy:allow:operator-approved-session-grant");
    assert.equal(grants.keys.size, 1);

    const again = await invokeCommand(
      registry,
      call({ command: "npm test" }),
      approver({ decision: "deny" }, asked),
      { sessionGrants: grants },
    );
    assert.equal(asked.length, 1, "a granted call is not asked again");
    assert.equal(again.isError, false);
    assert.equal(again.authzBasis, "policy:allow:session-grant");
  });

  it("matches the exact arguments only", async () => {
    const registry = createCommandRegistry([shell()]);
    const grants = memoryGrants();
    const asked: ToolApprovalRequest[] = [];
    await invokeCommand(registry, call({ command: "npm test" }), approver({ decision: "approve", scope: "session" }, asked), { sessionGrants: grants });
    for (const args of [{ command: "npm test " }, { command: "npm test; rm x" }, { command: "npm test", cwd: "sub" }]) {
      await invokeCommand(registry, call(args), approver({ decision: "deny" }, asked), { sessionGrants: grants });
    }
    assert.equal(asked.length, 4);
  });

  it("an approve-once answer records no grant", async () => {
    const registry = createCommandRegistry([shell()]);
    const grants = memoryGrants();
    const result = await invokeCommand(registry, call({ command: "x" }), approver({ decision: "approve" }, []), { sessionGrants: grants });
    assert.equal(result.authzBasis, "policy:allow:operator-approved");
    assert.equal(grants.keys.size, 0);
  });

  it("a denial records no grant", async () => {
    const registry = createCommandRegistry([shell()]);
    const grants = memoryGrants();
    await invokeCommand(registry, call({ command: "x" }), approver({ decision: "deny", scope: "session" } as ToolApprovalVerdict, []), { sessionGrants: grants });
    assert.equal(grants.keys.size, 0);
  });

  it("a command that is not grantable is never offered or granted", async () => {
    const registry = createCommandRegistry([shell({ grantable: undefined })]);
    const grants = memoryGrants();
    const asked: ToolApprovalRequest[] = [];
    const result = await invokeCommand(registry, call({ command: "x" }), approver({ decision: "approve", scope: "session" }, asked), { sessionGrants: grants });
    assert.equal(asked[0].grantable, undefined);
    assert.equal(result.authzBasis, "policy:allow:operator-approved");
    assert.equal(grants.keys.size, 0);
  });

  it("without a grant store nothing is offered or granted", async () => {
    const registry = createCommandRegistry([shell()]);
    const asked: ToolApprovalRequest[] = [];
    const result = await invokeCommand(registry, call({ command: "x" }), approver({ decision: "approve", scope: "session" }, asked), {});
    assert.equal(asked[0].grantable, undefined);
    assert.equal(result.authzBasis, "policy:allow:operator-approved");
  });
});
