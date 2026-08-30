import {
  canonicalJson,
  computeEvidenceDigest,
  MANDATORY_CHECK_IDS,
  MODEL_FAMILIES,
  POLICY_IDS,
  RISK_CLASSES,
  validateReceipt,
  type ValidationOptions,
} from "./assurance-receipt.ts";

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const SUBJECT_SHA = "a".repeat(40);
const NOW_MS = Date.parse("2026-08-29T12:00:00Z");

// The complete mandatory floor, every check executed, passing, and required
// — the smallest checks object a conforming `repository.required_checks`
// receipt can carry.
function floorExecuted(
  result: (id: string) => "pass" | "fail" | "warn" = () => "pass",
  required: (id: string) => boolean = () => true,
): Record<string, unknown>[] {
  return MANDATORY_CHECK_IDS.map((id) => ({
    id,
    result: result(id),
    required: required(id),
  }));
}

// A minimal conforming v1 receipt. `mutate` edits the payload before the
// evidence digest is (by default) recomputed, so structural tests exercise
// the target rule rather than tripping the digest check.
async function makeReceipt(
  mutate: (receipt: Record<string, unknown>) => void = () => {},
  resealDigest = true,
): Promise<Record<string, unknown>> {
  const receipt: Record<string, unknown> = {
    schema: "dyfj.assurance.receipt",
    version: 1,
    receipt_id: "receipt-fixture-0001",
    policy: { id: "repository.required_checks", version: 1 },
    subject: {
      kind: "git-commit",
      ref: SUBJECT_SHA,
      digest: { algorithm: "sha1", value: SUBJECT_SHA },
    },
    work_unit: "work-unit-fixture",
    actor: { kind: "operator", ref: "operator-fixture" },
    runner: { id: "gate-fixture", revision: SUBJECT_SHA },
    decision: "allow",
    // Even when independence is not required, every field is stated with an
    // explicit bounded sentinel rather than omitted.
    independence: {
      required: false,
      status: "unknown",
      observed_by: "runner-observed",
      implementer_family: "none",
      verifier_family: "none",
    },
    risk_classes: [],
    findings: [],
    checks: {
      executed: floorExecuted(),
      skipped: [],
      unavailable: [],
      failed: [],
    },
    source_revision: { repository: "dyfj", revision: SUBJECT_SHA },
    tool_revision: { id: "aggregate-test-gate", revision: SUBJECT_SHA },
    redaction: {
      posture: "evidence.value_free",
      matched_values_recorded: false,
      reason_values_recorded: false,
    },
    occurred_at: "2026-08-29T11:59:00Z",
    trace_refs: [],
    evidence_digest: { algorithm: "sha256", value: "0".repeat(64) },
    known_unknowns: [],
    degraded_conditions: [],
  };
  mutate(receipt);
  if (resealDigest) {
    receipt.evidence_digest = await computeEvidenceDigest(receipt);
  }
  return receipt;
}

async function expectViolation(
  mutate: (receipt: Record<string, unknown>) => void,
  violation: string,
  options: ValidationOptions = {},
): Promise<void> {
  const receipt = await makeReceipt(mutate);
  const result = await validateReceipt(receipt, options);
  if (result.valid) {
    throw new Error(`expected ${violation}, receipt validated`);
  }
  if (!result.violations.includes(violation)) {
    throw new Error(
      `expected ${violation}, got ${JSON.stringify(result.violations)}`,
    );
  }
}

Deno.test("a conforming v1 receipt validates", async () => {
  const result = await validateReceipt(await makeReceipt(), {
    verifiedSubjectDigest: SUBJECT_SHA,
    nowMs: NOW_MS,
    maxAgeMs: 60 * 60_000,
  });
  assertEquals(result, { valid: true, violations: [] });
});

Deno.test("non-object payloads are rejected", async () => {
  for (const payload of [null, "receipt", 7, ["x"]]) {
    const result = await validateReceipt(payload);
    assertEquals(result.valid, false);
  }
});

Deno.test("wrong schema and unsupported versions are rejected", async () => {
  await expectViolation((r) => {
    r.schema = "other.schema";
  }, "receipt.schema/wrong-schema");
  await expectViolation((r) => {
    r.version = 2;
  }, "receipt.schema/unsupported-version");
  await expectViolation((r) => {
    r.version = "1";
  }, "receipt.schema/unsupported-version");
});

Deno.test("every absent required field is rejected", async () => {
  const receipt = await makeReceipt();
  for (const field of Object.keys(receipt)) {
    if (field === "evidence_digest") continue;
    const result = await validateReceipt(
      await makeReceipt((r) => {
        delete r[field];
      }),
    );
    if (result.valid) {
      throw new Error(`receipt without ${field} validated`);
    }
    if (!result.violations.includes(`receipt.schema/missing:${field}`)) {
      throw new Error(`missing ${field} not reported`);
    }
  }
});

