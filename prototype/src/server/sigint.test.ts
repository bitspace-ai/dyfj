import assert from "node:assert/strict";
import { mock } from "node:test";
import { describe, it } from "@std/testing/bdd";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { installRuntimeSigintHandler } from "./sigint.ts";

describe("runtime SIGINT handling", () => {
  it("an autostarted runtime ignores terminal SIGINT", async () => {
    let handler: () => void | Promise<void> = () => {};
    const close = spy(() => Promise.resolve());
    const exit = mock.fn((_code: number) => {});
    const add = mock.fn((next: () => void) => handler = next);

    installRuntimeSigintHandler(
      true,
      close,
      { add },
      exit,
    );
    await handler();

    assert.equal(add.mock.callCount(), 1);
    assertSpyCalls(close, 0);
    assert.equal(exit.mock.callCount(), 0);
  });

  it("a foreground runtime closes and exits on SIGINT", async () => {
    let handler: () => void | Promise<void> = () => {};
    const close = spy(() => Promise.resolve());
    const exit = mock.fn((_code: number) => {});

    installRuntimeSigintHandler(
      false,
      close,
      { add: (next) => handler = next },
      exit,
    );
    await handler();

    assertSpyCalls(close, 1);
    assert.deepStrictEqual(exit.mock.calls[0].arguments, [0]);
  });

  it("foreground SIGINT waits for startup to supply runtime cleanup", async () => {
    let handler: () => void | Promise<void> = () => {};
    let resolveClose!: (close: () => Promise<void>) => void;
    const closeReady = new Promise<() => Promise<void>>((resolve) => {
      resolveClose = resolve;
    });
    const close = spy(() => Promise.resolve());
    const exit = mock.fn((_code: number) => {});

    installRuntimeSigintHandler(
      false,
      async () => await (await closeReady)(),
      { add: (next) => handler = next },
      exit,
    );
    const pending = handler();
    await Promise.resolve();

    assert.equal(exit.mock.callCount(), 0);
    resolveClose(close);
    await pending;

    assertSpyCalls(close, 1);
    assert.deepStrictEqual(exit.mock.calls[0].arguments, [0]);
  });

  it("a foreground runtime exits when graceful shutdown rejects", async () => {
    let handler: () => void | Promise<void> = () => {};
    const close = spy(() => Promise.reject(new Error("close failed")));
    const exit = mock.fn((_code: number) => {});

    installRuntimeSigintHandler(
      false,
      close,
      { add: (next) => handler = next },
      exit,
    );
    assert.strictEqual(await handler(), undefined);

    assertSpyCalls(close, 1);
    assert.deepStrictEqual(exit.mock.calls[0].arguments, [1]);
  });
});
