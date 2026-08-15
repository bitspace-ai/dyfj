import { describe, expect, test, vi } from "vitest";
import {
  bufferedTurn,
  buildServeUnixArgs,
  buildTurnBody,
  type CliConfig,
  type ConnectFn,
  createTurnOutputHandlers,
  createTurnSpinner,
  envFileVar,
  fetchSessionPosture,
  formatPostureLine,
  formatReceipt,
  formatRuntimeEvent,
  formatRuntimeStatus,
  friendlyError,
  handleReplIdeaCommand,
  handleReplModelCommand,
  handleReplPacketCommand,
  handleReplSessionCommand,
  handleTurnRuntimeEvent,
  installRootFromModuleUrl,
  type Io,
  isLoopbackServerUrl,
  main,
  memoryMcpNetGrant,
  nodeRunGrant,
  normalizeSessionRef,
  parseArgs,
  promptToolApproval,
  readLauncherMcpServersConfig,
  readLauncherSecretsConfig,
  readLineOrNull,
  readlineTurnInterruptSource,
  readMemoryMcpNetGrant,
  readServeUnixEnvGrants,
  readServeUnixNetGrants,
  readServeUnixRunGrants,
  replPrompt,
  resolveConfig,
  runExec,
  runModels,
  runRepl,
  runSessions,
  runStart,
  runStatus,
  runtimeEventIsVisible,
  rustupHomeReadGrant,
  selectTurnInterruptSource,
  socketError,
  socketTurn,
  spinnerGuardedTurnHandlers,
  type StartRuntimeFn,
  streamTurn,
  toolchainReadGrant,
  type TurnInterruptSource,
  type TurnResult,
} from "./cli";
import { serveWorkbenchUnix } from "./uds-server";
import { connectUnixClient, type ToolApprovalVerdict } from "./uds-client";
import { DomainError } from "./turn-contract";
import type {
  SupersedingRetryStartedEvent,
  TurnStreamFrame,
  UnparsedToolCallMarkupDetectedEvent,
} from "./turn-contract";

describe("readLineOrNull", () => {
  test("resolves the answered line", async () => {
    const rl = {
      question: () => Promise.resolve("hello"),
      once: () => {},
      off: () => {},
    };
    expect(await readLineOrNull(rl, "> ")).toBe("hello");
  });

  test("resolves null when the interface closes before answering (Ctrl-D)", async () => {
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
    expect(await pending).toBeNull();
  });

  test("resolves null when the question rejects", async () => {
    let removed = 0;
    const rl = {
      question: () => Promise.reject(new Error("boom")),
      once: () => {},
      off: () => {
        removed++;
      },
    };
    expect(await readLineOrNull(rl, "> ")).toBeNull();
    expect(removed).toBe(1);
  });

  test("passes an abort signal to the pending question", async () => {
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

    expect(await pending).toBeNull();
    expect(receivedSignal).toBe(abortController.signal);
  });
});

describe("readlineTurnInterruptSource", () => {
  test("routes readline SIGINT through the active turn handler", () => {
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
    const handler = vi.fn();

    source.add(handler);
    registered?.();
    expect(handler).toHaveBeenCalledOnce();
    source.remove(handler);
    expect(registered).toBeUndefined();
  });

  test("uses process SIGINT when terminal stdin has redirected stdout", () => {
    const readlineSource: TurnInterruptSource = {
      add: () => {},
      remove: () => {},
    };
    const signalSource: TurnInterruptSource = {
      add: () => {},
      remove: () => {},
    };

    expect(
      selectTurnInterruptSource(true, true, readlineSource, signalSource),
    ).toBe(readlineSource);
    expect(
      selectTurnInterruptSource(true, false, readlineSource, signalSource),
    ).toBe(signalSource);
    expect(
      selectTurnInterruptSource(false, true, readlineSource, signalSource),
    ).toBeUndefined();
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    serverUrl: "http://localhost:8787",
    socket: "/tmp/dyfj-test.sock",
    mode: "turn",
    color: false,
    ...overrides,
  };
}

function result(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    sessionId: "01CLISESSION0000000000000000",
    traceId: "0123456789abcdef0123456789abcdef",
    stopReason: "stop",
    text: "Workbench says hello.",
    receipt: "Workbench receipt",
    model: {
      displayName: "Qwen3 Coder 30B",
      slug: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
      provider: "mlx-lm",
      api: "openai-completions",
      tier: 0,
    },
    route: { reason: "default" },
    cost: { estimatedUsd: 0, totalUsd: 0, paidInferenceUsed: false },
    tokens: {
      input: 12,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalCalls: 1,
    },
    agent: { toolStepsUsed: 0, maxToolSteps: 32, limitReached: false },
    context: { sources: [] },
    ...overrides,
  };
}

type Frame =
  | { t: "delta"; text: string }
  | { t: "event"; event: Record<string, unknown> }
  | { t: "done"; result: TurnResult }
  | { t: "error"; message: string };

/**
 * The wire shape of the superseding-retry signal — `satisfies` pins the
 * fixture to the canonical contract type, so field drift breaks compile here.
 */
function supersedeEvent(): Record<string, unknown> {
  return {
    type: "supersedingRetryStarted",
    sessionId: "01CLISESSION0000000000000000",
    modelSlug: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
    reason: "context_overflow_recovery",
  } satisfies SupersedingRetryStartedEvent;
}

function unparsedMarkupEvent(): Record<string, unknown> {
  return {
    type: "unparsedToolCallMarkupDetected",
    sessionId: "01CLISESSION0000000000000000",
    count: 64,
    countIsLowerBound: true,
  } satisfies UnparsedToolCallMarkupDetectedEvent;
}

function sseResponse(frames: Frame[]): Response {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch(responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(responses[i++] ?? new Response("", { status: 500 }));
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function fakeIo(
  lines: string[] = [],
  opts: { errIsTerminal?: boolean } = {},
) {
  const queue = [...lines];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const raw: string[] = [];
  const prompts: string[] = [];
  const io: Io = {
    out: (text) => stdout.push(text),
    err: (line) => stderr.push(line),
    errRaw: (text) => raw.push(text),
    errIsTerminal: opts.errIsTerminal,
    readLine: (prompt) => {
      prompts.push(prompt);
      return Promise.resolve(queue.length ? queue.shift()! : null);
    },
    close: () => {},
  };
  return { io, stdout, stderr, raw, prompts };
}

// ── streamTurn / bufferedTurn ────────────────────────────────────────────────

describe("streamTurn", () => {
  test("renders deltas, forwards events, returns the done result", async () => {
    const { fn } = recordingFetch([
      sseResponse([
        { t: "event", event: { type: "modelSelected", modelSlug: "x" } },
        { t: "delta", text: "Hello " },
        { t: "delta", text: "world" },
        { t: "done", result: result() },
      ]),
    ]);
    const deltas: string[] = [];
    const events: Record<string, unknown>[] = [];
    const r = await streamTurn(
      cfg(),
      { prompt: "hi" },
      { onDelta: (t) => deltas.push(t), onEvent: (e) => events.push(e) },
      fn,
    );
    expect(deltas.join("")).toBe("Hello world");
    expect(events).toHaveLength(1);
    expect(r.sessionId).toBe(result().sessionId);
  });

  test("throws on an error frame", async () => {
    const { fn } = recordingFetch([
      sseResponse([{ t: "error", message: "boom" }]),
    ]);
    await expect(
      streamTurn(cfg(), { prompt: "x" }, { onDelta: () => {} }, fn),
    ).rejects.toThrow("boom");
  });

  test("surfaces a pre-stream JSON error", async () => {
    const { fn } = recordingFetch([
      jsonResponse({ error: "bad request" }, 400),
    ]);
    await expect(
      streamTurn(cfg(), { prompt: "x" }, { onDelta: () => {} }, fn),
    ).rejects.toThrow("bad request");
  });

  test("sends Accept: text/event-stream and the JSON body", async () => {
    const { fn, calls } = recordingFetch([
      sseResponse([{ t: "done", result: result() }]),
    ]);
    await streamTurn(cfg(), { prompt: "hi" }, { onDelta: () => {} }, fn);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["accept"]).toBe("text/event-stream");
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      prompt: "hi",
    });
  });
});

describe("bufferedTurn", () => {
  test("returns the JSON result", async () => {
    const { fn } = recordingFetch([jsonResponse(result())]);
    const r = await bufferedTurn(cfg(), { prompt: "x" }, fn);
    expect(r.text).toBe(result().text);
  });

  test("throws the server error message on non-2xx", async () => {
    const { fn } = recordingFetch([jsonResponse({ error: "nope" }, 500)]);
    await expect(bufferedTurn(cfg(), { prompt: "x" }, fn)).rejects.toThrow(
      "nope",
    );
  });
});

// ── socketTurn (turns over the UDS seam) ─────────────────────────────────────

/** A fake UDS connect that streams the given frames, then resolves `turn`. */
function fakeTurnConnect(frames: Frame[], r: TurnResult): ConnectFn {
  return (_socketPath: string, options) =>
    Promise.resolve({
      request: (method: string) => {
        if (method === "turn") {
          for (const f of frames) {
            if (f.t === "delta" || f.t === "event") options?.onStream?.(f);
          }
          return Promise.resolve(r);
        }
        return Promise.resolve(undefined);
      },
      close: () => {},
    });
}

