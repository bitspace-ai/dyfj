// The multiset comparison behind the per-file Node handle check.
import assert from "node:assert/strict";
import { test } from "node:test";
import { leakedResources, leakReport } from "./node-handle-leaks.ts";

test("only resources beyond the load-time baseline are leaks", () => {
  // The runner's own IPC pipes are live at load and at the end.
  const baseline = ["PipeWrap", "PipeWrap"];
  assert.deepEqual(leakedResources(baseline, ["PipeWrap", "PipeWrap"]), []);
  assert.deepEqual(leakedResources(baseline, ["PipeWrap"]), []);
  assert.deepEqual(
    leakedResources(baseline, [
      "Timeout",
      "PipeWrap",
      "TCPServerWrap",
      "PipeWrap",
      "PipeWrap",
    ]),
    ["PipeWrap", "TCPServerWrap", "Timeout"],
  );
});

test("the report names the file and each leaked type", () => {
  assert.equal(
    leakReport("/repo/src/a.test.ts", ["ProcessWrap", "Timeout"]),
    "dyfj node handle check: /repo/src/a.test.ts left 2 resource(s) live " +
      "after its tests: ProcessWrap, Timeout. Close every server, socket, " +
      "timer and child process a test starts before it ends.",
  );
});
