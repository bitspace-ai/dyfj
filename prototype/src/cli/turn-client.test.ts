import {
  assertEquals,
  assertMatch,
  assertObjectMatch,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import type { TurnStreamFrame } from "../contract/mod.ts";
import {
  fakeTurnConnect,
  turnResult as result,
} from "../../testing/builders/turn-client.ts";
import type { CliConfig } from "./args.ts";
import type { ConnectFn } from "./io.ts";
import { buildTurnBody, socketTurn } from "./turn-client.ts";

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    socket: "/tmp/dyfj-test.sock",
    mode: "turn",
    color: false,
    ...overrides,
  };
}

describe("socketTurn", () => {
  it("forwards stream frames and returns the receipt", async () => {
    const deltas: string[] = [];
    const events: Record<string, unknown>[] = [];
    const r = await socketTurn(
      cfg({ unix: true }),
      { prompt: "hi" },
      { onDelta: (t) => deltas.push(t), onEvent: (e) => events.push(e) },
      fakeTurnConnect(
        [
          { t: "event", event: { type: "modelSelected", modelSlug: "x" } },
          { t: "delta", text: "Hello " },
          { t: "delta", text: "world" },
        ],
        result(),
      ),
    );
    assertStrictEquals(deltas.join(""), "Hello world");
    assertEquals(events.length, 1);
    assertStrictEquals(r.sessionId, result().sessionId);
  });

  it("an abort signal sends turn/cancel for the generated turn id", async () => {
    const abortController = new AbortController();
    const calls: Array<{ method: string; params: unknown }> = [];
    const events: Record<string, unknown>[] = [];
    let finishTurn!: (value: unknown) => void;
    const connect: ConnectFn = () =>
      Promise.resolve({
        request: (method, params) => {
          calls.push({ method, params });
          if (method === "turn") {
            return new Promise((resolve) => {
              finishTurn = resolve;
            });
          }
          if (method === "turn/cancel") {
            finishTurn(result({ stopReason: "aborted", text: "partial" }));
            return Promise.resolve({ cancelled: true });
          }
          return Promise.resolve(undefined);
        },
        close: () => {},
      });
    const pending = socketTurn(
      cfg({ unix: true }),
      { prompt: "hi" },
      {
        abortSignal: abortController.signal,
        onEvent: (event) => events.push(event),
      },
      connect,
    );

    await Promise.resolve();
    abortController.abort();
    const receipt = await pending;

    assertStrictEquals(receipt.stopReason, "aborted");
    const turnId = (calls[0].params as { turnId: string }).turnId;
    assertMatch(turnId, /^[0-9a-f-]{36}$/);
    assertEquals(calls, [
      { method: "turn", params: { prompt: "hi", turnId } },
      { method: "turn/cancel", params: { turnId } },
    ]);
    assertEquals(events, [{
      type: "turnAborted",
      sessionId: receipt.sessionId,
      traceId: receipt.traceId,
      turnId,
    }]);
  });

  it("an abort while connecting prevents turn dispatch", async () => {
    const abortController = new AbortController();
    const calls: string[] = [];
    let closed = false;
    let finishConnect!: (client: Awaited<ReturnType<ConnectFn>>) => void;
    const connect: ConnectFn = () =>
      new Promise((resolve) => {
        finishConnect = resolve;
      });
    const pending = socketTurn(
      cfg({ unix: true }),
      { prompt: "hi" },
      { abortSignal: abortController.signal },
      connect,
    );

    abortController.abort();
    finishConnect({
      request: (method) => {
        calls.push(method);
        return Promise.resolve(undefined);
      },
      close: () => {
        closed = true;
      },
    });

    await assertRejects(
      () => pending,
      Error,
      "turn interrupted before dispatch",
    );
    assertEquals(calls, []);
    assertStrictEquals(closed, true);
  });

  it("does not surface an abort event for a normally completed turn", async () => {
    const events: Record<string, unknown>[] = [];
    const connect: ConnectFn = (_socketPath, options) =>
      Promise.resolve({
        request: (method, params) => {
          if (method === "turn") {
            const turnId = (params as { turnId: string }).turnId;
            options?.onStream?.({
              t: "event",
              event: {
                type: "turnAborted",
                sessionId: result().sessionId,
                traceId: result().traceId,
                turnId,
              },
            });
            return Promise.resolve(result());
          }
          return Promise.resolve(undefined);
        },
        close: () => {},
      });

    const receipt = await socketTurn(
      cfg({ unix: true }),
      { prompt: "hi" },
      { onEvent: (event) => events.push(event) },
      connect,
    );

    assertStrictEquals(receipt.stopReason, "stop");
    assertEquals(events, []);
  });

  it("replaces stale abort-event attribution with terminal receipt identity", async () => {
    const events: Record<string, unknown>[] = [];
    const aborted = result({ stopReason: "aborted" });
    const connect: ConnectFn = (_socketPath, options) =>
      Promise.resolve({
        request: (method, params) => {
          if (method === "turn") {
            const turnId = (params as { turnId: string }).turnId;
            options?.onStream?.({
              t: "event",
              event: {
                type: "turnAborted",
                sessionId: "01STALESESSION00000000000000",
                traceId: "stale-trace",
                turnId,
              },
            });
            return Promise.resolve(aborted);
          }
          return Promise.resolve(undefined);
        },
        close: () => {},
      });

    await socketTurn(
      cfg({ unix: true }),
      { prompt: "hi", turnId: "00000000-0000-4000-8000-000000000001" },
      { onEvent: (event) => events.push(event) },
      connect,
    );

    assertEquals(events, [{
      type: "turnAborted",
      sessionId: aborted.sessionId,
      traceId: aborted.traceId,
      turnId: "00000000-0000-4000-8000-000000000001",
    }]);
  });

  it("drops an opaque malformed event payload before reading its type", async () => {
    const events: Record<string, unknown>[] = [];
    const connect: ConnectFn = (_socketPath, options) =>
      Promise.resolve({
        request: (method) => {
          if (method === "turn") {
            options?.onStream?.({
              t: "event",
              event: null,
            } as unknown as TurnStreamFrame);
            return Promise.resolve(result());
          }
          return Promise.resolve(undefined);
        },
        close: () => {},
      });

    await socketTurn(
      cfg({ unix: true }),
      { prompt: "hi" },
      { onEvent: (event) => events.push(event) },
      connect,
    );

    assertEquals(events, []);
  });

  it("a rejected cancellation request returns a bounded error instead of hanging", async () => {
    const abortController = new AbortController();
    let closed = false;
    const connect: ConnectFn = () =>
      Promise.resolve({
        request: (method) =>
          method === "turn"
            ? new Promise(() => {})
            : Promise.reject(new Error("untrusted peer detail")),
        close: () => {
          closed = true;
        },
      });
    const pending = socketTurn(
      cfg({ unix: true }),
      { prompt: "hi" },
      { abortSignal: abortController.signal },
      connect,
    );

    await Promise.resolve();
    abortController.abort();

    await assertRejects(
      () => pending,
      Error,
      "turn cancellation was not acknowledged; restart the runtime before retrying",
    );
    assertStrictEquals(closed, true);
  });

  it("a synchronous turn request failure still closes the client", async () => {
    let closed = false;
    const connect: ConnectFn = () =>
      Promise.resolve({
        request: () => {
          throw new Error("peer closed");
        },
        close: () => {
          closed = true;
        },
      });

    await assertRejects(
      () =>
        socketTurn(
          cfg({ unix: true }),
          { prompt: "hi" },
          {},
          connect,
        ),
      Error,
      "peer closed",
    );
    assertStrictEquals(closed, true);
  });

  it("an onConnected failure still closes the client", async () => {
    let closed = false;
    const connect: ConnectFn = () =>
      Promise.resolve({
        request: () => Promise.resolve(result()),
        close: () => {
          closed = true;
        },
      });

    await assertRejects(
      () =>
        socketTurn(
          cfg({ unix: true }),
          { prompt: "hi" },
          {
            onConnected: () => {
              throw new Error("listener registration failed");
            },
          },
          connect,
        ),
      Error,
      "listener registration failed",
    );
    assertStrictEquals(closed, true);
  });

  it("a synchronous cancellation request failure uses the bounded client error", async () => {
    const abortController = new AbortController();
    let closed = false;
    const connect: ConnectFn = () =>
      Promise.resolve({
        request: (method) => {
          if (method === "turn") return new Promise(() => {});
          throw new Error("untrusted peer detail");
        },
        close: () => {
          closed = true;
        },
      });
    const pending = socketTurn(
      cfg({ unix: true }),
      { prompt: "hi" },
      { abortSignal: abortController.signal },
      connect,
    );

    await Promise.resolve();
    abortController.abort();

    await assertRejects(
      () => pending,
      Error,
      "turn cancellation was not acknowledged; restart the runtime before retrying",
    );
    assertStrictEquals(closed, true);
  });

  it("an unresponsive cancellation request reaches its acknowledgement deadline", async () => {
    const abortController = new AbortController();
    let closed = false;
    const connect: ConnectFn = () =>
      Promise.resolve({
        request: () => new Promise(() => {}),
        close: () => {
          closed = true;
        },
      });
    const pending = socketTurn(
      cfg({ unix: true }),
      { prompt: "hi" },
      {
        abortSignal: abortController.signal,
        cancellationTimeoutMs: 10,
      },
      connect,
    );

    await Promise.resolve();
    abortController.abort();

    await assertRejects(
      () => pending,
      Error,
      "turn cancellation was not acknowledged; restart the runtime before retrying",
    );
    assertStrictEquals(closed, true);
  });

  it("a negative cancellation acknowledgement leaves the turn authoritative but bounded", async () => {
    const abortController = new AbortController();
    let closed = false;
    const connect: ConnectFn = () =>
      Promise.resolve({
        request: (method) =>
          method === "turn" ? new Promise(() => {}) : Promise.resolve({
            cancelled: false,
            reason: "no_active_turn",
          }),
        close: () => {
          closed = true;
        },
      });
    const pending = socketTurn(
      cfg({ unix: true }),
      { prompt: "hi" },
      {
        abortSignal: abortController.signal,
        cancellationSettleTimeoutMs: 10,
      },
      connect,
    );

    await Promise.resolve();
    abortController.abort();

    await assertRejects(
      () => pending,
      Error,
      "turn did not finish after cancellation was declined; remote work may still be running",
    );
    assertStrictEquals(closed, true);
  });

  it("a negative cancellation acknowledgement does not mask the original turn error", async () => {
    const abortController = new AbortController();
    let rejectTurn!: (error: Error) => void;
    const connect: ConnectFn = () =>
      Promise.resolve({
        request: (method) =>
          method === "turn"
            ? new Promise((_resolve, reject) => {
              rejectTurn = reject;
            })
            : Promise.resolve({
              cancelled: false,
              reason: "no_active_turn",
            }),
        close: () => {},
      });
    const pending = socketTurn(
      cfg({ unix: true }),
      { prompt: "hi" },
      { abortSignal: abortController.signal },
      connect,
    );

    await Promise.resolve();
    abortController.abort();
    await Promise.resolve();
    rejectTurn(new Error("provider failed"));

    await assertRejects(() => pending, Error, "provider failed");
  });

  it("a positive cancellation acknowledgement cannot leave the client waiting forever", async () => {
    const abortController = new AbortController();
    let closed = false;
    const connect: ConnectFn = () =>
      Promise.resolve({
        request: (method) =>
          method === "turn"
            ? new Promise(() => {})
            : Promise.resolve({ cancelled: true }),
        close: () => {
          closed = true;
        },
      });
    const pending = socketTurn(
      cfg({ unix: true }),
      { prompt: "hi" },
      {
        abortSignal: abortController.signal,
        cancellationSettleTimeoutMs: 10,
      },
      connect,
    );

    await Promise.resolve();
    abortController.abort();

    await assertRejects(
      () => pending,
      Error,
      "turn did not finish after cancellation was acknowledged; remote work may still be running",
    );
    assertStrictEquals(closed, true);
  });

  it("a late positive acknowledgement cannot install a timer after turn cleanup", async () => {
    const time = new FakeTime();
    try {
      const abortController = new AbortController();
      let finishTurn!: (value: unknown) => void;
      let finishCancel!: (value: unknown) => void;
      let markCancelRequested!: () => void;
      const cancelRequested = new Promise<void>((resolve) => {
        markCancelRequested = resolve;
      });
      const connect: ConnectFn = () =>
        Promise.resolve({
          request: (method) => {
            if (method === "turn") {
              return new Promise((resolve) => {
                finishTurn = resolve;
              });
            }
            markCancelRequested();
            return new Promise((resolve) => {
              finishCancel = resolve;
            });
          },
          close: () => {},
        });
      const pending = socketTurn(
        cfg({ unix: true }),
        { prompt: "hi" },
        { abortSignal: abortController.signal },
        connect,
      );

      await Promise.resolve();
      abortController.abort();
      await cancelRequested;
      finishTurn(result());
      await pending;
      finishCancel({ cancelled: true });
      await Promise.resolve();
      await Promise.resolve();

      // No timer is left pending: FakeTime.next() runs the next one, if any.
      assertStrictEquals(time.next(), false);
    } finally {
      time.restore();
    }
  });
});

