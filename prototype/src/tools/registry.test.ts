// Tests for the command registry (`registry.ts`).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CommandDefinition } from "./definition.ts";
import { createCommandRegistry } from "./registry.ts";

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

describe("createCommandRegistry", () => {
  it("registers, looks up, and lists static command definitions", () => {
    const registry = createCommandRegistry();
    const command = readCommand();

    registry.register(command);

    assert.strictEqual(registry.lookup("memory.read"), command);
    assert.deepStrictEqual(registry.list(), [command]);
  });

  it("rejects duplicate command ids", () => {
    const registry = createCommandRegistry();
    registry.register(readCommand());

    assert.throws(
      () => registry.register(readCommand()),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("Command already registered: memory.read"),
    );
  });

  it("projects registered commands into model-facing tool schemas", () => {
    const registry = createCommandRegistry([readCommand()]);

    assert.deepStrictEqual(registry.projectTools(), [
      {
        name: "memory.read",
        description: "Load one Dolt-backed memory by slug.",
        parameters: {
          type: "object",
          required: ["slug"],
          properties: {
            slug: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" },
          },
          additionalProperties: false,
        },
      },
    ]);
  });
});
