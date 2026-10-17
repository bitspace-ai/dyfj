// The real terminal adapter's pieces: readline EOF and abort handling, which
// Ctrl-C source a turn listens on, and the synchronous write-all loop.
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  lazyReadline,
  readLineOrNull,
  readlineTurnInterruptSource,
  selectTurnInterruptSource,
  type TurnInterruptSource,
  writeAll,
  writeLine,
} from "./io.ts";

describe("readLineOrNull", () => {
  it("resolves the answered line", async () => {
    const rl = {
      question: () => Promise.resolve("hello"),
      once: () => {},
      off: () => {},
    };
    assert.strictEqual(await readLineOrNull(rl, "> "), "hello");
  });

  it("resolves null when the interface closes before answering (Ctrl-D)", async () => {
    let closeHandler: () => void = () => {};
    const rl = {
      // Never settles — mirrors readline's dropped question promise on EOF.
      question: () => new Promise<string>(() => {}),
      once: (_event: "close", handler: () => void) => {
        closeHandler = handler;
      },
      off: () => {},
    };
    const pending = readLineOrNull(rl, "> ");
    closeHandler();
    assert.strictEqual(await pending, null);
  });

  it("resolves null when the question rejects", async () => {
    let removed = 0;
    const rl = {
      question: () => Promise.reject(new Error("boom")),
      once: () => {},
      off: () => {
        removed++;
      },
    };
    assert.strictEqual(await readLineOrNull(rl, "> "), null);
    assert.strictEqual(removed, 1);
  });

  it("passes an abort signal to the pending question", async () => {
    const abortController = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const rl = {
      question: (
        _prompt: string,
        options?: { signal?: AbortSignal },
      ) => {
        receivedSignal = options?.signal;
        return new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
      once: () => {},
      off: () => {},
    };
    const pending = readLineOrNull(rl, "> ", abortController.signal);

    abortController.abort();

    assert.strictEqual(await pending, null);
    assert.strictEqual(receivedSignal, abortController.signal);
  });
});

describe("readlineTurnInterruptSource", () => {
  it("routes readline SIGINT through the active turn handler", () => {
    let registered: (() => void) | undefined;
    const rl = {
      on: (_event: "SIGINT", handler: () => void) => {
        registered = handler;
      },
      off: (_event: "SIGINT", handler: () => void) => {
        if (registered === handler) registered = undefined;
      },
    };
    const source = readlineTurnInterruptSource(rl);
    const handler = mock.fn();

    source.add(handler);
    registered?.();
    assert.equal(handler.mock.callCount(), 1);
    source.remove(handler);
    assert.strictEqual(registered, undefined);
  });

  it("uses process SIGINT when terminal stdin has redirected stdout", () => {
    const readlineSource: TurnInterruptSource = {
      add: () => {},
      remove: () => {},
    };
    const signalSource: TurnInterruptSource = {
      add: () => {},
      remove: () => {},
    };

    assert.strictEqual(
      selectTurnInterruptSource(true, true, readlineSource, signalSource),
      readlineSource,
    );
    assert.strictEqual(
      selectTurnInterruptSource(true, false, readlineSource, signalSource),
      signalSource,
    );
    assert.strictEqual(
      selectTurnInterruptSource(false, true, readlineSource, signalSource),
      undefined,
    );
  });
});

describe("lazyReadline", () => {
  function fakeReadline() {
    const listeners: Array<() => void> = [];
    return {
      closed: 0,
      listeners,
      on(_event: "SIGINT", handler: () => void) {
        listeners.push(handler);
      },
      off(_event: "SIGINT", handler: () => void) {
        listeners.splice(listeners.indexOf(handler), 1);
      },
      close() {
        this.closed++;
      },
    };
  }

  it("never creates the interface when nothing reads or listens", () => {
    // A terminal readline puts the TTY in raw mode, so a command that only
    // writes (dyfj start, status, stop) must not create one.
    const create = mock.fn(fakeReadline);
    const terminal = lazyReadline(create);
    terminal.sigint.off("SIGINT", () => {});
    terminal.close();
    assert.equal(create.mock.callCount(), 0);
  });

  it("creates it once, on first use, and closes that one", () => {
    const rl = fakeReadline();
    const create = mock.fn(() => rl);
    const terminal = lazyReadline(create);
    const handler = () => {};
    terminal.sigint.on("SIGINT", handler);
    assert.strictEqual(terminal.open(), rl);
    assert.equal(create.mock.callCount(), 1);
    assert.deepStrictEqual(rl.listeners, [handler]);
    terminal.sigint.off("SIGINT", handler);
    assert.deepStrictEqual(rl.listeners, []);
    terminal.close();
    assert.equal(rl.closed, 1);
  });
});

describe("writeAll", () => {
  it("keeps writing after a partial write until every byte is out", () => {
    const written: number[][] = [];
    const write = (
      _fd: number,
      bytes: Uint8Array,
      offset: number,
      length: number,
    ) => {
      const n = written.length === 0 ? 2 : length;
      written.push([...bytes.subarray(offset, offset + n)]);
      return n;
    };
    writeAll(1, new Uint8Array([1, 2, 3, 4, 5]), write, () => {});
    assert.deepStrictEqual(written, [[1, 2], [3, 4, 5]]);
  });

  it("pauses and retries when the descriptor reports EAGAIN", () => {
    const written: number[][] = [];
    const pause = mock.fn(() => {});
    let calls = 0;
    const write = (
      _fd: number,
      bytes: Uint8Array,
      offset: number,
      length: number,
    ) => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("resource temporarily unavailable"), {
          code: "EAGAIN",
        });
      }
      written.push([...bytes.subarray(offset, offset + length)]);
      return length;
    };
    writeAll(2, new Uint8Array([7, 8, 9]), write, pause);
    assert.equal(pause.mock.callCount(), 1);
    assert.deepStrictEqual(written, [[7, 8, 9]]);
  });

  it("writes nothing for an empty buffer", () => {
    const write = mock.fn(() => 0);
    writeAll(1, new Uint8Array(0), write, () => {});
    assert.equal(write.mock.callCount(), 0);
  });
});

describe("writeLine", () => {
  it("writes the whole line and a newline, past a partial write", () => {
    const written: number[] = [];
    let calls = 0;
    const write = (
      _fd: number,
      bytes: Uint8Array,
      offset: number,
      length: number,
    ) => {
      calls += 1;
      const n = calls === 1 ? 1 : length;
      written.push(...bytes.subarray(offset, offset + n));
      return n;
    };
    writeLine(2, "oops", write, () => {});
    assert.deepStrictEqual(
      new TextDecoder().decode(new Uint8Array(written)),
      "oops\n",
    );
  });
});