describe("socketTurn", () => {
  test("forwards stream frames and returns the receipt", async () => {
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
    expect(deltas.join("")).toBe("Hello world");
    expect(events).toHaveLength(1);
    expect(r.sessionId).toBe(result().sessionId);
  });

  test("an abort signal sends turn/cancel for the generated turn id", async () => {
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

    expect(receipt.stopReason).toBe("aborted");
    const turnId = (calls[0].params as { turnId: string }).turnId;
    expect(turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls).toEqual([
      { method: "turn", params: { prompt: "hi", turnId } },
      { method: "turn/cancel", params: { turnId } },
    ]);
    expect(events).toEqual([{
      type: "turnAborted",
      sessionId: receipt.sessionId,
      traceId: receipt.traceId,
      turnId,
    }]);
  });

  test("an abort while connecting prevents turn dispatch", async () => {
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

    await expect(pending).rejects.toThrow("turn interrupted before dispatch");
    expect(calls).toEqual([]);
    expect(closed).toBe(true);
  });

  test("does not surface an abort event for a normally completed turn", async () => {
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

    expect(receipt.stopReason).toBe("stop");
    expect(events).toEqual([]);
  });

  test("replaces stale abort-event attribution with terminal receipt identity", async () => {
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

    expect(events).toEqual([{
      type: "turnAborted",
      sessionId: aborted.sessionId,
      traceId: aborted.traceId,
      turnId: "00000000-0000-4000-8000-000000000001",
    }]);
  });

  test("drops an opaque malformed event payload before reading its type", async () => {
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

    expect(events).toEqual([]);
  });

  test("a rejected cancellation request returns a bounded error instead of hanging", async () => {
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

    await expect(pending).rejects.toThrow(
      "turn cancellation was not acknowledged; restart the runtime before retrying",
    );
    expect(closed).toBe(true);
  });

  test("a synchronous turn request failure still closes the client", async () => {
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

    await expect(socketTurn(
      cfg({ unix: true }),
      { prompt: "hi" },
      {},
      connect,
    )).rejects.toThrow("peer closed");
    expect(closed).toBe(true);
  });

  test("an onConnected failure still closes the client", async () => {
    let closed = false;
    const connect: ConnectFn = () =>
      Promise.resolve({
        request: () => Promise.resolve(result()),
        close: () => {
          closed = true;
        },
      });

    await expect(socketTurn(
      cfg({ unix: true }),
      { prompt: "hi" },
      {
        onConnected: () => {
          throw new Error("listener registration failed");
        },
      },
      connect,
    )).rejects.toThrow("listener registration failed");
    expect(closed).toBe(true);
  });

  test("a synchronous cancellation request failure uses the bounded client error", async () => {
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

    await expect(pending).rejects.toThrow(
      "turn cancellation was not acknowledged; restart the runtime before retrying",
    );
    expect(closed).toBe(true);
  });

  test("an unresponsive cancellation request reaches its acknowledgement deadline", async () => {
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

    await expect(pending).rejects.toThrow(
      "turn cancellation was not acknowledged; restart the runtime before retrying",
    );
    expect(closed).toBe(true);
  });

  test("a negative cancellation acknowledgement leaves the turn authoritative but bounded", async () => {
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

    await expect(pending).rejects.toThrow(
      "turn did not finish after cancellation was declined; remote work may still be running",
    );
    expect(closed).toBe(true);
  });

  test("a negative cancellation acknowledgement does not mask the original turn error", async () => {
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

    await expect(pending).rejects.toThrow("provider failed");
  });

  test("a positive cancellation acknowledgement cannot leave the client waiting forever", async () => {
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

    await expect(pending).rejects.toThrow(
      "turn did not finish after cancellation was acknowledged; remote work may still be running",
    );
    expect(closed).toBe(true);
  });

  test("a late positive acknowledgement cannot install a timer after turn cleanup", async () => {
    vi.useFakeTimers();
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

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("socketTurn over a real Unix socket (integration)", () => {
  test("streams deltas and returns the receipt across the wire", async () => {
    const dir = await Deno.makeTempDir({ dir: "/tmp" });
    const sock = `${dir}/wb.sock`;
    const server = await serveWorkbenchUnix(sock, {
      // Stub runtime: stream two deltas, then return a receipt. Cast loosely so
      // the test need not import the engine's runtime result type.
      // deno-lint-ignore no-explicit-any
      runRuntime: (async (input: any) => {
        input.onTextDelta?.("Hello ");
        input.onTextDelta?.("socket");
        return result({ text: "Hello socket" });
        // deno-lint-ignore no-explicit-any
      }) as any,
    });
    try {
      const deltas: string[] = [];
      const r = await socketTurn(
        cfg({ unix: true, socket: sock }),
        { prompt: "hi" },
        { onDelta: (t) => deltas.push(t) },
        connectUnixClient,
      );
      expect(deltas.join("")).toBe("Hello socket");
      expect(r.text).toBe("Hello socket");
    } finally {
      await server.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
});

// ── tool approval over the --unix seam ───────────────────────────────────────

/** A fake UDS connect whose `turn` asks for approval mid-call, capturing the verdict. */
function fakeApprovalConnect(
  request: unknown,
  r: TurnResult,
  captured: { verdict?: ToolApprovalVerdict },
): ConnectFn {
  return (_socketPath: string, options) =>
    Promise.resolve({
      request: async (method: string) => {
        if (method === "turn") {
          captured.verdict = await options?.onApproval?.(request);
          return r;
        }
        return undefined;
      },
      close: () => {},
    });
}

describe("promptToolApproval", () => {
  const acpPermissionRequest = {
    kind: "external_agent_permission",
    title: "Run shell command?",
    arguments: { "ACP tool": "terminal" },
    options: [
      {
        optionId: "allow-once-id",
        name: "Allow Once",
        kind: "allow_once",
      },
      {
        optionId: "allow-session-id",
        name: "Allow for Session",
        kind: "allow_always",
      },
      {
        optionId: "reject-id",
        name: "Reject",
        kind: "reject_once",
      },
    ],
  };
  const emptyAllowOnlyRequest = {
    kind: "external_agent_permission",
    title: "Run shell command?",
    options: [{
      optionId: "",
      name: "Allow Once",
      kind: "allow_once",
    }],
  };

  test.each([
    ["1", "allow-once-id"],
    ["2", "allow-session-id"],
    ["3", "reject-id"],
  ])(
    "returns the exact ACP option id selected by number (%s)",
    async (answer, optionId) => {
      const { io } = fakeIo([answer]);
      expect(
        await promptToolApproval(io, acpPermissionRequest, true),
      ).toEqual({ decision: "select", optionId });
    },
  );

  test("renders every ACP label once, including a dynamic remembered-command option", async () => {
    const dynamic = {
      ...acpPermissionRequest,
      options: [
        ...acpPermissionRequest.options,
        {
          optionId: "remember-command-id",
          name: "Always allow `git status`",
          kind: "allow_always",
        },
      ],
    };
    const { io, stderr } = fakeIo(["4"]);
    expect(await promptToolApproval(io, dynamic, true)).toEqual({
      decision: "select",
      optionId: "remember-command-id",
    });
    const rendered = stderr.join("\n");
    for (const option of dynamic.options) {
      expect(
        rendered.match(
          new RegExp(option.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
        ),
      )
        .toHaveLength(1);
    }
  });

  test("an explicit empty ACP input selects the advertised default rejection", async () => {
    const { io } = fakeIo([""]);
    expect(await promptToolApproval(io, acpPermissionRequest, true)).toEqual({
      decision: "select",
      optionId: "reject-id",
    });
  });

  test("closed ACP input defaults to policy rejection", async () => {
    const { io } = fakeIo([]);
    expect(await promptToolApproval(io, acpPermissionRequest, true)).toEqual({
      decision: "deny",
      reason: "ACP permission selection unavailable",
    });
  });

  test("invalid ACP input corrects and re-prompts without duplicating the request", async () => {
    const { io, stderr, prompts } = fakeIo(["later", "2"]);
    expect(await promptToolApproval(io, acpPermissionRequest, true)).toEqual({
      decision: "select",
      optionId: "allow-session-id",
    });
    expect(prompts).toHaveLength(2);
    expect(stderr.filter((line) => line.includes("Run shell command?")))
      .toHaveLength(1);
    expect(stderr.filter((line) => line.includes("Allow Once"))).toHaveLength(
      1,
    );
    expect(stderr.join("\n")).toContain("Enter a number from 1 to 3.");
  });

  test("an oversized ACP selection is rejected before parsing", async () => {
    const { io, prompts } = fakeIo([` 2${" ".repeat(63)}`, "1"]);
    expect(await promptToolApproval(io, acpPermissionRequest, true)).toEqual({
      decision: "select",
      optionId: "allow-once-id",
    });
    expect(prompts).toHaveLength(2);
  });

  test("three invalid ACP selections exhaust the bounded prompt and reject", async () => {
    const { io, stderr, prompts } = fakeIo(["later", "0", "4", "1"]);
    expect(await promptToolApproval(io, acpPermissionRequest, true)).toEqual({
      decision: "deny",
      reason: "ACP permission selection unavailable",
    });
    expect(prompts).toHaveLength(3);
    expect(stderr.filter((line) => line === "   Enter a number from 1 to 3."))
      .toHaveLength(3);
  });

  test.each([
    ["non-interactive", false, ["1"]],
    ["closed input", true, []],
  ])(
    "an empty allow id with no rejection fails closed on %s",
    async (_label, interactive, lines) => {
      const { io, stderr } = fakeIo(lines);
      expect(await promptToolApproval(io, emptyAllowOnlyRequest, interactive))
        .toEqual({
          decision: "deny",
          reason: "ACP rejection option unavailable",
        });
      if (interactive) {
        expect(
          stderr.filter((line) =>
            line === "   ACP permission options were invalid; request rejected."
          ),
        ).toHaveLength(1);
      }
    },
  );

  test("an all-or-nothing ACP option parse failure reports one fixed diagnostic", async () => {
    const { io, stderr, prompts } = fakeIo(["1"]);
    const duplicate = {
      ...acpPermissionRequest,
      options: acpPermissionRequest.options.map((option) => ({
        ...option,
        optionId: "duplicate",
      })),
    };
    expect(await promptToolApproval(io, duplicate, true)).toEqual({
      decision: "deny",
      reason: "ACP rejection option unavailable",
    });
    expect(prompts).toHaveLength(0);
    expect(
      stderr.filter((line) =>
        line === "   ACP permission options were invalid; request rejected."
      ),
    ).toHaveLength(1);
  });

  test("cancellation aborts a pending ACP selection without choosing an option", async () => {
    const controller = new AbortController();
    const io: Io = {
      out: () => {},
      err: () => {},
      readLine: (_prompt, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(null), {
            once: true,
          });
          controller.abort();
        }),
      close: () => {},
    };
    await expect(
      promptToolApproval(io, acpPermissionRequest, true, controller.signal),
    ).resolves.toEqual({ decision: "abort" });
  });

  test("a non-interactive ACP request defaults to policy rejection without prompting", async () => {
    const { io, prompts } = fakeIo(["1"]);
    await expect(promptToolApproval(io, acpPermissionRequest, false)).resolves
      .toEqual({
        decision: "deny",
        reason: "ACP permission selection unavailable",
      });
    expect(prompts).toHaveLength(0);
  });

  test("approves on y", async () => {
    const { io } = fakeIo(["y"]);
    expect(
      await promptToolApproval(io, {
        title: "Write File",
        arguments: { path: "a" },
      }, true),
    ).toEqual({ decision: "approve" });
  });
  test("denies on anything else", async () => {
    const { io } = fakeIo(["n"]);
    expect((await promptToolApproval(io, {}, true)).decision).toBe("deny");
  });
  test("reports an interrupted approval separately from a denial", async () => {
    const abortController = new AbortController();
    const io: Io = {
      out: () => {},
      err: () => {},
      readLine: (_prompt, signal) => {
        abortController.abort();
        expect(signal?.aborted).toBe(true);
        return Promise.resolve(null);
      },
      close: () => {},
    };
    expect(
      await promptToolApproval(
        io,
        {},
        true,
        abortController.signal,
      ),
    ).toEqual({ decision: "abort" });
  });
  test("denies without prompting when non-interactive", async () => {
    let asked = false;
    const io: Io = {
      out: () => {},
      err: () => {},
      readLine: () => {
        asked = true;
        return Promise.resolve("y");
      },
      close: () => {},
    };
    const verdict = await promptToolApproval(io, {}, false);
    expect(verdict.decision).toBe("deny");
    expect(asked).toBe(false);
  });

  test("runaway_anomaly gets its own hard-stop prompt and approves on y", async () => {
    const { io, stderr } = fakeIo(["y"]);
    const verdict = await promptToolApproval(io, {
      kind: "runaway_anomaly",
      message: "Runaway spend anomaly — hard stop",
    }, true);
    expect(verdict).toEqual({ decision: "approve" });
    expect(stderr.join("\n")).toContain("Runaway spend anomaly — hard stop");
    expect(stderr.join("\n")).not.toContain("exceed budget ceiling");
  });

  test("runaway_anomaly denies on anything but yes", async () => {
    const { io } = fakeIo([""]);
    const verdict = await promptToolApproval(io, {
      kind: "runaway_anomaly",
    }, true);
    expect(verdict.decision).toBe("deny");
  });
});

describe("runExec tool approval (--unix)", () => {
  test("prompts and sends the operator's approval back to the server", async () => {
    const captured: { verdict?: ToolApprovalVerdict } = {};
    const { io, stderr } = fakeIo(["y"]);
    const code = await runExec(
      "edit notes",
      cfg({ unix: true }),
      io,
      false,
      fetch,
      fakeApprovalConnect(
        {
          commandId: "write_file",
          title: "Write File",
          arguments: { path: "notes.md", content: "hi" },
        },
        result(),
        captured,
      ),
      true, // interactive
    );
    expect(code).toBe(0);
    expect(captured.verdict).toEqual({ decision: "approve" });
    expect(stderr.join("\n")).toContain("Write File");
  });

  test("a non-interactive run denies without prompting", async () => {
    const captured: { verdict?: ToolApprovalVerdict } = {};
    const { io } = fakeIo();
    await runExec(
      "edit notes",
      cfg({ unix: true }),
      io,
      false,
      fetch,
      fakeApprovalConnect(
        { commandId: "write_file", title: "Write File", arguments: {} },
        result(),
        captured,
      ),
      false, // not interactive
    );
    expect(captured.verdict?.decision).toBe("deny");
  });

  test("aborts pending operator input when the turn ends first", async () => {
    const approvalSettled = Promise.withResolvers<ToolApprovalVerdict>();
    const io: Io = {
      out: () => {},
      err: () => {},
      readLine: (_prompt, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(null), {
            once: true,
          });
        }),
      close: () => {},
    };
    const connect: ConnectFn = (_socketPath, options) =>
      Promise.resolve({
        request: async (method: string) => {
          if (method === "turn") {
            void Promise.resolve(
              options?.onApproval?.({
                commandId: "external_agent",
                title: "External agent action",
                arguments: {},
              }),
            ).then((verdict) => {
              if (verdict !== undefined) approvalSettled.resolve(verdict);
            });
            return result();
          }
          return undefined;
        },
        close: () => {},
      });

    await expect(runExec(
      "finish before approval",
      cfg({ unix: true }),
      io,
      false,
      fetch,
      connect,
      true,
    )).resolves.toBe(0);
    await expect(approvalSettled.promise).resolves.toEqual({
      decision: "abort",
    });
  });
});

// ── runExec ───────────────────────────────────────────────────────────────────

describe("runExec", () => {
  test("streams text to stdout and the receipt to stderr", async () => {
    const { fn } = recordingFetch([
      sseResponse([{ t: "delta", text: "Hi" }, {
        t: "done",
        result: result(),
      }]),
    ]);
    const { io, stdout, stderr } = fakeIo();
    const code = await runExec("hello", cfg(), io, false, fn);
    expect(code).toBe(0);
    expect(stdout.join("")).toBe("Hi\n");
    expect(stderr.join("\n")).toContain("Qwen3 Coder 30B");
  });

  test("surfaces tool progress events to stderr", async () => {
    const { fn } = recordingFetch([
      sseResponse([
        {
          t: "event",
          event: {
            type: "toolStepStarted",
            step: 1,
            toolCallCount: 1,
          },
        },
        {
          t: "event",
          event: {
            type: "toolCallStarted",
            commandId: "bash",
            callId: "call-1",
          },
        },
        {
          t: "event",
          event: {
            type: "toolCallCompleted",
            commandId: "bash",
            callId: "call-1",
            isError: false,
            durationMs: 85,
          },
        },
        { t: "done", result: result() },
      ]),
    ]);
    const { io, stderr } = fakeIo();
    const code = await runExec("inspect", cfg(), io, false, fn);
    expect(code).toBe(0);
    expect(stderr).toContain("tool: step 1 running 1 call(s)");
    expect(stderr).toContain("tool: bash started");
    expect(stderr).toContain("tool: bash finished (85ms)");
  });

  test("renders the shared unparsed-markup warning before the SSE receipt", async () => {
    const { fn } = recordingFetch([
      sseResponse([
        { t: "delta", text: "provider text" },
        { t: "event", event: unparsedMarkupEvent() },
        { t: "done", result: result({ text: "provider text" }) },
      ]),
    ]);
    const { io, stderr } = fakeIo();
    const code = await runExec("make the change", cfg(), io, false, fn);
    expect(code).toBe(0);
    const warningIndex = stderr.findIndex((line) =>
      line.startsWith("WARNING:")
    );
    const receiptIndex = stderr.findIndex((line) =>
      line.startsWith("— Qwen3 Coder 30B")
    );
    const warning = stderr[warningIndex];
    expect(warning).toContain("no tools were executed from it");
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(receiptIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeLessThan(receiptIndex);
  });

  test("renders streamed markdown without raw markers", async () => {
    const { fn } = recordingFetch([
      sseResponse([
        { t: "delta", text: "## Tools\n- **read_file**\n" },
        { t: "done", result: result() },
      ]),
    ]);
    const { io, stdout } = fakeIo();
    const code = await runExec("list tools", cfg(), io, false, fn);
    expect(code).toBe(0);
    const out = stdout.join("");
    expect(out).not.toMatch(/##|\*\*/);
    expect(out).toContain("Tools");
    expect(out).toContain("read_file");
  });

  test("falls back to result.text when a turn streams no deltas", async () => {
    const { fn } = recordingFetch([
      sseResponse([{ t: "done", result: result({ text: "buffered answer" }) }]),
    ]);
    const { io, stdout } = fakeIo();
    const code = await runExec("x", cfg(), io, false, fn);
    expect(code).toBe(0);
    expect(stdout.join("")).toBe("buffered answer\n");
  });

  test("the superseding-retry signal resets the renderer mid-stream", async () => {
    // The stale attempt opened a code fence that never closed; the signal
    // must reset that parse state or the replacement's markdown would render
    // verbatim as code-block lines.
    const { fn } = recordingFetch([
      sseResponse([
        { t: "delta", text: "```\nstale partial\n" },
        { t: "event", event: supersedeEvent() },
        { t: "delta", text: "**fresh** answer\n" },
        { t: "done", result: result({ text: "**fresh** answer" }) },
      ]),
    ]);
    const { io, stdout } = fakeIo();
    const code = await runExec("long question", cfg(), io, false, fn);
    expect(code).toBe(0);
    const out = stdout.join("");
    const markerAt = out.indexOf("retrying with recovered context");
    expect(markerAt).toBeGreaterThan(out.indexOf("stale partial"));
    // Rendered fresh (bold markers consumed), exactly once, after the marker.
    expect(out.indexOf("fresh answer")).toBeGreaterThan(markerAt);
    expect(out).not.toContain("**fresh**");
    expect(out.indexOf("fresh answer")).toBe(out.lastIndexOf("fresh answer"));
  });

  test("a superseding retry that streams no deltas still delivers the receipt text", async () => {
    // The signal re-arms the buffered-text fallback: everything streamed
    // before it is stale, so if nothing streams after, the authoritative
    // receipt text must render rather than leaving only the stale partial.
    const { fn } = recordingFetch([
      sseResponse([
        { t: "delta", text: "stale partial" },
        { t: "event", event: supersedeEvent() },
        { t: "done", result: result({ text: "authoritative answer" }) },
      ]),
    ]);
    const { io, stdout } = fakeIo();
    const code = await runExec("x", cfg(), io, false, fn);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("authoritative answer");
  });

  test("--json prints the buffered result and no receipt", async () => {
    const { fn } = recordingFetch([jsonResponse(result())]);
    const { io, stdout, stderr } = fakeIo();
    const code = await runExec("hello", cfg(), io, true, fn);
    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ text: result().text });
    expect(stderr).toHaveLength(0);
  });

  test("reports an unreachable runtime with a hint", async () => {
    const fn = (() =>
      Promise.reject(
        new TypeError("error sending request"),
      )) as unknown as typeof fetch;
    const { io, stderr } = fakeIo();
    const code = await runExec("x", cfg(), io, false, fn);
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("not reachable");
  });
});

describe("formatRuntimeEvent", () => {
  test("ignores routine non-tool lifecycle events", () => {
    expect(formatRuntimeEvent({ type: "modelSelected" })).toBeNull();
  });

  test("marks an aborted turn", () => {
    expect(formatRuntimeEvent({ type: "turnAborted" })).toBe("[interrupted]");
  });

  test("marks the forced conclusion after the tool-step limit", () => {
    expect(formatRuntimeEvent({
      type: "toolStepLimitReached",
      maxSteps: 8,
    })).toBe("tool: reached 8-step limit; concluding now");
  });

  test("warns about unparsed markup without model-supplied text", () => {
    const warning = formatRuntimeEvent(unparsedMarkupEvent());
    expect(warning).toBe(
      "WARNING: unparsed tool-call markup was present (at least 64 unmatched opening(s)); " +
        "no tools were executed from it",
    );
    expect(warning).not.toMatch(/edit_file|read_file|<tool_call>/);
  });

  test("renders negotiated memory-recall diagnostics from structured fields", () => {
    expect(formatRuntimeEvent({
      type: "memoryRecallNegotiated",
      era: "modern",
      revision: "2026-07-28",
      server: { name: "fixture-memory", version: "1.2.3" },
      extensions: ["fixture.extension"],
    })).toBe(
      "Memory recall MCP: era=modern revision=2026-07-28 " +
        "server=fixture-memory@1.2.3 extensions=fixture.extension",
    );
  });

  test("drops malformed recall evidence instead of rendering foreign text", () => {
    expect(formatRuntimeEvent({
      type: "memoryRecallNegotiated",
      era: "modern",
      revision: "2026-07-28\nprivate-text",
      extensions: [],
    })).toBeNull();
  });

  test("drops an over-limit extension list instead of reporting none", () => {
    expect(formatRuntimeEvent({
      type: "memoryRecallNegotiated",
      era: "modern",
      revision: "2026-07-28",
      extensions: Array.from({ length: 9 }, (_, index) => `extension.${index}`),
    })).toBeNull();
  });
});

describe("handleTurnRuntimeEvent", () => {
  test("routes the supersede signal to the renderer, not stderr", () => {
    const { io, stdout, stderr } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    handleTurnRuntimeEvent(supersedeEvent(), output, io);
    expect(stdout.join("")).toContain("retrying with recovered context");
    expect(stderr).toHaveLength(0);
  });

  test("still renders tool progress lines to stderr", () => {
    const { io, stdout, stderr } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    handleTurnRuntimeEvent(
      { type: "toolCallStarted", commandId: "bash", callId: "c1" },
      output,
      io,
    );
    expect(stderr).toContain("tool: bash started");
    expect(stdout).toHaveLength(0);
  });

  test("flushes preserved partial text before the interrupted marker", () => {
    const writes: string[] = [];
    const io: Io = {
      out: (text) => writes.push(`out:${text}`),
      err: (line) => writes.push(`err:${line}`),
      readLine: () => Promise.resolve(null),
      close: () => {},
    };
    const output = createTurnOutputHandlers(cfg(), io);
    output.onDelta("unfinished partial line");

    handleTurnRuntimeEvent({ type: "turnAborted" }, output, io);

    expect(writes.some((write) => write.startsWith("out:"))).toBe(true);
    expect(writes.at(-1)).toBe("err:[interrupted]");
  });

  test("renders a context-compression status line to stderr", () => {
    const { io, stderr } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    handleTurnRuntimeEvent(
      {
        type: "contextCompressed",
        sessionId: "s",
        compressorModelSlug: "qwen3:local",
        trigger: "proactive",
        turnsCompressed: 4,
        tokensBeforeEstimate: 900,
        tokensAfterEstimate: 120,
      },
      output,
      io,
    );
    expect(stderr.join("\n")).toContain("context: compressed 4 elder turn(s)");
  });

  // Both clients decode the transport JSON but never schema-validate the frame,
  // so a malformed event payload must be dropped, not dereferenced.
  test.each([
    ["null", null],
    ["a number", 42],
    ["a string", "supersedingRetryStarted"],
    ["an array", []],
  ])("drops a malformed event frame (%s) without throwing", (_label, event) => {
    const { io, stdout, stderr } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    expect(() => handleTurnRuntimeEvent(event, output, io)).not.toThrow();
    expect(stdout).toHaveLength(0);
    expect(stderr).toHaveLength(0);
  });

  test("does not supersede on an event that only fakes the discriminator", () => {
    const { io, stdout } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    // type matches but the pinned payload fields are absent: not a valid signal.
    handleTurnRuntimeEvent({ type: "supersedingRetryStarted" }, output, io);
    expect(stdout.join("")).not.toContain("retrying with recovered context");
  });

  // reason is an open union: a consumer that does not recognize a future reason
  // must still reset, or it renders the superseded attempt as the answer.
  test("supersedes on an unrecognized reason", () => {
    const { io, stdout } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    handleTurnRuntimeEvent(
      { ...supersedeEvent(), reason: "some_future_reason" },
      output,
      io,
    );
    expect(stdout.join("")).toContain("retrying with recovered context");
  });

  test("does not supersede on an empty reason", () => {
    const { io, stdout } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    handleTurnRuntimeEvent({ ...supersedeEvent(), reason: "" }, output, io);
    expect(stdout.join("")).not.toContain("retrying with recovered context");
  });
});

describe("runExec over the socket (--unix)", () => {
  test("streams text + receipt over the seam", async () => {
    const { io, stdout, stderr } = fakeIo();
    const code = await runExec(
      "hi",
      cfg({ unix: true }),
      io,
      false,
      fetch,
      fakeTurnConnect([{ t: "delta", text: "Hi" }], result()),
    );
    expect(code).toBe(0);
    expect(stdout.join("")).toBe("Hi\n");
    expect(stderr.join("\n")).toContain("Qwen3 Coder 30B");
  });

  test("prints buffered aborted text before the interrupted marker", async () => {
    const writes: string[] = [];
    const io: Io = {
      out: (text) => writes.push(`out:${text}`),
      err: (line) => writes.push(`err:${line}`),
      readLine: () => Promise.resolve(null),
      close: () => {},
    };
    const code = await runExec(
      "hi",
      cfg({ unix: true }),
      io,
      false,
      fetch,
      fakeTurnConnect(
        [],
        result({ stopReason: "aborted", text: "buffered partial text" }),
      ),
    );

    expect(code).toBe(0);
    const textIndex = writes.findIndex((write) =>
      write.includes("buffered partial text")
    );
    const markerIndex = writes.indexOf("err:[interrupted]");
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeGreaterThan(textIndex);
  });

  test("Ctrl-C cancels a one-shot UDS turn exactly once", async () => {
    let activeInterrupt: (() => void) | undefined;
    let finishTurn!: (value: unknown) => void;
    let cancelCalls = 0;
    const interrupts: TurnInterruptSource = {
      add: (handler) => {
        activeInterrupt = handler;
      },
      remove: () => {
        activeInterrupt = undefined;
      },
    };
    const connect: ConnectFn = (_socketPath, options) =>
      Promise.resolve({
        request: (method) => {
          if (method === "turn") {
            options?.onStream?.({ t: "delta", text: "partial" });
            queueMicrotask(() => {
              activeInterrupt?.();
              activeInterrupt?.();
            });
            return new Promise((resolve) => {
              finishTurn = resolve;
            });
          }
          if (method === "turn/cancel") {
            cancelCalls++;
            finishTurn(result({ stopReason: "aborted", text: "partial" }));
            return Promise.resolve({ cancelled: true });
          }
          return Promise.resolve(undefined);
        },
        close: () => {},
      });
    const { io, stdout, stderr } = fakeIo();
    io.turnInterrupts = interrupts;

    const code = await runExec(
      "cancel me",
      cfg({ unix: true }),
      io,
      false,
      fetch,
      connect,
    );

    expect(code).toBe(0);
    expect(cancelCalls).toBe(1);
    expect(stdout.join("")).toContain("partial");
    expect(stderr.filter((line) => line === "[interrupt requested]")).toEqual([
      "[interrupt requested]",
    ]);
    expect(stderr).toContain("[interrupted]");
    expect(activeInterrupt).toBeUndefined();
  });

  test("one-shot cleanup preserves the turn failure and still aborts approval input", async () => {
    const approvalSettled = Promise.withResolvers<ToolApprovalVerdict>();
    const interrupts: TurnInterruptSource = {
      add: () => {},
      remove: () => {
        throw new Error("interrupt cleanup failed");
      },
    };
    const connect: ConnectFn = (_socketPath, options) =>
      Promise.resolve({
        request: (method) => {
          if (method !== "turn") return Promise.resolve(undefined);
          void Promise.resolve(
            options?.onApproval?.({
              commandId: "external_agent",
              title: "External agent action",
              arguments: {},
            }),
          ).then((verdict) => {
            if (verdict !== undefined) approvalSettled.resolve(verdict);
          });
          return Promise.reject(new DomainError("turn failed"));
        },
        close: () => {},
      });
    const { io, stderr } = fakeIo();
    io.readLine = (_prompt, signal) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve(null), { once: true });
      });
    io.turnInterrupts = interrupts;

    const code = await runExec(
      "fail while approval is pending",
      cfg({ unix: true }),
      io,
      false,
      fetch,
      connect,
    );

    expect(code).toBe(1);
    await expect(approvalSettled.promise).resolves.toEqual({
      decision: "abort",
    });
    expect(stderr.join("\n")).toContain("turn failed");
    expect(stderr.join("\n")).not.toContain("interrupt cleanup failed");
  });

  test("one-shot cleanup failure changes an otherwise successful exit to failure", async () => {
    const interrupts: TurnInterruptSource = {
      add: () => {},
      remove: () => {
        throw new Error("interrupt cleanup failed");
      },
    };
    const { io, stderr } = fakeIo();
    io.turnInterrupts = interrupts;

    const code = await runExec(
      "successful turn",
      cfg({ unix: true }),
      io,
      false,
      fetch,
      fakeTurnConnect([], result()),
    );

    expect(code).toBe(1);
    expect(stderr.at(-1)).toBe("dyfj: [Error, 24 bytes]");
  });

  test("honors the superseding-retry signal over the UDS seam too", async () => {
    // Same frame shapes as SSE, so the reset contract holds across transports.
    const { io, stdout } = fakeIo();
    const code = await runExec(
      "long question",
      cfg({ unix: true }),
      io,
      false,
      fetch,
      fakeTurnConnect(
        [
          { t: "delta", text: "stale partial\n" },
          { t: "event", event: supersedeEvent() },
          { t: "delta", text: "fresh answer\n" },
        ],
        result({ text: "fresh answer" }),
      ),
    );
    expect(code).toBe(0);
    const out = stdout.join("");
    const markerAt = out.indexOf("retrying with recovered context");
    expect(markerAt).toBeGreaterThan(out.indexOf("stale partial"));
    expect(out.indexOf("fresh answer")).toBeGreaterThan(markerAt);
  });

  test("renders the shared unparsed-markup warning over the UDS seam", async () => {
    const { io, stderr } = fakeIo();
    const code = await runExec(
      "make the change",
      cfg({ unix: true }),
      io,
      false,
      fetch,
      fakeTurnConnect(
        [{ t: "event", event: unparsedMarkupEvent() }],
        result({ text: "provider text" }),
      ),
    );
    expect(code).toBe(0);
    const warningIndex = stderr.findIndex((line) =>
      line.startsWith("WARNING:")
    );
    const receiptIndex = stderr.findIndex((line) =>
      line.startsWith("— Qwen3 Coder 30B")
    );
    const warning = stderr[warningIndex];
    expect(warning).toContain("no tools were executed from it");
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(receiptIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeLessThan(receiptIndex);
  });

  test("an unreachable socket points the operator at dyfj start", async () => {
    const { io, stderr } = fakeIo();
    const code = await runExec(
      "hi",
      cfg({ unix: true, socket: "/run/missing.sock" }),
      io,
      false,
      fetch,
      () => {
        throw new Error("No such file or directory (os error 2)");
      },
    );
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("dyfj start");
  });
});

// ── runRepl ───────────────────────────────────────────────────────────────────

describe("runRepl", () => {
  test("holds a multi-turn conversation and resumes the session", async () => {
    const { fn, calls } = recordingFetch([
      sseResponse([{ t: "delta", text: "a" }, {
        t: "done",
        result: result({ sessionId: "SESS1", text: "a" }),
      }]),
      sseResponse([{ t: "delta", text: "b" }, {
        t: "done",
        result: result({ sessionId: "SESS1", text: "b" }),
      }]),
    ]);
    const { io, stdout } = fakeIo(["first", "second"]);
    await runRepl(cfg(), io, fn);

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].init.body as string).sessionId).toBeUndefined();
    expect(JSON.parse(calls[1].init.body as string).sessionId).toBe("SESS1");
    expect(stdout.join("")).toContain("a");
    expect(stdout.join("")).toContain("b");
  });

  test("skips blank lines and exits on /exit", async () => {
    const { fn, calls } = recordingFetch([
      sseResponse([{ t: "done", result: result() }]),
    ]);
    const { io } = fakeIo(["   ", "real", "/exit", "never"]);
    await runRepl(cfg(), io, fn);
    expect(calls).toHaveLength(1);
  });

  test("keeps the REPL alive after a turn error", async () => {
    const { fn, calls } = recordingFetch([
      sseResponse([{ t: "error", message: "transient" }]),
      sseResponse([{ t: "done", result: result() }]),
    ]);
    const { io, stderr } = fakeIo(["one", "two"]);
    await runRepl(cfg(), io, fn);
    expect(calls).toHaveLength(2);
    expect(stderr.join("\n")).toContain("transient");
  });

  test("exits the REPL after cancellation leaves remote work uncertain", async () => {
    let turnCalls = 0;
    const interrupts: TurnInterruptSource = {
      add: (handler) => queueMicrotask(handler),
      remove: () => {
        throw new Error("interrupt cleanup failed");
      },
    };
    const connect: ConnectFn = () =>
      Promise.resolve({
        request: (method) => {
          if (method === "turn") {
            turnCalls++;
            return new Promise(() => {});
          }
          return Promise.reject(new Error("cancel transport failed"));
        },
        close: () => {},
      });
    const { io, stderr, prompts } = fakeIo(["first", "second"]);

    const code = await runRepl(
      cfg({ unix: true }),
      io,
      fetch,
      connect,
      false,
      interrupts,
    );

    expect(turnCalls).toBe(1);
    expect(code).toBe(1);
    expect(prompts).toHaveLength(1);
    const renderedError = stderr.join("\n");
    expect(renderedError).toContain(
      "turn cancellation was not acknowledged; restart the runtime before retrying",
    );
    expect(renderedError).not.toContain("interrupt cleanup failed");
  });

  test("receipts carry the running session total across turns", async () => {
    const paid = (totalUsd: number) =>
      result({ cost: { estimatedUsd: 0, totalUsd, paidInferenceUsed: true } });
    const { fn } = recordingFetch([
      sseResponse([{ t: "done", result: paid(0.01) }]),
      sseResponse([{ t: "done", result: paid(0.02) }]),
    ]);
    const { io, stderr } = fakeIo(["one", "two"]);
    await runRepl(cfg(), io, fn);
    const text = stderr.join("\n");
    // Each receipt shows the sum of every per-turn cost so far.
    expect(text).toContain("session $0.0100");
    expect(text).toContain("session $0.0300");
  });

  test("Ctrl-C cancels one UDS turn and carries its session into the next request", async () => {
    const bodies: Array<{ sessionId?: string }> = [];
    let finishFirst!: (value: unknown) => void;
    let activeInterrupt: (() => void) | undefined;
    let interruptCount = 0;
    const interrupts: TurnInterruptSource = {
      add: (handler) => {
        interruptCount++;
        activeInterrupt = handler;
      },
      remove: () => {
        activeInterrupt = undefined;
      },
    };
    const connect: ConnectFn = (_socketPath, options) =>
      Promise.resolve({
        request: (method, params) => {
          if (method === "turn") {
            bodies.push(params as { sessionId?: string });
            if (bodies.length === 1) {
              options?.onStream?.({ t: "delta", text: "partial" });
              queueMicrotask(() => {
                activeInterrupt?.();
                activeInterrupt?.();
              });
              return new Promise((resolve) => {
                finishFirst = resolve;
              });
            }
            options?.onStream?.({ t: "delta", text: "next" });
            return Promise.resolve(result({ text: "next" }));
          }
          if (method === "turn/cancel") {
            options?.onStream?.({
              t: "event",
              event: { type: "turnAborted" },
            });
            finishFirst(result({ stopReason: "aborted", text: "partial" }));
            return Promise.resolve({ cancelled: true });
          }
          return Promise.resolve(undefined);
        },
        close: () => {},
      });
    const { io, stdout, stderr, raw } = fakeIo(
      ["first", "second"],
      { errIsTerminal: true },
    );
    io.turnInterrupts = interrupts;

    await runRepl(
      cfg({ unix: true }),
      io,
      fetch,
      connect,
      false,
    );

    expect(stdout.join("")).toContain("partial");
    expect(stdout.join("")).toContain("next");
    expect(stderr).toContain("[interrupted]");
    expect(stderr.filter((line) => line === "[interrupt requested]")).toEqual([
      "[interrupt requested]",
    ]);
    expect(bodies[0].sessionId).toBeUndefined();
    expect(bodies[1].sessionId).toBe(result().sessionId);
    expect(raw[raw.length - 1]).toBe(ERASE_LINE);
  });

  test("an aborted receipt commits its session before fallible rendering", async () => {
    const bodies: Array<{ sessionId?: string }> = [];
    const firstSessionId = "01ABORTEDSESSION000000000000";
    const connect: ConnectFn = (_socketPath, options) =>
      Promise.resolve({
        request: (method, params) => {
          if (method !== "turn") return Promise.resolve(undefined);
          bodies.push(params as { sessionId?: string });
          if (bodies.length === 1) {
            options?.onStream?.({ t: "delta", text: "partial" });
            return Promise.resolve(result({
              sessionId: firstSessionId,
              stopReason: "aborted",
              text: "partial",
            }));
          }
          return Promise.resolve(result({ sessionId: firstSessionId }));
        },
        close: () => {},
      });
    const { io } = fakeIo(["first", "second"]);
    const write = io.out;
    let failNextWrite = true;
    io.out = (text) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("stdout failed");
      }
      write(text);
    };

    await runRepl(cfg({ unix: true }), io, fetch, connect);

    expect(bodies).toHaveLength(2);
    expect(bodies[0].sessionId).toBeUndefined();
    expect(bodies[1].sessionId).toBe(firstSessionId);
  });

  test("an aborted receipt commits its session before fallible spinner cleanup", async () => {
    const bodies: Array<{ sessionId?: string }> = [];
    const firstSessionId = "01ABORTEDSESSION000000000000";
    const connect: ConnectFn = () =>
      Promise.resolve({
        request: (method, params) => {
          if (method !== "turn") return Promise.resolve(undefined);
          bodies.push(params as { sessionId?: string });
          return Promise.resolve(result({
            sessionId: firstSessionId,
            stopReason: bodies.length === 1 ? "aborted" : "stop",
          }));
        },
        close: () => {},
      });
    const { io } = fakeIo(["first", "second"], { errIsTerminal: true });
    let rawWrites = 0;
    io.errRaw = () => {
      rawWrites++;
      if (rawWrites === 2) throw new Error("terminal erase failed");
    };

    await runRepl(cfg({ unix: true }), io, fetch, connect);

    expect(bodies).toHaveLength(2);
    expect(bodies[0].sessionId).toBeUndefined();
    expect(bodies[1].sessionId).toBe(firstSessionId);
  });

  test("prints buffered aborted text before the interrupted marker", async () => {
    let activeInterrupt: (() => void) | undefined;
    const interrupts: TurnInterruptSource = {
      add: (handler) => {
        activeInterrupt = handler;
      },
      remove: () => {
        activeInterrupt = undefined;
      },
    };
    let finishTurn!: (value: unknown) => void;
    const connect: ConnectFn = () =>
      Promise.resolve({
        request: (method) => {
          if (method === "turn") {
            queueMicrotask(() => activeInterrupt?.());
            return new Promise((resolve) => {
              finishTurn = resolve;
            });
          }
          if (method === "turn/cancel") {
            finishTurn(result({
              stopReason: "aborted",
              text: "buffered partial text",
            }));
            return Promise.resolve({ cancelled: true });
          }
          return Promise.resolve(undefined);
        },
        close: () => {},
      });
    const writes: string[] = [];
    let readCount = 0;
    const io: Io = {
      out: (text) => writes.push(`out:${text}`),
      err: (line) => writes.push(`err:${line}`),
      readLine: () => Promise.resolve(readCount++ === 0 ? "first" : null),
      close: () => {},
    };

    await runRepl(
      cfg({ unix: true }),
      io,
      fetch,
      connect,
      false,
      interrupts,
    );

    const textIndex = writes.findIndex((write) =>
      write.includes("buffered partial text")
    );
    const markerIndex = writes.indexOf("err:[interrupted]");
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeGreaterThan(textIndex);
  });

  test("Ctrl-C cancels a pending approval read before the next REPL prompt", async () => {
    let interrupt: (() => void) | undefined;
    const interrupts: TurnInterruptSource = {
      add: (handler) => {
        interrupt = handler;
      },
      remove: () => {
        interrupt = undefined;
      },
    };
    let readCount = 0;
    let approvalReadSettled = false;
    let approvalSignal: AbortSignal | undefined;
    const io: Io = {
      out: () => {},
      err: () => {},
      readLine: (_prompt, signal) => {
        readCount++;
        if (readCount === 1) return Promise.resolve("first");
        if (readCount === 2) {
          approvalSignal = signal;
          return new Promise((resolve) => {
            signal?.addEventListener(
              "abort",
              () => {
                approvalReadSettled = true;
                resolve(null);
              },
              { once: true },
            );
          });
        }
        expect(approvalReadSettled).toBe(true);
        return Promise.resolve("/exit");
      },
      close: () => {},
    };
    const connect: ConnectFn = (_socketPath, options) =>
      Promise.resolve({
        request: (method) => {
          if (method === "runtime/status") {
            return Promise.resolve({ runtime: {} });
          }
          if (method === "turn") {
            const approval = options?.onApproval?.({
              kind: "tool",
              commandId: "write_file",
            });
            queueMicrotask(() => interrupt?.());
            return Promise.resolve(approval).then(() =>
              result({ stopReason: "aborted" })
            );
          }
          if (method === "turn/cancel") {
            return Promise.resolve({ cancelled: true });
          }
          return Promise.resolve(undefined);
        },
        close: () => {},
      });

    await runRepl(
      cfg({ unix: true }),
      io,
      fetch,
      connect,
      true,
      interrupts,
    );

    expect(approvalSignal?.aborted).toBe(true);
    expect(approvalReadSettled).toBe(true);
    expect(readCount).toBe(3);
  });

  test("a spinner startup failure never installs the in-flight interrupt handler", async () => {
    let added = 0;
    let removed = 0;
    let connectCalls = 0;
    const interrupts: TurnInterruptSource = {
      add: () => {
        added++;
      },
      remove: () => {
        removed++;
      },
    };
    const connect: ConnectFn = () => {
      connectCalls++;
      return Promise.reject(new Error("should not connect"));
    };
    const { io } = fakeIo(["first", "/exit"], { errIsTerminal: true });
    io.errRaw = () => {
      throw new Error("spinner write failed");
    };

    await runRepl(
      cfg({ unix: true }),
      io,
      fetch,
      connect,
      false,
      interrupts,
    );

    expect(added).toBe(0);
    expect(removed).toBe(0);
    expect(connectCalls).toBe(0);
  });

  test("does not intercept SIGINT until the UDS connection is established", async () => {
    let added = 0;
    let removed = 0;
    const interrupts: TurnInterruptSource = {
      add: () => {
        added++;
      },
      remove: () => {
        removed++;
      },
    };
    let finishConnect!: (client: Awaited<ReturnType<ConnectFn>>) => void;
    let markConnectStarted!: () => void;
    const connectStarted = new Promise<void>((resolve) => {
      markConnectStarted = resolve;
    });
    const connect: ConnectFn = () => {
      markConnectStarted();
      return new Promise((resolve) => {
        finishConnect = resolve;
      });
    };
    const { io } = fakeIo(["first", "/exit"]);
    const pending = runRepl(
      cfg({ unix: true }),
      io,
      fetch,
      connect,
      false,
      interrupts,
    );

    await connectStarted;
    expect(added).toBe(0);
    finishConnect({
      request: (method) =>
        method === "turn"
          ? Promise.resolve(result())
          : Promise.resolve(undefined),
      close: () => {},
    });
    await pending;

    expect(added).toBe(1);
    expect(removed).toBe(1);
  });

  test("a spinner erase failure cannot prevent an installed turn cancellation", async () => {
    const interrupts: TurnInterruptSource = {
      add: (handler) => {
        queueMicrotask(handler);
      },
      remove: () => {},
    };
    let finishTurn!: (value: unknown) => void;
    let cancellationCalls = 0;
    const connect: ConnectFn = () =>
      Promise.resolve({
        request: (method) => {
          if (method === "turn") {
            return new Promise((resolve) => {
              finishTurn = resolve;
            });
          }
          if (method === "turn/cancel") {
            cancellationCalls++;
            finishTurn(result({ stopReason: "aborted" }));
            return Promise.resolve({ cancelled: true });
          }
          return Promise.resolve(undefined);
        },
        close: () => {},
      });
    const { io } = fakeIo(["first", "/exit"], { errIsTerminal: true });
    let rawWrites = 0;
    io.errRaw = () => {
      rawWrites++;
      if (rawWrites > 1) throw new Error("stderr failed");
    };

    await runRepl(
      cfg({ unix: true }),
      io,
      fetch,
      connect,
      false,
      interrupts,
    );

    expect(cancellationCalls).toBe(1);
  });
});

