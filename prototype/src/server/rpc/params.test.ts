import { assertEquals, assertThrows } from "@std/assert";
import { RpcError, RpcErrorCode } from "../../transport/mod.ts";
import {
  asRecord,
  sanitizeRpcIdentifier,
  sanitizeRpcString,
} from "./params.ts";

function invalidParams(run: () => unknown, message: string): void {
  const error = assertThrows(run, RpcError);
  assertEquals(error.code, RpcErrorCode.invalidParams);
  assertEquals(error.message, message);
}

Deno.test("asRecord treats non-object params as empty", () => {
  assertEquals(asRecord(undefined), {});
  assertEquals(asRecord("x"), {});
  assertEquals(asRecord({ a: 1 }), { a: 1 });
});

Deno.test("sanitizeRpcIdentifier enforces presence, type, length and characters", () => {
  assertEquals(sanitizeRpcIdentifier(undefined, "id"), undefined);
  assertEquals(sanitizeRpcIdentifier("abc", "id"), "abc");
  invalidParams(
    () => sanitizeRpcIdentifier(undefined, "id", { required: true }),
    "id is required",
  );
  invalidParams(() => sanitizeRpcIdentifier(1, "id"), "id must be a string");
  invalidParams(
    () => sanitizeRpcIdentifier("abcd", "id", { maxLen: 3 }),
    "id must be between 1 and 3 characters",
  );
  invalidParams(
    () => sanitizeRpcIdentifier("   ", "id"),
    "id cannot be empty or whitespace-only",
  );
  invalidParams(
    () => sanitizeRpcIdentifier("a\u009Bb", "id"),
    "id cannot contain control characters or whitespace",
  );
});

Deno.test("sanitizeRpcString strips complete ANSI CSI escape sequences", () => {
  assertEquals(
    sanitizeRpcString("Clean \x1b[31mRed\x1b[0m Text", "label"),
    "Clean Red Text",
  );
});

Deno.test("sanitizeRpcString folds or keeps newlines by mode and bounds length", () => {
  assertEquals(sanitizeRpcString(" a\n\tb ", "text"), "a b");
  assertEquals(
    sanitizeRpcString("a\r\nb\tc", "text", { singleLine: false }),
    "a\nb c",
  );
  invalidParams(
    () => sanitizeRpcString("   ", "text"),
    "text cannot be empty or whitespace-only",
  );
  invalidParams(
    () => sanitizeRpcString("abcd", "text", { maxLen: 3 }),
    "text exceeds maximum length of 3 characters",
  );
});
