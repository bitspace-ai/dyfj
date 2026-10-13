// Fixture tests for the test-dialect codemod (`deno-test-dialect.ts`). Each
// file under `fixtures/` holds a before text, the expected after text, the
// rules the conversion must apply and the findings it must report (lines in
// the after text). Optional `captured-import:` and `almost-equal-import:`
// lines give the specifiers the file would import the captured-assertion and
// almost-equal helpers from. Written to node: builtins only, like the tool, so
// this file never names the host runtime's global in its own text.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  almostEqualImportFor,
  capturedImportFor,
  type ConversionResult,
  convertSource,
  FLAGS,
  parseCliArgs,
  RULES,
} from "./deno-test-dialect.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const ROOT = join(HERE, "..", "..");

interface Fixture {
  name: string;
  rules: string[];
  capturedImport?: string;
  almostEqualImport?: string;
  before: string;
  after: string;
  findings: string[];
}

function parseFixture(name: string, text: string): Fixture {
  const sections = new Map<string, string[]>();
  const header: string[] = [];
  let current = header;
  for (const line of text.split("\n")) {
    const section = /^--- (before|after|findings)$/.exec(line);
    if (section) {
      current = [];
      sections.set(section[1], current);
    } else {
      current.push(line);
    }
  }
  const body = (key: string) => {
    const lines = sections.get(key);
    if (lines === undefined) throw new Error(`${name}: no "--- ${key}"`);
    return lines;
  };
  const rulesLine = header.find((line) => line.startsWith("rules:"));
  if (rulesLine === undefined) throw new Error(`${name}: no "rules:" line`);
  const headerValue = (key: string) =>
    header.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1)
      .trim();
  const capturedImport = headerValue("captured-import");
  const almostEqualImport = headerValue("almost-equal-import");
  return {
    name,
    rules: rulesLine.slice("rules:".length).split(",").map((rule) =>
      rule.trim()
    ).filter((rule) => rule !== ""),
    ...(capturedImport === undefined ? {} : { capturedImport }),
    ...(almostEqualImport === undefined ? {} : { almostEqualImport }),
    // The before and after sections end at the next marker; the newline
    // before that marker belongs to the text.
    before: body("before").join("\n") + "\n",
    after: body("after").join("\n") + "\n",
    findings: body("findings").filter((line) => line.trim() !== ""),
  };
}

const fixtures: Fixture[] = readdirSync(FIXTURES)
  .filter((file) => file.endsWith(".fixture"))
  .sort()
  .map((file) =>
    parseFixture(file, readFileSync(join(FIXTURES, file), "utf8"))
  );

function findingLines(result: ConversionResult): string[] {
  return result.findings.map((finding) =>
    [finding.kind, finding.flag, String(finding.line)]
      .filter((part) => part !== undefined).join(" ")
  );
}

function totalRewrites(result: ConversionResult): number {
  let total = 0;
  for (const count of result.rewrites.values()) total += count;
  return total;
}