// ── parseArgs / resolveConfig / presentation ─────────────────────────────────

describe("parseArgs", () => {
  test("bare args is the REPL", () => {
    expect(parseArgs([]).command).toBe("repl");
  });
  test("exec joins the prompt words", () => {
    const p = parseArgs(["exec", "summarize", "the", "repo"]);
    expect(p.command).toBe("exec");
    expect(p.prompt).toBe("summarize the repo");
  });
  test("-p is an exec alias", () => {
    const p = parseArgs(["-p", "hello"]);
    expect(p).toMatchObject({ command: "exec", prompt: "hello" });
  });
  test("parses only the declared external runners", () => {
    expect(parseArgs(["--runner", "fixture", "exec", "hi"]).overrides.runner)
      .toBe("fixture");
    expect(
      parseArgs([
        "--runner",
        "codex-chatgpt",
        "exec",
        "hi",
      ]).overrides.runner,
    ).toBe("codex-chatgpt");
    expect(parseArgs(["--runner", "vendor", "exec", "hi"]).error)
      .toContain("runner must be fixture or codex-chatgpt");
  });

  test("keeps the Codex ChatGPT runner one-shot", () => {
    expect(parseArgs(["--runner", "codex-chatgpt"]).error).toContain(
      "one-shot",
    );
    expect(
      parseArgs([
        "--runner",
        "codex-chatgpt",
        "--session",
        "01ABCDEF0123456789ABCDEF01",
        "exec",
        "hi",
      ]).error,
    ).toContain("does not support --session");
    for (const command of ["status", "models", "sessions", "start"]) {
      expect(parseArgs(["--runner", "codex-chatgpt", command]).error)
        .toContain("one-shot");
    }
    expect(
      parseArgs(["--runner", "codex-chatgpt", "status", "-p", "hi"]),
    ).toMatchObject({ command: "exec", prompt: "hi" });
  });

  test("rejects explicit model routing alongside a runner", () => {
    for (
      const routing of [["--model", "model"], ["--tier", "1"], [
        "--hint",
        "code",
      ]]
    ) {
      expect(
        parseArgs(["--runner", "fixture", ...routing, "exec", "hi"]).error,
      ).toContain("runner cannot be combined");
    }
  });
  test("collects routing + server flags", () => {
    const p = parseArgs([
      "--model",
      "m",
      "--tier",
      "2",
      "--hint",
      "code",
      "--server",
      "http://h",
      "exec",
      "hi",
    ]);
    expect(p.overrides).toMatchObject({
      model: "m",
      tier: 2,
      hint: "code",
      serverUrl: "http://h",
    });
    expect(p.prompt).toBe("hi");
    expect(parseArgs(["--workspace", "/ws", "exec", "hi"]).overrides.workspace)
      .toBe("/ws");
  });
  test("rejects an invalid tier", () => {
    expect(parseArgs(["--tier", "9", "exec", "x"]).error).toContain("tier");
  });
  test("rejects an unknown flag", () => {
    expect(parseArgs(["--wat"]).error).toContain("unknown flag");
  });
  test("canonicalizes a valid --session value", () => {
    expect(
      parseArgs(["--session", "workbench-01ktz1xwcn7jmgs5e8kakfezkr"])
        .overrides.sessionId,
    ).toBe("01KTZ1XWCN7JMGS5E8KAKFEZKR");
  });
  test("rejects a garbage --session as a parse error, not a throw", () => {
    const p = parseArgs(["--session", "garbage-value"]);
    expect(p.command).toBe("help");
    expect(p.error).toContain("dyfj sessions");
    // main prefixes "dyfj: "; the parse error must not carry its own.
    expect(p.error).not.toMatch(/^dyfj:/);
  });
  test("--help asks for help", () => {
    expect(parseArgs(["--help"]).command).toBe("help");
  });
  test("'models' and 'sessions' are their own commands", () => {
    expect(parseArgs(["models"]).command).toBe("models");
    expect(parseArgs(["sessions"]).command).toBe("sessions");
  });
  test("'status' and 'start' are their own commands", () => {
    expect(parseArgs(["status"]).command).toBe("status");
    expect(parseArgs(["start"]).command).toBe("start");
  });
  test("accepts the internal launcher marker only on start", () => {
    expect(parseArgs(["start", "--launcher-autostarted"])).toMatchObject({
      command: "start",
      launcherAutostarted: true,
    });
    expect(parseArgs(["-p", "--launcher-autostarted"])).toMatchObject({
      command: "exec",
      prompt: "--launcher-autostarted",
    });
  });
  test("rejects the internal launcher marker outside start", () => {
    for (
      const argv of [
        ["--launcher-autostarted"],
        ["status", "--launcher-autostarted"],
        ["start", "extra", "--launcher-autostarted"],
        ["-p", "hello", "start", "--launcher-autostarted"],
        ["start", "--launcher-autostarted", "--help"],
      ]
    ) {
      expect(parseArgs(argv).error).toContain(
        "--launcher-autostarted is valid only with start",
      );
    }
  });
  test("--socket overrides the socket path", () => {
    expect(parseArgs(["--socket", "/run/x.sock", "models"]).overrides.socket)
      .toBe("/run/x.sock");
  });
  test("--unix routes turns over the socket", () => {
    expect(parseArgs(["--unix", "exec", "x"]).overrides.unix).toBe(true);
  });
  test("--approve-paid sets the paid opt-in", () => {
    expect(parseArgs(["--approve-paid", "exec", "x"]).overrides.approvePaid)
      .toBe(true);
  });
  test("--mode sets the context mode", () => {
    expect(parseArgs(["--mode", "ask", "exec", "x"]).overrides.mode).toBe(
      "ask",
    );
  });
  test("rejects an invalid mode", () => {
    expect(parseArgs(["--mode", "wat", "exec", "x"]).error).toContain("mode");
  });
  test("'ask' is a one-shot ask-mode exec", () => {
    const p = parseArgs(["ask", "what", "is", "this", "repo"]);
    expect(p.command).toBe("exec");
    expect(p.prompt).toBe("what is this repo");
    expect(p.overrides.mode).toBe("ask");
  });
  test("'ask' requires a prompt", () => {
    expect(parseArgs(["ask"]).error).toContain("ask requires a prompt");
  });
});

