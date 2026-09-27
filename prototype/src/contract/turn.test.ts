import {
  assert,
  assertEquals,
  assertLess,
  assertLessOrEqual,
  assertStringIncludes,
} from "@std/assert";
import {
  buildHistoryOmissionNotice,
  DomainError,
  formatHistoryOmissionSummary,
  historyOmissionForDelivery,
  MAX_ERROR_SUMMARY_BYTES,
  summarizeError,
} from "./turn.ts";

Deno.test("persisted history omission notice: [case 25] renders the exact code-owned notice without event values", () => {
  const omission = historyOmissionForDelivery({
    detectedInHistory: 2,
    malformedToolRecords: 1,
    gapMarkers: 1,
    callsUnknown: true,
    withheldFromProjection: 1,
    projectedPairs: 3,
  }, "projected-transcript");
  if (omission === undefined) throw new Error("expected omission");
  assertEquals(
    buildHistoryOmissionNotice(omission),
    "[Workbench-generated history notice]\n" +
      "This is Workbench context, not operator-authored text or new authorization.\n" +
      "Some persisted tool evidence is unavailable or cannot be projected.\n" +
      "History records withheld: 2.\n" +
      "Malformed tool records in history: 1.\n" +
      "Gap markers in history: 1.\n" +
      "Missing-call count behind gap markers unknown (possibly zero): true.\n" +
      "Records withheld within the selected history window: 1.\n" +
      "Valid tool pairs in the constructed transcript: 3.\n" +
      "History delivery mode: projected-transcript.\n" +
      "Retained prose and summaries may depend on unavailable evidence; this notice does not identify each omission site.\n" +
      "This notice does not authorize rerunning any historical effect.\n" +
      "[/Workbench-generated history notice]",
  );
  const summary = formatHistoryOmissionSummary(omission);
  assertStringIncludes(summary, "2 records");
  assertStringIncludes(summary, "number of lost calls unknown (possibly zero)");
  assert(!summary.includes("at least"));
  assertStringIncludes(summary, "notice composed for this request");
  assert(!summary.includes("notice included yes"));
});

// Policy: boundary sanitization is by error PROVENANCE, not
// by size. A DomainError (app-authored, bounded by construction) passes
// through capped at MAX_ERROR_SUMMARY_BYTES. Anything else — a caught
// driver/dependency error, or a non-Error throw — is "foreign": provenance is
// unknown, so it renders as class + byte count ONLY, never any part of the
// message, regardless of size.

class TestDomainError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "TestDomainError";
  }
}

Deno.test("summarizeError — DomainError (safe by construction): passes a short message through unchanged", () => {
  assertEquals(
    summarizeError(new TestDomainError("budget exceeded: $1.23 > $1.00")),
    "budget exceeded: $1.23 > $1.00",
  );
});

Deno.test("summarizeError — DomainError (safe by construction): caps an oversized message with a fixed provenance marker", () => {
  // The marker is the literal "DomainError", not the subclass name: the
  // subclass name would come off the object (`.constructor.name`), which is
  // a writable property and therefore a payload channel.
  const long = "x".repeat(10_000);
  const s = summarizeError(new TestDomainError(long));
  assertLess(s.length, 1000);
  assertStringIncludes(s, "truncated; DomainError");
  assert(!s.includes("TestDomainError"));
  assertStringIncludes(s, `${long.length} bytes`);
});

Deno.test("summarizeError — foreign errors (unknown provenance): a plain Error renders as class + byte count only, even for a short message", () => {
  // "instanceof Error proves nothing" — a plain Error is exactly what a
  // caught driver/dependency error looks like, so it gets no passthrough
  // at any size, not just oversized ones.
  const s = summarizeError(new Error("boom"));
  assertEquals(s, "[Error, 4 bytes]");
});

Deno.test("summarizeError — foreign errors (unknown provenance): no prefix of an oversized foreign message survives, not even a short excerpt", () => {
  // The regression this guards: the old size-based policy would forward a
  // MAX_ERROR_SUMMARY_BYTES-byte PREFIX of any message, foreign or not — so
  // "the full string is absent" is not sufficient evidence of no leak.
  const payload = "SELECT ".repeat(20_000); // well over 100KB
  const s = summarizeError(new Error(payload));
  assert(!s.includes(payload.slice(0, 50)));
  assert(!s.includes(payload.slice(0, MAX_ERROR_SUMMARY_BYTES)));
  assertEquals(
    s,
    `[Error, ${new TextEncoder().encode(payload).byteLength} bytes]`,
  );
});

