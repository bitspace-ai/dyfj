import { describe, expect, test } from "vitest";
import {
  bufferedTurn,
  buildTurnBody,
  type CliConfig,
  formatReceipt,
  friendlyError,
  type Io,
  parseArgs,
  readLineOrNull,
  resolveConfig,
  runExec,
  runRepl,
  streamTurn,
  type TurnResult,
} from "./cli";

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
  return { serverUrl: "http://localhost:8787", mode: "turn", color: false, ...overrides };
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
    tokens: { input: 12, output: 5, cacheRead: 0, cacheWrite: 0, totalCalls: 1 },
    ...overrides,
  };
}

type Frame =
  | { t: "delta"; text: string }
  | { t: "event"; event: Record<string, unknown> }
  | { t: "done"; result: TurnResult }
  | { t: "error"; message: string };

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

function fakeIo(lines: string[] = []) {
  const queue = [...lines];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: Io = {
    out: (text) => stdout.push(text),
    err: (line) => stderr.push(line),
    readLine: (_prompt) => Promise.resolve(queue.length ? queue.shift()! : null),
    close: () => {},
  };
  return { io, stdout, stderr };
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
    const { fn } = recordingFetch([sseResponse([{ t: "error", message: "boom" }])]);
    await expect(
      streamTurn(cfg(), { prompt: "x" }, { onDelta: () => {} }, fn),
    ).rejects.toThrow("boom");
  });

  test("surfaces a pre-stream JSON error", async () => {
    const { fn } = recordingFetch([jsonResponse({ error: "bad request" }, 400)]);
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
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ prompt: "hi" });
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
    await expect(bufferedTurn(cfg(), { prompt: "x" }, fn)).rejects.toThrow("nope");
  });
});

// ── runExec ───────────────────────────────────────────────────────────────────

describe("runExec", () => {
  test("streams text to stdout and the receipt to stderr", async () => {
    const { fn } = recordingFetch([
      sseResponse([{ t: "delta", text: "Hi" }, { t: "done", result: result() }]),
    ]);
    const { io, stdout, stderr } = fakeIo();
    const code = await runExec("hello", cfg(), io, false, fn);
    expect(code).toBe(0);
    expect(stdout.join("")).toBe("Hi\n");
    expect(stderr.join("\n")).toContain("Qwen3 Coder 30B");
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
      Promise.reject(new TypeError("error sending request"))) as unknown as typeof fetch;
    const { io, stderr } = fakeIo();
    const code = await runExec("x", cfg(), io, false, fn);
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("not reachable");
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
      "--model", "m", "--tier", "2", "--hint", "code", "--server", "http://h",
      "exec", "hi",
    ]);
    expect(p.overrides).toMatchObject({
      model: "m",
      tier: 2,
      hint: "code",
      serverUrl: "http://h",
    });
    expect(p.prompt).toBe("hi");
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
  test("--mode sets the context mode", () => {
    expect(parseArgs(["--mode", "ask", "exec", "x"]).overrides.mode).toBe("ask");
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
  test("mode defaults to turn and honors the override", () => {
    expect(resolveConfig({}, { get: () => undefined }).mode).toBe("turn");
    expect(resolveConfig({ mode: "ask" }, { get: () => undefined }).mode).toBe("ask");
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
});

describe("presentation", () => {
  test("formatReceipt names the model and token counts", () => {
    const s = formatReceipt(result(), false);
    expect(s).toContain("Qwen3 Coder 30B");
    expect(s).toContain("12→5 tok");
  });
  test("friendlyError maps connection failures to a start hint", () => {
    const s = friendlyError(new TypeError("tcp connect error"), cfg());
    expect(s).toContain("not reachable");
    expect(s).toContain("workbench-http");
  });
});
