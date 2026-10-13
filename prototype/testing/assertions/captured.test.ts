import assert from "node:assert/strict";
import { test } from "node:test";
import { captureRejection, captureThrow } from "./captured.ts";

class CustomError extends Error {
  readonly code = "custom";
}

test("captureThrow returns the thrown error", () => {
  const error = new Error("boom");
  assert.strictEqual(
    captureThrow(() => {
      throw error;
    }),
    error,
  );
});

test("captureThrow returns the error typed by its class", () => {
  const caught = captureThrow(() => {
    throw new CustomError("boom");
  }, CustomError);
  assert.strictEqual(caught.code, "custom");
});

test("captureThrow fails when nothing is thrown", () => {
  assert.throws(
    () => captureThrow(() => "fine"),
    (error: unknown) =>
      error instanceof assert.AssertionError &&
      error.message === "expected a throw",
  );
});

test("captureThrow fails when the error is not of the class", () => {
  assert.throws(
    () =>
      captureThrow(() => {
        throw new TypeError("boom");
      }, CustomError),
    assert.AssertionError,
  );
});

test("captureThrow returns a non-Error thrown value as is", () => {
  const thrown = { reason: "not an error" };
  assert.strictEqual(
    captureThrow(() => {
      throw thrown;
    }),
    thrown,
  );
});

test("captureRejection returns the rejection", async () => {
  const error = new Error("boom");
  assert.strictEqual(
    await captureRejection(() => Promise.reject(error)),
    error,
  );
});

test("captureRejection returns the rejection typed by its class", async () => {
  const caught = await captureRejection(
    () => Promise.reject(new CustomError("boom")),
    CustomError,
  );
  assert.strictEqual(caught.code, "custom");
});

test("captureRejection fails when the promise resolves", async () => {
  await assert.rejects(
    () => captureRejection(() => Promise.resolve("fine")),
    (error: unknown) =>
      error instanceof assert.AssertionError &&
      error.message === "expected a rejection",
  );
});

test("captureRejection fails when the rejection is not of the class", async () => {
  await assert.rejects(
    () =>
      captureRejection(
        () => Promise.reject(new TypeError("boom")),
        CustomError,
      ),
    assert.AssertionError,
  );
});

test("captureRejection returns a non-Error rejection value as is", async () => {
  const thrown = { reason: "not an error" };
  assert.strictEqual(
    await captureRejection(() => Promise.reject(thrown)),
    thrown,
  );
});

test("captureRejection fails when the function throws instead of rejecting", async () => {
  await assert.rejects(
    () =>
      captureRejection(() => {
        throw new Error("synchronous");
      }),
    assert.AssertionError,
  );
});

test("captureRejection fails when the function returns no promise", async () => {
  await assert.rejects(
    () => captureRejection(() => "fine" as unknown as Promise<unknown>),
    assert.AssertionError,
  );
});
