import assert from "node:assert/strict";
import { it } from "node:test";
import { applyAcpToolPatch, type AcpToolEvidenceAccumulator } from "../../acp-tool-evidence.ts";
import { toolCallProgress, type ToolProgressState } from "./tool-progress.ts";

function turn(workspace = "/workspace") {
  const evidence: AcpToolEvidenceAccumulator = { entries: [], calls: new Map() };
  const states = new Map<string, ToolProgressState>();
  return (patch: Record<string, unknown>) => {
    const update = { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Run command", status: "in_progress", ...patch };
    applyAcpToolPatch(evidence, update);
    return toolCallProgress(update, evidence, states, workspace);
  };
}

it("omits the workspace directory with either trailing slash", () => {
  for (const workspace of ["/workspace", "/workspace/"]) {
    for (const cwd of ["/workspace", "/workspace/"]) {
      assert.strictEqual(turn(workspace)({ rawInput: { command: "pwd", cwd } })?.cwd, undefined);
    }
  }
});

it("retains a command directory outside the workspace", () => {
  assert.strictEqual(turn()({ rawInput: { command: "pwd", cwd: "/elsewhere" } })?.cwd, "/elsewhere");
});

it("makes interior locations relative without resolving paths", () => {
  for (const workspace of ["/workspace", "/workspace/"]) {
    assert.deepStrictEqual(turn(workspace)({ locations: [{ path: "/workspace/CHANGELOG.md" }] })?.locations, ["CHANGELOG.md"]);
  }
  assert.deepStrictEqual(turn("/")({ locations: [{ path: "/CHANGELOG.md" }] })?.locations, ["CHANGELOG.md"]);
});

it("retains outside equal and parent-component locations", () => {
  for (const path of ["/elsewhere/file", "/workspace-other/file", "/workspace", "/workspace/", "/workspace/a/../file", "a/../file"]) {
    assert.deepStrictEqual(turn()({ locations: [{ path }] })?.locations, [path]);
  }
});

it("removes every workspace prefix from displayed titles", () => {
  for (const workspace of ["/workspace", "/workspace/"]) {
    assert.strictEqual(turn(workspace)({ title: "Read '/workspace/CHANGELOG.md' and '/workspace/README.md'" })?.title, "Read 'CHANGELOG.md' and 'README.md'");
  }
});

it("detects title changes using the received title", () => {
  const update = turn();
  update({ title: "Read '/workspace/README.md'" });
  const changed = update({ sessionUpdate: "tool_call_update", title: "Read 'README.md'" });
  assert.ok(changed);
  assert.strictEqual(changed.title, "Read 'README.md'");
});

const credential = "made-up-value-925";
const commands = [String.raw`TOKEN=\"${credential}\"`, String.raw`{\"password\":\"${credential}\"}`, String.raw`pass\word=${credential}`];
for (const [index, command] of commands.entries()) {
  it(`withholds credential-shaped display values case ${index + 1}`, () => {
    const update = turn();
    const frames = [
      update({ title: command, name: command, kind: command, rawInput: { command, cwd: "/elsewhere" }, locations: [{ path: "README.md" }] }),
      update({ sessionUpdate: "tool_call_update", title: command, status: "completed" }),
    ];
    assert.strictEqual(frames[0]?.inputWithheld, true);
    for (const frame of frames) {
      assert.strictEqual(frame?.title, "[withheld]");
      assert.strictEqual(frame?.name, "[withheld]");
      for (const field of ["input", "cwd", "locations", "toolKind"] as const) assert.strictEqual(frame?.[field], undefined);
    }
    assert.ok(!JSON.stringify(frames).includes(credential));
  });
}

it("checks full directory and location values before workspace shortening", () => {
  for (const value of commands) {
    const workspace = `/workspace/ ${value}`;
    for (const patch of [
      { rawInput: { command: "pwd", cwd: workspace } },
      { locations: [{ path: `${workspace}/README.md` }] },
      { locations: [{ path: "one" }, { path: "two" }, { path: "three" }, { path: "x".repeat(250) + " " + value }] },
    ]) {
      const frame = turn(workspace)(patch);
      assert.strictEqual(frame?.inputWithheld, true);
      for (const field of ["input", "cwd", "locations"] as const) assert.strictEqual(frame?.[field], undefined);
    }
    assert.strictEqual(turn(workspace)({ title: `Read '${workspace}/README.md'` })?.title, "[withheld]");
  }
});

for (const [label, toolCallId] of [["empty", ""], ["oversized", "x".repeat(129)], ["credential-shaped", "sk-" + "a".repeat(24)]]) {
  it(`omits summaries for ${label} call IDs across MCP updates`, () => {
    const update = turn();
    const frames = [
      update({ toolCallId, title: "mcp.fixture.read", rawInput: { server: "fixture", tool: "read", arguments: {} } }),
      update({ sessionUpdate: "tool_call_update", toolCallId, title: undefined, status: undefined, locations: [{ path: "/workspace/README.md" }] }),
      update({ sessionUpdate: "tool_call_update", toolCallId, title: undefined, rawInput: { command: commands[0], cwd: "/elsewhere" } }),
    ];
    for (const frame of frames) {
      assert.ok(frame);
      for (const field of ["toolCallId", "input", "cwd", "locations", "inputWithheld"] as const) assert.strictEqual(frame[field], undefined);
    }
  });
}