describe("resolveConfig", () => {
  test("overrides beat env, env beats defaults", () => {
    const env = new Map([
      ["DYFJ_SERVER_URL", "http://env"],
      ["DYFJ_WORKBENCH_MODEL", "envmodel"],
      ["NO_COLOR", "1"],
    ]);
    const c = resolveConfig(
      { model: "flagmodel" },
      { get: (k) => env.get(k) },
      true,
    );
    expect(c.serverUrl).toBe("http://env");
    expect(c.model).toBe("flagmodel");
    expect(c.color).toBe(false);
  });
  test("defaults the server and enables color on a TTY", () => {
    const c = resolveConfig({}, { get: () => undefined }, true);
    expect(c.serverUrl).toBe("http://127.0.0.1:8787");
    expect(c.color).toBe(true);
  });
  test("defaults to the UDS seam locally; --server switches to HTTP", () => {
    // No server configured → local-first default is the UDS seam.
    expect(resolveConfig({}, { get: () => undefined }).unix).toBe(true);
    // An explicit --server opts into HTTP.
    expect(
      resolveConfig({ serverUrl: "http://remote.example" }, {
        get: () => undefined,
      }).unix,
    ).toBe(false);
    // DYFJ_SERVER_URL env also opts into HTTP.
    expect(
      resolveConfig({}, {
        get: (k) => (k === "DYFJ_SERVER_URL" ? "http://e" : undefined),
      }).unix,
    ).toBe(false);
    // --unix forces the seam even with a server configured.
    expect(
      resolveConfig({ unix: true, serverUrl: "http://e" }, {
        get: () => undefined,
      }).unix,
    ).toBe(true);
  });
  test("mode defaults to turn and honors the override", () => {
    expect(resolveConfig({}, { get: () => undefined }).mode).toBe("turn");
    expect(resolveConfig({ mode: "ask" }, { get: () => undefined }).mode).toBe(
      "ask",
    );
  });
  test("workspace defaults to cwd; flag and env override it", () => {
    expect(
      resolveConfig({}, { get: () => undefined }, false, "/work/dir").workspace,
    )
      .toBe("/work/dir");
    const env = new Map([["DYFJ_WORKSPACE", "/env/ws"]]);
    expect(
      resolveConfig({}, { get: (k) => env.get(k) }, false, "/cwd").workspace,
    )
      .toBe("/env/ws");
    expect(
      resolveConfig(
        { workspace: "/flag/ws" },
        { get: (k) => env.get(k) },
        false,
        "/cwd",
      )
        .workspace,
    ).toBe("/flag/ws");
  });
  test("marks workspace explicit only when set via flag or env", () => {
    expect(
      resolveConfig({}, { get: () => undefined }, false, "/cwd")
        .workspaceExplicit,
    )
      .toBe(false);
    expect(
      resolveConfig(
        { workspace: "/w" },
        { get: () => undefined },
        false,
        "/cwd",
      )
        .workspaceExplicit,
    ).toBe(true);
    const env = new Map([["DYFJ_WORKSPACE", "/env"]]);
    expect(
      resolveConfig({}, { get: (k) => env.get(k) }, false, "/cwd")
        .workspaceExplicit,
    ).toBe(true);
  });
  test("socket defaults via DYFJ_SOCKET and the --socket override", () => {
    const env = new Map([["DYFJ_SOCKET", "/run/dyfj.sock"]]);
    expect(resolveConfig({}, { get: (k) => env.get(k) }).socket).toBe(
      "/run/dyfj.sock",
    );
    expect(
      resolveConfig({ socket: "/flag.sock" }, { get: (k) => env.get(k) })
        .socket,
    ).toBe("/flag.sock");
  });
  test("unix: --unix / --unix=false / DYFJ_UNIX override the default", () => {
    expect(resolveConfig({ unix: true }, { get: () => undefined }).unix).toBe(
      true,
    );
    expect(resolveConfig({ unix: false }, { get: () => undefined }).unix).toBe(
      false,
    );
    const env = new Map([["DYFJ_UNIX", "1"]]);
    expect(resolveConfig({}, { get: (k) => env.get(k) }).unix).toBe(true);
  });
});

describe("models/sessions over UDS", () => {
  function fakeConnect(responses: Record<string, unknown>): ConnectFn {
    return (_socketPath: string) =>
      Promise.resolve({
        request: (method: string) => Promise.resolve(responses[method]),
        close: () => {},
      });
  }

  test("runModels lists models from the seam", async () => {
    const { io, stdout } = fakeIo();
    const code = await runModels(
      cfg(),
      io,
      fakeConnect({
        "models/list": {
          models: [
            {
              slug: "gemma4",
              tier: 0,
              provider: "ollama",
              displayName: "Gemma 4",
            },
          ],
        },
      }),
    );
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("gemma4");
    expect(stdout.join("")).toContain("Gemma 4");
  });

  test("runModels annotates rows the server marked unroutable", async () => {
    const { io, stdout } = fakeIo();
    const code = await runModels(
      cfg(),
      io,
      fakeConnect({
        "models/list": {
          models: [
            {
              slug: "gemma4",
              tier: 0,
              provider: "ollama",
              displayName: "Gemma 4",
              routable: true,
            },
            {
              slug: "gpt-6-preview",
              tier: 2,
              provider: "openai",
              displayName: "GPT-6 Preview",
              routable: false,
            },
            // Older server: no flag — must not be smeared as unpriced.
            {
              slug: "claude-opus-4-8",
              tier: 2,
              provider: "anthropic",
              displayName: "Claude Opus 4.8",
            },
          ],
        },
      }),
    );
    expect(code).toBe(0);
    const out = stdout.join("");
    const lines = out.split("\n");
    expect(lines.find((l) => l.includes("gpt-6-preview"))).toContain(
      "[unpriced — not routable]",
    );
    expect(lines.find((l) => l.includes("gemma4"))).not.toContain("unpriced");
    expect(lines.find((l) => l.includes("claude-opus-4-8"))).not.toContain(
      "unpriced",
    );
  });

  test("runSessions groups by project", async () => {
    const { io, stdout } = fakeIo();
    const code = await runSessions(
      cfg(),
      io,
      fakeConnect({
        "sessions/list": {
          projects: [
            {
              project: "dyfj",
              sessions: [{ slug: "s-1", sessionName: "Build" }],
            },
          ],
        },
      }),
    );
    expect(code).toBe(0);
    const out = stdout.join("");
    expect(out).toContain("dyfj");
    expect(out).toContain("s-1");
    expect(out).toContain("Build");
  });

  test("runSessions shows when each session last moved and a resume hint", async () => {
    const { io, stdout, stderr } = fakeIo();
    const code = await runSessions(
      cfg(),
      io,
      fakeConnect({
        "sessions/list": {
          projects: [
            {
              project: "dyfj",
              sessions: [{
                slug: "workbench-01ktz1xwcn7jmgs5e8kakfezkr",
                sessionName: "Build",
                updatedAt: "2026-07-05 09:12:33.123456",
              }],
            },
          ],
        },
      }),
    );
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("2026-07-05 09:12");
    expect(stderr.join("\n")).toContain("resume one with: dyfj --session");
  });

  test("a connection failure points the operator at dyfj start", async () => {
    const { io, stderr } = fakeIo();
    const code = await runModels(
      cfg({ socket: "/run/missing.sock" }),
      io,
      () => {
        throw new Error("No such file or directory (os error 2)");
      },
    );
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("dyfj start");
    expect(stderr.join("\n")).toContain("/run/missing.sock");
  });
});

