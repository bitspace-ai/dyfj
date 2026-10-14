// Tests for the `erasable.syntax` lane. Written to `node:` builtins only, as
// the lane is. The plugin runs for real: each fixture is linted by the same
// binary that runs this file.
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FAST_LANE_LABELS,
  productionLanes,
  REQUIRED_CHECK_IDS,
} from "./aggregate-test-gate.ts";
import {
  checkErasableSyntax,
  erasableSyntaxViolations,
  LABEL,
  LINT_CONFIG_PATH,
  lintParameterProperties,
} from "./erasable-syntax.ts";

const SCRIPTS = fileURLToPath(new URL(".", import.meta.url));
const RUNTIME = process.execPath;

const withRoot = (run: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "erasable-syntax-"));
  try {
    mkdirSync(join(root, "scripts"));
    for (
      const file of [
        "erasable-syntax-lint.json",
        "erasable-syntax-lint-plugin.ts",
      ]
    ) {
      copyFileSync(join(SCRIPTS, file), join(root, "scripts", file));
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

/** Lints one fixture and returns the lane's error lines for it. */
const violationsIn = (source: string): string[] => {
  let errors: string[] = [];
  withRoot((root) => {
    const file = join(root, "fixture.ts");
    writeFileSync(file, source);
    errors = erasableSyntaxViolations(
      lintParameterProperties(RUNTIME, root, [file]),
      root,
    );
  });
  return errors;
};

describe("the parameter-property rule", () => {
  it("flags each modifier, on one line or across line breaks", () => {
    const errors = violationsIn(`class Base {}
export class A extends Base {
  constructor(
    public a: string,
    private b: string,
    protected c: string,
    readonly d: string,
    public readonly e: string = "e",
    plain: string,
  ) {
    super();
    void plain;
  }
}
export class B extends Base {
  constructor(override readonly f: string) { super(); }
}
`);
    assert.deepEqual(
      errors.map((error) => error.split(":").slice(0, 2).join(":")),
      [
        "fixture.ts:4",
        "fixture.ts:5",
        "fixture.ts:6",
        "fixture.ts:7",
        "fixture.ts:8",
        "fixture.ts:16",
      ],
    );
    assert.match(errors[0], /constructor parameter property `a`/);
    assert.match(errors[4], /constructor parameter property `e`/);
  });

  it("passes explicit fields, private names and readonly types", () => {
    const errors = violationsIn(`export class C {
  readonly a: string;
  #b: number;
  private readonly c = 1;
  constructor(a: string, opts: { readonly b: number }, ...rest: readonly string[]) {
    this.a = a;
    this.#b = opts.b;
    void rest;
  }
}
export function f(readonlyName: string): string {
  return readonlyName;
}
`);
    assert.deepEqual(errors, []);
  });

  it("fails a file it cannot parse", () => {
    const errors = violationsIn("export class {\n");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /fixture\.ts: could not be parsed/);
  });
});

describe("erasableSyntaxViolations", () => {
  it("ignores other rules and orders by path and line", () => {
    const at = (filename: string, line: number, code: string) => ({
      filename,
      code,
      message: "x",
      range: { start: { line } },
    });
    const errors = erasableSyntaxViolations({
      diagnostics: [
        at("file:///repo/b.ts", 3, "erasable-syntax/parameter-property"),
        at("file:///repo/a.ts", 9, "erasable-syntax/parameter-property"),
        at("file:///repo/a.ts", 2, "erasable-syntax/parameter-property"),
        at("file:///repo/a.ts", 1, "other/rule"),
      ],
      errors: [],
    }, "/repo");
    assert.deepEqual(errors.map((error) => error.split(": ")[0]), [
      "a.ts:2",
      "a.ts:9",
      "b.ts:3",
    ]);
  });
});

describe("checkErasableSyntax", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env: {}, stdio: "pipe" });

  it("scans tracked .ts files only", () => {
    withRoot((root) => {
      git(root, "init", "--quiet");
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/clean.ts"), "export const a = 1;\n");
      writeFileSync(
        join(root, "src/notes.md"),
        "class A { constructor(public a: string) {} }\n",
      );
      git(root, "add", "src");
      // Untracked, so outside the lane.
      writeFileSync(
        join(root, "untracked.ts"),
        "export class A { constructor(public a: string) {} }\n",
      );
      const result = checkErasableSyntax(root, RUNTIME);
      assert.deepEqual(result.errors, []);
      // The copied plugin is untracked too; only src/clean.ts is scanned.
      assert.equal(
        result.report,
        `${LABEL}: 1 tracked .ts files scanned, 0 violations`,
      );
    });
  });

  it("fails on a tracked file with a parameter property", () => {
    withRoot((root) => {
      git(root, "init", "--quiet");
      writeFileSync(
        join(root, "a.ts"),
        "export class A {\n  constructor(private readonly a: string) {}\n}\n",
      );
      git(root, "add", "a.ts");
      const result = checkErasableSyntax(root, RUNTIME);
      assert.equal(result.errors.length, 1);
      assert.match(
        result.errors[0],
        /^a\.ts:2: constructor parameter property `a`/,
      );
      assert.equal(
        result.report,
        `${LABEL}: 1 tracked .ts files scanned, 1 violations`,
      );
    });
  });
});

describe("the gate wiring", () => {
  const lanes = productionLanes("/repo", "/fixtures/runtime/deno");
  const lane = lanes.find((candidate) => candidate.label.includes(LABEL));

  it("runs the lane under test.aggregate with read, git and lint grants", () => {
    assert.ok(lane, "erasable.syntax lane is missing");
    assert.equal(lane.checkId, "test.aggregate");
    assert.equal(lane.cwd, "/repo");
    assert.ok(lane.args.includes("scripts/erasable-syntax.ts"));
    assert.ok(lane.args.includes("--allow-read=/repo"));
    assert.ok(lane.args.includes("--allow-run=git,/fixtures/runtime/deno"));
    assert.ok(lane.args.includes("--deno=/fixtures/runtime/deno"));
    assert.equal(
      lane.args.some((arg) => arg.startsWith("--allow-write")),
      false,
    );
    assert.equal(lane.args.some((arg) => arg.startsWith("--allow-net")), false);
  });

  it("names the lint config the lane reads", () => {
    assert.equal(LINT_CONFIG_PATH, "scripts/erasable-syntax-lint.json");
  });

  it("adds no required check id", () => {
    assert.ok(!REQUIRED_CHECK_IDS.includes(LABEL));
  });

  it("is in the fast subset, as runtime.neutral is", () => {
    assert.ok(lane);
    assert.ok(FAST_LANE_LABELS.includes(lane.label));
  });
});
