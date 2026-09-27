import { describe, expect, test } from "vitest";
import {
  buildHistoryOmissionNotice,
  DomainError,
  formatHistoryOmissionSummary,
  historyOmissionForDelivery,
  MAX_ERROR_SUMMARY_BYTES,
  summarizeError,
} from "./turn-contract.ts";

describe("persisted history omission notice", () => {
  test("[case 25] renders the exact code-owned notice without event values", () => {
    const omission = historyOmissionForDelivery({
      detectedInHistory: 2,
      malformedToolRecords: 1,
      gapMarkers: 1,
      callsUnknown: true,
      withheldFromProjection: 1,
      projectedPairs: 3,
    }, "projected-transcript");
    if (omission === undefined) throw new Error("expected omission");
    expect(buildHistoryOmissionNotice(omission)).toBe(
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
    expect(summary).toContain("2 records");
    expect(summary).toContain("number of lost calls unknown (possibly zero)");
    expect(summary).not.toContain("at least");
    expect(summary).toContain("notice composed for this request");
    expect(summary).not.toContain("notice included yes");
  });
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

describe("summarizeError — DomainError (safe by construction)", () => {
  test("passes a short message through unchanged", () => {
    expect(
      summarizeError(new TestDomainError("budget exceeded: $1.23 > $1.00")),
    )
      .toBe("budget exceeded: $1.23 > $1.00");
  });

  test("caps an oversized message with a fixed provenance marker", () => {
    // The marker is the literal "DomainError", not the subclass name: the
    // subclass name would come off the object (`.constructor.name`), which is
    // a writable property and therefore a payload channel.
    const long = "x".repeat(10_000);
    const s = summarizeError(new TestDomainError(long));
    expect(s.length).toBeLessThan(1000);
    expect(s).toContain("truncated; DomainError");
    expect(s).not.toContain("TestDomainError");
    expect(s).toContain(`${long.length} bytes`);
  });
});

describe("summarizeError — foreign errors (unknown provenance)", () => {
  test("a plain Error renders as class + byte count only, even for a short message", () => {
    // "instanceof Error proves nothing" — a plain Error is exactly what a
    // caught driver/dependency error looks like, so it gets no passthrough
    // at any size, not just oversized ones.
    const s = summarizeError(new Error("boom"));
    expect(s).toBe("[Error, 4 bytes]");
  });

  test("no prefix of an oversized foreign message survives, not even a short excerpt", () => {
    // The regression this guards: the old size-based policy would forward a
    // MAX_ERROR_SUMMARY_BYTES-byte PREFIX of any message, foreign or not — so
    // "the full string is absent" is not sufficient evidence of no leak.
    const payload = "SELECT ".repeat(20_000); // well over 100KB
    const s = summarizeError(new Error(payload));
    expect(s).not.toContain(payload.slice(0, 50));
    expect(s).not.toContain(payload.slice(0, MAX_ERROR_SUMMARY_BYTES));
    expect(s).toBe(
      `[Error, ${new TextEncoder().encode(payload).byteLength} bytes]`,
    );
  });

  test("a non-Error thrown value renders by typeof, not by message", () => {
    const stringThrow = "a bare string throw";
    expect(summarizeError(stringThrow)).toBe(
      `[string, ${new TextEncoder().encode(stringThrow).byteLength} bytes]`,
    );
    expect(summarizeError(42)).toBe(
      `[number, ${new TextEncoder().encode(String(42)).byteLength} bytes]`,
    );
  });

  test("a custom Error subclass that does NOT extend DomainError is still foreign — and its subclass name is not echoed", () => {
    // The subclass name would come off the object; the label is the fixed
    // literal "Error" regardless of what the prototype chain calls itself.
    class UnrelatedError extends Error {}
    const detail = "some driver detail";
    const s = summarizeError(new UnrelatedError(detail));
    expect(s).toBe(
      `[Error, ${new TextEncoder().encode(detail).byteLength} bytes]`,
    );
  });

  test("a foreign Error that spoofs .name to match a DomainError class is still foreign", () => {
    // .name is a plain mutable string property any Error can be given; only
    // instanceof (checked by callers, not by summarizeError itself, but the
    // same principle applies here) reflects the real prototype chain.
    const spoofed = new Error("driver detail with a spoofed name");
    spoofed.name = "TestDomainError";
    const s = summarizeError(spoofed);
    expect(s).not.toContain("driver detail");
    expect(s).toBe(
      `[Error, ${new TextEncoder().encode(spoofed.message).byteLength} bytes]`,
    );
  });
});

describe("summarizeError — adversarial candidates (no string is ever read off the object)", () => {
  test("a shadowed constructor cannot smuggle a payload through the label", () => {
    // `instanceof` walks the prototype chain; `.constructor` is an ordinary
    // own-property that can be reassigned independently. The label must be
    // the fixed literal, never `.constructor.name`.
    const err = new Error("boom");
    Object.defineProperty(err, "constructor", {
      value: { name: "FOREIGN_PAYLOAD ".repeat(1000) },
    });
    const s = summarizeError(err);
    expect(s).toBe("[Error, 4 bytes]");
    expect(s).not.toContain("FOREIGN_PAYLOAD");
  });

  test("a null constructor does not break the never-throws contract", () => {
    const err = new Error("boom");
    Object.defineProperty(err, "constructor", { value: null });
    expect(summarizeError(err)).toBe("[Error, 4 bytes]");
  });

  test("a throwing message getter does not break the never-throws contract", () => {
    const err = new Error("unused");
    Object.defineProperty(err, "message", {
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(summarizeError(err)).toBe("[Error, 0 bytes]");
  });

  test("a non-Error object with a throwing toString does not break the never-throws contract", () => {
    const hostile = {
      toString() {
        throw new Error("hostile toString");
      },
    };
    expect(summarizeError(hostile)).toBe("[object, 0 bytes]");
  });

  test("a multibyte DomainError message truncates on a byte-safe boundary within the stated cap", () => {
    // Each "é" is 2 UTF-8 bytes; 500 is even, but shift the boundary with a
    // leading ASCII byte so the cut lands mid-character. The excerpt must be
    // genuinely <= MAX_ERROR_SUMMARY_BYTES — a permissive decode would swap
    // the clipped tail for a 3-byte replacement character and exceed the
    // publicly stated bound.
    const s = summarizeError(new TestDomainError("x" + "é".repeat(5_000)));
    const excerpt = s.slice(0, s.indexOf("…"));
    expect(new TextEncoder().encode(excerpt).byteLength)
      .toBeLessThanOrEqual(MAX_ERROR_SUMMARY_BYTES);
    expect(s).not.toContain("�");
    expect(s).toContain("truncated; DomainError");
  });

  test("an oversized DomainError with a shadowed constructor keeps the fixed marker", () => {
    const err = new TestDomainError("y".repeat(10_000));
    Object.defineProperty(err, "constructor", {
      value: { name: "FORGED_CLASS_NAME" },
    });
    const s = summarizeError(err);
    expect(s).toContain("truncated; DomainError");
    expect(s).not.toContain("FORGED_CLASS_NAME");
    expect(s.length).toBeLessThan(1000);
  });
});
