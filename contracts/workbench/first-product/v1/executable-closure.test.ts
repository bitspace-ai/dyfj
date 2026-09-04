import {
  type Corpus,
  formatDiagnostic,
  loadSchemaRegistry,
  validateCorpus,
} from "./validate.ts";
import { PROBE_FIXTURES } from "./oracle-probes.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function exactIds(prefix: string, count: number, width: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index + 1).padStart(width, "0")}`,
  );
}

Deno.test("the executable-closure manifest fixes the EC denominator", async () => {
  const manifest = JSON.parse(
    await Deno.readTextFile(
      new URL("./executable-closure-manifest.json", import.meta.url),
    ),
  );
  assert(manifest.denominator.targets === 24, "target denominator is not 24");
  assert(manifest.denominator.invariants === 61, "EC denominator is not 61");
  assert(manifest.denominator.probes === 31, "RP denominator is not 31");
  assert(
    JSON.stringify(manifest.invariants) ===
      JSON.stringify(exactIds("EC", 61, 3)),
    "manifest does not enumerate EC-001 through EC-061 exactly once",
  );
  const targetIds = manifest.targets.map((target: { id: string }) => target.id);
  assert(
    new Set(targetIds).size === 24,
    "target ids are missing or duplicated",
  );
  const probeIds = new Set(PROBE_FIXTURES.map((fixture) => fixture.id));
  assert(
    JSON.stringify([...probeIds]) === JSON.stringify(exactIds("RP", 31, 2)),
    "fixture catalog does not enumerate RP-01 through RP-31",
  );
  for (const id of ["RP-16", "RP-17", "RP-29"]) {
    const branches = PROBE_FIXTURES.filter((fixture) => fixture.id === id).map(
      (fixture) => fixture.branch,
    );
    assert(
      branches.includes("allowed") && branches.includes("forbidden"),
      `${id} does not carry separate allowed and forbidden fixtures`,
    );
  }
  assert(
    PROBE_FIXTURES.some((fixture) =>
      fixture.id === "RP-31" && fixture.expected === "accept"
    ),
    "RP-31 was promoted into a global one-Room rejection rule",
  );
});

Deno.test("preserved counterexample probes match their required dispositions", async () => {
  const baseline = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "./fixtures/positive/first-product-baseline.json",
        import.meta.url,
      ),
    ),
  ) as Corpus;
  const registry = await loadSchemaRegistry();
  const mismatches: string[] = [];
  for (const fixture of PROBE_FIXTURES) {
    const corpus = structuredClone(baseline);
    fixture.mutate(corpus);
    const result = validateCorpus(registry, corpus);
    const actual = result.accepted ? "accept" : "reject";
    if (actual !== fixture.expected) {
      const rules = result.rules.length === 0 ? "none" : result.rules.join(",");
      const diagnostics = result.diagnostics.length === 0
        ? "none"
        : result.diagnostics.map(formatDiagnostic).join("; ");
      mismatches.push(
        `${fixture.id}.${fixture.branch}: expected=${fixture.expected} actual=${actual} ec=${
          fixture.ec.join(",")
        } rules=${rules} diagnostics=${diagnostics}`,
      );
    }
  }
  assert(
    mismatches.length === 0,
    `counterexample oracle mismatch count=${mismatches.length}\n${
      mismatches.join("\n")
    }`,
  );
});
