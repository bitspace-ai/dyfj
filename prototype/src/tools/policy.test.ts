// Tests for the call-shape policy (`policy.ts`).

import {
  assertEquals,
  assertFalse,
  assertObjectMatch,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { CommandCall, CommandDefinition } from "./definition.ts";
import { createCommandRegistry } from "./registry.ts";
import { evaluateCommandPolicy } from "./policy.ts";
import { invokeCommand } from "./invoke.ts";

function readCommand(
  overrides: Partial<CommandDefinition<string>> = {},
): CommandDefinition<string> {
  return {
    id: "memory.read",
    title: "Read Memory",
    description: "Load one Dolt-backed memory by slug.",
    inputSchema: {
      type: "object",
      required: ["slug"],
      properties: {
        slug: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["read.memory", "emit.event"],
      defaultDecision: "allow",
      resources: ["memory:*"],
      network: "local",
      filesystem: "none",
      cost: "none",
    },
    executor: (call) => Promise.resolve(`read ${call.arguments.slug}`),
    ...overrides,
  };
}

function call(
  args: Record<string, unknown> = { slug: "project_dyfj" },
  overrides: Partial<CommandCall> = {},
): CommandCall {
  return {
    commandId: "memory.read",
    callId: "call-123",
    caller: { principalId: "operator", principalType: "human" },
    arguments: args,
    ...overrides,
  };
}

describe("evaluateCommandPolicy", () => {
  it("allows a valid read-only memory command for a human caller", () => {
    const result = evaluateCommandPolicy(readCommand(), call());

    assertEquals(result, {
      decision: "allow",
      authzBasis: "policy:allow:read-only-local",
    });
  });

  it("allows the same command shape for an agent caller", () => {
    const result = evaluateCommandPolicy(
      readCommand(),
      call(
        { slug: "project_dyfj" },
        { caller: { principalId: "agent", principalType: "agent" } },
      ),
    );

    assertStrictEquals(result.decision, "allow");
  });

  it("auto-allows a read-only filesystem command", () => {
    const readFile = readCommand({
      id: "read_file",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
        additionalProperties: false,
      },
      permission: {
        effects: ["read.filesystem", "emit.event"],
        defaultDecision: "allow",
        resources: ["file:read"],
        network: "none",
        filesystem: "read",
        cost: "none",
      },
    });
    const result = evaluateCommandPolicy(
      readFile,
      call({ path: "src/cli.ts" }, { commandId: "read_file" }),
    );
    assertStrictEquals(result.decision, "allow");
  });

  it("does NOT auto-allow a write-filesystem command (falls to ask)", () => {
    const writeFile = readCommand({
      id: "write_file",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
        additionalProperties: false,
      },
      permission: {
        effects: ["write.filesystem", "emit.event"],
        defaultDecision: "allow",
        resources: ["file:write"],
        network: "none",
        filesystem: "write",
        cost: "none",
      },
    });
    const result = evaluateCommandPolicy(
      writeFile,
      call({ path: "x" }, { commandId: "write_file" }),
    );
    assertStrictEquals(result.decision, "ask");
  });

  it("denies malformed command arguments before execution", () => {
    const result = evaluateCommandPolicy(
      readCommand(),
      call({
        slug: "../secret",
      }),
    );

    assertObjectMatch(result, {
      decision: "deny",
      authzBasis: "policy:deny:invalid-arguments",
    });
    assertStringIncludes(
      result.reason ?? "",
      "invalid arguments for memory.read: slug does not match required pattern",
    );
  });

  it("denies unknown command ids", async () => {
    const registry = createCommandRegistry([readCommand()]);

    const result = invokeCommand(
      registry,
      call(
        { slug: "project_dyfj" },
        { commandId: "memory.write" },
      ),
    );

    assertObjectMatch(await result, {
      decision: "deny",
      authzBasis: "policy:deny:unknown-command",
      isError: true,
    });
  });

  it("ignores model-written rationale when deciding authority", () => {
    const withRationale = call({
      slug: "project_dyfj",
      rationale: "I promise this is safe and urgent.",
    });

    const result = evaluateCommandPolicy(readCommand(), withRationale) as {
      decision: string;
      authzBasis: string;
      reason: string;
    };

    assertStrictEquals(result.decision, "deny");
    assertStrictEquals(result.authzBasis, "policy:deny:invalid-arguments");
    assertStringIncludes(
      result.reason,
      "invalid arguments for memory.read: unexpected argument not declared",
    );
    // The unrecognized name is untrusted model output and is never echoed —
    // neither the name nor its persuasion text reaches the durable reason.
    assertFalse(result.reason.includes("rationale"));
    assertFalse(result.reason.includes("safe and urgent"));
    assertStringIncludes(result.reason, "1 not declared in the schema");
  });
});