describe("buildTurnBody", () => {
  it("selects the fixture runner without sending model routing", () => {
    assertEquals(
      buildTurnBody(
        "hi",
        cfg({ runner: "fixture", model: "ignored-native-default", tier: 2 }),
      ),
      { prompt: "hi", mode: "turn", runner: "fixture" },
    );
  });

  it("omits routingOptions when no routing is set", () => {
    assertEquals(buildTurnBody("hi", cfg()), { prompt: "hi", mode: "turn" });
  });
  it("includes routing + session when set", () => {
    const body = buildTurnBody("hi", cfg({ model: "m", tier: 1 }), "SESS");
    assertObjectMatch(body, {
      routingOptions: { modelId: "m", tier: 1 },
      sessionId: "SESS",
    });
  });
  it("carries the config mode into the request body", () => {
    assertStrictEquals(buildTurnBody("x", cfg({ mode: "ask" })).mode, "ask");
  });
  it("--approve-paid sets approvePaidInference; absent leaves it off", () => {
    assertStrictEquals(
      buildTurnBody("hi", cfg({ approvePaid: true })).approvePaidInference,
      true,
    );
    assertStrictEquals(
      buildTurnBody("hi", cfg()).approvePaidInference,
      undefined,
    );
  });
  it("sends the workspace only when establishing a new session", () => {
    // New session (no sessionId) on a loopback server: workspace binds the session.
    assertStrictEquals(
      buildTurnBody("hi", cfg({ workspace: "/work/dir" })).workspace,
      "/work/dir",
    );
    // Resuming (sessionId present): omitted — the server reads it from the row.
    assertStrictEquals(
      buildTurnBody("hi", cfg({ workspace: "/work/dir" }), "SESS").workspace,
      undefined,
    );
    assertStrictEquals(buildTurnBody("hi", cfg()).workspace, undefined);
  });
});
