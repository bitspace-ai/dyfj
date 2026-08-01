import { describe, expect, test, vi } from "vitest";
import { installRuntimeSigintHandler } from "./runtime-sigint";

describe("runtime SIGINT handling", () => {
  test("an autostarted runtime ignores terminal SIGINT", async () => {
    let handler: () => void | Promise<void> = () => {};
    const close = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    const add = vi.fn((next: () => void) => handler = next);

    installRuntimeSigintHandler(
      true,
      close,
      { add },
      exit,
    );
    await handler();

    expect(add).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  test("a foreground runtime closes and exits on SIGINT", async () => {
    let handler: () => void | Promise<void> = () => {};
    const close = vi.fn(() => Promise.resolve());
    const exit = vi.fn();

    installRuntimeSigintHandler(
      false,
      close,
      { add: (next) => handler = next },
      exit,
    );
    await handler();

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("foreground SIGINT waits for startup to supply runtime cleanup", async () => {
    let handler: () => void | Promise<void> = () => {};
    let resolveClose!: (close: () => Promise<void>) => void;
    const closeReady = new Promise<() => Promise<void>>((resolve) => {
      resolveClose = resolve;
    });
    const close = vi.fn(() => Promise.resolve());
    const exit = vi.fn();

    installRuntimeSigintHandler(
      false,
      async () => await (await closeReady)(),
      { add: (next) => handler = next },
      exit,
    );
    const pending = handler();
    await Promise.resolve();

    expect(exit).not.toHaveBeenCalled();
    resolveClose(close);
    await pending;

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("a foreground runtime exits when graceful shutdown rejects", async () => {
    let handler: () => void | Promise<void> = () => {};
    const close = vi.fn(() => Promise.reject(new Error("close failed")));
    const exit = vi.fn();

    installRuntimeSigintHandler(
      false,
      close,
      { add: (next) => handler = next },
      exit,
    );
    await expect(handler()).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
