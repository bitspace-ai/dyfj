// Assertions that return what they caught, for tests that inspect the thrown
// error. `node:assert`'s `throws` and `rejects` return nothing; these keep
// what `@std/assert`'s `assertThrows` and `assertRejects` did when a test
// used their value: fail unless the function throws (or its promise
// rejects), check the class when one is given, and return the error.
import assert from "node:assert/strict";

type ErrorClass<E> = abstract new (...args: any[]) => E;

function checkClass(caught: unknown, Cls: ErrorClass<unknown> | undefined) {
  if (Cls !== undefined && !(caught instanceof Cls)) {
    assert.fail(
      `expected an instance of ${Cls.name}, got ${
        caught instanceof Error ? caught.name : typeof caught
      }`,
    );
  }
}

/** Runs `fn`, fails unless it throws, and returns what it threw. */
export function captureThrow(fn: () => unknown): unknown;
export function captureThrow<E>(fn: () => unknown, Cls: ErrorClass<E>): E;
export function captureThrow(
  fn: () => unknown,
  Cls?: ErrorClass<unknown>,
): unknown {
  let threw = false;
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    threw = true;
    caught = error;
  }
  if (!threw) assert.fail("expected a throw");
  checkClass(caught, Cls);
  return caught;
}

/**
 * Runs `fn`, fails unless the promise it returns rejects, and returns the
 * rejection. A synchronous throw or a non-promise return fails too.
 */
export function captureRejection(
  fn: () => PromiseLike<unknown>,
): Promise<unknown>;
export function captureRejection<E>(
  fn: () => PromiseLike<unknown>,
  Cls: ErrorClass<E>,
): Promise<E>;
export async function captureRejection(
  fn: () => PromiseLike<unknown>,
  Cls?: ErrorClass<unknown>,
): Promise<unknown> {
  let pending: unknown;
  try {
    pending = fn();
  } catch (error) {
    assert.fail(
      `expected a rejection, but the function threw: ${String(error)}`,
    );
  }
  if (typeof (pending as PromiseLike<unknown> | null)?.then !== "function") {
    assert.fail("expected the function to return a promise");
  }
  let rejected = false;
  let caught: unknown;
  try {
    await pending;
  } catch (error) {
    rejected = true;
    caught = error;
  }
  if (!rejected) assert.fail("expected a rejection");
  checkClass(caught, Cls);
  return caught;
}
