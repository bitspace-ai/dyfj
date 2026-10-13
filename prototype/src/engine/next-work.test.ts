import assert from "node:assert/strict";
import {
  buildNextWorkBrief,
  printNextWorkResult,
  validateNextWorkJson,
} from "./next-work.ts";

Deno.test("buildNextWorkBrief: requests strict JSON for the next-work worklet without private context", () => {
  const brief = buildNextWorkBrief({
    workletId: "next-work.v0",
    contextProfile: "compact",
    prompt: "what should I work on next here?",
  });

  assert.ok(
    brief.includes("worklet_id: next-work.v0"),
    `expected ${JSON.stringify(brief)} to include "worklet_id: next-work.v0"`,
  );
  assert.ok(
    brief.includes("context_profile: compact"),
    `expected ${JSON.stringify(brief)} to include "context_profile: compact"`,
  );
  assert.ok(
    brief.includes("Return strict JSON only"),
    `expected ${JSON.stringify(brief)} to include "Return strict JSON only"`,
  );
  assert.ok(
    brief.includes('"recommendation"'),
    `expected ${JSON.stringify(brief)} to include '"recommendation"'`,
  );
  assert.ok(
    brief.includes('"confidence"'),
    `expected ${JSON.stringify(brief)} to include '"confidence"'`,
  );
});

Deno.test("validateNextWorkJson: accepts a complete strict JSON next-work result", () => {
  const result = validateNextWorkJson(JSON.stringify({
    worklet_id: "next-work.v0",
    context_profile: "compact",
    recommendation: "Work the next-work routing slice next.",
    rationale: "It is the ready routing experiment slice.",
    evidence: ["notes/workbench-model-routing-mvp.md"],
    risks: ["Local model output may drift."],
    next_commands: ["deno task test"],
    confidence: "medium",
  }));

  assert.deepStrictEqual(result, {
    ok: true,
    value: {
      worklet_id: "next-work.v0",
      context_profile: "compact",
      recommendation: "Work the next-work routing slice next.",
      rationale: "It is the ready routing experiment slice.",
      evidence: ["notes/workbench-model-routing-mvp.md"],
      risks: ["Local model output may drift."],
      next_commands: ["deno task test"],
      confidence: "medium",
    },
    errors: [],
  });
});

Deno.test("validateNextWorkJson: rejects prose or incomplete JSON before trusting the model result", () => {
  assert.deepStrictEqual(
    validateNextWorkJson("Work on the routing item next."),
    {
      ok: false,
      errors: ["model output was not strict JSON"],
    },
  );

  const incomplete = validateNextWorkJson(JSON.stringify({
    worklet_id: "next-work.v0",
    context_profile: "compact",
    recommendation: "Work the next-work routing slice next.",
  }));

  assert.deepStrictEqual(incomplete, {
    ok: false,
    errors: [
      "missing required field: rationale",
      "missing required field: evidence",
      "missing required field: risks",
      "missing required field: next_commands",
      "missing required field: confidence",
    ],
  });
});

Deno.test("printNextWorkResult presents a valid result and the raw output of an invalid one", () => {
  const lines: string[] = [];
  const log = (...parts: unknown[]) => void lines.push(parts.join(" "));
  printNextWorkResult(
    { ok: false, errors: ["missing required field: risks"] },
    "raw model text",
    log,
  );
  assert.deepStrictEqual(lines, [
    "Next-work validation failed",
    "- missing required field: risks",
    "",
    "Raw model output:",
    "raw model text",
  ]);
  lines.length = 0;
  printNextWorkResult(
    {
      ok: true,
      errors: [],
      value: {
        worklet_id: "next-work.v0",
        context_profile: "compact",
        recommendation: "Ship it.",
        rationale: "Ready.",
        evidence: [],
        risks: ["one"],
        next_commands: [],
        confidence: "high",
      },
    },
    "{}",
    log,
  );
  assert.deepStrictEqual(lines, [
    "Next work",
    "Recommendation: Ship it.",
    "Rationale: Ready.",
    "Confidence: high",
    "Risks:",
    "- one",
  ]);
});
