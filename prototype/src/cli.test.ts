import { describe, expect, test } from "vitest";
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
  handleReplModelCommand,
  handleTurnRuntimeEvent,
  installRootFromModuleUrl,
  type Io,
  isLoopbackServerUrl,
  memoryMcpNetGrant,
  normalizeSessionRef,
  parseArgs,
  promptToolApproval,
  readLauncherSecretsConfig,
  readLineOrNull,
  readMemoryMcpNetGrant,
  replPrompt,
  readServeUnixEnvGrants,
  readServeUnixNetGrants,
  readServeUnixRunGrants,
  resolveConfig,
  runExec,
  runModels,
  runRepl,
  runSessions,
  runStart,
  runStatus,
  runtimeEventIsVisible,
  socketError,
  socketTurn,
  spinnerGuardedTurnHandlers,
  type StartRuntimeFn,
  streamTurn,
  type TurnResult,
} from "./cli";
import { serveWorkbenchUnix } from "./uds-server";
import { connectUnixClient, type ToolApprovalVerdict } from "./uds-client";
import { DomainError } from "./turn-contract";
import type { SupersedingRetryStartedEvent } from "./turn-contract";

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
    const rl = {
      question: () => Promise.reject(new Error("boom")),
      once: () => {},
      off: () => {},
    };
    expect(await readLineOrNull(rl, "> ")).toBeNull();
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
});

describe("socketTurn over a real Unix socket (integration)", () => {
  test("streams deltas and returns the receipt across the wire", async () => {
    const dir = await Deno.makeTempDir();
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
        models: { total: 3, local: 1, hosted: 2 },
        methods: ["runtime/status", "models/list"],
      },
    });
    expect(text).toContain("runtime: reachable");
    expect(text).toContain("socket: /run/wb.sock");
    expect(text).toContain("qwen-local");
    expect(text).toContain("3 total");
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
    const compileEnv = parsed.tasks["compile-cli"].match(/--allow-env=(\S+)/)
      ?.[1];
    expect(compileEnv?.split(",")).toContain("DYFJ_MEMORY_MCP_URL");
    const launcher = await Deno.readTextFile("scripts/dyfj-launcher.sh");
    const launcherEnv = launcher.match(/printf '%s' '([^']+)'/)?.[1];
    expect(launcherEnv?.split(",")).toContain("DYFJ_MEMORY_MCP_URL");
  });

  test("readServeUnixNetGrants reads the real profile", async () => {
    // Guards the runtime read path: the serve-unix profile must keep a
    // declared net grant list for dyfj start to reproduce.
    const grants = await readServeUnixNetGrants(".");
    expect(grants.length).toBeGreaterThan(0);
    expect(grants).toContain("127.0.0.1:3306");
  });

  test("dyfj start spawn args stay in lockstep with the serve-unix task", async () => {
    // buildServeUnixArgs reproduces the serve-unix task plus the socket net
    // grant. If the task definition changes shape, change both together.
    const raw = await Deno.readTextFile("deno.json");
    const tasks = (JSON.parse(raw) as { tasks: Record<string, string> }).tasks;
    expect(tasks["serve-unix"]).toBe(
      "deno run --no-prompt -P=serve-unix --env-file=.env --sloppy-imports src/uds-serve.ts",
    );
    // Every server entrypoint must refuse to prompt.
    for (const task of ["serve-unix", "workbench", "workbench-http", "start"]) {
      expect(tasks[task]).toContain("--no-prompt");
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
        [{ slug: "claude-opus-4-8" }, { slug: "gpt-5.5", tier: 2, local: false }],
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
        [{ slug: "claude-opus-4-8" }, { slug: "gpt-5.5", tier: 2, local: false }],
        { permissionLevel: "strict" },
      ),
    );
    expect(handled).toBe(true);
    expect(config.model).toBe("gpt-5.5");
    expect(stderr.join("\n")).toContain(
      "posture: gpt-5.5 · tier 2 · hosted · paid off (hosted turns fail closed) · permission strict · workspace instructions: unknown",
    );
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
  test("formatReceipt names the model and token counts", () => {
    const s = formatReceipt(result(), false);
    expect(s).toContain("Qwen3 Coder 30B");
    expect(s).toContain("12→5 tok");
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

describe("buildServeUnixArgs with a resolver run grant", () => {
  const NET = ["127.0.0.1:3306"];
  const SOCK = "/run/dyfj/workbench.sock";

  test("omits --allow-run when no resolver is configured (null)", () => {
    const args = buildServeUnixArgs(NET, SOCK, null, null);
    expect(args.some((a) => a.startsWith("--allow-run"))).toBe(false);
    // -P still supplies the profile's run grants unchanged.
    expect(args).toContain("-P=serve-unix");
  });

  test("appends --allow-run with the profile grants plus the resolver binary", () => {
    const args = buildServeUnixArgs(NET, SOCK, null, ["bash", "op"]);
    expect(args).toContain("--allow-run=bash,op");
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
