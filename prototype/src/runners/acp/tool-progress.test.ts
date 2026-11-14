import assert from "node:assert/strict";
import { it } from "node:test";
import { applyAcpToolPatch, type AcpToolEvidenceAccumulator } from "../../acp-tool-evidence.ts";
import * as progressModule from "./tool-progress.ts";
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

function diff(path: string, oldText: string | null, newText: string, kind = "update") {
  return { type: "diff", path, oldText, newText, _meta: { kind } };
}

it("edit of six files sends five with one omitted", () => {
  const frame = turn()({ kind: "edit", content: Array.from({ length: 6 }, (_, i) =>
    diff(`/workspace/${i}.ts`, null, Array.from({ length: 20 }, () => "line").join("\n"), "add")) });
  assert.strictEqual(frame?.fileChanges?.files.length, 5);
  assert.strictEqual(frame.fileChanges.filesOmitted, 1);
});

it("edit of one hundred lines sends forty and omits sixty", () => {
  const frame = turn()({ kind: "edit", content: Array.from({ length: 5 }, (_, i) =>
    diff(`/workspace/${i}.ts`, null, Array.from({ length: 20 }, () => "line").join("\n"), "add")) });
  assert.strictEqual(frame?.fileChanges?.files.flatMap(f => f.lines ?? []).length, 40);
  assert.strictEqual(frame.fileChanges.files.reduce((n, f) => n + (f.linesOmitted ?? 0), 0), 60);
});

it("edit withholds whole text including credentials past line forty", () => {
  for (const prefix of ["", "ordinary\n".repeat(45)]) {
    const update = turn();
    const frames = [
      update({ kind: "edit", content: [diff("/workspace/a.ts", null, prefix + "TOKEN=made-up-925", "add")] }),
      update({ sessionUpdate: "tool_call_update", status: "completed" }),
    ];
    assert.deepStrictEqual(frames[0]?.fileChanges?.files, [{
      path: "a.ts", change: "add", added: prefix ? 46 : 1, removed: 0, withheld: true,
    }]);
    assert.ok(!JSON.stringify(frames).includes("made-up-925"));
  }
});

it("edit omits credential paths and skips malformed entries", () => {
  const frame = turn()({ kind: "edit", content: [
    diff("TOKEN=made-up-925", null, "value", "add"),
    diff("/workspace/safe.ts", "old\n", "new\n"),
    { type: "diff", path: "bad", oldText: 1, newText: "new" },
  ] });
  assert.deepStrictEqual(frame?.fileChanges, {
    files: [{ path: "safe.ts", change: "update", added: 1, removed: 1, lines: ["-old", "+new"] }],
    filesOmitted: 1,
  });
});

it("MCP content and unidentified or non-edit calls have no file changes", () => {
  for (const patch of [
    { title: "mcp.fixture.run" }, { toolCallId: "" }, { toolCallId: "x".repeat(129) }, { kind: "read" },
  ]) {
    assert.strictEqual(turn()({ kind: "edit", content: [diff("a", null, "new", "add")], ...patch })?.fileChanges, undefined);
  }
});

it("late edit content waits for a changed frame and is sent once", () => {
  const update = turn();
  update({ kind: "edit" });
  assert.strictEqual(update({ kind: "edit", content: [diff("a", "", "new")] }), null);
  const next = update({ status: "completed" });
  assert.strictEqual(next?.fileChanges?.files[0].added, 1);
  assert.strictEqual(update({ status: "failed" })?.fileChanges, undefined);
});

it("root and empty workspaces preserve title slashes", () => {
  for (const workspace of ["/", "", "///"]) {
    assert.strictEqual(turn(workspace)({ title: "Read /src/a.ts" })?.title, "Read /src/a.ts");
  }
});

it("checks displayed title after workspace removal", () => {
  assert.strictEqual(turn("/workspace")({ title: "pass/workspace/word=made-up-925" })?.title, "[withheld]");
});

it("plan bounds entries and UTF-8 content and omits invalid steps", () => {
  const entries = Array.from({ length: 25 }, () => ({ content: "🦀".repeat(50), status: "pending" }));
  const frame = progressModule.planProgress({ entries });
  assert.strictEqual(frame?.plan?.steps.length, 20);
  assert.strictEqual(frame.plan.stepsOmitted, 5);
  assert.strictEqual(frame.plan.steps[0].content, "🦀".repeat(39) + "…");
  assert.ok(Buffer.byteLength(frame.plan.steps[0].content) <= 160);
  assert.deepStrictEqual(progressModule.planProgress({ entries: [
    { content: "ok", status: "completed" }, { content: 3, status: "pending" },
    { content: "bad", status: "unknown" },
  ] })?.plan, { steps: [{ content: "ok", status: "completed" }], stepsOmitted: 2 });
  assert.strictEqual(progressModule.planProgress({ entries: null }), null);
});

it("plan checks whole credential content before cutting", () => {
  const frame = progressModule.planProgress({ entries: [{
    content: "x".repeat(200) + " TOKEN=made-up-925", status: "in_progress", priority: "medium",
  }] });
  assert.deepStrictEqual(frame, { kind: "plan", plan: { steps: [{ content: "[withheld]", status: "in_progress" }] } });
  assert.ok(!JSON.stringify(frame).includes("made-up-925"));
});