describe("runtime lifecycle commands", () => {
  function fakeConnect(responses: Record<string, unknown>): ConnectFn {
    return (_socketPath: string) =>
      Promise.resolve({
        request: (method: string) => Promise.resolve(responses[method]),
        close: () => {},
      });
  }

  test("formatRuntimeStatus gives an operator-readable local snapshot", () => {
    const text = formatRuntimeStatus(cfg({ socket: "/run/wb.sock" }), {
      runtime: {
        transport: "uds",
        clearance: "loopback",
        defaultCompanionModel: "qwen-local",
        permissionLevel: "strict",
        approvePaidDefault: false,
        defaultSessionBudgetUsd: 2,
        defaultPerCallBudgetUsd: 0.25,
        maxToolSteps: 7,
        models: { total: 3, local: 1, hosted: 2 },
        methods: ["runtime/status", "models/list"],
      },
    });
    expect(text).toContain("runtime: reachable");
    expect(text).toContain("socket: /run/wb.sock");
    expect(text).toContain("qwen-local");
    expect(text).toContain("3 total");
    expect(text).toContain("tool-step limit: 7");
    expect(text).toContain("methods: 2");
    // The runtime omits the trust field here (older/incomplete response), so the
    // stance is unknown — never asserted "off" without evidence.
    expect(text).toContain("workspace instructions: unknown");
    // No server-resolved bare-turn route in the payload (older server) — the
    // line is omitted rather than rendered with unknowns.
    expect(text).not.toContain("bare-turn route");
  });

  test("formatRuntimeStatus reports the workspace-instruction trust state", () => {
    const render = (trust?: boolean) =>
      formatRuntimeStatus(cfg({ socket: "/run/wb.sock" }), {
        runtime: {
          transport: "uds",
          clearance: "loopback",
          ...(trust === undefined ? {} : { trustWorkspaceInstructions: trust }),
        },
      });
    expect(render(true)).toContain("workspace instructions: trusted");
    // Literal false pins "off" to real evidence, never inferred from absence.
    expect(render(false)).toContain("workspace instructions: off");
    expect(render(undefined)).toContain("workspace instructions: unknown");
  });

  test("malformed trust values render unknown on both surfaces — literal booleans only", () => {
    // The wire value is unvalidated JSON: the TypeScript type says boolean,
    // but a drifted or buggy runtime can send anything. A stringly "false" is
    // truthy, and null/0 are falsy-but-not-false — none of them are evidence,
    // and none may render as a confirmed posture.
    const malformed: unknown[] = [null, "false", "true", 0, 1, {}, []];
    for (const value of malformed) {
      const statusText = formatRuntimeStatus(cfg({ socket: "/run/wb.sock" }), {
        runtime: {
          trustWorkspaceInstructions: value as unknown as boolean,
        },
      });
      expect(statusText).toContain("workspace instructions: unknown");
      const postureLine = formatPostureLine({
        slug: "x",
        approvePaidSession: false,
        trustWorkspaceInstructions: value as unknown as boolean,
      });
      expect(postureLine).toContain("workspace instructions: unknown");
    }
  });

  test("formatRuntimeStatus shows the resolved bare-turn route when reported", () => {
    const text = formatRuntimeStatus(cfg({ socket: "/run/wb.sock" }), {
      runtime: {
        defaultCompanionModel: "claude-opus-4-8",
        defaultTurnModel: { slug: "qwen-local", tier: 0, local: true },
      },
    });
    // The configured default and the actual bare-turn route can differ under
    // the local-by-default posture; status shows both.
    expect(text).toContain("default model: claude-opus-4-8");
    expect(text).toContain("bare-turn route: qwen-local (tier 0, local)");
  });

  test("formatRuntimeStatus renders an unavailable bare-turn route on explicit null", () => {
    // The server tried and bare-turn selection failed (any cause — the null
    // carries no reason) — say so rather than silently omitting the line
    // (omission is reserved for older servers that never sent the field).
    const text = formatRuntimeStatus(cfg(), {
      runtime: { defaultTurnModel: null },
    });
    // The full line is contractual operator guidance — pin it verbatim.
    expect(text).toContain(
      "bare-turn route: unavailable (selection failed — check the model " +
        "registry and default model)",
    );
  });

  test("runStatus reports reachable runtime details", async () => {
    const { io, stdout } = fakeIo();
    const code = await runStatus(
      cfg({ socket: "/run/wb.sock" }),
      io,
      fakeConnect({
        "runtime/status": {
          runtime: {
            transport: "uds",
            clearance: "loopback",
            models: { total: 1, local: 1, hosted: 0 },
            methods: ["runtime/status"],
          },
        },
      }),
    );
    expect(code).toBe(0);
    const out = stdout.join("");
    expect(out).toContain("runtime: reachable");
    expect(out).toContain("/run/wb.sock");
  });

  test("runStatus reports unreachable runtime and start hint", async () => {
    const { io, stdout, stderr } = fakeIo();
    const code = await runStatus(
      cfg({ socket: "/run/missing.sock" }),
      io,
      () => {
        throw new Error("No such file or directory (os error 2)");
      },
    );
    expect(code).toBe(1);
    expect(stdout.join("")).toContain("runtime: unreachable");
    expect(stderr.join("\n")).toContain("dyfj start");
  });

  test("runStart delegates to the runtime starter", async () => {
    const { io, stderr } = fakeIo();
    const calls: string[] = [];
    const starter: StartRuntimeFn = (config) => {
      calls.push(config.socket);
      return Promise.resolve(0);
    };
    const code = await runStart(cfg({ socket: "/run/wb.sock" }), io, starter);
    expect(code).toBe(0);
    expect(calls).toEqual(["/run/wb.sock"]);
    expect(stderr.join("\n")).toContain("foreground process");
  });

  test("runStart describes the autostarted signal posture accurately", async () => {
    const { io, stderr } = fakeIo();
    let receivedAutostarted: boolean | undefined;
    const code = await runStart(
      cfg(),
      io,
      (_config, options) => {
        receivedAutostarted = options?.autostarted;
        return Promise.resolve(0);
      },
      true,
    );

    expect(code).toBe(0);
    expect(receivedAutostarted).toBe(true);
    expect(stderr.join("\n")).toContain("autostarted process");
    expect(stderr.join("\n")).toContain("leaves the runtime running");
    expect(stderr.join("\n")).not.toContain("foreground process");
  });

  test("runStart fails with a precise fallback command", async () => {
    const { io, stderr } = fakeIo();
    const code = await runStart(cfg(), io, () => {
      throw new Error("permission denied");
    });
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("could not start");
    expect(stderr.join("\n")).toContain("deno task serve-unix");
  });

  // Every client error printer must share one discipline: runStart's printer
  // needs the same oversized-case pin friendlyError/socketError carry.
  test("runStart truncates an oversized runtime-start error the same way as friendlyError", async () => {
    const payload = "x".repeat(200_000);
    const { io, stderr } = fakeIo();
    const code = await runStart(cfg(), io, () => {
      throw new Error(payload);
    });
    expect(code).toBe(1);
    const out = stderr.join("\n");
    expect(out).not.toContain(payload);
    const errorLine = stderr.find((line) => line.includes("could not start"))!;
    expect(errorLine).toContain("Error");
    expect(errorLine).toContain(`${payload.length} bytes`);
    expect(errorLine.length).toBeLessThan(1000);
  });

  test("buildServeUnixArgs grants the resolved socket alongside the profile net list", () => {
    const args = buildServeUnixArgs(
      ["127.0.0.1:3306", "localhost:18080"],
      "/run/wb.sock",
    );
    expect(args).toEqual([
      "run",
      "--no-prompt",
      "-P=serve-unix",
      "--allow-net=127.0.0.1:3306,localhost:18080,unix:/run/wb.sock",
      "--env-file=.env",
      "--sloppy-imports",
      "src/uds-serve.ts",
    ]);
  });

  test("buildServeUnixArgs does not duplicate an already-granted socket", () => {
    const args = buildServeUnixArgs(
      ["unix:/run/wb.sock"],
      "/run/wb.sock",
    );
    expect(args[3]).toBe("--allow-net=unix:/run/wb.sock");
  });

  test("buildServeUnixArgs marks only an autostarted runtime", () => {
    const foreground = buildServeUnixArgs(
      ["127.0.0.1:3306"],
      "/run/wb.sock",
    );
    const autostarted = buildServeUnixArgs(
      ["127.0.0.1:3306"],
      "/run/wb.sock",
      null,
      null,
      null,
      true,
    );

    expect(foreground).not.toContain("--autostarted");
    expect(autostarted.at(-1)).toBe("--autostarted");
  });

  test("buildServeUnixArgs appends the launch-resolved memory endpoint grant", () => {
    const args = buildServeUnixArgs(
      ["127.0.0.1:3306"],
      "/run/wb.sock",
      "memory.example:443",
    );
    expect(args[3]).toBe(
      "--allow-net=127.0.0.1:3306,unix:/run/wb.sock,memory.example:443",
    );
  });

  test("buildServeUnixArgs appends unique config-declared MCP endpoint grants", () => {
    const args = buildServeUnixArgs(
      ["127.0.0.1:3306", "mcp.linear.app:443"],
      "/run/wb.sock",
      null,
      null,
      null,
      false,
      ["mcp.linear.app:443", "127.0.0.1:43137"],
    );
    expect(args[3]).toBe(
      "--allow-net=127.0.0.1:3306,mcp.linear.app:443,unix:/run/wb.sock,127.0.0.1:43137",
    );
  });

  test("buildServeUnixArgs rejects comma-bearing network grants", () => {
    expect(() =>
      buildServeUnixArgs(
        ["127.0.0.1:3306"],
        "/run/wb.sock",
        null,
        null,
        null,
        false,
        ["foo,bar.example:443"],
      )
    ).toThrow("Deno network grants cannot contain commas");
  });

  test("buildServeUnixArgs adds no memory grant when recall is unconfigured", () => {
    const args = buildServeUnixArgs(["127.0.0.1:3306"], "/run/wb.sock", null);
    expect(args[3]).toBe("--allow-net=127.0.0.1:3306,unix:/run/wb.sock");
  });

  test("buildServeUnixArgs does not duplicate an already-granted memory host", () => {
    const args = buildServeUnixArgs(
      ["memory.example:443"],
      "/run/wb.sock",
      "memory.example:443",
    );
    expect(args[3]).toBe(
      "--allow-net=memory.example:443,unix:/run/wb.sock",
    );
  });

  test("memoryMcpNetGrant derives host:port, defaulting the scheme port", () => {
    expect(memoryMcpNetGrant(undefined)).toBeNull();
    expect(memoryMcpNetGrant("")).toBeNull();
    expect(memoryMcpNetGrant("https://memory.example/mcp")).toBe(
      "memory.example:443",
    );
    expect(memoryMcpNetGrant("https://memory.example:8443/mcp")).toBe(
      "memory.example:8443",
    );
    // Plain http is loopback-only; the default port still derives.
    expect(memoryMcpNetGrant("http://127.0.0.1:8080/mcp")).toBe(
      "127.0.0.1:8080",
    );
    expect(memoryMcpNetGrant("http://localhost/mcp")).toBe("localhost:80");
  });

  test("memoryMcpNetGrant keeps IPv6 hosts bracketed, as Deno grants require", () => {
    // WHATWG URL.hostname returns IPv6 literals WITH brackets (unlike legacy
    // url.parse), which is exactly the shape --allow-net expects.
    expect(memoryMcpNetGrant("http://[::1]:8443/mcp")).toBe("[::1]:8443");
    expect(memoryMcpNetGrant("https://[2001:db8::1]/mcp")).toBe(
      "[2001:db8::1]:443",
    );
  });

  test("memoryMcpNetGrant fails at launch on a malformed or insecure endpoint", () => {
    // Misconfiguration surfaces at `dyfj start`, not as NotCapable mid-recall —
    // and a grant is never derived for a destination that would carry the
    // token in cleartext off-box.
    expect(() => memoryMcpNetGrant("not a url")).toThrow("not a valid URL");
    expect(() => memoryMcpNetGrant("ftp://memory.example/mcp")).toThrow(
      "https",
    );
    expect(() => memoryMcpNetGrant("http://memory.example/mcp")).toThrow(
      "https",
    );
    // A DNS name that merely starts with "127." is routable, not loopback.
    expect(() => memoryMcpNetGrant("http://127.attacker.example/mcp")).toThrow(
      "https",
    );
    expect(() => memoryMcpNetGrant("http://127.example.com/mcp")).toThrow(
      "https",
    );
  });

  test("envFileVar reads the dotenv shapes --env-file accepts", () => {
    const text = [
      "# comment",
      "",
      "OTHER=1",
      'export DYFJ_MEMORY_MCP_URL="https://memory.example/mcp"',
    ].join("\n");
    expect(envFileVar(text, "DYFJ_MEMORY_MCP_URL")).toBe(
      "https://memory.example/mcp",
    );
    expect(envFileVar(text, "OTHER")).toBe("1");
    expect(envFileVar("A='x'\n", "A")).toBe("x");
    expect(envFileVar(text, "MISSING")).toBeUndefined();
  });

  const noAmbient = { get: () => undefined };

  test("readMemoryMcpNetGrant resolves the grant from the runtime env file", async () => {
    const grant = await readMemoryMcpNetGrant(
      "/proto",
      (path) => {
        expect(path).toBe("/proto/.env");
        return Promise.resolve(
          "DYFJ_MEMORY_MCP_URL=https://memory.example/mcp\n",
        );
      },
      noAmbient,
    );
    expect(grant).toBe("memory.example:443");
  });

  test("readMemoryMcpNetGrant is null without an env file or endpoint", async () => {
    expect(
      await readMemoryMcpNetGrant(
        "/proto",
        () => Promise.reject(new Error("ENOENT")),
        noAmbient,
      ),
    ).toBeNull();
    expect(
      await readMemoryMcpNetGrant(
        "/proto",
        () => Promise.resolve("OTHER=1\n"),
        noAmbient,
      ),
    ).toBeNull();
  });

  test("readMemoryMcpNetGrant prefers ambient env, as --env-file does in the child", async () => {
    // The spawned runtime inherits ambient env and --env-file does not override
    // it; the launcher must grant the host the child will actually dial.
    const grant = await readMemoryMcpNetGrant(
      "/proto",
      () => Promise.resolve("DYFJ_MEMORY_MCP_URL=https://stale.example/mcp\n"),
      {
        get: (
          name,
        ) => (name === "DYFJ_MEMORY_MCP_URL"
          ? "https://ambient.example/mcp"
          : undefined),
      },
    );
    expect(grant).toBe("ambient.example:443");
  });

  test("readMemoryMcpNetGrant treats an empty ambient value as authoritative", async () => {
    // --env-file does not fill an explicitly empty inherited var: the child
    // sees "" and disables recall, so no grant may be derived from the file.
    const grant = await readMemoryMcpNetGrant(
      "/proto",
      () => Promise.resolve("DYFJ_MEMORY_MCP_URL=https://memory.example/mcp\n"),
      { get: (name) => (name === "DYFJ_MEMORY_MCP_URL" ? "" : undefined) },
    );
    expect(grant).toBeNull();
  });

  test("every dyfj CLI surface may read the memory endpoint URL", async () => {
    // The launcher derives the child's net grant from DYFJ_MEMORY_MCP_URL, so
    // all three CLI permission surfaces (profile, compiled binary, launcher
    // script) must stay in lockstep on the env grant.
    const raw = await Deno.readTextFile("deno.json");
    const parsed = JSON.parse(raw) as {
      tasks: Record<string, string>;
      permissions: Record<string, { env?: string[] | boolean }>;
    };
    expect(parsed.permissions["cli"].env).toContain("DYFJ_MEMORY_MCP_URL");
    expect(parsed.permissions["cli"].env).toContain("DYFJ_NODE_PATH");
    expect(parsed.permissions["cli"].env).toContain(
      "DYFJ_CODEX_TOOLCHAIN_PATH",
    );
    expect(parsed.permissions["cli"].env).toContain("DYFJ_CODEX_RUSTUP_HOME");
    const compileEnv = parsed.tasks["compile-cli"].match(/--allow-env=(\S+)/)
      ?.[1];
    expect(compileEnv?.split(",")).toContain("DYFJ_MEMORY_MCP_URL");
    expect(compileEnv?.split(",")).toContain("DYFJ_NODE_PATH");
    expect(compileEnv?.split(",")).toContain("DYFJ_CODEX_TOOLCHAIN_PATH");
    expect(compileEnv?.split(",")).toContain("DYFJ_CODEX_RUSTUP_HOME");
    const launcher = await Deno.readTextFile("scripts/dyfj-launcher.sh");
    const launcherEnv = launcher.match(/printf '%s' '([^']+)'/)?.[1];
    expect(launcherEnv?.split(",")).toContain("DYFJ_MEMORY_MCP_URL");
    expect(launcherEnv?.split(",")).toContain("DYFJ_NODE_PATH");
    expect(launcherEnv?.split(",")).toContain("DYFJ_CODEX_TOOLCHAIN_PATH");
    expect(launcherEnv?.split(",")).toContain("DYFJ_CODEX_RUSTUP_HOME");
  });

  test("the internal autostart marker is not ambient process state", async () => {
    const raw = await Deno.readTextFile("deno.json");
    const parsed = JSON.parse(raw) as {
      tasks: Record<string, string>;
      permissions: Record<string, { env?: string[] | boolean }>;
    };
    expect(parsed.permissions["cli"].env).not.toContain("DYFJ_AUTOSTARTED");
    const compileEnv = parsed.tasks["compile-cli"].match(/--allow-env=(\S+)/)
      ?.[1];
    expect(compileEnv?.split(",")).not.toContain("DYFJ_AUTOSTARTED");
    const launcher = await Deno.readTextFile("scripts/dyfj-launcher.sh");
    const launcherEnv = launcher.match(/printf '%s' '([^']+)'/)?.[1];
    expect(launcherEnv?.split(",")).not.toContain("DYFJ_AUTOSTARTED");
  });

  test("readServeUnixNetGrants reads the real profile", async () => {
    // Guards the runtime read path: the serve-unix profile must keep a
    // declared net grant list for dyfj start to reproduce.
    const grants = await readServeUnixNetGrants(".");
    expect(grants.length).toBeGreaterThan(0);
    expect(grants).toContain("127.0.0.1:3306");
  });

  test("generic server tasks remain cross-platform and runner-neutral", async () => {
    const raw = await Deno.readTextFile("deno.json");
    const parsed = JSON.parse(raw) as {
      tasks: Record<string, string>;
      permissions: Record<string, {
        env?: string[] | boolean;
        read?: string[] | boolean;
        run?: string[] | boolean;
        sys?: string[] | boolean;
      }>;
    };
    const tasks = parsed.tasks;
    expect(tasks["codex-chatgpt-login"]).toContain(
      '--allow-read=".,$node_path,$HOME,$HOME/.dyfj,$HOME/.dyfj/runner-homes,$HOME/.dyfj/runner-homes/codex-chatgpt"',
    );
    expect(tasks["codex-chatgpt-login"]).toContain(
      '--allow-write="$HOME/.dyfj,$HOME/.dyfj/runner-homes,$HOME/.dyfj/runner-homes/codex-chatgpt"',
    );
    expect(tasks["codex-chatgpt-login"]).toContain(
      '--allow-run="bash,$node_path"',
    );
    expect(tasks["codex-chatgpt-login"]).toContain("--allow-sys=uid");
    for (const task of ["serve-unix", "workbench", "workbench-http", "start"]) {
      expect(tasks[task]).toMatch(/^deno run --no-prompt /);
      expect(tasks[task]).not.toContain("/bin/sh");
      expect(tasks[task]).not.toContain("DYFJ_NODE_PATH");
    }
    for (const profile of ["serve-unix", "workbench", "workbench-http"]) {
      expect(parsed.permissions[profile].run).toContain("/bin/kill");
      expect(parsed.permissions[profile].sys).toContain("uid");
    }
    expect(parsed.permissions["test"].run).toContain("/bin/bash");
    const vitestRunner = await Deno.readTextFile("scripts/run-vitest.ts");
    expect(vitestRunner).toContain(
      "--allow-run=bash,/bin/bash,${denoExecutable},/bin/kill,/bin/sh",
    );
    expect(vitestRunner).not.toContain(
      "--allow-run=bash,/bin/bash,deno,/bin/kill,/bin/sh",
    );
    expect(parsed.permissions["serve-unix"].env).toContain("NODE_V8_COVERAGE");
    expect(parsed.permissions["serve-unix"].read).toBe(true);
    for (const profile of ["workbench", "workbench-http"]) {
      expect(parsed.permissions[profile].env).toContain("NODE_V8_COVERAGE");
      expect(parsed.permissions[profile].read).toEqual([".."]);
    }
  });

  test("codex-chatgpt-login fails clearly when Node is unavailable", async () => {
    const dir = await Deno.makeTempDir({ dir: Deno.cwd() });
    const fakeDeno = `${dir}/deno`;
    try {
      await Deno.writeTextFile(
        fakeDeno,
        "#!/bin/sh\necho 'unexpected deno invocation' >&2\nexit 99\n",
      );
      await Deno.chmod(fakeDeno, 0o700);
      const raw = await Deno.readTextFile("deno.json");
      const tasks =
        (JSON.parse(raw) as { tasks: Record<string, string> }).tasks;
      for (
        const env of [
          { DYFJ_NODE_PATH: "", PATH: dir },
          { DYFJ_NODE_PATH: dir, PATH: "/usr/bin:/bin" },
        ]
      ) {
        const output = await new Deno.Command("/bin/sh", {
          args: ["-c", tasks["codex-chatgpt-login"]],
          cwd: Deno.cwd(),
          env: { ...Deno.env.toObject(), ...env },
          stdout: "piped",
          stderr: "piped",
        }).output();
        const stderr = new TextDecoder().decode(output.stderr);
        expect(output.code).toBe(1);
        expect(stderr).toContain(
          "dyfj: codex-chatgpt-login requires an absolute operator-authorized executable on PATH or in DYFJ_NODE_PATH",
        );
        expect(stderr).not.toContain("unexpected deno invocation");
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("codex-chatgpt-login rejects an unsafe home before Deno starts", async () => {
    const raw = await Deno.readTextFile("deno.json");
    const tasks = (JSON.parse(raw) as { tasks: Record<string, string> }).tasks;
    for (const home of ["", "..", "/tmp/dyfj,home", "/tmp/dyfj:home"]) {
      const output = await new Deno.Command("/bin/sh", {
        args: ["-c", tasks["codex-chatgpt-login"]],
        cwd: Deno.cwd(),
        env: { ...Deno.env.toObject(), HOME: home },
        stdout: "piped",
        stderr: "piped",
      }).output();
      expect(output.code).toBe(1);
      expect(new TextDecoder().decode(output.stderr)).toContain(
        home.startsWith("/tmp/dyfj")
          ? "codex-chatgpt-login home path contains an unsupported delimiter"
          : "codex-chatgpt-login requires an absolute home path",
      );
    }
  });

  test("codex-chatgpt-login does not read or project the optional toolchain", async () => {
    const raw = await Deno.readTextFile("deno.json");
    const tasks = (JSON.parse(raw) as { tasks: Record<string, string> }).tasks;
    const home = await Deno.makeTempDir({ dir: Deno.cwd() });
    const fakeNode = `${home}/node`;
    const marker = `${home}/.dyfj/runner-homes/codex-chatgpt/home/login-args`;
    await Deno.writeTextFile(
      fakeNode,
      `#!/bin/sh
if [ "$1" = "-p" ]; then
  printf '%s\\n' '{"execPath":"${fakeNode}","release":"node"}'
  exit 0
fi
printf '%s\\n' "$*" > "$HOME/login-args"
`,
    );
    await Deno.chmod(fakeNode, 0o700);
    try {
      const output = await new Deno.Command("/bin/sh", {
        args: ["-c", tasks["codex-chatgpt-login"]],
        cwd: Deno.cwd(),
        env: {
          ...Deno.env.toObject(),
          HOME: home,
          DYFJ_NODE_PATH: fakeNode,
          DYFJ_CODEX_TOOLCHAIN_PATH: `${home}/must-not-be-read`,
          DYFJ_CODEX_RUSTUP_HOME: `${home}/must-not-be-read-either`,
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stderr = new TextDecoder().decode(output.stderr);
      expect(output.code).toBe(0);
      expect(stderr).not.toContain(
        'Requires env access to "DYFJ_CODEX_TOOLCHAIN_PATH"',
      );
      expect(stderr).not.toContain(
        'Requires env access to "DYFJ_CODEX_RUSTUP_HOME"',
      );
      expect((await Deno.readTextFile(marker)).trim().endsWith(" login")).toBe(
        true,
      );
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  });
});

describe("REPL /model", () => {
  function fakeConnect(
    models: { slug: string; tier?: number; local?: boolean }[],
    runtime: Record<string, unknown> = {},
  ): ConnectFn {
    return () =>
      Promise.resolve({
        request: (method: string) =>
          method === "models/list"
            ? Promise.resolve({ models })
            : method === "runtime/status"
            ? Promise.resolve({ runtime })
            : Promise.resolve({}),
        close: () => {},
      });
  }

  test("/model with no arg prints the active model, slugs, and posture", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg({ model: "gpt-5.5" });
    const handled = await handleReplModelCommand(
      "/model",
      config,
      io,
      fakeConnect(
        [{ slug: "claude-opus-4-8" }, {
          slug: "gpt-5.5",
          tier: 2,
          local: false,
        }],
        { permissionLevel: "operator" },
      ),
    );
    expect(handled).toBe(true);
    expect(stderr.join("\n")).toContain("active model: gpt-5.5");
    expect(stderr.join("\n")).toContain("claude-opus-4-8");
    expect(stderr.join("\n")).toContain(
      "posture: gpt-5.5 · tier 2 · hosted · paid off (hosted turns fail closed) · permission operator · workspace instructions: unknown",
    );
  });

  test("/model <slug> switches the active model and reprints the posture", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg({ model: "claude-opus-4-8" });
    const handled = await handleReplModelCommand(
      "/model gpt-5.5",
      config,
      io,
      fakeConnect(
        [{ slug: "claude-opus-4-8" }, {
          slug: "gpt-5.5",
          tier: 2,
          local: false,
        }],
        { permissionLevel: "strict" },
      ),
    );
    expect(handled).toBe(true);
    expect(config.model).toBe("gpt-5.5");
    expect(stderr.join("\n")).toContain(
      "posture: gpt-5.5 · tier 2 · hosted · paid off (hosted turns fail closed) · permission strict · workspace instructions: unknown",
    );
  });

  test("/model <slug> leaves an external runner for native model routing", async () => {
    const { io } = fakeIo();
    const config = cfg({ runner: "fixture" });
    await handleReplModelCommand(
      "/model gpt-5.5",
      config,
      io,
      fakeConnect([{ slug: "gpt-5.5", tier: 2, local: false }]),
    );
    expect(config.model).toBe("gpt-5.5");
    expect(config.runner).toBeUndefined();
  });

  test("/model <slug> --approve-paid arms the session paid opt-in", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg();
    await handleReplModelCommand(
      "/model gpt-5.5 --approve-paid",
      config,
      io,
      fakeConnect([{ slug: "gpt-5.5", tier: 2, local: false }]),
    );
    expect(config.model).toBe("gpt-5.5");
    expect(config.approvePaid).toBe(true);
    expect(stderr.join("\n")).toContain("paid approved (session)");
  });

  test("/model rejects an unknown slug and leaves the active model unchanged", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg({ model: "claude-opus-4-8" });
    await handleReplModelCommand(
      "/model no-such-model",
      config,
      io,
      fakeConnect([{ slug: "claude-opus-4-8" }]),
    );
    expect(config.model).toBe("claude-opus-4-8");
    expect(stderr.join("\n")).toContain("unknown model");
  });

  test("a failed switch never arms paid inference as a side effect", async () => {
    const { io } = fakeIo();
    const config = cfg({ model: "claude-opus-4-8" });
    await handleReplModelCommand(
      "/model no-such-model --approve-paid",
      config,
      io,
      fakeConnect([{ slug: "claude-opus-4-8" }]),
    );
    expect(config.model).toBe("claude-opus-4-8");
    expect(config.approvePaid).toBeUndefined();
  });
});

describe("REPL /session command", () => {
  test("/session with no active session shows prompt-first message", async () => {
    const { io, stderr } = fakeIo();
    const state = { turnCount: 0, sessionSpendUsd: 0 };
    const handled = await handleReplSessionCommand(
      "/session",
      cfg(),
      io,
      state,
    );
    expect(handled).toBe(true);
    expect(stderr.join("\n")).toContain("no session yet");
  });

  test("/session with active session displays identity, turns, spend, and resume instructions", async () => {
    const { io, stderr } = fakeIo();
    const state = {
      sessionId: "01TEST_ACTIVE",
      turnCount: 3,
      sessionSpendUsd: 0.0425,
    };
    const handled = await handleReplSessionCommand(
      "/session",
      cfg(),
      io,
      state,
    );
    expect(handled).toBe(true);
    const out = stderr.join("\n");
    expect(out).toContain("session: 01TEST_ACTIVE");
    expect(out).toContain("repl turns (this session): 3");
    expect(out).toContain("repl spend (this session): $0.0425");
    expect(out).toContain("resume later with: dyfj --session 01TEST_ACTIVE");
  });

  test("/session switch changes active sessionId and resets counts", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg({ sessionId: "01OLD" });
    const state = { sessionId: "01OLD", turnCount: 5, sessionSpendUsd: 0.1 };
    const handled = await handleReplSessionCommand(
      "/session switch 01NEW",
      config,
      io,
      state,
    );
    expect(handled).toBe(true);
    expect(state.sessionId).toBe("01NEW");
    expect(config.sessionId).toBe("01NEW");
    expect(state.turnCount).toBe(0);
    expect(state.sessionSpendUsd).toBe(0);
    expect(stderr.join("\n")).toContain("switched to session: 01NEW");
  });

  test("/session switch rejects oversized session identifiers", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg();
    const state = { sessionId: "01OLD", turnCount: 2, sessionSpendUsd: 0.1 };
    const handled = await handleReplSessionCommand(
      `/session switch ${"A".repeat(300)}`,
      config,
      io,
      state,
    );
    expect(handled).toBe(true);
    expect(state.sessionId).toBe("01OLD");
    expect(stderr.join("\n")).toContain("session identifier must be non-empty and <= 256 characters");
  });

  test("/session list lists sessions from RPC seam", async () => {
    const { io, stderr } = fakeIo();
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: (method: string) => {
          if (method === "sessions/list") {
            return Promise.resolve({
              projects: [
                {
                  project: "dyfj",
                  sessions: [
                    {
                      sessionId: "01S1",
                      taskDescription: "First task",
                      createdAt: "2026-08-15T10:00:00Z",
                    },
                  ],
                },
              ],
            });
          }
          return Promise.resolve({});
        },
        close: () => {},
      });

    const state = { turnCount: 0, sessionSpendUsd: 0 };
    const handled = await handleReplSessionCommand(
      "/session list",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    expect(handled).toBe(true);
    expect(stderr.join("\n")).toContain("01S1");
    expect(stderr.join("\n")).toContain("First task");
  });
});

describe("REPL /idea command", () => {
  test("/idea mark captures an idea and emits next-step hint", async () => {
    const { io, stderr } = fakeIo();
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: (_method: string, params: any) =>
          Promise.resolve({
            idea: {
              ideaId: "01IDEA_TEST",
              sessionId: params.sessionId,
              eventId: params.eventId ?? null,
              label: params.label,
              description: params.label,
              createdAt: "2026-08-15T12:00:00Z",
            },
          }),
        close: () => {},
      });

    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const handled = await handleReplIdeaCommand(
      "/idea mark Rate limit background autostarts",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    expect(handled).toBe(true);
    const out = stderr.join("\n");
    expect(out).toContain("marked idea [01IDEA_TEST]: \"Rate limit background autostarts\"");
    expect(out).toContain("/packet draft 01IDEA_TEST");
  });

  test("/idea list displays marked ideas", async () => {
    const { io, stderr } = fakeIo();
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: () =>
          Promise.resolve({
            ideas: [
              {
                ideaId: "01IDEA_LIST_1",
                sessionId: "01ACTIVE_SESS",
                label: "Validate DOLT_PORT",
                createdAt: "2026-08-15T12:00:00Z",
              },
            ],
          }),
        close: () => {},
      });

    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const handled = await handleReplIdeaCommand(
      "/idea list",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    expect(handled).toBe(true);
    expect(stderr.join("\n")).toContain("01IDEA_LIST_1");
    expect(stderr.join("\n")).toContain("Validate DOLT_PORT");
  });
});

