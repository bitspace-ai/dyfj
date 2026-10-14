import assert from "node:assert/strict";
import { describe, it } from "@std/testing/bdd";
import { BudgetExceededError } from "../budget/mod.ts";
import { DomainError, MAX_REASON_FIELD_BYTES } from "../contract/mod.ts";
import {
  ProviderAuthenticationError,
  ProviderModelNotFoundError,
  ProviderRateLimitedError,
  ProviderRedirectedError,
  ProviderRequestFailedError,
  ProviderRequestTooLargeError,
  ProviderUnreachableError,
  WorkbenchModelFastSpeedUnsupportedError,
} from "../providers/mod.ts";
import {
  classifyErrorKind,
  ContextCompressionPersistenceUncertainError,
  PaidEscalationDeclinedError,
  SessionModelUnavailableError,
  SessionRunnerNotRestorableError,
} from "./errors.ts";

// ── PaidEscalationDeclinedError — reason field sanitization ──────────────────
//
// verdict.reason comes from the injected confirmPaidEscalation callback — an
// operator's TTY answer today, potentially a remote approval peer tomorrow.
// DomainError only certifies the message this constructor builds, so the
// field is capped and control-char-stripped before it reaches either the
// message or the stored `.verdict` (read directly by the runtime's catch
// block, not just via .message).

Deno.test("PaidEscalationDeclinedError passes a short, ordinary reason through unchanged", () => {
  const err = new PaidEscalationDeclinedError({
    decision: "deny",
    reason: "not now",
  });
  assert.strictEqual(err.verdict.reason, "not now");
  assert.ok(err.message.includes("not now"));
});

Deno.test("PaidEscalationDeclinedError caps an oversized reason, on both .message and the stored .verdict", () => {
  const reason = "SELECT ".repeat(2_000);
  const err = new PaidEscalationDeclinedError({
    decision: "escalate",
    reason,
  });
  assert.ok(
    new TextEncoder().encode(err.verdict.reason ?? "").byteLength <=
      MAX_REASON_FIELD_BYTES,
  );
  assert.ok(!err.message.includes(reason));
});

Deno.test("PaidEscalationDeclinedError strips a terminal escape sequence from the reason", () => {
  const esc = String.fromCharCode(27);
  const err = new PaidEscalationDeclinedError({
    decision: "deny",
    reason: `${esc}[31mdanger${esc}[0m`,
  });
  assert.ok(!(err.verdict.reason ?? "").includes(esc));
  assert.ok(!err.message.includes(esc));
});

// ── classifyErrorKind ─────────────────────────────────────────────────────────
//
// Neither .name nor .constructor.name is safe to classify by: both are
// ordinary, writable properties on any object (including a real Error, via
// Object.defineProperty), so a crafted `{ constructor: { name: "..." } }`
// reaches .constructor.name unchanged. classifyErrorKind never reads either
// property; it classifies purely by instanceof against classes this codebase
// controls.

Deno.test("classifyErrorKind reports a real DomainError's own class", () => {
  assert.strictEqual(
    classifyErrorKind(new PaidEscalationDeclinedError({ decision: "deny" })),
    "PaidEscalationDeclinedError",
  );
  assert.strictEqual(
    classifyErrorKind(
      new WorkbenchModelFastSpeedUnsupportedError("test-model"),
    ),
    "WorkbenchModelFastSpeedUnsupportedError",
  );
});

Deno.test("classifyErrorKind classifies a DomainError subclass with a shadowed .constructor to its real class", () => {
  // instanceof DomainError alone does not make .constructor.name safe to
  // read — instanceof walks the prototype chain, but .constructor is an
  // independently-writable own property. A real BudgetExceededError with
  // .constructor reassigned must classify via the fixed table entry.
  const err = new BudgetExceededError("session_limit", 0.5, 1, 0.9);
  Object.defineProperty(err, "constructor", {
    value: { name: "FOREIGN_PAYLOAD" },
  });
  assert.ok(err instanceof DomainError);
  assert.ok(err instanceof BudgetExceededError);
  assert.strictEqual(classifyErrorKind(err), "BudgetExceededError");
  assert.notStrictEqual(classifyErrorKind(err), "FOREIGN_PAYLOAD");
});

