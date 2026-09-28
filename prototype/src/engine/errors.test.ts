import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { BudgetExceededError } from "../budget/mod.ts";
import { DomainError, MAX_REASON_FIELD_BYTES } from "../contract/mod.ts";
import { WorkbenchModelFastSpeedUnsupportedError } from "../providers/mod.ts";
import { classifyErrorKind, PaidEscalationDeclinedError } from "./errors.ts";

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
  assertEquals(err.verdict.reason, "not now");
  assert(err.message.includes("not now"));
});

Deno.test("PaidEscalationDeclinedError caps an oversized reason, on both .message and the stored .verdict", () => {
  const reason = "SELECT ".repeat(2_000);
  const err = new PaidEscalationDeclinedError({
    decision: "escalate",
    reason,
  });
  assert(
    new TextEncoder().encode(err.verdict.reason ?? "").byteLength <=
      MAX_REASON_FIELD_BYTES,
  );
  assert(!err.message.includes(reason));
});

Deno.test("PaidEscalationDeclinedError strips a terminal escape sequence from the reason", () => {
  const esc = String.fromCharCode(27);
  const err = new PaidEscalationDeclinedError({
    decision: "deny",
    reason: `${esc}[31mdanger${esc}[0m`,
  });
  assert(!(err.verdict.reason ?? "").includes(esc));
  assert(!err.message.includes(esc));
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
  assertEquals(
    classifyErrorKind(new PaidEscalationDeclinedError({ decision: "deny" })),
    "PaidEscalationDeclinedError",
  );
  assertEquals(
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
  assert(err instanceof DomainError);
  assert(err instanceof BudgetExceededError);
  assertEquals(classifyErrorKind(err), "BudgetExceededError");
  assertNotEquals(classifyErrorKind(err), "FOREIGN_PAYLOAD");
});

Deno.test("classifyErrorKind classifies an unlisted DomainError subclass to the generic literal", () => {
  class UnlistedDomainError extends DomainError {}
  assertEquals(
    classifyErrorKind(new UnlistedDomainError("x")),
    "DomainError",
  );
});

Deno.test('classifyErrorKind reports the fixed literal "Error" for a plain Error', () => {
  assertEquals(classifyErrorKind(new Error("boom")), "Error");
});

Deno.test('classifyErrorKind reports "unknown" for a non-Error throw', () => {
  assertEquals(classifyErrorKind("bare string throw"), "unknown");
  assertEquals(classifyErrorKind(null), "unknown");
});

Deno.test('classifyErrorKind classifies a foreign Error with a spoofed .constructor.name as plain "Error"', () => {
  const spoofed = new Error("driver detail that must not leak");
  Object.defineProperty(spoofed, "constructor", {
    value: { name: "FOREIGN_PAYLOAD" },
  });
  assert(spoofed instanceof Error);
  assertEquals(classifyErrorKind(spoofed), "Error");
});

Deno.test("classifyErrorKind does not treat an error-shaped plain object as an Error", () => {
  const fake = {
    name: "ContextWindowOverflowError",
    constructor: { name: "ContextWindowOverflowError" },
    message: "not a real error",
  };
  assert(!(fake instanceof Error));
  assertEquals(classifyErrorKind(fake), "unknown");
});
