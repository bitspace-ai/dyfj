// Tests for the tool catalog (`catalog.ts`).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CommandCall } from "./definition.ts";
import { evaluateCommandPolicy } from "./policy.ts";
import { buildToolCatalog } from "./catalog.ts";
import { RootAnchors } from "./builtin/root-anchors.ts";
import { MapEnv } from "../../testing/fakes/map-env.ts";

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
    assert.deepStrictEqual(registry.list().map((c) => c.id), ["memory.read"]);
  });

  it("refuses to register the file tools without root anchors", () => {
    assert.throws(
      () => buildToolCatalog({}, { workspaceRoot: "/work" }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          "tool catalog: the workspace file tools need root anchors",
        ),
    );
  });

  it("registers the file tools when a workspace root is set", () => {
    const registry = buildToolCatalog({ rootAnchors: new RootAnchors() }, {
      workspaceRoot: "/work",
    });
    assert.deepStrictEqual(registry.list().map((c) => c.id).sort(), [
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
      call({ path: "package.json" }, { commandId: "read_file" }),
    );
    assert.strictEqual(result.decision, "allow");
  });

  it("registers memory.read as the first core command", () => {
    const registry = buildToolCatalog({
      readMemory: (slug) => Promise.resolve(`# ${slug}`),
    }, {});

    const memoryRead = registry.lookup("memory.read");
    assert.ok(memoryRead !== undefined && memoryRead !== null);
    assert.partialDeepStrictEqual(memoryRead, {
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
    assert.deepStrictEqual(memoryRead.permission.effects, [
      "read.memory",
      "emit.event",
    ]);
    assert.deepStrictEqual(memoryRead.permission.resources, ["memory:*"]);
    const projected = registry.projectTools()[0];
    assert.partialDeepStrictEqual(projected, {
      name: "memory.read",
      parameters: {
        required: ["slug"],
        additionalProperties: false,
      },
    });
    assert.deepStrictEqual(projected.parameters.required, ["slug"]);
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
    assert.deepStrictEqual(
      ["grep_files"].filter((item) => !names.includes(item)),
      [],
    );
    assert.deepStrictEqual(
      ["glob_files"].filter((item) => !names.includes(item)),
      [],
    );
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
      assert.strictEqual(result.decision, "allow");
      assert.strictEqual(result.authzBasis, "policy:allow:read-only-local");
    }

    const bash = registry.lookup("bash")!;
    assert.strictEqual(
      evaluateCommandPolicy(
        bash,
        call({ command: "ls" }, { commandId: "bash" }),
      ).decision,
      "ask",
    );
  });
});

// The engine's Env port, not the process environment, says whether the bash
// and git tools run in the isolated executor.
describe("buildToolCatalog executor wiring", () => {
  it("reads the executor socket from the env port it is given", () => {
    const registry = buildToolCatalog(
      {
        rootAnchors: new RootAnchors(),
        env: new MapEnv({ DYFJ_EXECUTOR_SOCKET: "/run/dyfj-exec/exec.sock" }),
      },
      { workspaceRoot: "/work" },
    );
    assert.match(registry.lookup("bash")!.description, /isolated executor/);
    assert.match(registry.lookup("git")!.description, /isolated executor/);
  });

  it("stays native when the env port holds no socket", () => {
    const registry = buildToolCatalog(
      { rootAnchors: new RootAnchors(), env: new MapEnv({}) },
      { workspaceRoot: "/work" },
    );
    assert.match(registry.lookup("bash")!.description, /NOT sandboxed/);
  });
});
