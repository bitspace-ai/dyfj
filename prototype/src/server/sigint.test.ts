import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { installRuntimeSigintHandler } from "./sigint.ts";

function install(
  autostarted: boolean,
  close: () => Promise<void>,
  waitingOn = () => "the server to close",
) {
  let handler: () => void | Promise<void> = () => {};
  const add = mock.fn((next: () => void) => handler = next);
  const exit = mock.fn((_code: number) => {});
  const said: string[] = [];
  installRuntimeSigintHandler({
    autostarted,
    close,
    signals: { add },
    exit,
    say: (line) => said.push(line),
    waitingOn,
  });
  return { press: () => handler(), add, exit, said };
}

describe("runtime SIGINT handling", () => {
  it("an autostarted runtime ignores terminal SIGINT", async () => {
    const close = mock.fn(() => Promise.resolve());
    const runtime = install(true, close);
    await runtime.press();

    assert.equal(runtime.add.mock.callCount(), 1);
    assert.equal(close.mock.callCount(), 0);
    assert.equal(runtime.exit.mock.callCount(), 0);
  });

  it("a foreground runtime closes and exits on SIGINT", async () => {
    const close = mock.fn(() => Promise.resolve());
    const runtime = install(false, close);
    await runtime.press();

    assert.equal(close.mock.callCount(), 1);
    assert.deepStrictEqual(runtime.exit.mock.calls[0].arguments, [0]);
  });

  it("foreground SIGINT waits for startup to supply runtime cleanup", async () => {
    let resolveClose!: (close: () => Promise<void>) => void;
    const closeReady = new Promise<() => Promise<void>>((resolve) => {
      resolveClose = resolve;
    });
    const close = mock.fn(() => Promise.resolve());
    const runtime = install(false, async () => await (await closeReady)());
    const pending = runtime.press();
    await Promise.resolve();

    assert.equal(runtime.exit.mock.callCount(), 0);
    resolveClose(close);
    await pending;

    assert.equal(close.mock.callCount(), 1);
    assert.deepStrictEqual(runtime.exit.mock.calls[0].arguments, [0]);
  });

  it("a foreground runtime exits when graceful shutdown rejects", async () => {
    const close = mock.fn(() => Promise.reject(new Error("close failed")));
    const runtime = install(false, close);
    assert.strictEqual(await runtime.press(), undefined);

    assert.equal(close.mock.callCount(), 1);
    assert.deepStrictEqual(runtime.exit.mock.calls[0].arguments, [1]);
  });

  it("a second Ctrl-C during a pending close says what it waits on; a third forces a nonzero exit", async () => {
    const close = mock.fn(() => new Promise<void>(() => {}));
    let stage = "the server to close";
    const runtime = install(false, close, () => stage);

    void runtime.press();
    await Promise.resolve();
    assert.deepStrictEqual(runtime.said, []);

    stage = "the store's connection pool to close";
    await runtime.press();
    assert.equal(close.mock.callCount(), 1, "a repeat press starts no second close");
    assert.equal(runtime.exit.mock.callCount(), 0);
    assert.equal(runtime.said.length, 1);
    assert.match(runtime.said[0], /waiting for the store's connection pool to close/);
    assert.match(runtime.said[0], /Ctrl-C again to force/);

    await runtime.press();
    assert.deepStrictEqual(runtime.exit.mock.calls[0].arguments, [130]);
    assert.match(runtime.said[1], /forced exit/);
  });
});