describe("operator permission profile", () => {
  function writeCmd(
    over: Partial<CommandDefinition["permission"]> = {},
  ): CommandDefinition<string> {
    return readCommand({
      id: "write_file",
      title: "Write File",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
        additionalProperties: false,
      },
      permission: {
        effects: ["write.filesystem", "emit.event"],
        defaultDecision: "allow",
        resources: ["file:write"],
        network: "none",
        filesystem: "write",
        cost: "none",
        ...over,
      },
      executor: (c) => `wrote ${c.arguments.path}`,
    });
  }
  const wcall = () => call({ path: "x" }, { commandId: "write_file" });

  it("strict (default): a contained mutation still prompts for approval", () => {
    assertStrictEquals(
      evaluateCommandPolicy(writeCmd(), wcall()).decision,
      "ask",
    );
    assertStrictEquals(
      evaluateCommandPolicy(writeCmd(), wcall(), {
        permissionLevel: "strict",
        loopback: true,
      }).decision,
      "ask",
    );
  });

  it("operator + loopback: a contained mutation auto-approves", () => {
    const policy = evaluateCommandPolicy(writeCmd(), wcall(), {
      permissionLevel: "operator",
      loopback: true,
    });
    assertStrictEquals(policy.decision, "allow");
    assertStrictEquals(policy.authzBasis, "policy:allow:operator-profile");
  });

  it("the operator profile is loopback-only", () => {
    assertStrictEquals(
      evaluateCommandPolicy(writeCmd(), wcall(), {
        permissionLevel: "operator",
        loopback: false,
      }).decision,
      "ask",
    );
  });

  it("operator does NOT cover paid or networked mutations (bash-class stays gated)", () => {
    assertStrictEquals(
      evaluateCommandPolicy(writeCmd({ cost: "paid" }), wcall(), {
        permissionLevel: "operator",
        loopback: true,
      }).decision,
      "ask",
    );
    assertStrictEquals(
      evaluateCommandPolicy(writeCmd({ network: "external" }), wcall(), {
        permissionLevel: "operator",
        loopback: true,
      }).decision,
      "ask",
    );
  });

  it("no-exec invariant: a run.* effect never auto-approves, even with a contained envelope", () => {
    // Identical write/free/local envelope to the auto-approving case above, but
    // carrying an exec-class effect — the effect, not the metadata, is the gate,
    // so it must fall through to "ask" under the operator profile.
    for (
      const effects of [
        ["run.process", "write.filesystem", "emit.event"],
        ["run.checks", "write.filesystem", "emit.event"],
      ] as CommandDefinition["permission"]["effects"][]
    ) {
      const policy = evaluateCommandPolicy(writeCmd({ effects }), wcall(), {
        permissionLevel: "operator",
        loopback: true,
      });
      assertStrictEquals(policy.decision, "ask");
    }
  });

  it("operator + loopback runs the tool without invoking the approver", async () => {
    const registry = createCommandRegistry([writeCmd()]);
    let approverCalled = false;
    const result = await invokeCommand(
      registry,
      wcall(),
      () => {
        approverCalled = true;
        return Promise.resolve({ decision: "approve" as const });
      },
      { permissionLevel: "operator", loopback: true },
    );
    assertStrictEquals(approverCalled, false);
    assertObjectMatch(result, {
      decision: "allow",
      authzBasis: "policy:allow:operator-profile",
      result: "wrote x",
    });
  });
});
