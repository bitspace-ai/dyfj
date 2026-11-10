// Tests for the native file tools over the workspace and added roots
// (`multi-root.ts`, wired by `buildToolCatalog`): the `root` argument picks
// the root, a read-only root refuses writes, and each root keeps its own
// containment, so a path out of every root is refused.

import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AdmittedAdditionalRoot } from "../../contract/mod.ts";
import { buildToolCatalog } from "../catalog.ts";
import type {
  CommandCall,
  CommandDefinition,
  CommandExecutionContext,
} from "../definition.ts";
import { validateCommandArguments } from "../validate.ts";
import { RootAnchors } from "./root-anchors.ts";
import { multiRootTool } from "./multi-root.ts";

let base: string;
let workspace: string;
let writable: string;
let readable: string;
let outside: string;
let roots: AdmittedAdditionalRoot[];

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "dyfj-multi-root-")));
  workspace = join(base, "workspace");
  writable = join(base, "worktree");
  readable = join(base, "reference");
  outside = join(base, "outside");
  for (const dir of [workspace, writable, readable, outside]) mkdirSync(dir);
  await writeFile(join(workspace, "w.txt"), "in the workspace\n");
  await writeFile(join(writable, "a.txt"), "in the worktree\n");
  await writeFile(join(readable, "r.txt"), "for reference\n");
  // A synthetic canary standing in for a linked prototype/.env.
  await writeFile(join(outside, ".env"), "CANARY_TOKEN=not-a-secret\n");
  await symlink(join(outside, ".env"), join(writable, ".env"));
  roots = [
    { name: "worktree", path: writable, readOnly: false },
    { name: "reference", path: readable, readOnly: true },
  ];
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

const context = { authzBasis: "test" } as CommandExecutionContext;

function catalog() {
  return buildToolCatalog({ rootAnchors: new RootAnchors() }, {
    workspaceRoot: workspace,
    additionalRoots: roots,
  });
}

function tool(id: string): CommandDefinition {
  const command = catalog().lookup(id);
  assert.ok(command, `${id} is registered`);
  return command;
}

function call(commandId: string, args: Record<string, unknown>): CommandCall {
  return {
    commandId,
    callId: "call-1",
    caller: { principalId: "operator", principalType: "human" },
    arguments: args,
  };
}

async function run(id: string, args: Record<string, unknown>) {
  const command = tool(id);
  const problem = validateCommandArguments(command.inputSchema, args);
  assert.strictEqual(problem, null, `arguments for ${id} validate`);
  const refused = await command.precheck?.(call(id, args));
  if (refused) return { refused };
  return { result: String(await command.executor(call(id, args), context)) };
}

describe("file tools over added roots", () => {
  it("offers the added roots by name in each file tool's schema", () => {
    for (
      const id of [
        "read_file",
        "list_files",
        "grep_files",
        "glob_files",
        "write_file",
        "edit_file",
      ]
    ) {
      const property = tool(id).inputSchema.properties?.root;
      assert.deepStrictEqual(property?.enum, ["worktree", "reference"], id);
    }
  });

  it("leaves bash and git on the workspace", () => {
    assert.strictEqual(tool("bash").inputSchema.properties?.root, undefined);
    assert.strictEqual(tool("git").inputSchema.properties?.root, undefined);
  });

  it("reads the workspace without root, and an added root with it", async () => {
    assert.match((await run("read_file", { path: "w.txt" })).result!, /in the workspace/);
    assert.match(
      (await run("read_file", { path: "a.txt", root: "worktree" })).result!,
      /in the worktree/,
    );
    assert.match(
      (await run("read_file", { path: "r.txt", root: "reference" })).result!,
      /for reference/,
    );
  });

  it("writes to a read-write root", async () => {
    const { result } = await run("write_file", {
      path: "new.txt",
      content: "written\n",
      root: "worktree",
    });
    assert.doesNotMatch(result!, /^error/);
    assert.strictEqual(await readFile(join(writable, "new.txt"), "utf8"), "written\n");
  });

  it("refuses writes and edits to a read-only root before the prompt", async () => {
    const write = await run("write_file", {
      path: "r.txt",
      content: "overwritten\n",
      root: "reference",
    });
    assert.strictEqual(write.refused, "root reference is read-only");
    const edit = await run("edit_file", {
      path: "r.txt",
      old_string: "for",
      new_string: "against",
      root: "reference",
    });
    assert.strictEqual(edit.refused, "root reference is read-only");
    // The executor refuses too, for a call that skipped the precheck.
    const direct = await tool("write_file").executor(
      call("write_file", { path: "r.txt", content: "x", root: "reference" }),
      context,
    );
    assert.strictEqual(direct, "error: root reference is read-only");
    assert.strictEqual(await readFile(join(readable, "r.txt"), "utf8"), "for reference\n");
  });

  it("refuses a root that is not one of the session's", () => {
    const problem = validateCommandArguments(tool("read_file").inputSchema, {
      path: "a.txt",
      root: "outside",
    });
    assert.notStrictEqual(problem, null);
  });

  it("refuses a path out of every root", async () => {
    for (const root of [undefined, "worktree", "reference"]) {
      const args = { path: "../outside/.env", ...(root ? { root } : {}) };
      const { result } = await run("read_file", args);
      assert.match(result!, /^error/);
      assert.doesNotMatch(result!, /CANARY/);
    }
    const { result } = await run("write_file", {
      path: "../outside/new.txt",
      content: "x",
      root: "worktree",
    });
    assert.match(result!, /^error/);
  });

  it("does not follow a symlink in an added root to a file outside it", async () => {
    const { result } = await run("read_file", { path: ".env", root: "worktree" });
    assert.match(result!, /^error/);
    assert.doesNotMatch(result!, /CANARY/);
    const grep = await run("grep_files", { pattern: "CANARY", root: "worktree" });
    assert.doesNotMatch(grep.result!, /CANARY_TOKEN=/);
  });

  it("names the root in the approval title", () => {
    assert.match(
      tool("write_file").approvalTitle!(
        call("write_file", { path: "x", content: "y", root: "worktree" }),
      ),
      /\(root worktree\)$/,
    );
  });

  it("returns the tool unchanged without added roots", () => {
    const primary = buildToolCatalog({ rootAnchors: new RootAnchors() }, {
      workspaceRoot: workspace,
    }).lookup("read_file")!;
    assert.strictEqual(primary.inputSchema.properties?.root, undefined);
    assert.strictEqual(multiRootTool(primary, [], false), primary);
  });
});