Deno.test("unknown top-level fields are rejected without echo", async () => {
  const hostile = "\x1b[2Jhostile-payload";
  const receipt = await makeReceipt((r) => {
    r[hostile] = "smuggled";
  });
  const result = await validateReceipt(receipt);
  assertEquals(result.valid, false);
  const flattened = result.violations.join("|");
  if (flattened.includes("hostile") || flattened.includes("smuggled")) {
    throw new Error("hostile field content reached violations");
  }
  if (!result.violations.includes("receipt.schema/unknown-field")) {
    throw new Error("unknown field not reported");
  }
});

Deno.test("unknown decision values are rejected", async () => {
  await expectViolation((r) => {
    r.decision = "approve";
  }, "receipt.schema/unknown-decision");
});

Deno.test("mutable-only subject references are rejected", async () => {
  for (const ref of ["HEAD", "refs/heads/main", "main-branch-tip"]) {
    await expectViolation((r) => {
      (r.subject as Record<string, unknown>).ref = ref;
    }, "receipt.schema/mutable-subject-ref");
  }
  // A ref carrying some other commit hex is immutable-shaped but not bound
  // to the supplied digest, so it is still rejected.
  await expectViolation((r) => {
    (r.subject as Record<string, unknown>).ref = "b".repeat(40);
  }, "receipt.schema/mutable-subject-ref");
});

Deno.test("every subject kind requires a digest-bound immutable ref", async () => {
  const digest64 = "c".repeat(64);
  for (
    const kind of ["diff", "file", "artifact", "command", "deployment"]
  ) {
    await expectViolation((r) => {
      r.subject = {
        kind,
        ref: "release-latest",
        digest: { algorithm: "sha256", value: digest64 },
      };
    }, "receipt.schema/mutable-subject-ref");
    const bound = await makeReceipt((r) => {
      r.subject = {
        kind,
        ref: `${kind}-fixture@sha256:${digest64}`,
        digest: { algorithm: "sha256", value: digest64 },
      };
    });
    assertEquals((await validateReceipt(bound)).valid, true);
  }
});

Deno.test("unknown policy ids and non-1 policy versions are rejected", async () => {
  await expectViolation((r) => {
    r.policy = { id: "future.policy", version: 1 };
  }, "receipt.schema/unknown-policy");
  await expectViolation((r) => {
    r.policy = { id: "repository.required_checks", version: 2 };
  }, "receipt.schema/unsupported-policy-version");
});

Deno.test("every stable pipeline policy id validates at version 1", async () => {
  for (const id of POLICY_IDS) {
    const receipt = await makeReceipt((r) => {
      r.policy = { id, version: 1 };
    });
    const result = await validateReceipt(receipt);
    if (!result.valid) {
      throw new Error(
        `policy ${id} did not validate: ${JSON.stringify(result.violations)}`,
      );
    }
  }
});

Deno.test("the reserved product runtime policy is not accepted", async () => {
  for (
    const id of ["product.runtime", "runtime.authorization", "product.policy"]
  ) {
    await expectViolation((r) => {
      r.policy = { id, version: 1 };
    }, "receipt.schema/unknown-policy");
  }
});

Deno.test("a required_checks receipt must account for every mandatory check", async () => {
  for (const omitted of MANDATORY_CHECK_IDS) {
    await expectViolation((r) => {
      (r.checks as Record<string, unknown>).executed = floorExecuted()
        .filter((entry) => entry.id !== omitted);
    }, "receipt.schema/mandatory-check-missing");
  }
  // The same omission under a different stable policy is not a floor gap.
  const otherPolicy = await makeReceipt((r) => {
    r.policy = { id: "repository.diff_hygiene", version: 1 };
    (r.checks as Record<string, unknown>).executed = [
      { id: "diff.whitespace", result: "pass", required: true },
    ];
  });
  assertEquals((await validateReceipt(otherPolicy)).valid, true);
});

Deno.test("a duplicated check id cannot validate", async () => {
  await expectViolation((r) => {
    (r.checks as Record<string, unknown>).skipped = [
      { id: "test.aggregate", reason_class: "duplicate", required: false },
    ];
  }, "receipt.schema/duplicate-check-id");
});

Deno.test("a mandatory check not marked required cannot validate", async () => {
  await expectViolation((r) => {
    (r.checks as Record<string, unknown>).executed = floorExecuted(
      () => "pass",
      (id) => id !== "secret.diff",
    );
  }, "receipt.schema/mandatory-check-not-required");
});

