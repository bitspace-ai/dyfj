import { describe, expect, test } from "vitest";
import {
  DomainError,
  MAX_ERROR_SUMMARY_BYTES,
  MAX_REASON_FIELD_BYTES,
  sanitizeBoundaryText,
  summarizeError,
} from "./turn-contract";

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

describe("sanitizeBoundaryText", () => {
  test("leaves ordinary short text unchanged", () => {
    expect(sanitizeBoundaryText("session not found", 500)).toBe(
      "session not found",
    );
  });

  test("collapses tab/newline/carriage-return to a single space, rather than dropping or preserving them", () => {
    // At the 200–500-byte single-field sizes this function guards, LF/CR are
    // their own injection surface — an embedded LF can forge a fake log line
    // in a durable/console record, and a CR can rewind a terminal cursor to
    // overwrite a rendered prefix. Collapsing (not dropping outright) keeps
    // words from running together.
    expect(sanitizeBoundaryText("hello\tworld", 500)).toBe("hello world");
    expect(sanitizeBoundaryText("hello\nworld", 500)).toBe("hello world");
    expect(sanitizeBoundaryText("hello\rworld", 500)).toBe("hello world");
    expect(sanitizeBoundaryText("hello\r\nworld", 500)).toBe("hello  world");
  });

  test("an embedded newline cannot forge a fake log line", () => {
    const injected = "declined" +
      "\n[2026-01-01] operator approved unlimited spend";
    const result = sanitizeBoundaryText(injected, 500);
    expect(result).not.toContain("\n");
    expect(result.split("\n").length).toBe(1);
  });

  test("strips a terminal escape sequence, leaving it inert plain text", () => {
    const esc = String.fromCharCode(27);
    const withEscape = `${esc}[31mred text${esc}[0m`;
    const result = sanitizeBoundaryText(withEscape, 500);
    expect(result).not.toContain(esc);
    expect(result).toBe("[31mred text[0m");
  });

  test("strips C0 and C1 control characters and DEL", () => {
    const withControls = "a" + String.fromCharCode(1) +
      String.fromCharCode(127) + String.fromCharCode(0x9f) + "b";
    expect(sanitizeBoundaryText(withControls, 500)).toBe("ab");
  });

  test("caps to maxBytes on a byte-safe boundary, never exceeding it", () => {
    // Non-homogeneous payload: a run of one repeated character would make
    // "output still contains a slice of the input" trivially true regardless
    // of whether the cap is byte-safe, so it can't discriminate a broken
    // (character-based) implementation from a correct one.
    const payload = "SELECT ".repeat(20_000);
    const result = sanitizeBoundaryText(payload, MAX_REASON_FIELD_BYTES);
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(
      MAX_REASON_FIELD_BYTES,
    );
    expect(result.length).toBeLessThan(payload.length);
  });

  test("a byte cap that lands mid-character decodes cleanly (no replacement character)", () => {
    // Each "é" is 2 UTF-8 bytes; an odd byte cap forces the naive cut to land
    // mid-character.
    const result = sanitizeBoundaryText("é".repeat(200), 101);
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(
      101,
    );
    expect(result).not.toContain("�");
  });
});
