// The real terminal adapter's readline pieces: EOF and abort handling, and
// which Ctrl-C source a turn listens on.
import { assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { assertSpyCalls, spy } from "@std/testing/mock";
import {
  readLineOrNull,
  readlineTurnInterruptSource,
  selectTurnInterruptSource,
  type TurnInterruptSource,
} from "./io.ts";

describe("readLineOrNull", () => {
  it("resolves the answered line", async () => {
    const rl = {
      question: () => Promise.resolve("hello"),
      once: () => {},
      off: () => {},
    };
    assertStrictEquals(await readLineOrNull(rl, "> "), "hello");
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
    assertStrictEquals(await pending, null);
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
    assertStrictEquals(await readLineOrNull(rl, "> "), null);
    assertStrictEquals(removed, 1);
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

    assertStrictEquals(await pending, null);
    assertStrictEquals(receivedSignal, abortController.signal);
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
    const handler = spy();

    source.add(handler);
    registered?.();
    assertSpyCalls(handler, 1);
    source.remove(handler);
    assertStrictEquals(registered, undefined);
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

    assertStrictEquals(
      selectTurnInterruptSource(true, true, readlineSource, signalSource),
      readlineSource,
    );
    assertStrictEquals(
      selectTurnInterruptSource(true, false, readlineSource, signalSource),
      signalSource,
    );
    assertStrictEquals(
      selectTurnInterruptSource(false, true, readlineSource, signalSource),
      undefined,
    );
  });
});