Deno.test("check ids outside the controlled vocabulary are rejected without echo", async () => {
  const hostile = "\x1b[2Jcustom.check";
  const result = await validateReceipt(
    await makeReceipt((r) => {
      (r.checks as Record<string, unknown>).skipped = [
        { id: hostile, reason_class: "experimental", required: false },
      ];
    }),
  );
  assertEquals(result.valid, false);
  if (!result.violations.includes("receipt.schema/unknown-check-id")) {
    throw new Error("unknown check id not reported");
  }
  if (result.violations.join("|").includes("custom")) {
    throw new Error("hostile check id reached violations");
  }
});

Deno.test("risk classes are a controlled vocabulary", async () => {
  const accepted = await makeReceipt((r) => {
    r.risk_classes = [...RISK_CLASSES];
  });
  assertEquals((await validateReceipt(accepted)).valid, true);
  await expectViolation((r) => {
    r.risk_classes = ["totally-custom-risk"];
  }, "receipt.schema/unknown-risk-class");
});

Deno.test("runner identity requires a revision", async () => {
  await expectViolation((r) => {
    r.runner = { id: "gate-fixture" };
  }, "receipt.schema/invalid:runner");
});

Deno.test("subject digest mismatches are rejected", async () => {
  await expectViolation(
    () => {},
    "receipt.schema/subject-digest-mismatch",
    { verifiedSubjectDigest: "b".repeat(40) },
  );
  await expectViolation((r) => {
    (r.subject as Record<string, unknown>).digest = {
      algorithm: "sha1",
      value: "not-hex",
    };
  }, "receipt.schema/invalid:subject-digest");
});

Deno.test("stale and future subject timestamps are rejected", async () => {
  await expectViolation(
    (r) => {
      r.occurred_at = "2026-08-29T01:00:00Z";
    },
    "receipt.schema/stale-subject",
    { nowMs: NOW_MS, maxAgeMs: 60 * 60_000 },
  );
  await expectViolation(
    (r) => {
      r.occurred_at = "2026-08-30T12:00:00Z";
    },
    "receipt.schema/future-timestamp",
    { nowMs: NOW_MS },
  );
  await expectViolation((r) => {
    r.occurred_at = "not a timestamp";
  }, "receipt.schema/invalid:occurred_at");
});

Deno.test("occurred_at must be an absolute UTC instant", async () => {
  // Date.parse accepts all of these, but none pins one absolute UTC
  // instant in the canonical `Z` form.
  for (
    const shape of [
      "2026-08-29",
      "2026-08-29T11:59:00",
      "2026-08-29T11:59:00+00:00",
      "2026-08-29T11:59:00-05:00",
      "2026-13-40T11:59:00Z",
    ]
  ) {
    await expectViolation((r) => {
      r.occurred_at = shape;
    }, "receipt.schema/invalid:occurred_at");
  }
  const zulu = await makeReceipt((r) => {
    r.occurred_at = "2026-08-29T11:59:00.250Z";
  });
  assertEquals((await validateReceipt(zulu)).valid, true);
});

Deno.test("negative finding counts are rejected", async () => {
  await expectViolation((r) => {
    r.findings = [{ class: "secret-shaped", count: -1 }];
  }, "receipt.schema/negative-finding-count");
});

Deno.test("passing decisions with failed required checks are rejected", async () => {
  const failExecuted = (r: Record<string, unknown>) => {
    (r.checks as Record<string, unknown>).executed = floorExecuted(
      (id) => id === "test.aggregate" ? "fail" : "pass",
    );
  };
  for (const decision of ["allow", "warn", "degraded", "needs-approval"]) {
    await expectViolation((r) => {
      r.decision = decision;
      failExecuted(r);
    }, "receipt.schema/passing-with-failed-checks");
  }
  const blocked = await makeReceipt((r) => {
    r.decision = "block";
    failExecuted(r);
  });
  assertEquals((await validateReceipt(blocked)).valid, true);
});

Deno.test("an all-warn required-check receipt cannot pass", async () => {
  // The verified failure: every mandatory check ran and returned `warn` —
  // not one of them delivered the assurance it is required for — and the
  // receipt still decided `allow`.
  const warnExecuted = (r: Record<string, unknown>) => {
    (r.checks as Record<string, unknown>).executed = floorExecuted(
      () => "warn",
    );
  };
  for (const decision of ["allow", "warn", "degraded", "needs-approval"]) {
    await expectViolation((r) => {
      r.decision = decision;
      warnExecuted(r);
    }, "receipt.schema/passing-with-warned-checks");
  }
  // A bypass reference cannot convert a warn into a mandatory pass either.
  await expectViolation((r) => {
    r.decision = "bypass";
    r.bypass_ref = `exception-${"d".repeat(40)}`;
    warnExecuted(r);
  }, "receipt.schema/passing-with-warned-checks");
  // The warn vocabulary itself stays legitimate: a non-passing decision may
  // record exactly what the checks reported.
  for (const decision of ["block", "unknown"]) {
    const recorded = await makeReceipt((r) => {
      r.decision = decision;
      warnExecuted(r);
    });
    assertEquals((await validateReceipt(recorded)).valid, true);
  }
});

