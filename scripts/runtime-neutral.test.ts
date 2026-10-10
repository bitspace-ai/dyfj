// Tests for the `runtime.neutral` lane. Written to `node:` builtins only, as
// the lane is, so this file names the measured word nowhere in its own text.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  FAST_LANE_LABELS,
  productionLanes,
  REQUIRED_CHECK_IDS,
} from "./aggregate-test-gate.ts";
import {
  checkRuntimeNeutral,
  countReferences,
  EXCEPTIONS_PATH,
  formatReport,
  LABEL,
  runtimeNeutralViolations,
} from "./runtime-neutral.ts";

// The word the lane counts, built so this file never contains it itself.
const WORD = ["De", "no"].join("");
const call = (n: number) => `${WORD}.cwd();\n`.repeat(n);

const entry = (path: string, count: number, reason = "host API under S1") => ({
  path,
  count,
  reason,
});

describe("countReferences", () => {
  it("counts every occurrence, comments and strings included", () => {
    const source = `${call(2)}// ${WORD}.readTextFile is mentioned here\n` +
      `/* ${WORD}.env */\nconst s = "${WORD}";\n`;
    assert.equal(countReferences(source), 5);
  });

  it("counts each way the host object is reached", () => {
    const forms = [
      `globalThis.${WORD}?.x`,
      `(globalThis as any).${WORD}?.resolveDns`,
      `${WORD}["env"]`,
      `${WORD}?.env`,
      `stub(${WORD}, "x")`,
      `fn.bind(${WORD})`,
      `const { env } = ${WORD}`,
      `const d = ${WORD}`,
      `${WORD}`,
      `${WORD} is a runtime`,
    ];
    for (const form of forms) {
      assert.equal(countReferences(form), 1, form);
    }
  });

  it("counts the whole word only, not a longer identifier", () => {
    assert.equal(
      countReferences(`const ${WORD} = 1; ${WORD}ise.y; ${WORD}, x`),
      2,
    );
    for (const longer of [
      `${WORD}ise`,
      `my${WORD}`,
      `_${WORD}`,
      `${WORD}_x`,
      `$${WORD}`,
      `${WORD}$`,
      `${WORD}9`,
      `x.${WORD.toLowerCase()}`,
    ]) {
      assert.equal(countReferences(longer), 0, longer);
    }
  });
});

describe("runtimeNeutralViolations", () => {
  it("passes on an exact match", () => {
    const counts = new Map([["a.ts", 3], ["b.ts", 0]]);
    assert.deepEqual(
      runtimeNeutralViolations(counts, [entry("a.ts", 3)]),
      [],
    );
  });

  it("passes with no references and an empty list", () => {
    assert.deepEqual(runtimeNeutralViolations(new Map([["a.ts", 0]]), []), []);
  });

  it("fails a file with references and no entry", () => {
    const errors = runtimeNeutralViolations(new Map([["new.ts", 1]]), []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /new\.ts/);
    assert.match(errors[0], /no entry/);
  });

  it("fails growth over the recorded count", () => {
    const errors = runtimeNeutralViolations(
      new Map([["a.ts", 4]]),
      [entry("a.ts", 3)],
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /a\.ts/);
    assert.match(errors[0], /grew/);
  });

  it("fails a count below its entry until the entry is lowered", () => {
    const errors = runtimeNeutralViolations(
      new Map([["a.ts", 2]]),
      [entry("a.ts", 3)],
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /a\.ts/);
    assert.match(errors[0], /lower the entry to 2/);
  });

  it("fails an entry whose file has no references", () => {
    const errors = runtimeNeutralViolations(
      new Map([["a.ts", 0]]),
      [entry("a.ts", 3)],
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /remove the entry/);
  });

  it("fails an entry whose file is not tracked", () => {
    const errors = runtimeNeutralViolations(new Map(), [entry("gone.ts", 3)]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /gone\.ts/);
    assert.match(errors[0], /remove the entry/);
  });

  it("fails a malformed entry", () => {
    const malformed: unknown[] = [
      null,
      "a.ts",
      [],
      {},
      { path: "", count: 1, reason: "r" },
      { path: "a.ts", count: 1 },
      { path: "a.ts", count: 1, reason: "  " },
      { path: "a.ts", count: 0, reason: "r" },
      { path: "a.ts", count: -1, reason: "r" },
      { path: "a.ts", count: 1.5, reason: "r" },
      { path: "a.ts", count: "1", reason: "r" },
    ];
    for (const bad of malformed) {
      const errors = runtimeNeutralViolations(new Map(), [bad]);
      assert.equal(errors.length, 1, JSON.stringify(bad));
      assert.match(errors[0], /malformed/, JSON.stringify(bad));
    }
  });

  it("fails an entry listed twice", () => {
    const errors = runtimeNeutralViolations(
      new Map([["a.ts", 3]]),
      [entry("a.ts", 3), entry("a.ts", 3)],
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /listed twice/);
  });

  it("fails a list that is not an array", () => {
    for (const bad of [{}, null, "[]"]) {
      const errors = runtimeNeutralViolations(new Map(), bad);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /JSON array/);
    }
  });

  it("reports every violation, not just the first", () => {
    const errors = runtimeNeutralViolations(
      new Map([["new.ts", 1], ["grown.ts", 5]]),
      [entry("grown.ts", 2), entry("gone.ts", 1)],
    );
    assert.equal(errors.length, 3);
  });
});