describe("REPL /packet command", () => {
  test("/packet draft generates work packet markdown and registers packet", async () => {
    const { io, stdout, stderr } = fakeIo();
    const recordedCalls: Array<{ method: string; params: any }> = [];
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: (method: string, params: any) => {
          recordedCalls.push({ method, params });
          return Promise.resolve({
            packet: {
              packetId: "01PACKET_1",
              sessionId: params.sessionId,
              title: params.title ?? "Draft work packet",
              issueId: params.issueId ?? null,
            },
            markdown:
              "# Work Packet: Draft work packet\n\n## 1. Source Context\n\nContext excerpt\n\n## 2. Operator Intent\n\nIntent\n\n## 3. Proposed Acceptance Criteria\n\n- [ ] Criteria\n\n## 4. Verification & Provenance\n\n- **Primary Verifier:** `human_operator`",
          });
        },
        close: () => {},
      });

    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const handled = await handleReplPacketCommand(
      "/packet draft 01IDEA_1 --issue ISSUE-258 --title Neutral session capture",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    expect(handled).toBe(true);
    expect(recordedCalls).toEqual([
      {
        method: "packets/draft",
        params: {
          sessionId: "01ACTIVE_SESS",
          ideaId: "01IDEA_1",
          eventId: undefined,
          issueId: "ISSUE-258",
          title: "Neutral session capture",
        },
      },
    ]);
    expect(stdout.join("\n")).toContain("# Work Packet: Draft work packet");
    expect(stderr.join("\n")).toContain(
      "draft work packet registered: [01PACKET_1]",
    );
  });

  test("/packet draft with event-id passes eventId parameter", async () => {
    const { io, stdout, stderr } = fakeIo();
    const recordedCalls: Array<{ method: string; params: any }> = [];
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: (method: string, params: any) => {
          recordedCalls.push({ method, params });
          return Promise.resolve({
            packet: {
              packetId: "01PACKET_2",
              sessionId: params.sessionId,
              title: "Event packet",
              issueId: null,
            },
            markdown: "# Work Packet: Event packet",
          });
        },
        close: () => {},
      });

    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const handled = await handleReplPacketCommand(
      "/packet draft evt-0123456789",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    expect(handled).toBe(true);
    expect(recordedCalls).toEqual([
      {
        method: "packets/draft",
        params: {
          sessionId: "01ACTIVE_SESS",
          ideaId: undefined,
          eventId: "evt-0123456789",
          issueId: undefined,
          title: undefined,
        },
      },
    ]);
    expect(stdout.join("\n")).toContain("# Work Packet: Event packet");
    expect(stderr.join("\n")).toContain(
      "draft work packet registered: [01PACKET_2]",
    );
  });

  test("/packet draft correctly parses --title before --issue in any order", async () => {
    const { io, stdout } = fakeIo();
    const recordedCalls: Array<{ method: string; params: any }> = [];
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: (method: string, params: any) => {
          recordedCalls.push({ method, params });
          return Promise.resolve({
            packet: {
              packetId: "01PACKET_3",
              sessionId: params.sessionId,
              title: params.title,
              issueId: params.issueId,
            },
            markdown: "# Work Packet: Fix startup",
          });
        },
        close: () => {},
      });

    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const handled = await handleReplPacketCommand(
      "/packet draft 01IDEA_1 --title Fix startup --issue ISSUE-258",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    expect(handled).toBe(true);
    expect(recordedCalls).toEqual([
      {
        method: "packets/draft",
        params: {
          sessionId: "01ACTIVE_SESS",
          ideaId: "01IDEA_1",
          eventId: undefined,
          issueId: "ISSUE-258",
          title: "Fix startup",
        },
      },
    ]);
    expect(stdout.join("\n")).toContain("# Work Packet: Fix startup");
  });

  test("/packet draft correctly parses multi-word title followed by --issue", async () => {
    const { io, stdout } = fakeIo();
    const recordedCalls: Array<{ method: string; params: any }> = [];
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: (method: string, params: any) => {
          recordedCalls.push({ method, params });
          return Promise.resolve({
            packet: {
              packetId: "01PACKET_4",
              sessionId: params.sessionId,
              title: params.title,
              issueId: params.issueId,
            },
            markdown: "# Work Packet: Document session behavior",
          });
        },
        close: () => {},
      });

    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const handled = await handleReplPacketCommand(
      "/packet draft 01IDEA_1 --title Document session behavior --issue ISSUE-258",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    expect(handled).toBe(true);
    expect(recordedCalls).toEqual([
      {
        method: "packets/draft",
        params: {
          sessionId: "01ACTIVE_SESS",
          ideaId: "01IDEA_1",
          eventId: undefined,
          issueId: "ISSUE-258",
          title: "Document session behavior",
        },
      },
    ]);
    expect(stdout.join("\n")).toContain("# Work Packet: Document session behavior");
  });

  test("/packet draft supports explicit --event and --idea flags", async () => {
    const { io, stdout } = fakeIo();
    const recordedCalls: Array<{ method: string; params: any }> = [];
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: (method: string, params: any) => {
          recordedCalls.push({ method, params });
          return Promise.resolve({
            packet: {
              packetId: "01PACKET_5",
              sessionId: params.sessionId,
              title: params.title,
              issueId: params.issueId,
            },
            markdown: "# Work Packet: Event Flag Test",
          });
        },
        close: () => {},
      });

    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const handled = await handleReplPacketCommand(
      "/packet draft --event custom-event-id --title Event Flag Test",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    expect(handled).toBe(true);
    expect(recordedCalls).toEqual([
      {
        method: "packets/draft",
        params: {
          sessionId: "01ACTIVE_SESS",
          ideaId: undefined,
          eventId: "custom-event-id",
          issueId: undefined,
          title: "Event Flag Test",
        },
      },
    ]);
  });

  test("/packet draft supports explicit --idea flag", async () => {
    const { io, stdout } = fakeIo();
    const recordedCalls: Array<{ method: string; params: any }> = [];
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: (method: string, params: any) => {
          recordedCalls.push({ method, params });
          return Promise.resolve({
            packet: {
              packetId: "01PACKET_6",
              sessionId: params.sessionId,
              title: params.title,
              issueId: params.issueId,
            },
            markdown: "# Work Packet: Idea Flag Test",
          });
        },
        close: () => {},
      });

    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const handled = await handleReplPacketCommand(
      "/packet draft --idea 01IDEA_CUSTOM --title Idea Flag Test",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    expect(handled).toBe(true);
    expect(recordedCalls).toEqual([
      {
        method: "packets/draft",
        params: {
          sessionId: "01ACTIVE_SESS",
          ideaId: "01IDEA_CUSTOM",
          eventId: undefined,
          issueId: undefined,
          title: "Idea Flag Test",
        },
      },
    ]);
  });

  test("/packet draft supports targetless drafting from session context", async () => {
    const { io, stdout } = fakeIo();
    const recordedCalls: Array<{ method: string; params: any }> = [];
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: (method: string, params: any) => {
          recordedCalls.push({ method, params });
          return Promise.resolve({
            packet: {
              packetId: "01PACKET_GENERIC",
              sessionId: params.sessionId,
              title: params.title,
              issueId: params.issueId,
            },
            markdown: "# Work Packet: Generic Session Task",
          });
        },
        close: () => {},
      });

    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const handled = await handleReplPacketCommand(
      "/packet draft --issue ISSUE-258 --title Investigate startup",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    expect(handled).toBe(true);
    expect(recordedCalls).toEqual([
      {
        method: "packets/draft",
        params: {
          sessionId: "01ACTIVE_SESS",
          ideaId: undefined,
          eventId: undefined,
          issueId: "ISSUE-258",
          title: "Investigate startup",
        },
      },
    ]);
  });

  test("/packet draft diagnoses duplicate or conflicting options and invalid option values", async () => {
    const { io, stderr } = fakeIo();
    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };

    await handleReplPacketCommand(
      "/packet draft 01IDEA --event evt-1",
      cfg({ unix: true }),
      io,
      state,
    );
    expect(stderr.join("\n")).toContain("cannot specify both positional target and explicit --idea/--event flag");

    const io2 = fakeIo();
    await handleReplPacketCommand(
      "/packet draft --idea 01IDEA --event evt-1",
      cfg({ unix: true }),
      io2.io,
      state,
    );
    expect(io2.stderr.join("\n")).toContain("cannot specify both --idea and --event");

    const io3 = fakeIo();
    await handleReplPacketCommand(
      "/packet draft 01IDEA --issue ISSUE-1 --issue ISSUE-2",
      cfg({ unix: true }),
      io3.io,
      state,
    );
    expect(io3.stderr.join("\n")).toContain("--issue specified multiple times");

    const io4 = fakeIo();
    await handleReplPacketCommand(
      "/packet draft 01IDEA --issue --isseu",
      cfg({ unix: true }),
      io4.io,
      state,
    );
    expect(io4.stderr.join("\n")).toContain("--issue requires an issue identifier");

    const io5 = fakeIo();
    await handleReplPacketCommand(
      "/packet list extra-arg",
      cfg({ unix: true }),
      io5.io,
      state,
    );
    expect(io5.stderr.join("\n")).toContain("usage: /packet list");

    const io6 = fakeIo();
    await handleReplPacketCommand(
      "/packet show 01PACKET extra-arg",
      cfg({ unix: true }),
      io6.io,
      state,
    );
    expect(io6.stderr.join("\n")).toContain("usage: /packet show <packet-id>");
  });

  test("/idea list and show validate trailing arguments", async () => {
    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const io1 = fakeIo();
    await handleReplIdeaCommand(
      "/idea list extra-arg",
      cfg({ unix: true }),
      io1.io,
      state,
    );
    expect(io1.stderr.join("\n")).toContain("usage: /idea list");

    const io2 = fakeIo();
    await handleReplIdeaCommand(
      "/idea show 01IDEA extra-arg",
      cfg({ unix: true }),
      io2.io,
      state,
    );
    expect(io2.stderr.join("\n")).toContain("usage: /idea show <idea-id>");
  });

  test("/session list and /session switch validate trailing arguments", async () => {
    const state = { turnCount: 0, sessionSpendUsd: 0 };
    const io1 = fakeIo();
    await handleReplSessionCommand(
      "/session list extra-arg",
      cfg({ unix: true }),
      io1.io,
      state,
    );
    expect(io1.stderr.join("\n")).toContain("usage: /session list");

    const io2 = fakeIo();
    await handleReplSessionCommand(
      "/session switch 01SESS extra-arg",
      cfg({ unix: true }),
      io2.io,
      state,
    );
    expect(io2.stderr.join("\n")).toContain("usage: /session switch <sessionId>");
  });

  test("/packet draft rejects duplicate --title flags", async () => {
    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const { io, stderr } = fakeIo();
    await handleReplPacketCommand(
      "/packet draft 01IDEA --title First --title Second",
      cfg({ unix: true }),
      io,
      state,
    );
    expect(stderr.join("\n")).toContain("error: --title specified multiple times");
  });

  test("/packet draft, list, and show work in local mode without unix socket", async () => {
    const state = { sessionId: "01LOCAL_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const io1 = fakeIo();
    await handleReplPacketCommand(
      "/packet draft --title Local Work Packet --issue ISSUE-100",
      cfg({ unix: false }),
      io1.io,
      state,
    );
    expect(io1.stdout.join("\n")).toContain("# Work Packet: Local Work Packet");
    expect(io1.stderr.join("\n")).toContain("draft work packet registered");

    const match = io1.stderr.join("\n").match(/draft work packet registered: \[([^\]]+)\]/);
    const packetId = match ? match[1] : "01PACKET";

    const io2 = fakeIo();
    await handleReplPacketCommand(
      "/packet list",
      cfg({ unix: false }),
      io2.io,
      state,
    );
    expect(io2.stderr.join("\n")).toContain("Work packets for session 01LOCAL_SESS:");
    expect(io2.stderr.join("\n")).toContain("Local Work Packet");

    const io3 = fakeIo();
    await handleReplPacketCommand(
      `/packet show ${packetId}`,
      cfg({ unix: false }),
      io3.io,
      state,
    );
    expect(io3.stdout.join("\n")).toContain("# Work Packet: Local Work Packet");

    const io4 = fakeIo();
    await handleReplPacketCommand(
      "/packet draft MISSING_IDEA",
      cfg({ unix: false }),
      io4.io,
      state,
    );
    expect(io4.stderr.join("\n")).toContain("dyfj: failed to draft packet");
  });

  test("/idea mark --event rejects option-looking event ID", async () => {
    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const { io, stderr } = fakeIo();
    await handleReplIdeaCommand(
      "/idea mark --event --evnt evt-1 Fix startup",
      cfg({ unix: true }),
      io,
      state,
    );
    expect(stderr.join("\n")).toContain("usage: /idea mark --event <event-id> <label...>");
  });

  test("/idea mark rejects unrecognized options", async () => {
    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const { io, stderr } = fakeIo();
    await handleReplIdeaCommand(
      "/idea mark --evnt evt-1 Fix startup",
      cfg({ unix: true }),
      io,
      state,
    );
    expect(stderr.join("\n")).toContain("error: unexpected argument \"--evnt\"");
  });

  test("/idea mark rejects single-dash unexpected option flags and option-like event IDs", async () => {
    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const { io: io1, stderr: stderr1 } = fakeIo();
    await handleReplIdeaCommand(
      "/idea mark -evnt evt-1 Fix startup",
      cfg({ unix: true }),
      io1,
      state,
    );
    expect(stderr1.join("\n")).toContain("error: unexpected argument \"-evnt\"");

    const { io: io2, stderr: stderr2 } = fakeIo();
    await handleReplIdeaCommand(
      "/idea mark --event -evnt Fix startup",
      cfg({ unix: true }),
      io2,
      state,
    );
    expect(stderr2.join("\n")).toContain("usage: /idea mark --event <event-id> <label...>");
  });

  test("/packet draft rejects unexpected option flags following --title", async () => {
    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const { io, stderr } = fakeIo();
    await handleReplPacketCommand(
      "/packet draft --title Fix --isseu ISSUE-1",
      cfg({ unix: true }),
      io,
      state,
    );
    expect(stderr.join("\n")).toContain("error: unexpected argument \"--isseu\"");
  });

  test("/packet draft rejects single-dash unexpected option flags", async () => {
    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const { io, stderr } = fakeIo();
    await handleReplPacketCommand(
      "/packet draft -isseu ISSUE-1",
      cfg({ unix: true }),
      io,
      state,
    );
    expect(stderr.join("\n")).toContain("error: unexpected argument \"-isseu\"");
  });

  test("/idea mark preserves label starting with evt- without explicit --event flag", async () => {
    const { io, stderr } = fakeIo();
    const recordedCalls: Array<{ method: string; params: any }> = [];
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: (method: string, params: any) => {
          recordedCalls.push({ method, params });
          return Promise.resolve({
            idea: {
              ideaId: "01IDEA_EVT_LABEL",
              sessionId: params.sessionId,
              eventId: params.eventId ?? null,
              label: params.label,
              description: params.label,
              createdAt: "2026-08-15T12:00:00Z",
            },
          });
        },
        close: () => {},
      });

    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const handled = await handleReplIdeaCommand(
      "/idea mark evt-driven architecture",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    expect(handled).toBe(true);
    expect(recordedCalls).toEqual([
      {
        method: "ideas/mark",
        params: {
          sessionId: "01ACTIVE_SESS",
          eventId: undefined,
          label: "evt-driven architecture",
        },
      },
    ]);
    expect(stderr.join("\n")).toContain("marked idea [01IDEA_EVT_LABEL]: \"evt-driven architecture\"");
  });

  test("/idea mark and /packet draft support local event references with sessionState.events", async () => {
    const state = {
      sessionId: "01LOCAL_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
      events: [
        {
          sessionId: "01LOCAL_SESS",
          eventId: "evt_a_1",
          eventType: "model_response",
          content: "Let's capture this thought.",
          createdAt: "2026-08-15T12:00:00Z",
        } as any,
      ],
    };

    const io1 = fakeIo();
    const handledIdea = await handleReplIdeaCommand(
      "/idea mark --event evt_a_1 Follow-up task",
      cfg({ unix: false }),
      io1.io,
      state,
    );
    expect(handledIdea).toBe(true);
    expect(io1.stderr.join("\n")).toContain("marked idea");

    const io2 = fakeIo();
    const handledPacket = await handleReplPacketCommand(
      "/packet draft evt_a_1 --title Local Event Packet",
      cfg({ unix: false }),
      io2.io,
      state,
    );
    expect(handledPacket).toBe(true);
    expect(io2.stdout.join("\n")).toContain("# Work Packet: Local Event Packet");
    expect(io2.stderr.join("\n")).toContain("draft work packet registered");

    // Rejects non-existent event in local mode
    const io3 = fakeIo();
    await handleReplIdeaCommand(
      "/idea mark --event evt_missing Non-existent",
      cfg({ unix: false }),
      io3.io,
      state,
    );
    expect(io3.stderr.join("\n")).toContain("error: event \"evt_missing\" not found in current local session context");
  });

  test("/session list orders sessions by latest activity timestamp (updatedAt)", async () => {
    const { io, stderr } = fakeIo();
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: () =>
          Promise.resolve({
            projects: [
              {
                sessions: [
                  {
                    sessionId: "01NEW_SESS",
                    taskDescription: "New session created yesterday untouched",
                    createdAt: "2026-08-14T00:00:00Z",
                    updatedAt: "2026-08-14T00:00:00Z",
                  },
                  {
                    sessionId: "01OLD_SESS",
                    taskDescription: "Old session created earlier but updated today",
                    createdAt: "2026-01-01T00:00:00Z",
                    updatedAt: "2026-08-15T12:00:00Z",
                  },
                ],
              },
            ],
          }),
        close: () => {},
      });

    const state = { turnCount: 0, sessionSpendUsd: 0 };
    await handleReplSessionCommand(
      "/session list",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    const output = stderr.join("\n");
    const oldIdx = output.indexOf("01OLD_SESS");
    const newIdx = output.indexOf("01NEW_SESS");
    expect(oldIdx).toBeLessThan(newIdx);
  });

  test("/idea mark and /packet draft support -- delimiter for option-looking tokens", async () => {
    const { io, stderr } = fakeIo();
    const recordedCalls: Array<{ method: string; params: any }> = [];
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: (method: string, params: any) => {
          recordedCalls.push({ method, params });
          if (method === "ideas/mark") {
            return Promise.resolve({
              idea: {
                ideaId: "01IDEA_WERROR",
                sessionId: params.sessionId,
                label: params.label,
                createdAt: "2026-08-15T12:00:00Z",
              },
            });
          }
          return Promise.resolve({
            packet: {
              packetId: "01PACKET_WERROR",
              sessionId: params.sessionId,
              title: params.title,
            },
            markdown: "# Work Packet: Document -Werror",
          });
        },
        close: () => {},
      });

    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const handledIdea = await handleReplIdeaCommand(
      "/idea mark -- Support -Werror builds",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    expect(handledIdea).toBe(true);
    expect(recordedCalls[0].params.label).toBe("Support -Werror builds");

    const handledPacket = await handleReplPacketCommand(
      "/packet draft --title -- Document -Werror",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    expect(handledPacket).toBe(true);
    expect(recordedCalls[1].params.title).toBe("Document -Werror");
  });

  test("/session switch resets local session events", async () => {
    const state: any = {
      sessionId: "01SESSION_A",
      turnCount: 3,
      sessionSpendUsd: 0.1,
      events: [{ eventId: "evt_u_1", sessionId: "01SESSION_A" }],
      eventCounter: 3,
    };
    const { io } = fakeIo();
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: () => Promise.resolve({ exists: true }),
        close: () => {},
      });

    await handleReplSessionCommand(
      "/session switch 01SESSION_B",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );

    expect(state.sessionId).toBe("01SESSION_B");
    expect(state.turnCount).toBe(0);
    expect(state.events).toEqual([]);
    expect(state.eventCounter).toBe(3);
  });

  test("/session switch rejects session identifiers with control characters or whitespace", async () => {
    const state: any = { sessionId: "01SESSION_A", turnCount: 0, sessionSpendUsd: 0 };
    const { io, stderr } = fakeIo();
    await handleReplSessionCommand(
      "/session switch session\x1Bid",
      cfg({ unix: true }),
      io,
      state,
    );
    expect(stderr.join("\n")).toContain("error: session identifier cannot contain control characters or whitespace");
    expect(state.sessionId).toBe("01SESSION_A");
  });

  test("/packet draft -- rejects extra positional arguments", async () => {
    const { io, stderr } = fakeIo();
    const state = { sessionId: "01ACTIVE_SESS", turnCount: 1, sessionSpendUsd: 0 };
    const handled = await handleReplPacketCommand(
      "/packet draft -- IDEA_A IDEA_B",
      cfg({ unix: true }),
      io,
      state,
    );
    expect(handled).toBe(true);
    expect(stderr.join("\n")).toContain('error: unexpected argument "IDEA_B"');
  });
});