Deno.test("a single warned mandatory check blocks a passing decision", async () => {
  // Mixed pass/warn: the other ten mandatory checks passing does not cover
  // for the one that only warned.
  for (const warned of MANDATORY_CHECK_IDS) {
    await expectViolation((r) => {
      (r.checks as Record<string, unknown>).executed = floorExecuted((id) =>
        id === warned ? "warn" : "pass"
      );
    }, "receipt.schema/passing-with-warned-checks");
  }
  // A warn alongside a failure reports both rules, not just the failure.
  const mixed = await validateReceipt(
    await makeReceipt((r) => {
      (r.checks as Record<string, unknown>).executed = floorExecuted((id) => {
        if (id === "secret.diff") return "warn";
        return id === "test.aggregate" ? "fail" : "pass";
      });
    }),
  );
  assertEquals(mixed.valid, false);
  for (
    const violation of [
      "receipt.schema/passing-with-warned-checks",
      "receipt.schema/passing-with-failed-checks",
    ]
  ) {
    if (!mixed.violations.includes(violation)) {
      throw new Error(
        `expected ${violation}, got ${JSON.stringify(mixed.violations)}`,
      );
    }
  }
});

Deno.test("warn stays valid where nothing mandatory rests on it", async () => {
  // An advisory check that warned is recorded and accepted; the required
  // check beside it passed, so the receipt still carries a clean floor.
  const advisory = await makeReceipt((r) => {
    r.policy = { id: "repository.diff_hygiene", version: 1 };
    (r.checks as Record<string, unknown>).executed = [
      { id: "diff.whitespace", result: "pass", required: true },
      { id: "markdown.links", result: "warn", required: false },
    ];
  });
  assertEquals((await validateReceipt(advisory)).valid, true);
  // Under any policy, though, a warn on a *required* check is not a pass.
  await expectViolation((r) => {
    r.policy = { id: "repository.diff_hygiene", version: 1 };
    (r.checks as Record<string, unknown>).executed = [
      { id: "diff.whitespace", result: "warn", required: true },
    ];
  }, "receipt.schema/passing-with-warned-checks");
});

// Moves one mandatory check out of `executed` into the named gap bucket so
// the floor stays exactly-once while the gap rule is exercised.
function moveToGap(
  r: Record<string, unknown>,
  bucket: string,
  reasonClass: string,
): void {
  const checks = r.checks as Record<string, unknown>;
  checks.executed = floorExecuted().filter((entry) =>
    entry.id !== "secret.tree"
  );
  checks[bucket] = [
    { id: "secret.tree", reason_class: reasonClass, required: true },
  ];
}

Deno.test("required skipped or unavailable checks block a pass", async () => {
  for (const bucket of ["skipped", "unavailable", "failed"]) {
    await expectViolation((r) => {
      moveToGap(r, bucket, "tool-missing");
    }, "receipt.schema/passing-with-required-gap");
  }
  const unknownDecision = await makeReceipt((r) => {
    r.decision = "unknown";
    moveToGap(r, "unavailable", "tool-missing");
  });
  assertEquals((await validateReceipt(unknownDecision)).valid, true);
});

Deno.test("bypass cannot clear a required deterministic failure", async () => {
  await expectViolation((r) => {
    r.decision = "bypass";
    r.bypass_ref = `exception-${"d".repeat(40)}`;
    moveToGap(r, "failed", "findings");
  }, "receipt.schema/passing-with-required-gap");
  await expectViolation((r) => {
    r.decision = "bypass";
  }, "receipt.schema/missing-bypass-ref");
});

Deno.test("approval and bypass refs must be bounded immutable references", async () => {
  await expectViolation((r) => {
    r.approval_ref = "team-lead-approval";
  }, "receipt.schema/invalid:approval_ref");
  await expectViolation((r) => {
    r.decision = "bypass";
    r.bypass_ref = "break-glass";
  }, "receipt.schema/invalid:bypass_ref");
  const anchored = await makeReceipt((r) => {
    r.approval_ref = `approvals/${"e".repeat(40)}`;
  });
  assertEquals((await validateReceipt(anchored)).valid, true);
});