describe("formatReport", () => {
  it("names the total and the number of files with references", () => {
    const counts = new Map([["a.ts", 3], ["b.ts", 0], ["c.ts", 2]]);
    assert.equal(
      formatReport(counts),
      `runtime.neutral: 5 ${WORD} references in 2 files`,
    );
  });

  it("says file, not files, when exactly one has references", () => {
    assert.equal(
      formatReport(new Map([["a.ts", 4], ["b.ts", 0]])),
      `runtime.neutral: 4 ${WORD} references in 1 file`,
    );
  });
});

describe("checkRuntimeNeutral", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env: {}, stdio: "pipe" });

  const withRepo = (
    files: Record<string, string>,
    exceptions: unknown,
    run: (root: string) => void,
  ) => {
    const root = mkdtempSync(join(tmpdir(), "runtime-neutral-"));
    try {
      git(root, "init", "--quiet");
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      git(root, "add", "--all");
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(
        join(root, EXCEPTIONS_PATH),
        JSON.stringify(exceptions, null, 2),
      );
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("counts tracked .ts files only", () => {
    withRepo(
      {
        "src/a.ts": call(2),
        "src/nested/b.ts": call(1),
        "notes.md": call(9),
        "src/data.json": call(9),
      },
      [entry("src/a.ts", 2), entry("src/nested/b.ts", 1)],
      (root) => {
        // Untracked, so outside the lane.
        writeFileSync(join(root, "untracked.ts"), call(7));
        const result = checkRuntimeNeutral(root);
        assert.deepEqual(result.errors, []);
        assert.equal(
          result.report,
          `runtime.neutral: 3 ${WORD} references in 2 files`,
        );
      },
    );
  });

  it("fails and still reports when a file is unlisted", () => {
    withRepo({ "src/a.ts": call(1) }, [], (root) => {
      const result = checkRuntimeNeutral(root);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0], /src\/a\.ts/);
      assert.equal(
        result.report,
        `runtime.neutral: 1 ${WORD} references in 1 file`,
      );
    });
  });

  it("reads a tracked file that was deleted from the work tree as absent", () => {
    withRepo({ "src/a.ts": call(1) }, [], (root) => {
      rmSync(join(root, "src/a.ts"));
      const result = checkRuntimeNeutral(root);
      assert.deepEqual(result.errors, []);
      assert.equal(
        result.report,
        `runtime.neutral: 0 ${WORD} references in 0 files`,
      );
    });
  });

  it("fails on a malformed exceptions file", () => {
    withRepo({ "src/a.ts": "export {};\n" }, { not: "an array" }, (root) => {
      const result = checkRuntimeNeutral(root);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0], /JSON array/);
    });
  });
});

describe("the gate wiring", () => {
  const lanes = productionLanes("/repo", "/fixtures/runtime/deno");
  const lane = lanes.find((candidate) => candidate.label.includes(LABEL));

  it("runs the lane under test.aggregate with a read-only git grant", () => {
    assert.ok(lane, "runtime.neutral lane is missing");
    assert.equal(lane.checkId, "test.aggregate");
    assert.equal(lane.cwd, "/repo");
    const args = lane.args.join(" ");
    assert.match(args, /scripts\/runtime-neutral\.ts/);
    assert.ok(lane.args.includes("--allow-read=/repo"));
    assert.ok(lane.args.includes("--allow-run=git"));
    assert.equal(
      lane.args.some((arg) => arg.startsWith("--allow-write")),
      false,
    );
    assert.equal(lane.args.some((arg) => arg.startsWith("--allow-net")), false);
  });

  it("adds no required check id", () => {
    assert.ok(!REQUIRED_CHECK_IDS.includes(LABEL));
  });

  it("is in the fast subset, as arch.imports is", () => {
    assert.ok(lane);
    assert.ok(FAST_LANE_LABELS.includes(lane.label));
  });
});
