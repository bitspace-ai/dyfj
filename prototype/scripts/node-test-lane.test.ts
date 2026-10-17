// The Node half of the test lanes (`node-test-lane.ts`): its version gate,
// arguments and count reporting. Runs nothing; the integration case
// `node-handle-check.integration.test.ts` runs real files.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatNodeSummary,
  HANDLE_CHECK_URL,
  nameFilterPattern,
  nodeTestArgs,
  nodeVersionProblem,
  parseTapSummary,
  requireNode,
  startNodeTests,
} from "./node-test-lane.ts";

const SUMMARY = [
  "1..3",
  "# tests 3",
  "# suites 1",
  "# pass 2",
  "# fail 1",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 35.0",
].join("\n");

test("only Node 26 runs the Node lanes", () => {
  assert.equal(nodeVersionProblem("v26.11.1\n"), undefined);
  assert.equal(nodeVersionProblem("v26.0.0"), undefined);
  assert.match(
    nodeVersionProblem(undefined) ?? "",
    /needs `node` on PATH, and none ran; install Node 26/,
  );
  assert.match(
    nodeVersionProblem("v24.4.0") ?? "",
    /needs Node 26, but `node --version` reported "v24.4.0"; install Node 26/,
  );
  assert.match(nodeVersionProblem("garbage") ?? "", /needs Node 26/);
  assert.throws(() => requireNode(() => "v22.1.0"), /needs Node 26/);
  assert.doesNotThrow(() => requireNode(() => "v26.11.1"));
});

test("node --test runs with the handle check, the lane's jobs and TAP", () => {
  assert.deepEqual(nodeTestArgs(["a.test.ts", "b.test.ts"], { jobs: 4 }), [
    "--test",
    `--import=${HANDLE_CHECK_URL}`,
    "--test-concurrency=4",
    "--test-reporter=tap",
    "a.test.ts",
    "b.test.ts",
  ]);
  assert.ok(HANDLE_CHECK_URL.endsWith("/testing/node-handle-check.ts"));
  assert.deepEqual(
    nodeTestArgs(["a.test.ts"], { jobs: 1, filter: "a.b" }).at(-2),
    "--test-name-pattern=a\\.b",
  );
});

test("a test:file filter is a substring unless written as /regex/", () => {
  assert.equal(nameFilterPattern("round trip (x)"), "round trip \\(x\\)");
  assert.equal(nameFilterPattern("/^round/"), "^round");
  assert.equal(nameFilterPattern("/"), "/");
});

test("the TAP summary is parsed from the closing unindented lines", () => {
  const tap = [
    "TAP version 13",
    "# Subtest: suite",
    "    # tests 99",
    "    ok 1 - inner",
    "not ok 1 - suite",
    SUMMARY,
  ].join("\n");
  assert.deepEqual(parseTapSummary(tap), {
    tests: 3,
    suites: 1,
    pass: 2,
    fail: 1,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  });
  assert.equal(
    parseTapSummary("TAP version 13\nok 1 - a\n# tests 1"),
    undefined,
  );
});

test("the count line reads like the existing runner's and names the files", () => {
  const summary = parseTapSummary(SUMMARY)!;
  assert.equal(
    formatNodeSummary("test.unit", 2, summary),
    "test.unit node --test: FAILED | 2 passed | 1 failed | 0 skipped | " +
      "0 todo | 0 cancelled (3 tests, 1 suites, 2 files)",
  );
  assert.match(
    formatNodeSummary("test.unit", 1, { ...summary, fail: 0, pass: 3 }),
    /^test\.unit node --test: ok \| 3 passed \| 0 failed/,
  );
});

test("an empty Node subset is skipped and reported as 0 files", async () => {
  const lines: string[] = [];
  const run = startNodeTests({
    lane: "test.golden",
    files: [],
    cwd: ".",
    env: {},
    jobs: 1,
    log: (line) => lines.push(line),
  });
  assert.equal(await run.code, 0);
  assert.deepEqual(lines, ["test.golden node --test: 0 files"]);
});