Deno.test("required independence needs supporting observation", async () => {
  const claim = (
    overrides: Record<string, unknown>,
  ): Record<string, unknown> => ({
    required: true,
    status: "independent",
    observed_by: "runner-observed",
    implementer_family: "anthropic",
    verifier_family: "openai",
    ...overrides,
  });
  const supported = await makeReceipt((r) => {
    r.independence = claim({});
  });
  assertEquals((await validateReceipt(supported)).valid, true);
  for (
    const broken of [
      claim({ status: "same-family" }),
      claim({ status: "forged" }),
      claim({ status: "unknown" }),
      claim({ observed_by: "model-asserted" }),
      claim({ observed_by: "self-attested" }),
      claim({ verifier_family: "anthropic" }),
    ]
  ) {
    await expectViolation((r) => {
      r.independence = broken;
    }, "receipt.schema/unsupported-independence");
  }
  // An omitted family is a shape violation, not merely unsupported evidence.
  await expectViolation((r) => {
    r.independence = claim({ verifier_family: undefined });
  }, "receipt.schema/invalid:independence");
});

Deno.test("an independent status always needs supporting observation", async () => {
  // Even when independence is not required, claiming the achieved status
  // with a self-asserted observer, a sentinel family, or matching families
  // is rejected.
  const claim = (
    overrides: Record<string, unknown>,
  ): Record<string, unknown> => ({
    required: false,
    status: "independent",
    observed_by: "runner-observed",
    implementer_family: "anthropic",
    verifier_family: "openai",
    ...overrides,
  });
  for (
    const broken of [
      claim({ observed_by: "model-asserted" }),
      claim({ observed_by: "self-attested" }),
      claim({ implementer_family: "none" }),
      claim({ verifier_family: "unknown" }),
      claim({ verifier_family: "anthropic" }),
    ]
  ) {
    await expectViolation((r) => {
      r.independence = broken;
    }, "receipt.schema/unsupported-independence");
  }
  const supported = await makeReceipt((r) => {
    r.independence = claim({ observed_by: "operator-attested" });
  });
  assertEquals((await validateReceipt(supported)).valid, true);
});

Deno.test("independence fields are required even when not required to be independent", async () => {
  for (
    const field of [
      "required",
      "status",
      "observed_by",
      "implementer_family",
      "verifier_family",
    ]
  ) {
    await expectViolation((r) => {
      delete (r.independence as Record<string, unknown>)[field];
    }, "receipt.schema/invalid:independence");
  }
});

Deno.test("condition entries require their bounded companion fields", async () => {
  await expectViolation((r) => {
    r.known_unknowns = [{ class: "coverage-gap" }];
  }, "receipt.schema/invalid:known_unknowns");
  await expectViolation((r) => {
    r.degraded_conditions = [{ class: "tool-degraded" }];
  }, "receipt.schema/invalid:degraded_conditions");
  const complete = await makeReceipt((r) => {
    r.known_unknowns = [
      { class: "coverage-gap", evidence_needed: "independent-verification" },
    ];
    r.degraded_conditions = [
      { class: "tool-degraded", scope: "markdown-link-check" },
    ];
  });
  assertEquals((await validateReceipt(complete)).valid, true);
});

Deno.test("unconfirmed redaction is rejected", async () => {
  await expectViolation((r) => {
    (r.redaction as Record<string, unknown>).matched_values_recorded = true;
  }, "receipt.schema/redaction-not-confirmed");
});

Deno.test("unbounded reference lists are rejected", async () => {
  await expectViolation((r) => {
    r.trace_refs = Array.from({ length: 65 }, (_, i) => `trace-${i}`);
  }, "receipt.schema/invalid:trace_refs");
  await expectViolation((r) => {
    r.trace_refs = ["x".repeat(513)];
  }, "receipt.schema/invalid:trace_refs");
});

Deno.test("a tampered payload fails the evidence digest", async () => {
  const receipt = await makeReceipt();
  receipt.work_unit = "tampered-after-sealing";
  const result = await validateReceipt(receipt);
  assertEquals(result.valid, false);
  if (!result.violations.includes("receipt.schema/evidence-digest-mismatch")) {
    throw new Error("tampered payload passed the evidence digest");
  }
});

// An independence claim in the achieved status, with the families under test
// substituted in.
function independenceClaim(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    required: true,
    status: "independent",
    observed_by: "runner-observed",
    implementer_family: "anthropic",
    verifier_family: "openai",
    ...overrides,
  };
}

Deno.test("family identifiers outside the canonical form are rejected", async () => {
  for (
    const family of [
      "Anthropic",
      "ANTHROPIC",
      "open_ai",
      " openai",
      "openai ",
      "open.ai",
      "open ai",
      "-openai",
      "open--ai",
      "аnthropic", // Cyrillic lookalike
      "b".repeat(65),
    ]
  ) {
    await expectViolation((r) => {
      r.independence = independenceClaim({ implementer_family: family });
    }, "receipt.schema/non-canonical-family");
    await expectViolation((r) => {
      r.independence = independenceClaim({ verifier_family: family });
    }, "receipt.schema/non-canonical-family");
  }
});