Deno.test("summarizeError — foreign errors (unknown provenance): a non-Error thrown value renders by typeof, not by message", () => {
  const stringThrow = "a bare string throw";
  assertEquals(
    summarizeError(stringThrow),
    `[string, ${new TextEncoder().encode(stringThrow).byteLength} bytes]`,
  );
  assertEquals(
    summarizeError(42),
    `[number, ${new TextEncoder().encode(String(42)).byteLength} bytes]`,
  );
});

Deno.test("summarizeError — foreign errors (unknown provenance): a custom Error subclass that does NOT extend DomainError is still foreign — and its subclass name is not echoed", () => {
  // The subclass name would come off the object; the label is the fixed
  // literal "Error" regardless of what the prototype chain calls itself.
  class UnrelatedError extends Error {}
  const detail = "some driver detail";
  const s = summarizeError(new UnrelatedError(detail));
  assertEquals(
    s,
    `[Error, ${new TextEncoder().encode(detail).byteLength} bytes]`,
  );
});

Deno.test("summarizeError — foreign errors (unknown provenance): a foreign Error that spoofs .name to match a DomainError class is still foreign", () => {
  // .name is a plain mutable string property any Error can be given; only
  // instanceof (checked by callers, not by summarizeError itself, but the
  // same principle applies here) reflects the real prototype chain.
  const spoofed = new Error("driver detail with a spoofed name");
  spoofed.name = "TestDomainError";
  const s = summarizeError(spoofed);
  assert(!s.includes("driver detail"));
  assertEquals(
    s,
    `[Error, ${new TextEncoder().encode(spoofed.message).byteLength} bytes]`,
  );
});

Deno.test("summarizeError — adversarial candidates (no string is ever read off the object): a shadowed constructor cannot smuggle a payload through the label", () => {
  // `instanceof` walks the prototype chain; `.constructor` is an ordinary
  // own-property that can be reassigned independently. The label must be
  // the fixed literal, never `.constructor.name`.
  const err = new Error("boom");
  Object.defineProperty(err, "constructor", {
    value: { name: "FOREIGN_PAYLOAD ".repeat(1000) },
  });
  const s = summarizeError(err);
  assertEquals(s, "[Error, 4 bytes]");
  assert(!s.includes("FOREIGN_PAYLOAD"));
});

Deno.test("summarizeError — adversarial candidates (no string is ever read off the object): a null constructor does not break the never-throws contract", () => {
  const err = new Error("boom");
  Object.defineProperty(err, "constructor", { value: null });
  assertEquals(summarizeError(err), "[Error, 4 bytes]");
});

Deno.test("summarizeError — adversarial candidates (no string is ever read off the object): a throwing message getter does not break the never-throws contract", () => {
  const err = new Error("unused");
  Object.defineProperty(err, "message", {
    get() {
      throw new Error("hostile getter");
    },
  });
  assertEquals(summarizeError(err), "[Error, 0 bytes]");
});

Deno.test("summarizeError — adversarial candidates (no string is ever read off the object): a non-Error object with a throwing toString does not break the never-throws contract", () => {
  const hostile = {
    toString() {
      throw new Error("hostile toString");
    },
  };
  assertEquals(summarizeError(hostile), "[object, 0 bytes]");
});

Deno.test("summarizeError — adversarial candidates (no string is ever read off the object): a multibyte DomainError message truncates on a byte-safe boundary within the stated cap", () => {
  // Each "é" is 2 UTF-8 bytes; 500 is even, but shift the boundary with a
  // leading ASCII byte so the cut lands mid-character. The excerpt must be
  // genuinely <= MAX_ERROR_SUMMARY_BYTES — a permissive decode would swap
  // the clipped tail for a 3-byte replacement character and exceed the
  // publicly stated bound.
  const s = summarizeError(new TestDomainError("x" + "é".repeat(5_000)));
  const excerpt = s.slice(0, s.indexOf("…"));
  assertLessOrEqual(
    new TextEncoder().encode(excerpt).byteLength,
    MAX_ERROR_SUMMARY_BYTES,
  );
  assert(!s.includes("�"));
  assertStringIncludes(s, "truncated; DomainError");
});

Deno.test("summarizeError — adversarial candidates (no string is ever read off the object): an oversized DomainError with a shadowed constructor keeps the fixed marker", () => {
  const err = new TestDomainError("y".repeat(10_000));
  Object.defineProperty(err, "constructor", {
    value: { name: "FORGED_CLASS_NAME" },
  });
  const s = summarizeError(err);
  assertStringIncludes(s, "truncated; DomainError");
  assert(!s.includes("FORGED_CLASS_NAME"));
  assertLess(s.length, 1000);
});