describe("session posture", () => {
  test("formatPostureLine covers paid states and locality", () => {
    expect(
      formatPostureLine({
        slug: "qwen-local",
        tier: 0,
        local: true,
        approvePaidSession: false,
        approvePaidDefault: false,
        permissionLevel: "operator",
      }),
    ).toBe(
      "posture: qwen-local · tier 0 · local · paid off (hosted turns fail closed) · permission operator · workspace instructions: unknown",
    );
    expect(
      formatPostureLine({
        slug: "claude-opus-4-8",
        tier: 2,
        local: false,
        approvePaidSession: true,
        permissionLevel: "strict",
      }),
    ).toBe(
      "posture: claude-opus-4-8 · tier 2 · hosted · paid approved (session) · permission strict · workspace instructions: unknown",
    );
    expect(
      formatPostureLine({
        slug: "x",
        approvePaidSession: false,
        approvePaidDefault: true,
      }),
    ).toBe(
      "posture: x · tier ? · locality unknown · paid approved (standing config) · permission unknown · workspace instructions: unknown",
    );
  });

  test("formatPostureLine surfaces the workspace-instruction trust state", () => {
    // The operator must see the trust stance on the same line they read at
    // session start — never discover a permissive stance after the fact. The
    // three states are distinct: an absent field is missing evidence
    // ("unknown"), not a confirmed-off stance.
    const base = {
      slug: "qwen-local",
      tier: 0,
      local: true,
      approvePaidSession: false,
      approvePaidDefault: false,
      permissionLevel: "operator",
    };
    const line = "posture: qwen-local · tier 0 · local · " +
      "paid off (hosted turns fail closed) · permission operator · " +
      "workspace instructions: ";
    expect(
      formatPostureLine({ ...base, trustWorkspaceInstructions: true }),
    ).toBe(`${line}trusted`);
    // Literal false pins "off" to real evidence, never inferred from absence.
    expect(
      formatPostureLine({ ...base, trustWorkspaceInstructions: false }),
    ).toBe(`${line}off`);
    expect(formatPostureLine(base)).toBe(`${line}unknown`);
  });

  function postureConnect(
    runtime: Record<string, unknown>,
    models: unknown[] = [],
  ): ConnectFn {
    return () =>
      Promise.resolve({
        request: (method: string) =>
          method === "runtime/status"
            ? Promise.resolve({ runtime })
            : method === "models/list"
            ? Promise.resolve({ models })
            : Promise.resolve({}),
        close: () => {},
      });
  }

  test("fetchSessionPosture uses the server-resolved bare-turn default", async () => {
    const posture = await fetchSessionPosture(
      cfg(),
      postureConnect({
        defaultTurnModel: { slug: "qwen-local", tier: 0, local: true },
        approvePaidDefault: false,
        permissionLevel: "operator",
      }),
    );
    expect(posture).toEqual({
      slug: "qwen-local",
      tier: 0,
      local: true,
      approvePaidSession: false,
      approvePaidDefault: false,
      permissionLevel: "operator",
      trustWorkspaceInstructions: undefined,
    });
  });

  test("fetchSessionPosture carries the runtime's workspace-instruction trust", async () => {
    const posture = await fetchSessionPosture(
      cfg(),
      postureConnect({
        defaultTurnModel: { slug: "qwen-local", tier: 0, local: true },
        permissionLevel: "operator",
        trustWorkspaceInstructions: true,
      }),
    );
    expect(posture).toMatchObject({ trustWorkspaceInstructions: true });
  });

  test("fetchSessionPosture resolves an explicit model from the model list", async () => {
    const posture = await fetchSessionPosture(
      cfg({ model: "claude-opus-4-8", approvePaid: true }),
      postureConnect(
        { permissionLevel: "strict" },
        [{ slug: "claude-opus-4-8", tier: 2, local: false }],
      ),
    );
    expect(posture).toMatchObject({
      slug: "claude-opus-4-8",
      tier: 2,
      local: false,
      approvePaidSession: true,
      permissionLevel: "strict",
    });
  });

  test("fetchSessionPosture names explicit tier/hint routing instead of the bare default", async () => {
    // A session launched with --tier routes every turn explicitly, so the
    // server's bare-turn default would misdescribe it.
    const posture = await fetchSessionPosture(
      cfg({ tier: 2 }),
      postureConnect({
        defaultTurnModel: { slug: "qwen-local", tier: 0, local: true },
        permissionLevel: "operator",
      }),
    );
    expect(posture).toMatchObject({
      slug: "(tier 2 route)",
      tier: 2,
      local: undefined,
    });

    const hinted = await fetchSessionPosture(
      cfg({ hint: "code" }),
      postureConnect({ permissionLevel: "operator" }),
    );
    expect(hinted).toMatchObject({ slug: "(hint code route)" });
  });

  test("fetchSessionPosture reports an error when the seam is unreachable", async () => {
    const posture = await fetchSessionPosture(
      cfg(),
      () => Promise.reject(new Error("connection refused")),
    );
    expect(posture).toHaveProperty("error");
  });

  test("runRepl prints the posture line at session start on the UDS seam", async () => {
    const { io, stderr } = fakeIo([]);
    await runRepl(
      cfg({ unix: true }),
      io,
      fetch,
      postureConnect({
        defaultTurnModel: { slug: "qwen-local", tier: 0, local: true },
        permissionLevel: "operator",
      }),
    );
    expect(stderr.join("\n")).toContain(
      "posture: qwen-local · tier 0 · local · paid off (hosted turns fail closed) · permission operator · workspace instructions: unknown",
    );
  });

  test("runRepl still opens when the posture read fails", async () => {
    const { io, stderr } = fakeIo([]);
    await runRepl(
      cfg({ unix: true }),
      io,
      fetch,
      () => Promise.reject(new Error("connection refused")),
    );
    expect(stderr.join("\n")).not.toContain("posture:");
  });
});

describe("buildTurnBody", () => {
  test("selects the fixture runner without sending model routing", () => {
    expect(buildTurnBody(
      "hi",
      cfg({ runner: "fixture", model: "ignored-native-default", tier: 2 }),
    )).toEqual({ prompt: "hi", mode: "turn", runner: "fixture" });
  });

  test("omits routingOptions when no routing is set", () => {
    expect(buildTurnBody("hi", cfg())).toEqual({ prompt: "hi", mode: "turn" });
  });
  test("includes routing + session when set", () => {
    const body = buildTurnBody("hi", cfg({ model: "m", tier: 1 }), "SESS");
    expect(body).toMatchObject({
      routingOptions: { modelId: "m", tier: 1 },
      sessionId: "SESS",
    });
  });
  test("carries the config mode into the request body", () => {
    expect(buildTurnBody("x", cfg({ mode: "ask" })).mode).toBe("ask");
  });
  test("--approve-paid sets approvePaidInference; absent leaves it off", () => {
    expect(buildTurnBody("hi", cfg({ approvePaid: true })).approvePaidInference)
      .toBe(true);
    expect(buildTurnBody("hi", cfg()).approvePaidInference).toBeUndefined();
  });
  test("sends the workspace only when establishing a new session", () => {
    // New session (no sessionId) on a loopback server: workspace binds the session.
    expect(buildTurnBody("hi", cfg({ workspace: "/work/dir" })).workspace)
      .toBe("/work/dir");
    // Resuming (sessionId present): omitted — the server reads it from the row.
    expect(
      buildTurnBody("hi", cfg({ workspace: "/work/dir" }), "SESS").workspace,
    )
      .toBeUndefined();
    expect(buildTurnBody("hi", cfg()).workspace).toBeUndefined();
  });
  test("never auto-sends the implicit cwd workspace to a remote server", () => {
    const remote = cfg({
      workspace: "/work/dir",
      serverUrl: "https://remote.example",
    });
    // Implicit cwd default must not cross the local->remote boundary.
    expect(buildTurnBody("hi", remote).workspace).toBeUndefined();
    // An explicitly-supplied workspace is honored even for a remote server.
    const remoteExplicit = cfg({
      workspace: "/work/dir",
      serverUrl: "https://remote.example",
      workspaceExplicit: true,
    });
    expect(buildTurnBody("hi", remoteExplicit).workspace).toBe("/work/dir");
  });
  test("isLoopbackServerUrl recognizes loopback hosts only", () => {
    expect(isLoopbackServerUrl("http://127.0.0.1:8787")).toBe(true);
    expect(isLoopbackServerUrl("http://localhost:8787")).toBe(true);
    expect(isLoopbackServerUrl("https://workbench.example.test")).toBe(false);
  });
});