Deno.test("case-differing spellings never satisfy different-family independence", async () => {
  // The verified failure: `Anthropic` versus `anthropic` is one family
  // wearing two spellings, and must never validate as independent.
  for (
    const pair of [
      { implementer_family: "anthropic", verifier_family: "Anthropic" },
      { implementer_family: "Anthropic", verifier_family: "anthropic" },
      { implementer_family: "ANTHROPIC", verifier_family: "anthropic" },
    ]
  ) {
    const receipt = await makeReceipt((r) => {
      r.independence = independenceClaim(pair);
    });
    const result = await validateReceipt(receipt);
    assertEquals(result.valid, false);
    if (!result.violations.includes("receipt.schema/non-canonical-family")) {
      throw new Error(
        `case-aliased families accepted: ${pair.verifier_family}`,
      );
    }
  }
  // A genuine different-family claim in canonical form still validates.
  const genuine = await makeReceipt((r) => {
    r.independence = independenceClaim({});
  });
  assertEquals((await validateReceipt(genuine)).valid, true);
});

Deno.test("separator aliases of one family are not two families", async () => {
  for (
    const pair of [
      { implementer_family: "openai", verifier_family: "open-ai" },
      { implementer_family: "anthro-pic", verifier_family: "anthropic" },
    ]
  ) {
    await expectViolation((r) => {
      r.independence = independenceClaim(pair);
    }, "receipt.schema/unsupported-independence");
  }
  // A sentinel spelled with separators is still a sentinel.
  await expectViolation((r) => {
    r.independence = independenceClaim({ implementer_family: "un-known" });
  }, "receipt.schema/unsupported-independence");
});

Deno.test("semantic aliases of one family are not two families", async () => {
  // The verified failure: `openai` and `gpt` are both canonical in form and
  // both name one family, so an independence claim resting on the pair is a
  // single family reviewing itself and must never validate.
  for (
    const pair of [
      { implementer_family: "openai", verifier_family: "gpt" },
      { implementer_family: "gpt", verifier_family: "chatgpt" },
      { implementer_family: "claude", verifier_family: "anthropic" },
      { implementer_family: "google", verifier_family: "gemini" },
      { implementer_family: "llama", verifier_family: "meta" },
    ]
  ) {
    await expectViolation((r) => {
      r.independence = independenceClaim(pair);
    }, "receipt.schema/unsupported-independence");
  }
  // A genuinely cross-family claim, named either way round, still validates.
  for (
    const pair of [
      { implementer_family: "anthropic", verifier_family: "openai" },
      { implementer_family: "gpt", verifier_family: "claude" },
    ]
  ) {
    const genuine = await makeReceipt((r) => {
      r.independence = independenceClaim(pair);
    });
    const result = await validateReceipt(genuine);
    if (!result.valid) {
      throw new Error(
        `cross-family claim rejected: ${JSON.stringify(result.violations)}`,
      );
    }
  }
});

Deno.test("families outside the closed vocabulary cannot be forged", async () => {
  // Canonical in form, but a name this version does not carry: admitting it
  // as a family would let any invented pair of spellings claim independence.
  const invented = "smuggled-family-x";
  const forged = await makeReceipt((r) => {
    r.independence = independenceClaim({
      implementer_family: invented,
      verifier_family: "openai",
    });
  });
  const result = await validateReceipt(forged);
  assertEquals(result.valid, false);
  for (
    const violation of [
      "receipt.schema/unknown-family",
      "receipt.schema/unsupported-independence",
    ]
  ) {
    if (!result.violations.includes(violation)) {
      throw new Error(
        `expected ${violation}, got ${JSON.stringify(result.violations)}`,
      );
    }
  }
  // The rejected name is attacker-chosen and never echoed.
  if (result.violations.join("|").includes("smuggled")) {
    throw new Error("invented family reached violations");
  }
  // The vocabulary binds even when no independence is claimed.
  await expectViolation((r) => {
    r.independence = {
      required: false,
      status: "unknown",
      observed_by: "runner-observed",
      implementer_family: invented,
      verifier_family: "none",
    };
  }, "receipt.schema/unknown-family");
  // ... and the optional model object draws from the same vocabulary.
  const model = (family: string): Record<string, unknown> => ({
    provider: "provider-fixture",
    model: "model-fixture",
    family,
    observed_by: "runner-observed",
  });
  await expectViolation((r) => {
    r.model = model(invented);
  }, "receipt.schema/unknown-family");
  const aliased = await makeReceipt((r) => {
    r.model = model("claude");
  });
  assertEquals((await validateReceipt(aliased)).valid, true);
});

