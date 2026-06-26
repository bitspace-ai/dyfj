import { describe, expect, test } from "vitest";
import {
  bufferedTurn,
  buildTurnBody,
  type CliConfig,
  type ConnectFn,
  formatReceipt,
  friendlyError,
  handleReplModelCommand,
  type Io,
  isLoopbackServerUrl,
  parseArgs,
  promptToolApproval,
  readLineOrNull,
  resolveConfig,
  runExec,
  runModels,
  runRepl,
  runSessions,
  socketTurn,
  streamTurn,
  type TurnResult,
} from "./cli";
import { serveWorkbenchUnix } from "./uds-server";
import { connectUnixClient, type ToolApprovalVerdict } from "./uds-client";

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
    readLine: (_prompt) =>
      Promise.resolve(queue.length ? queue.shift()! : null),
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
    const server = serveWorkbenchUnix(sock, {
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
      Promise.reject(
        new TypeError("error sending request"),
      )) as unknown as typeof fetch;
    const { io, stderr } = fakeIo();
    const code = await runExec("x", cfg(), io, false, fn);
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("not reachable");
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

  test("an unreachable socket points the operator at serve-unix", async () => {
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
    expect(stderr.join("\n")).toContain("serve-unix");
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

  test("a connection failure points the operator at serve-unix", async () => {
    const { io, stderr } = fakeIo();
    const code = await runModels(
      cfg({ socket: "/run/missing.sock" }),
      io,
      () => {
        throw new Error("No such file or directory (os error 2)");
      },
    );
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("serve-unix");
    expect(stderr.join("\n")).toContain("/run/missing.sock");
  });
});

describe("REPL /model", () => {
  function fakeConnect(models: { slug: string }[]): ConnectFn {
    return () =>
      Promise.resolve({
        request: (method: string) =>
          method === "models/list" ? Promise.resolve({ models }) : Promise.resolve({}),
        close: () => {},
      });
  }

  test("/model with no arg prints the active model and available slugs", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg({ model: "gpt-5.5" });
    const handled = await handleReplModelCommand(
      "/model",
      config,
      io,
      fakeConnect([{ slug: "claude-opus-4-8" }, { slug: "gpt-5.5" }]),
    );
    expect(handled).toBe(true);
    expect(stderr.join("\n")).toContain("active model: gpt-5.5");
    expect(stderr.join("\n")).toContain("claude-opus-4-8");
  });

  test("/model <slug> switches the active model when the slug is known", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg({ model: "claude-opus-4-8" });
    const handled = await handleReplModelCommand(
      "/model gpt-5.5",
      config,
      io,
      fakeConnect([{ slug: "claude-opus-4-8" }, { slug: "gpt-5.5" }]),
    );
    expect(handled).toBe(true);
    expect(config.model).toBe("gpt-5.5");
    expect(stderr.join("\n")).toContain("model: gpt-5.5");
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
  test("friendlyError maps connection failures to a start hint", () => {
    const s = friendlyError(new TypeError("tcp connect error"), cfg());
    expect(s).toContain("not reachable");
    expect(s).toContain("workbench-http");
  });
});