describe("test-dialect codemod fixtures", () => {
  it("finds the fixtures", () => {
    assert.ok(fixtures.length > 0, `no fixtures under ${FIXTURES}`);
  });

  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      const options = {
        capturedImport: fixture.capturedImport,
        almostEqualImport: fixture.almostEqualImport,
      };
      const result = convertSource(fixture.before, options);

      it("converts the before text to the after text", () => {
        assert.equal(result.source, fixture.after);
      });

      it("reports the expected findings", () => {
        assert.deepEqual(findingLines(result), fixture.findings);
      });

      it("applies the rules it names, and only known rules", () => {
        for (const rule of fixture.rules) {
          assert.ok(
            (result.rewrites.get(rule) ?? 0) > 0,
            `rule ${rule} did not fire`,
          );
        }
        const known = new Set(RULES.map((rule) => rule.id));
        for (const rule of result.rewrites.keys()) {
          assert.ok(known.has(rule), `unknown rule ${rule}`);
          assert.ok(
            fixture.rules.includes(rule),
            `rule ${rule} fired but the fixture does not name it`,
          );
        }
      });

      it("is idempotent: a second run changes nothing", () => {
        const again = convertSource(result.source, options);
        assert.equal(again.source, result.source);
        assert.equal(totalRewrites(again), 0);
        assert.deepEqual(findingLines(again), findingLines(result));
      });
    });
  }

  it("maps finding lines back to the text before conversion", () => {
    const fixture = fixtures.find((f) => f.name === "errors.fixture")!;
    const [leftover] = convertSource(fixture.before).findings;
    assert.equal(leftover.line, 18);
    assert.equal(leftover.originalLine, 16);
    assert.match(fixture.before.split("\n")[15], /new \w+\.errors\.NotFound/);
  });

  it("imports the captured helper relative to a file under prototype/", () => {
    assert.equal(
      capturedImportFor(join(ROOT, "prototype/src/config/a.test.ts")),
      "../../testing/assertions/captured.ts",
    );
    assert.equal(
      capturedImportFor(join(ROOT, "prototype/testing/assertions/b.test.ts")),
      "./captured.ts",
    );
  });

  it("leaves a used thrown value flagged in a file outside prototype/", () => {
    const outside = join(ROOT, "scripts/x.test.ts");
    assert.equal(capturedImportFor(outside), undefined);
    const before = [
      'import { assertThrows } from "@std/assert";',
      "",
      'it("x", () => {',
      "  const error = assertThrows(() => boom());",
      "  void error;",
      "});",
      "",
    ].join("\n");
    const result = convertSource(before, {
      capturedImport: capturedImportFor(outside),
    });
    assert.equal(result.source, before);
    assert.deepEqual(findingLines(result), ["hand-review thrown-value-used 4"]);
  });

  it("imports the almost-equal helper relative to a file under prototype/", () => {
    assert.equal(
      almostEqualImportFor(join(ROOT, "prototype/src/budget/a.test.ts")),
      "../../testing/assertions/almost-equal.ts",
    );
    assert.equal(
      almostEqualImportFor(
        join(ROOT, "prototype/testing/assertions/b.test.ts"),
      ),
      "./almost-equal.ts",
    );
  });

  it("leaves assertAlmostEquals unconverted in a file outside prototype/", () => {
    const outside = join(ROOT, "scripts/x.test.ts");
    assert.equal(almostEqualImportFor(outside), undefined);
    const before = [
      'import { assertAlmostEquals } from "@std/assert";',
      "",
      'it("x", () => {',
      "  assertAlmostEquals(0.1 + 0.2, 0.3);",
      "});",
      "",
    ].join("\n");
    const result = convertSource(before, {
      almostEqualImport: almostEqualImportFor(outside),
    });
    assert.equal(result.source, before);
    assert.deepEqual(findingLines(result), ["unconverted 4"]);
  });

  it("parses its command line and rejects unknown options", () => {
    assert.deepEqual(parseCliArgs(["--write", "--json", "a", "b"]), {
      write: true,
      json: true,
      paths: ["a", "b"],
    });
    assert.deepEqual(parseCliArgs(["a"]), {
      write: false,
      json: false,
      paths: ["a"],
    });
    assert.throws(() => parseCliArgs(["--wirte", "a"]), /--wirte/);
    assert.throws(() => parseCliArgs([]), /usage/);
  });

  it("has a fixture for every rule", () => {
    const named = new Set(fixtures.flatMap((fixture) => fixture.rules));
    const missing = RULES.map((rule) => rule.id).filter((id) => !named.has(id));
    assert.deepEqual(missing, []);
  });

  it("has a fixture for every hand-review flag", () => {
    const flagged = new Set(
      fixtures.flatMap((fixture) =>
        fixture.findings.filter((line) => line.startsWith("hand-review "))
          .map((line) => line.split(" ")[1])
      ),
    );
    const missing = Object.keys(FLAGS).filter((flag) => !flagged.has(flag));
    assert.deepEqual(missing, []);
  });
});