Deno.test("a rejected family spelling is never echoed", async () => {
  const hostile = "\x1b[2JFamily-Smuggled";
  const receipt = await makeReceipt((r) => {
    r.independence = independenceClaim({ implementer_family: hostile });
  });
  const result = await validateReceipt(receipt);
  assertEquals(result.valid, false);
  if (result.violations.join("|").includes("Smuggled")) {
    throw new Error("hostile family reached violations");
  }
});

Deno.test("the model family is a canonical identifier", async () => {
  const model = (family: string): Record<string, unknown> => ({
    provider: "provider-fixture",
    model: "model-fixture",
    family,
    observed_by: "runner-observed",
  });
  await expectViolation((r) => {
    r.model = model("Anthropic");
  }, "receipt.schema/non-canonical-family");
  const canonical = await makeReceipt((r) => {
    r.model = model("anthropic");
  });
  assertEquals((await validateReceipt(canonical)).valid, true);
});

Deno.test("placeholder family identifiers are not production families", async () => {
  // The verified failure: the vocabulary carried stand-in family names, so a
  // receipt could claim two-family independent review — `family-a` reviewed
  // by `family-b` — without either name identifying a real model family.
  const model = (family: string): Record<string, unknown> => ({
    provider: "provider-fixture",
    model: "model-fixture",
    family,
    observed_by: "runner-observed",
  });
  for (const placeholder of ["family-a", "family-b", "family-c"]) {
    await expectViolation((r) => {
      r.independence = independenceClaim({
        implementer_family: placeholder,
      });
    }, "receipt.schema/unknown-family");
    await expectViolation((r) => {
      r.model = model(placeholder);
    }, "receipt.schema/unknown-family");
  }
  // A claim resting on two placeholders supports nothing at all.
  await expectViolation((r) => {
    r.independence = independenceClaim({
      implementer_family: "family-a",
      verifier_family: "family-b",
    });
  }, "receipt.schema/unsupported-independence");
  // Every remaining family names a real one and still carries a claim.
  for (const family of MODEL_FAMILIES) {
    const receipt = await makeReceipt((r) => {
      r.independence = independenceClaim({
        implementer_family: family,
        verifier_family: family === "anthropic" ? "openai" : "anthropic",
      });
    });
    const result = await validateReceipt(receipt);
    if (!result.valid) {
      throw new Error(
        `canonical family ${family} rejected: ${
          JSON.stringify(result.violations)
        }`,
      );
    }
  }
});

Deno.test("unknown keys in nested objects are rejected without echo", async () => {
  const hostile = "\x1b[2Jsmuggled-member";
  const nested: Record<string, string> = {
    policy: "policy",
    subject: "subject",
    actor: "actor",
    runner: "runner",
    tool_revision: "tool_revision",
    independence: "independence",
    source_revision: "source_revision",
    redaction: "redaction",
    checks: "checks",
  };
  for (const [field, reported] of Object.entries(nested)) {
    const receipt = await makeReceipt((r) => {
      (r[field] as Record<string, unknown>)[hostile] = "payload";
    });
    const result = await validateReceipt(receipt);
    assertEquals(result.valid, false);
    if (
      !result.violations.includes(
        `receipt.schema/unknown-nested-field:${reported}`,
      )
    ) {
      throw new Error(`unknown member in ${field} not reported`);
    }
    const flattened = result.violations.join("|");
    if (flattened.includes("smuggled") || flattened.includes("payload")) {
      throw new Error(`hostile member of ${field} reached violations`);
    }
  }
  // The nested subject digest is closed too.
  await expectViolation((r) => {
    ((r.subject as Record<string, unknown>).digest as Record<
      string,
      unknown
    >)[hostile] = "payload";
  }, "receipt.schema/unknown-nested-field:subject-digest");
  // ... as is the optional model object.
  await expectViolation((r) => {
    r.model = {
      provider: "provider-fixture",
      model: "model-fixture",
      family: "anthropic",
      observed_by: "runner-observed",
      [hostile]: "payload",
    };
  }, "receipt.schema/unknown-nested-field:model");
});