describe("presentation", () => {
  test("formatReceipt reports ACP provenance without fake token or USD facts", () => {
    const external: TurnResult = {
      sessionId: "01CLISESSION0000000000000000",
      traceId: "0123456789abcdef0123456789abcdef",
      stopReason: "stop",
      text: "fixture output",
      receipt: "External-agent turn receipt",
      runner: {
        kind: "external_agent",
        profile: "fixture",
        protocol: "acp",
        protocolVersion: 1,
        externalStopReason: "end_turn",
        externalSessionId: "fixture-1",
        capabilities: [],
        workspace: "/tmp/workspace",
        transport: "local_stdio",
        accessRoute: "local_sidecar",
        costBasis: "local_free",
        evidence: {
          source: "acp",
          innerState: "opaque",
          toolchainDirectoryCount: 0,
          routeSource: "profile_declared",
        },
        elapsedMs: 12,
      },
      route: { reason: "explicit_external_agent" },
      context: { sources: [] },
    };
    const formatted = formatReceipt(external, false);
    expect(formatted).toContain(
      "fixture · acp v1 · local_stdio · local_sidecar · local_free · 12ms",
    );
    expect(formatted).not.toContain("tok");
    expect(formatted).not.toContain("$0");
  });

  test("formatReceipt names the model and token counts", () => {
    const s = formatReceipt(result(), false);
    expect(s).toContain("Qwen3 Coder 30B");
    expect(s).toContain("12→5 tok");
    expect(s).toContain("tools 0/32");
  });
  test("formatReceipt names a reached tool-step limit", () => {
    expect(
      formatReceipt(
        result({
          agent: { toolStepsUsed: 2, maxToolSteps: 2, limitReached: true },
        }),
        false,
      ),
    ).toContain("tools 2/2 (limit reached)");
  });
  test("formatReceipt appends the running session total when given", () => {
    const paid = result({
      cost: { estimatedUsd: 0, totalUsd: 0.0123, paidInferenceUsed: true },
    });
    expect(formatReceipt(paid, false, 0.0456)).toContain(
      "$0.0123 · session $0.0456",
    );
    // A free session shows an explicit $0 total, and one-shot receipts
    // (no session figure passed) stay unchanged.
    expect(formatReceipt(result(), false, 0)).toContain("session $0");
    expect(formatReceipt(result(), false)).not.toContain("session");
  });
  test("formatReceipt shows reasoning tokens only when reported", () => {
    const withReasoning = result({
      tokens: {
        input: 12,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 256,
        totalCalls: 1,
      },
    });
    expect(formatReceipt(withReasoning, false)).toContain(
      "12→5 tok (+256 reasoning)",
    );
    expect(formatReceipt(result(), false)).not.toContain("reasoning");
  });
  test("friendlyError maps connection failures to a start hint", () => {
    const s = friendlyError(new TypeError("tcp connect error"), cfg());
    expect(s).toContain("not reachable");
    expect(s).toContain("workbench-http");
  });

  // dispatchRequest (jsonrpc.ts) forwards a server error's message to
  // the client verbatim, and a rejected event-log INSERT can embed the whole
  // offending payload in that message (the original defect quoted pages of
  // source code this way). The client must never render that raw payload.
  test("friendlyError truncates an oversized message to a fixed label + byte-count, never the raw payload", () => {
    const payload = "SELECT ".repeat(20_000); // well over 100KB
    const s = friendlyError(new RangeError(payload), cfg());
    expect(s.length).toBeLessThan(1000);
    expect(s).not.toContain(payload);
    // The label is the fixed literal "Error", not the subclass name — the
    // subclass name would come off the object (`.constructor.name`), a
    // writable property and therefore a payload channel.
    expect(s).toContain("[Error,");
    expect(s).not.toContain("RangeError");
    expect(s).toContain(
      `${new TextEncoder().encode(payload).byteLength} bytes`,
    );
  });

  test("friendlyError renders a short DomainError message unchanged — trusted by provenance", () => {
    const s = friendlyError(
      new DomainError("missing required argument: path"),
      cfg(),
    );
    expect(s).toBe("dyfj: missing required argument: path");
  });

  test("friendlyError never passes a plain Error's message through, even a short one", () => {
    // A plain Error is exactly what a reconstructed network/fetch failure
    // looks like — provenance unknown — so no size threshold makes it safe.
    const message = "missing required argument: path";
    const s = friendlyError(new Error(message), cfg());
    expect(s).not.toContain(message);
    expect(s).toBe(
      `dyfj: [Error, ${new TextEncoder().encode(message).byteLength} bytes]`,
    );
  });

  test("friendlyError trusts an honest server-relayed error, through the real bufferedTurn reconstruction", async () => {
    // Through the real wire path (not a directly-constructed DomainError,
    // which can't catch a regression in the reconstruction itself): a normal
    // server error message survives byte-identical.
    const { fn } = recordingFetch([
      jsonResponse({ error: "session not found" }, 404),
    ]);
    let thrown: unknown;
    try {
      await bufferedTurn(cfg(), { prompt: "x" }, fn);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect(friendlyError(thrown, cfg())).toBe("dyfj: session not found");
  });

  // A wire-reconstructed error becomes a DomainError, and DomainError gets
  // the capped-PASSTHROUGH treatment (unlike a foreign error, which gets
  // zero content) — so these assert bounded length and no control/escape
  // bytes, not "no prefix survives": a capped prefix surviving is the
  // intended behavior here, by design ("bounded", not
  // "eliminated"). The escape-sequence check is what actually proves
  // sanitizeBoundaryText ran, since a capped-but-unsanitized prefix would
  // still start with the payload's own leading bytes either way.
  test("bufferedTurn sanitizes an oversized or control-character-laden wire message before it becomes a DomainError", async () => {
    // config.serverUrl is operator-configurable, so the wire is not a trust
    // boundary — a hostile or misbehaving peer's response body must not ride
    // DomainError's capped-passthrough treatment unsanitized.
    const escapePrefix = String.fromCharCode(27) + "[31m";
    const payload = escapePrefix + "SELECT ".repeat(20_000); // well over 100KB
    const { fn } = recordingFetch([jsonResponse({ error: payload }, 500)]);
    let thrown: unknown;
    try {
      await bufferedTurn(cfg(), { prompt: "x" }, fn);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    const rendered = friendlyError(thrown, cfg());
    expect(rendered.length).toBeLessThan(1000);
    expect(rendered.length).toBeLessThan(payload.length);
    expect(rendered).not.toContain(String.fromCharCode(27));
  });

  test("streamTurn sanitizes an oversized SSE error frame the same way", async () => {
    // Same adversarial leading-ESC shape as the buffered test above: without
    // it, this test can't distinguish SSE-path sanitization from downstream
    // capping alone (a capped-but-unsanitized prefix and a capped-and-
    // sanitized prefix both satisfy a length-only assertion).
    const escapePrefix = String.fromCharCode(27) + "[31m";
    const payload = escapePrefix + "SELECT ".repeat(20_000);
    const { fn } = recordingFetch([
      sseResponse([{ t: "error", message: payload }]),
    ]);
    let thrown: unknown;
    try {
      await streamTurn(cfg(), { prompt: "x" }, { onDelta: () => {} }, fn);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    const rendered = friendlyError(thrown, cfg());
    expect(rendered.length).toBeLessThan(1000);
    expect(rendered.length).toBeLessThan(payload.length);
    expect(rendered).not.toContain(String.fromCharCode(27));
  });

  test("socketError truncates an oversized message the same way as friendlyError", () => {
    const payload = "x".repeat(200_000);
    const s = socketError(new Error(payload), cfg());
    expect(s.length).toBeLessThan(1000);
    expect(s).not.toContain(payload);
    expect(s).toContain("Error");
    expect(s).toContain(`${payload.length} bytes`);
  });
});

describe("normalizeSessionRef", () => {
  test("accepts the slug exactly as dyfj sessions lists it", () => {
    expect(normalizeSessionRef("workbench-01ktz1xwcn7jmgs5e8kakfezkr")).toBe(
      "01KTZ1XWCN7JMGS5E8KAKFEZKR",
    );
  });

  test("accepts a bare session id in either case", () => {
    expect(normalizeSessionRef("01KTZ1XWCN7JMGS5E8KAKFEZKR")).toBe(
      "01KTZ1XWCN7JMGS5E8KAKFEZKR",
    );
    expect(normalizeSessionRef("01ktz1xwcn7jmgs5e8kakfezkr")).toBe(
      "01KTZ1XWCN7JMGS5E8KAKFEZKR",
    );
  });

  test("rejects garbage with a pointer to dyfj sessions", () => {
    expect(() => normalizeSessionRef("not-a-session")).toThrow(
      /dyfj sessions/,
    );
  });
});

describe("main usage errors", () => {
  test("a garbage --session exits 2 via the usage-error path", async () => {
    const { io, stderr } = fakeIo();
    const code = await main(["--session", "garbage-value"], io);
    expect(code).toBe(2);
    expect(stderr[0]).toMatch(/^dyfj: --session /);
    expect(stderr[0]).toContain("dyfj sessions");
    // The tidy path: usage message + help, never a stack trace.
    expect(stderr.join("\n")).not.toMatch(/^\s+at /m);
  });
});

describe("installRootFromModuleUrl (fail-closed prototype root)", () => {
  test("derives the prototype root from a file: cli.ts URL", () => {
    expect(
      installRootFromModuleUrl(
        "file:///Users/x/projects/dyfj/prototype/src/cli.ts",
      ),
    ).toBe("/Users/x/projects/dyfj/prototype");
  });

  test("decodes percent-encoded path segments", () => {
    expect(
      installRootFromModuleUrl(
        "file:///Users/x/My%20Code/prototype/src/cli.ts",
      ),
    ).toBe("/Users/x/My Code/prototype");
  });

  test("returns null for a non-file (remote) module — no trustworthy local root", () => {
    expect(
      installRootFromModuleUrl("https://example.com/prototype/src/cli.ts"),
    ).toBeNull();
  });

  test("returns null when the URL is not the expected src/<file> shape", () => {
    expect(installRootFromModuleUrl("file:///weird/path.ts")).toBeNull();
    expect(installRootFromModuleUrl("not a url")).toBeNull();
  });
});

describe("readServeUnixRunGrants", () => {
  test("reads the serve-unix run grant list from the real profile", async () => {
    const grants = await readServeUnixRunGrants(".");
    expect(grants).toContain("bash");
  });
});

describe("nodeRunGrant", () => {
  test("carries the selected absolute executable after validating its target", async () => {
    const root = await Deno.makeTempDir({ dir: Deno.cwd() });
    const target = `${root}/target`;
    const executable = `${root}/selected`;
    try {
      await Deno.writeTextFile(target, "#!/bin/sh\nexit 0\n");
      await Deno.chmod(target, 0o700);
      const linked = await new Deno.Command("bash", {
        args: ["-c", '/bin/ln -s "$1" "$2"', "bash", target, executable],
      }).output();
      expect(linked.success).toBe(true);
      expect(await nodeRunGrant({ get: () => executable })).toBe(executable);
      await expect(nodeRunGrant({ get: () => "node" })).rejects.toThrow(
        "must name an absolute executable",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("allows a runtime without the optional Codex route", async () => {
    expect(await nodeRunGrant({ get: () => undefined })).toBeNull();
  });

  test("rejects delimiter-unsafe selected and canonical paths", async () => {
    for (const delimiter of [",", ":"]) {
      const root = await Deno.makeTempDir({ dir: Deno.cwd() });
      const target = `${root}/node${delimiter}target`;
      const selected = `${root}/node`;
      try {
        await Deno.writeTextFile(target, "#!/bin/sh\nexit 0\n");
        await Deno.chmod(target, 0o700);
        const linked = await new Deno.Command("bash", {
          args: ["-c", '/bin/ln -s "$1" "$2"', "bash", target, selected],
          stdout: "null",
          stderr: "null",
        }).output();
        expect(linked.success).toBe(true);
        await expect(nodeRunGrant({ get: () => selected })).rejects.toThrow(
          "canonical target contains an unsupported delimiter",
        );
        await expect(nodeRunGrant({ get: () => target })).rejects.toThrow(
          "contains an unsupported delimiter",
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  });
});

describe("buildServeUnixArgs with launch-resolved run grants", () => {
  const NET = ["127.0.0.1:3306"];
  const SOCK = "/run/dyfj/workbench.sock";

  test("omits --allow-run when no resolver is configured (null)", () => {
    const args = buildServeUnixArgs(NET, SOCK, null, null);
    expect(args.some((a) => a.startsWith("--allow-run"))).toBe(false);
    // -P still supplies the profile's run grants unchanged.
    expect(args).toContain("-P=serve-unix");
  });

  test("appends --allow-run with the profile grants plus the resolver binary", () => {
    const args = buildServeUnixArgs(NET, SOCK, null, [
      "bash",
      "/opt/node/bin/node",
      "/bin/kill",
      "op",
    ]);
    expect(args).toContain(
      "--allow-run=bash,/opt/node/bin/node,/bin/kill,op",
    );
  });

  test("rejects delimiter-unsafe run grants", () => {
    expect(() =>
      buildServeUnixArgs(NET, SOCK, null, [
        "bash",
        "/opt/Node,Inc/bin/node",
      ])
    ).toThrow("Deno run grants cannot contain commas");
  });

  test("the socket grant is still present alongside the run grant", () => {
    const args = buildServeUnixArgs(NET, SOCK, null, ["bash", "op"]);
    const net = args.find((a) => a.startsWith("--allow-net="));
    expect(net).toContain(`unix:${SOCK}`);
  });

  test("omits --allow-env when no inherit_env grant is needed (null)", () => {
    const args = buildServeUnixArgs(NET, SOCK, null, null, null);
    expect(args.some((a) => a.startsWith("--allow-env"))).toBe(false);
  });

  test("appends --allow-env with the profile env plus the inherit_env names", () => {
    const args = buildServeUnixArgs(NET, SOCK, null, null, [
      "PATH",
      "HOME",
      "OP_SERVICE_ACCOUNT_TOKEN",
    ]);
    expect(args).toContain("--allow-env=PATH,HOME,OP_SERVICE_ACCOUNT_TOKEN");
  });
});

describe("toolchainReadGrant", () => {
  test("validates one readable directory and preserves its selected path", async () => {
    const directory = await Deno.makeTempDir({ dir: Deno.cwd() });
    try {
      expect(await toolchainReadGrant({ get: () => directory })).toBe(
        directory,
      );
      expect(await toolchainReadGrant({ get: () => undefined })).toBeNull();
    } finally {
      await Deno.remove(directory);
    }
  });

  test("rejects whole dot components before resolving the selected path", async () => {
    const root = await Deno.makeTempDir({ dir: Deno.cwd() });
    const child = `${root}/child`;
    const dotted = [
      `${root}/.cargo`,
      `${root}/.rustup`,
      `${root}/..cache`,
      `${root}/tool.chain`,
    ];
    await Deno.mkdir(child);
    for (const directory of dotted) await Deno.mkdir(directory);
    try {
      for (
        const value of [
          `${root}/./child`,
          `${root}/../${root.split("/").at(-1)}/child`,
          `${child}/.`,
          `${child}/..`,
          `${child}/./`,
          `${child}/../`,
          "/.",
          "/..",
          `${root}//.//child/`,
          `${root}//..//${root.split("/").at(-1)}//child/`,
        ]
      ) {
        let failure: Error | undefined;
        try {
          await toolchainReadGrant({ get: () => value });
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        expect(failure?.message).toBe(
          "Codex toolchain path must not contain dot components",
        );
        expect(failure?.message).not.toContain(value);
      }
      for (const directory of dotted) {
        await expect(toolchainReadGrant({ get: () => directory })).resolves
          .toBe(directory);
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("rejects relative, delimiter-bearing, missing, file, and symlink paths", async () => {
    const root = await Deno.makeTempDir({ dir: Deno.cwd() });
    const file = `${root}/file`;
    const link = `${root}/link`;
    await Deno.writeTextFile(file, "x");
    const linked = await new Deno.Command("bash", {
      args: ["-c", '/bin/ln -s "$1" "$2"', "bash", root, link],
    }).output();
    expect(linked.success).toBe(true);
    try {
      await expect(toolchainReadGrant({ get: () => "relative" })).rejects
        .toThrow("absolute directory");
      for (const value of [`${root},other`, `${root}:other`]) {
        await expect(toolchainReadGrant({ get: () => value })).rejects.toThrow(
          "unsupported delimiter",
        );
      }
      for (
        const value of ["/", "///", `${root}/missing`, file, link, `${link}/`]
      ) {
        await expect(toolchainReadGrant({ get: () => value })).rejects.toThrow(
          "directory is unavailable",
        );
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("rustupHomeReadGrant", () => {
  test("validates one readable directory and preserves its selected path", async () => {
    const directory = await Deno.makeTempDir({ dir: Deno.cwd() });
    try {
      expect(await rustupHomeReadGrant({ get: () => directory })).toBe(
        directory,
      );
      expect(await rustupHomeReadGrant({ get: () => undefined })).toBeNull();
    } finally {
      await Deno.remove(directory);
    }
  });

  test("rejects whole dot components before resolving the selected path", async () => {
    const root = await Deno.makeTempDir({ dir: Deno.cwd() });
    const child = `${root}/child`;
    const dotted = [
      `${root}/.cargo`,
      `${root}/.rustup`,
      `${root}/..cache`,
      `${root}/tool.chain`,
    ];
    await Deno.mkdir(child);
    for (const directory of dotted) await Deno.mkdir(directory);
    try {
      for (
        const value of [
          `${root}/./child`,
          `${root}/../${root.split("/").at(-1)}/child`,
          `${child}/.`,
          `${child}/..`,
          `${child}/./`,
          `${child}/../`,
          "/.",
          "/..",
          `${root}//.//child/`,
          `${root}//..//${root.split("/").at(-1)}//child/`,
        ]
      ) {
        let failure: Error | undefined;
        try {
          await rustupHomeReadGrant({ get: () => value });
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        expect(failure?.message).toBe(
          "Codex Rustup home must not contain dot components",
        );
        expect(failure?.message).not.toContain(value);
      }
      for (const directory of dotted) {
        await expect(rustupHomeReadGrant({ get: () => directory })).resolves
          .toBe(directory);
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("rejects relative, delimiter-bearing, missing, file, and symlink paths", async () => {
    const root = await Deno.makeTempDir({ dir: Deno.cwd() });
    const file = `${root}/file`;
    const link = `${root}/link`;
    await Deno.writeTextFile(file, "x");
    const linked = await new Deno.Command("bash", {
      args: ["-c", '/bin/ln -s "$1" "$2"', "bash", root, link],
    }).output();
    expect(linked.success).toBe(true);
    try {
      await expect(rustupHomeReadGrant({ get: () => "relative" })).rejects
        .toThrow("absolute directory");
      for (const value of [`${root},other`, `${root}:other`]) {
        await expect(rustupHomeReadGrant({ get: () => value })).rejects.toThrow(
          "unsupported delimiter",
        );
      }
      for (
        const value of ["/", "///", `${root}/missing`, file, link, `${link}/`]
      ) {
        await expect(rustupHomeReadGrant({ get: () => value })).rejects.toThrow(
          "directory is unavailable",
        );
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("Codex toolchain runtime grant", () => {
  test("the serve-unix profile may read the operator selection", async () => {
    expect(await readServeUnixEnvGrants(".")).toContain(
      "DYFJ_CODEX_TOOLCHAIN_PATH",
    );
    expect(await readServeUnixEnvGrants(".")).toContain(
      "DYFJ_CODEX_RUSTUP_HOME",
    );
  });
});

describe("readServeUnixEnvGrants", () => {
  test("reads the serve-unix env grant list from the real profile", async () => {
    const grants = await readServeUnixEnvGrants(".");
    expect(grants).toContain("PATH");
    expect(grants).toContain("HOME");
  });
});

describe("every dyfj CLI surface may read DYFJ_ROOT", () => {
  test("profile, compiled binary, and launcher stay in lockstep on DYFJ_ROOT", async () => {
    // dyfj start reads ~/.dyfj/config.toml (located via DYFJ_ROOT) to derive the
    // child's --allow-run resolver-binary grant, so all three CLI permission
    // surfaces must grant DYFJ_ROOT.
    const raw = await Deno.readTextFile("deno.json");
    const parsed = JSON.parse(raw) as {
      tasks: Record<string, string>;
      permissions: Record<string, { env?: string[] | boolean }>;
    };
    expect(parsed.permissions["cli"].env).toContain("DYFJ_ROOT");
    const compileEnv = parsed.tasks["compile-cli"].match(/--allow-env=(\S+)/)
      ?.[1];
    expect(compileEnv?.split(",")).toContain("DYFJ_ROOT");
    const launcher = await Deno.readTextFile("scripts/dyfj-launcher.sh");
    const launcherEnv = launcher.match(/printf '%s' '([^']+)'/)?.[1];
    expect(launcherEnv?.split(",")).toContain("DYFJ_ROOT");
  });
});

describe("readLauncherSecretsConfig (.env / DYFJ_ROOT precedence)", () => {
  // Inject a parser (the real @std/toml jsr specifier can't load under the node
  // test runner). readTextFile returns this marker for the config file; the
  // parser maps it to a [secrets] table.
  const TOML = "(toml)";
  const parse = () => ({
    secrets: {
      command: ["op", "read"],
      pointers: { ANTHROPIC_API_KEY: "op://v/a/credential" },
    },
  });

  test("ambient DYFJ_ROOT wins and locates config.toml there", async () => {
    const reads: string[] = [];
    const readTextFile = (path: string) => {
      reads.push(path);
      if (path === "/ambient/config.toml") return Promise.resolve(TOML);
      return Promise.reject(new Deno.errors.NotFound());
    };
    const env = {
      get: (n: string) =>
        n === "DYFJ_ROOT" ? "/ambient" : n === "HOME" ? "/home/x" : undefined,
    };
    const cfg = await readLauncherSecretsConfig(
      "/cwd",
      readTextFile,
      env,
      parse,
    );
    expect(cfg?.command).toEqual(["op", "read"]);
    // Ambient root is used directly; .env is not consulted for the root.
    expect(reads).toContain("/ambient/config.toml");
  });

  test("falls back to .env DYFJ_ROOT when ambient is unset (mirrors the child)", async () => {
    const readTextFile = (path: string) => {
      if (path === "/cwd/.env") return Promise.resolve("DYFJ_ROOT=/from-env\n");
      if (path === "/from-env/config.toml") return Promise.resolve(TOML);
      return Promise.reject(new Deno.errors.NotFound());
    };
    const env = { get: (n: string) => (n === "HOME" ? "/home/x" : undefined) };
    const cfg = await readLauncherSecretsConfig(
      "/cwd",
      readTextFile,
      env,
      parse,
    );
    expect(cfg?.pointers.ANTHROPIC_API_KEY).toBe("op://v/a/credential");
  });

  test("falls back to HOME/.dyfj when neither ambient nor .env set the root", async () => {
    const readTextFile = (path: string) => {
      if (path === "/home/x/.dyfj/config.toml") return Promise.resolve(TOML);
      return Promise.reject(new Deno.errors.NotFound());
    };
    const env = { get: (n: string) => (n === "HOME" ? "/home/x" : undefined) };
    const cfg = await readLauncherSecretsConfig(
      "/cwd",
      readTextFile,
      env,
      parse,
    );
    expect(cfg?.command).toEqual(["op", "read"]);
  });

  test("empty ambient DYFJ_ROOT is treated as absent, NOT read from .env (mirrors the child)", async () => {
    const readPaths: string[] = [];
    const readTextFile = (path: string) => {
      readPaths.push(path);
      // A .env that DOES set DYFJ_ROOT — the launcher must ignore it here,
      // because the child's --env-file can't override the empty ambient value.
      if (path === "/cwd/.env") return Promise.resolve("DYFJ_ROOT=/from-env\n");
      if (path === "/home/x/.dyfj/config.toml") return Promise.resolve(TOML);
      return Promise.reject(new Deno.errors.NotFound());
    };
    const env = {
      get: (n: string) =>
        n === "DYFJ_ROOT" ? "" : n === "HOME" ? "/home/x" : undefined,
    };
    const cfg = await readLauncherSecretsConfig(
      "/cwd",
      readTextFile,
      env,
      parse,
    );
    expect(cfg?.command).toEqual(["op", "read"]);
    // Resolved against HOME, and .env was never consulted for the root.
    expect(readPaths).toContain("/home/x/.dyfj/config.toml");
    expect(readPaths).not.toContain("/cwd/.env");
  });

  test("loads external MCP servers from the same child-visible config", async () => {
    const readTextFile = (path: string) => {
      if (path === "/home/x/.dyfj/config.toml") return Promise.resolve(TOML);
      return Promise.reject(new Deno.errors.NotFound());
    };
    const env = {
      get: (name: string) => name === "HOME" ? "/home/x" : undefined,
    };
    const secrets = await readLauncherSecretsConfig(
      "/cwd",
      readTextFile,
      env,
      () => ({
        secrets: {
          command: ["op", "read"],
          named: { linear_mcp: "op://v/linear/credential" },
        },
      }),
    );
    const servers = await readLauncherMcpServersConfig(
      "/cwd",
      secrets,
      readTextFile,
      env,
      () => ({
        mcp: {
          servers: [{
            id: "linear",
            transport: "streamable_http",
            url: "https://mcp.linear.app/mcp",
            minimum_clearance: "loopback",
            auth: { type: "bearer", secret: "linear_mcp" },
            tools: [{ name: "get_issue", effect: "read", approval: "allow" }],
          }],
        },
      }),
    );
    expect(servers.map((server) => server.id)).toEqual(["linear"]);
  });
});

// ── Turn-in-flight spinner ───────────────────────────────────────────────────

const ERASE_LINE = "\r\x1b[2K";

describe("createTurnSpinner", () => {
  test("animates only when the Io has a raw writer and a TTY stderr", () => {
    const { io, raw } = fakeIo([], { errIsTerminal: true });
    const spinner = createTurnSpinner(cfg(), io);
    spinner.start();
    spinner.stop();
    expect(raw).toEqual([`${ERASE_LINE}⠋ working…`, ERASE_LINE]);
  });

  test("is a no-op when stderr is not a terminal", () => {
    const { io, raw } = fakeIo();
    const spinner = createTurnSpinner(cfg(), io);
    spinner.start();
    spinner.stop();
    expect(raw).toEqual([]);
  });

  test("is a no-op when the Io exposes no raw stderr writer", () => {
    const stderr: string[] = [];
    const io: Io = {
      out: () => {},
      err: (line) => stderr.push(line),
      readLine: () => Promise.resolve(null),
      close: () => {},
    };
    const spinner = createTurnSpinner(cfg(), io);
    spinner.start();
    spinner.stop();
    expect(stderr).toEqual([]);
  });
});

describe("spinnerGuardedTurnHandlers", () => {
  function stubSpinner(calls: string[]) {
    return {
      start: () => calls.push("start"),
      stop: () => calls.push("stop"),
    };
  }

  test("stops the spinner before rendering the first delta", () => {
    const calls: string[] = [];
    const { io, stdout } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), {
      ...io,
      out: (text) => {
        calls.push("out");
        stdout.push(text);
      },
    });
    const handlers = spinnerGuardedTurnHandlers(
      stubSpinner(calls),
      output,
      io,
      () => ({ decision: "deny" as const, reason: "n/a" }),
    );
    handlers.onDelta("hello\n");
    expect(calls[0]).toBe("stop");
    expect(calls).toContain("out");
    expect(stdout.join("")).toBe("hello\n");
  });

  test("stops the spinner before a visible runtime-event status line", () => {
    const calls: string[] = [];
    const { io, stderr } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    const handlers = spinnerGuardedTurnHandlers(
      stubSpinner(calls),
      output,
      {
        ...io,
        err: (line) => {
          calls.push("err");
          stderr.push(line);
        },
      },
      () => ({ decision: "deny" as const, reason: "n/a" }),
    );
    handlers.onEvent({ type: "toolCallStarted", commandId: "read_file" });
    expect(calls[0]).toBe("stop");
    expect(stderr).toEqual(["tool: read_file started"]);
  });

  test("keeps spinning through an invisible event (modelSelected)", () => {
    const calls: string[] = [];
    const { io, stderr } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    const handlers = spinnerGuardedTurnHandlers(
      stubSpinner(calls),
      output,
      io,
      () => ({ decision: "deny" as const, reason: "n/a" }),
    );
    // Emitted right before the provider wait; it renders nothing, so the
    // spinner must survive it — otherwise it vanishes before the wait it
    // exists to cover.
    handlers.onEvent({ type: "modelSelected", modelSlug: "x", tier: 0 });
    expect(calls).toEqual([]);
    expect(stderr).toEqual([]);
    // …and still stops on the first delta that follows.
    handlers.onDelta("hi\n");
    expect(calls).toEqual(["stop"]);
  });

  test("stops the spinner before delegating a mid-turn approval", async () => {
    const calls: string[] = [];
    const { io } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    const handlers = spinnerGuardedTurnHandlers(
      stubSpinner(calls),
      output,
      io,
      () => {
        calls.push("approval");
        return { decision: "approve" as const };
      },
    );
    const verdict = await handlers.onApproval({ kind: "tool" });
    expect(calls).toEqual(["stop", "approval"]);
    expect(verdict).toEqual({ decision: "approve" });
  });
});

describe("runtimeEventIsVisible", () => {
  test("invisible bookkeeping events render nothing", () => {
    expect(runtimeEventIsVisible({ type: "modelSelected", modelSlug: "x" }))
      .toBe(false);
    expect(runtimeEventIsVisible({ type: "unknownFutureEvent" })).toBe(false);
    expect(runtimeEventIsVisible(null)).toBe(false);
    expect(runtimeEventIsVisible("nope")).toBe(false);
  });

  test("status-line and supersede events are visible", () => {
    expect(runtimeEventIsVisible({ type: "toolCallStarted", commandId: "x" }))
      .toBe(true);
    expect(runtimeEventIsVisible({ type: "toolStepStarted", step: 1 }))
      .toBe(true);
    expect(runtimeEventIsVisible(supersedeEvent())).toBe(true);
  });
});

describe("runExec spinner integration", () => {
  test("paints at submit and erases before streamed output on a TTY", async () => {
    const { fn } = recordingFetch([
      sseResponse([
        { t: "delta", text: "hi" },
        { t: "done", result: result() },
      ]),
    ]);
    const { io, raw, stdout } = fakeIo([], { errIsTerminal: true });
    const code = await runExec("x", cfg(), io, false, fn);
    expect(code).toBe(0);
    expect(raw[0]).toBe(`${ERASE_LINE}⠋ working…`);
    expect(raw[raw.length - 1]).toBe(ERASE_LINE);
    expect(stdout.join("")).toContain("hi");
  });

  test("an invisible modelSelected event does not erase the spinner early", async () => {
    // The real ordering: modelSelected arrives before the provider wait, then
    // the first delta. The spinner must survive the event and be erased only
    // once by the delta — never flicker off during the wait.
    const { fn } = recordingFetch([
      sseResponse([
        { t: "event", event: { type: "modelSelected", modelSlug: "x" } },
        { t: "delta", text: "hi" },
        { t: "done", result: result() },
      ]),
    ]);
    const { io, raw } = fakeIo([], { errIsTerminal: true });
    const code = await runExec("x", cfg(), io, false, fn);
    expect(code).toBe(0);
    // Exactly one erase (from the delta), and it is the last spinner write.
    expect(raw.filter((w) => w === ERASE_LINE)).toHaveLength(1);
    expect(raw[raw.length - 1]).toBe(ERASE_LINE);
  });

  test("erases the spinner when the turn fails (no orphaned line)", async () => {
    const { fn } = recordingFetch([
      sseResponse([{ t: "error", message: "boom" }]),
    ]);
    const { io, raw } = fakeIo([], { errIsTerminal: true });
    const code = await runExec("x", cfg(), io, false, fn);
    expect(code).toBe(1);
    expect(raw[raw.length - 1]).toBe(ERASE_LINE);
  });

  test("--json turns never see spinner bytes", async () => {
    const { fn } = recordingFetch([jsonResponse(result())]);
    const { io, raw } = fakeIo([], { errIsTerminal: true });
    const code = await runExec("x", cfg(), io, true, fn);
    expect(code).toBe(0);
    expect(raw).toEqual([]);
  });

  test("piped stderr sees no spinner bytes", async () => {
    const { fn } = recordingFetch([
      sseResponse([
        { t: "delta", text: "hi" },
        { t: "done", result: result() },
      ]),
    ]);
    const { io, raw } = fakeIo();
    const code = await runExec("x", cfg(), io, false, fn);
    expect(code).toBe(0);
    expect(raw).toEqual([]);
  });
});

describe("runRepl spinner integration", () => {
  test("each turn paints at submit and erases before output", async () => {
    const { fn } = recordingFetch([
      sseResponse([
        { t: "delta", text: "first" },
        { t: "done", result: result() },
      ]),
      sseResponse([
        { t: "delta", text: "second" },
        { t: "done", result: result() },
      ]),
    ]);
    const { io, raw, stdout } = fakeIo(["one", "two"], { errIsTerminal: true });
    await runRepl(cfg(), io, fn);
    // Two turns → two paint…erase runs, freshly armed per turn. Frame counts
    // stay loose: the real interval timer may add repaints on a slow run.
    const erases = raw.filter((write) => write === ERASE_LINE);
    expect(erases).toHaveLength(2);
    expect(raw[0]).toBe(`${ERASE_LINE}⠋ working…`);
    expect(raw[raw.length - 1]).toBe(ERASE_LINE);
    const secondTurnPaint = raw[raw.indexOf(ERASE_LINE) + 1];
    expect(secondTurnPaint).toBe(`${ERASE_LINE}⠋ working…`);
    expect(stdout.join("")).toContain("first");
    expect(stdout.join("")).toContain("second");
  });
});

// ── REPL prompt gutter ───────────────────────────────────────────────────────

describe("replPrompt", () => {
  test("plain mode is byte-identical to the historical prompt", () => {
    expect(replPrompt(false)).toBe("\ndyfj> ");
  });

  test("color mode carries a bold green gutter", () => {
    expect(replPrompt(true)).toBe("\n\x1b[1m\x1b[32mdyfj ❯\x1b[0m ");
  });

  test("runRepl prompts with the plain gutter when color is off", async () => {
    const { fn } = recordingFetch([]);
    const { io, prompts } = fakeIo([]);
    await runRepl(cfg({ color: false }), io, fn);
    expect(prompts).toEqual(["\ndyfj> "]);
  });

  test("runRepl prompts with the styled gutter when color is on", async () => {
    const { fn } = recordingFetch([]);
    const { io, prompts } = fakeIo([]);
    await runRepl(cfg({ color: true }), io, fn);
    expect(prompts).toEqual([replPrompt(true)]);
  });
});

// ── --parse-check (launcher validity contract) ───────────────────────────────

describe("main --parse-check", () => {
  const silentIo = {
    out: () => {},
    err: () => {},
    readLine: () => Promise.resolve(null),
    close: () => {},
  };
  test("a valid invocation exits 0", async () => {
    expect(await main(["--parse-check", "status"], silentIo)).toBe(0);
    expect(await main(["--parse-check"], silentIo)).toBe(0);
  });
  test("a parser rejection exits 2", async () => {
    expect(await main(["--parse-check", "--bogus"], silentIo)).toBe(2);
    expect(await main(["--parse-check", "--tier", "3"], silentIo)).toBe(2);
  });
  test("a parser THROW also exits 2 — the contract is 0/2, not 0/2/crash", async () => {
    // normalizeSessionRef throws on an invalid ref rather than returning a
    // parse error; parse-check absorbs either rejection shape.
    expect(
      await main(["--parse-check", "--session", "garbage-value"], silentIo),
    )
      .toBe(2);
  });
});
