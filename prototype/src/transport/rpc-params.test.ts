import assert from "node:assert/strict";
import { test } from "node:test";
import { RpcError, RpcErrorCode } from "./jsonrpc.ts";
import {
  asRecord,
  sanitizeRpcIdentifier,
  sanitizeRpcString,
} from "./rpc-params.ts";

function invalidParams(run: () => unknown, message: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.strictEqual(error.code, RpcErrorCode.invalidParams);
    assert.strictEqual(error.message, message);
    return true;
  });
}

test("asRecord treats non-object params as empty", () => {
  assert.deepStrictEqual(asRecord(undefined), {});
  assert.deepStrictEqual(asRecord("x"), {});
  assert.deepStrictEqual(asRecord({ a: 1 }), { a: 1 });
});

test("sanitizeRpcIdentifier enforces presence, type, length and characters", () => {
  assert.deepStrictEqual(sanitizeRpcIdentifier(undefined, "id"), undefined);
  assert.deepStrictEqual(sanitizeRpcIdentifier("abc", "id"), "abc");
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

test("sanitizeRpcString strips complete ANSI CSI escape sequences", () => {
  assert.deepStrictEqual(
    sanitizeRpcString("Clean \x1b[31mRed\x1b[0m Text", "label"),
    "Clean Red Text",
  );
});

test("sanitizeRpcString folds or keeps newlines by mode and bounds length", () => {
  assert.deepStrictEqual(sanitizeRpcString(" a\n\tb ", "text"), "a b");
  assert.deepStrictEqual(
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