Deno.test("unknown keys in nested list entries are rejected", async () => {
  await expectViolation((r) => {
    (r.checks as Record<string, unknown>).executed = floorExecuted().map((
      entry,
    ) =>
      entry.id === "test.aggregate" ? { ...entry, extra: "payload" } : entry
    );
  }, "receipt.schema/unknown-nested-field:checks");
  await expectViolation((r) => {
    (r.checks as Record<string, unknown>).skipped = [
      {
        id: "markdown.links",
        reason_class: "tool-missing",
        required: false,
        extra: "payload",
      },
    ];
  }, "receipt.schema/unknown-nested-field:checks");
  await expectViolation((r) => {
    r.findings = [{ class: "secret-shaped", count: 0, extra: "payload" }];
  }, "receipt.schema/unknown-nested-field:findings");
  await expectViolation((r) => {
    r.known_unknowns = [
      { class: "coverage-gap", evidence_needed: "review", extra: "payload" },
    ];
  }, "receipt.schema/unknown-nested-field:known_unknowns");
  await expectViolation((r) => {
    r.degraded_conditions = [
      { class: "tool-degraded", scope: "links", extra: "payload" },
    ];
  }, "receipt.schema/unknown-nested-field:degraded_conditions");
});

Deno.test("the sealed evidence digest object is closed", async () => {
  const receipt = await makeReceipt();
  (receipt.evidence_digest as Record<string, unknown>).extra = "payload";
  const result = await validateReceipt(receipt);
  assertEquals(result.valid, false);
  if (
    !result.violations.includes(
      "receipt.schema/unknown-nested-field:evidence_digest",
    )
  ) {
    throw new Error("unknown evidence_digest member not reported");
  }
});

Deno.test("an oversized nested member is rejected before digest work", async () => {
  // The verified failure: a sealed receipt carrying a 1 MB nested member.
  const receipt = await makeReceipt((r) => {
    (r.policy as Record<string, unknown>).extra = "P".repeat(1024 * 1024);
  });
  const result = await validateReceipt(receipt);
  assertEquals(result, {
    valid: false,
    violations: ["receipt.schema/excessive-size"],
  });
  // The aggregate bound also binds when every individual string and list is
  // within its own per-field bound: 64 maximal trace refs plus 64 maximal
  // known-unknown entries still overrun the receipt as a whole.
  const many = await makeReceipt((r) => {
    r.trace_refs = Array.from({ length: 64 }, () => "t".repeat(512));
    r.known_unknowns = Array.from({ length: 64 }, () => ({
      class: "c".repeat(512),
      evidence_needed: "e".repeat(512),
    }));
  });
  assertEquals(await validateReceipt(many), {
    valid: false,
    violations: ["receipt.schema/excessive-size"],
  });
});

Deno.test("JSON escaping cannot hide an oversized receipt", async () => {
  // The verified failure: every string is inside its own 512-character bound
  // and the structural estimate lands well under 64 KiB, but each `"` costs
  // two bytes once serialized, so the canonical form the digest is computed
  // over is over the aggregate bound.
  const escaped = await makeReceipt((r) => {
    r.trace_refs = Array.from({ length: 64 }, () => '"'.repeat(512));
  });
  const escapedBytes = new TextEncoder().encode(canonicalJson(escaped)).length;
  if (escapedBytes <= 64 * 1024) {
    throw new Error(`fixture is not oversized: ${escapedBytes} bytes`);
  }
  assertEquals(await validateReceipt(escaped), {
    valid: false,
    violations: ["receipt.schema/excessive-size"],
  });
  // Control characters escape to six bytes apiece; the same undercount.
  const control = await makeReceipt((r) => {
    r.trace_refs = Array.from({ length: 32 }, () => "\u0001".repeat(512));
  });
  assertEquals(await validateReceipt(control), {
    valid: false,
    violations: ["receipt.schema/excessive-size"],
  });
  // The bound is on bytes, not code units: a multi-byte payload whose length
  // in characters is a third of the bound still overruns it.
  const multibyte = await makeReceipt((r) => {
    r.trace_refs = Array.from({ length: 64 }, () => "€".repeat(512));
  });
  if (canonicalJson(multibyte).length > 64 * 1024) {
    throw new Error("multi-byte fixture is oversized in code units too");
  }
  assertEquals(await validateReceipt(multibyte), {
    valid: false,
    violations: ["receipt.schema/excessive-size"],
  });
  // A receipt carrying escaped and multi-byte content that still serializes
  // within the bound is not rejected for size.
  const within = await makeReceipt((r) => {
    r.trace_refs = ['trace-"quoted"', "trace-back\\slash", "trace-€"];
  });
  assertEquals((await validateReceipt(within)).valid, true);
});

Deno.test("excessive nesting depth is rejected before canonicalization", async () => {
  const receipt = await makeReceipt((r) => {
    r.trace_refs = [[[[["deep"]]]]];
  });
  const result = await validateReceipt(receipt);
  assertEquals(result, {
    valid: false,
    violations: ["receipt.schema/excessive-nesting-depth"],
  });
});

Deno.test("canonical JSON is key-order independent", () => {
  assertEquals(
    canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }),
    canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }),
  );
});