Deno.test("classifyErrorKind classifies an unlisted DomainError subclass to the generic literal", () => {
  class UnlistedDomainError extends DomainError {}
  assert.strictEqual(
    classifyErrorKind(new UnlistedDomainError("x")),
    "DomainError",
  );
});

Deno.test('classifyErrorKind reports the fixed literal "Error" for a plain Error', () => {
  assert.strictEqual(classifyErrorKind(new Error("boom")), "Error");
});

Deno.test('classifyErrorKind reports "unknown" for a non-Error throw', () => {
  assert.deepStrictEqual(classifyErrorKind("bare string throw"), "unknown");
  assert.deepStrictEqual(classifyErrorKind(null), "unknown");
});

Deno.test('classifyErrorKind classifies a foreign Error with a spoofed .constructor.name as plain "Error"', () => {
  const spoofed = new Error("driver detail that must not leak");
  Object.defineProperty(spoofed, "constructor", {
    value: { name: "FOREIGN_PAYLOAD" },
  });
  assert.ok(spoofed instanceof Error);
  assert.strictEqual(classifyErrorKind(spoofed), "Error");
});

Deno.test("classifyErrorKind does not treat an error-shaped plain object as an Error", () => {
  const fake = {
    name: "ContextWindowOverflowError",
    constructor: { name: "ContextWindowOverflowError" },
    message: "not a real error",
  };
  assert.ok(!(fake instanceof Error));
  assert.deepStrictEqual(classifyErrorKind(fake), "unknown");
});

Deno.test("classifyErrorKind reports each provider failure class by its own fixed literal", () => {
  const target = { provider: "anthropic", slug: "claude-x" };
  const cases: ReadonlyArray<[DomainError, string]> = [
    [
      new ProviderAuthenticationError(target, 401),
      "ProviderAuthenticationError",
    ],
    [
      new ProviderRateLimitedError(target, 429, "rate_limit"),
      "ProviderRateLimitedError",
    ],
    [new ProviderModelNotFoundError(target, 404), "ProviderModelNotFoundError"],
    [
      new ProviderUnreachableError(target, "refused"),
      "ProviderUnreachableError",
    ],
    [new ProviderRedirectedError(target), "ProviderRedirectedError"],
    [
      new ProviderRequestTooLargeError(target, 413),
      "ProviderRequestTooLargeError",
    ],
    [
      new ProviderRequestFailedError(target, { status: 500, bodyBytes: 1 }),
      "ProviderRequestFailedError",
    ],
  ];
  for (const [err, label] of cases) {
    assert.strictEqual(classifyErrorKind(err), label);
  }
});

// Own enumerable properties, in order, are what JSON.stringify and error
// serialization see, so the order each constructor gives them is pinned.
describe("engine error own properties", () => {
  it("SessionModelUnavailableError keeps the sanitized slug", () => {
    const err = new SessionModelUnavailableError("s\u0007", "unpriced");
    assert.deepStrictEqual(Object.keys(err), ["slug", "why", "name"]);
    assert.strictEqual(err.slug, "s");
    assert.strictEqual(err.why, "unpriced");
    assert.strictEqual(
      err.message,
      'This session last ran on "s", which is no longer routable ' +
        "(unpriced); name a model to resume it on",
    );
    assert.strictEqual(err.cause, undefined);
  });

  it("SessionRunnerNotRestorableError keeps the sanitized profile", () => {
    const err = new SessionRunnerNotRestorableError("p");
    assert.deepStrictEqual(Object.keys(err), ["profile", "name"]);
    assert.strictEqual(err.profile, "p");
    assert.ok(
      err.message.startsWith(
        'This session last ran on the external agent runner "p"',
      ),
    );
    assert.strictEqual(err.cause, undefined);
  });

  it("ContextCompressionPersistenceUncertainError keeps both kinds", () => {
    const err = new ContextCompressionPersistenceUncertainError("A", "B");
    assert.deepStrictEqual(Object.keys(err), [
      "writeErrorKind",
      "probeErrorKind",
      "name",
    ]);
    assert.deepStrictEqual([err.writeErrorKind, err.probeErrorKind], [
      "A",
      "B",
    ]);
    assert.ok(
      err.message.startsWith(
        "Context compression persistence is uncertain: the event write " +
          "failed (A) and the durability probe also failed (B)",
      ),
    );
    assert.strictEqual(err.cause, undefined);
  });
});
