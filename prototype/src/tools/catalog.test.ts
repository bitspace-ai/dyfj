// Tests for the tool catalog (`catalog.ts`).

import {
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertObjectMatch,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { CommandCall } from "./definition.ts";
import { evaluateCommandPolicy } from "./policy.ts";
import { buildToolCatalog } from "./catalog.ts";
import { RootAnchors } from "./builtin/root-anchors.ts";

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

describe("buildToolCatalog", () => {
  it("registers only memory.read without a workspace root", () => {
    const registry = buildToolCatalog({}, {});
    assertEquals(registry.list().map((c) => c.id), ["memory.read"]);
  });

  it("registers the file tools when a workspace root is set", () => {
    const registry = buildToolCatalog({ rootAnchors: new RootAnchors() }, {
      workspaceRoot: "/work",
    });
    assertEquals(registry.list().map((c) => c.id).sort(), [
      "bash",
      "edit_file",
      "git",
      "glob_files",
      "grep_files",
      "list_files",
      "memory.read",
      "read_file",
      "write_file",
    ]);
  });

  it("the registered file tools are read-only (auto-allowed)", () => {
    const registry = buildToolCatalog({ rootAnchors: new RootAnchors() }, {
      workspaceRoot: "/work",
    });
    const readFile = registry.lookup("read_file")!;
    const result = evaluateCommandPolicy(
      readFile,
      call({ path: "deno.json" }, { commandId: "read_file" }),
    );
    assertStrictEquals(result.decision, "allow");
  });

  it("registers memory.read as the first core command", () => {
    const registry = buildToolCatalog({
      readMemory: (slug) => Promise.resolve(`# ${slug}`),
    }, {});

    const memoryRead = registry.lookup("memory.read");
    assertExists(memoryRead);
    assertObjectMatch(memoryRead, {
      id: "memory.read",
      title: "Read Memory",
      permission: {
        effects: ["read.memory", "emit.event"],
        defaultDecision: "allow",
        resources: ["memory:*"],
        network: "local",
        filesystem: "none",
        cost: "none",
      },
    });
    // assertObjectMatch treats an expected array as a prefix; pin the exact
    // arrays so an added effect or resource still fails.
    assertEquals(memoryRead.permission.effects, ["read.memory", "emit.event"]);
    assertEquals(memoryRead.permission.resources, ["memory:*"]);
    const projected = registry.projectTools()[0];
    assertObjectMatch(projected, {
      name: "memory.read",
      parameters: {
        required: ["slug"],
        additionalProperties: false,
      },
    });
    assertEquals(projected.parameters.required, ["slug"]);
  });
});

describe("buildToolCatalog wiring", () => {
  // A command can be fully built, unit-tested, and policy-probed and still be
  // absent from the model's toolset, because unit tests and direct policy
  // probes both bypass buildToolCatalog — registration is a separate step
  // with nothing else asserting it. These two cover what the executor and
  // policy tests cannot: that the tools reach the MODEL, and that they
  // auto-approve once registered.
  it("the search tools reach the model as projected tools", () => {
    const registry = buildToolCatalog({ rootAnchors: new RootAnchors() }, {
      workspaceRoot: "/work",
    });

    const names = registry.projectTools().map((t) => t.name);
    assertArrayIncludes(names, ["grep_files"]);
    assertArrayIncludes(names, ["glob_files"]);
  });

  it("registered search tools auto-approve; bash still asks", () => {
    const registry = buildToolCatalog({ rootAnchors: new RootAnchors() }, {
      workspaceRoot: "/work",
    });

    for (const id of ["grep_files", "glob_files"]) {
      const cmd = registry.lookup(id)!;
      const result = evaluateCommandPolicy(
        cmd,
        call({ pattern: "x" }, { commandId: id }),
      );
      assertStrictEquals(result.decision, "allow");
      assertStrictEquals(result.authzBasis, "policy:allow:read-only-local");
    }

    const bash = registry.lookup("bash")!;
    assertStrictEquals(
      evaluateCommandPolicy(
        bash,
        call({ command: "ls" }, { commandId: "bash" }),
      ).decision,
      "ask",
    );
  });
});
