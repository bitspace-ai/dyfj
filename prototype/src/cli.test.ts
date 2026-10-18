import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchSessionPosture,
  formatFreshnessWarning,
  formatPostureLine,
  handleReplFastCommand,
  handleReplFrictionCommand,
  handleReplIdeaCommand,
  handleReplModelCommand,
  handleReplPacketCommand,
  handleReplSessionCommand,
  replPrompt,
  type ReplSessionState,
  runRepl,
} from "./cli.ts";
import type { CliConfig } from "./cli/args.ts";
import { formatRuntimeStatus } from "./cli/commands/status.ts";
import type { ConnectFn, Io, TurnInterruptSource } from "./cli/io.ts";
import { DomainError } from "./contract/mod.ts";
import { fakeIo } from "../testing/fakes/fake-io.ts";
import {
  fakeTurnConnect,
  sequentialTurnConnect,
  turnResult as result,
} from "../testing/builders/turn-client.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    socket: "/tmp/dyfj-test.sock",
    mode: "turn",
    color: false,
    ...overrides,
  };
}

// ── runExec ───────────────────────────────────────────────────────────────────

// ── runRepl ───────────────────────────────────────────────────────────────────

describe("runRepl", () => {
  it("holds a multi-turn conversation and resumes the session", async () => {
    const { connect, params } = sequentialTurnConnect([
      {
        frames: [{ t: "delta", text: "a" }],
        result: result({ sessionId: "SESS1", text: "a" }),
      },
      {
        frames: [{ t: "delta", text: "b" }],
        result: result({ sessionId: "SESS1", text: "b" }),
      },
    ]);
    const { io, stdout } = fakeIo(["first", "second"]);
    await runRepl(cfg(), io, connect, false);

    assert.deepStrictEqual(params.length, 2);
    assert.strictEqual(
      (params[0] as { sessionId?: string }).sessionId,
      undefined,
    );
    assert.strictEqual(
      (params[1] as { sessionId?: string }).sessionId,
      "SESS1",
    );
    assert.ok(
      stdout.join("").includes("a"),
      `expected stdout.join("") to include "a"`,
    );
    assert.ok(
      stdout.join("").includes("b"),
      `expected stdout.join("") to include "b"`,
    );
  });

  it("does not treat a slash-prefixed prompt that is not a command as friction command context", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const connect: ConnectFn = () =>
      Promise.resolve({
        request: (method, params) => {
          calls.push({ method, params });
          if (method === "turn") return Promise.resolve(result());
          if (method === "friction/post") {
            return Promise.resolve({
              number: "F039",
              commentId: "comment-39",
              firstLine: "F039 · 2026-09-03 · minor · escaped? no",
            });
          }
          return Promise.resolve(undefined);
        },
        close: () => {},
      });
    const prompt = "/usr/bin/env is what?";
    const { io } = fakeIo([
      prompt,
      "/friction minor A concrete failure.",
    ]);

    await runRepl(cfg({ unix: true }), io, connect, false);

    assert.partialDeepStrictEqual(
      calls.find((call) => call.method === "turn")?.params as Record<
        string,
        unknown
      >,
      { prompt },
    );
    const frictionCall = calls.find((call) => call.method === "friction/post");
    assert.notStrictEqual(frictionCall, undefined);
    assert.ok(
      !("command" in
        ((frictionCall?.params as { context: unknown }).context as object)),
    );
  });

  it("forwards a consumed slash command as truncated friction context", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const previousSlashCommand = `/idea mark ${"x".repeat(200)}`;
    const truncatedSlashCommand = previousSlashCommand.slice(0, 119) + "…";
    const connect: ConnectFn = () =>
      Promise.resolve({
        request: (method, params) => {
          calls.push({ method, params });
          if (method === "turn") return Promise.resolve(result());
          if (method === "ideas/mark") {
            return Promise.resolve({
              idea: {
                ideaId: "idea-39",
                label: "x".repeat(200),
              },
            });
          }
          if (method === "friction/post") {
            return Promise.resolve({
              number: "F039",
              commentId: "comment-39",
              firstLine: "F039 · 2026-09-03 · minor · escaped? no",
            });
          }
          return Promise.resolve(undefined);
        },
        close: () => {},
      });
    const { io } = fakeIo([
      "establish the session",
      previousSlashCommand,
      "/friction minor A concrete failure.",
    ]);

    await runRepl(cfg({ unix: true }), io, connect, false);

    const frictionCall = calls.find((call) => call.method === "friction/post");
    assert.partialDeepStrictEqual(
      frictionCall?.params as Record<string, unknown>,
      {
        context: { command: truncatedSlashCommand },
      },
    );
  });

  it("an interactive session holds a connection open throughout, so an autostarted runtime stays up while the REPL waits", async () => {
    let open = 0;
    const connect: ConnectFn = () => {
      open++;
      let closed = false;
      return Promise.resolve({
        request: () => Promise.resolve(undefined),
        close: () => {
          if (!closed) {
            closed = true;
            open--;
          }
        },
      } as unknown as Awaited<ReturnType<ConnectFn>>);
    };
    const lines = ["", "", "/exit"];
    const openWhileReading: number[] = [];
    const { io } = fakeIo([]);
    io.readLine = async () => {
      // Let the session's connection settle, as an operator's pause would.
      await new Promise((resolve) => setTimeout(resolve, 5));
      openWhileReading.push(open);
      return lines.shift() ?? null;
    };
    await runRepl(cfg(), io, connect, true);
    assert.deepStrictEqual(openWhileReading, [1, 1, 1]);
    assert.strictEqual(open, 0, "closed when the REPL exits");
  });

  it("refuses an unknown slash command locally, with no turn", async () => {
    const { connect, params } = sequentialTurnConnect([
      { result: result() },
    ]);
    const { io, stderr } = fakeIo(["/status", "/status now please", "real"]);
    await runRepl(cfg(), io, connect, false);
    assert.deepStrictEqual(
      params.map((body) => (body as { prompt: string }).prompt),
      ["real"],
    );
    assert.deepStrictEqual(
      stderr.filter((line) => line.startsWith("unknown command")),
      [
        "unknown command /status; /help lists commands",
        "unknown command /status; /help lists commands",
      ],
    );
  });

  it("sends a slash line that is not a single command word as text", async () => {
    const { connect, params } = sequentialTurnConnect([
      { result: result() },
      { result: result() },
    ]);
    const { io, stderr } = fakeIo([
      "/usr/bin/env is what?",
      "/status!",
    ]);
    await runRepl(cfg(), io, connect, false);
    assert.deepStrictEqual(
      params.map((body) => (body as { prompt: string }).prompt),
      ["/usr/bin/env is what?", "/status!"],
    );
    assert.ok(!stderr.some((line) => line.startsWith("unknown command")));
  });

  it("//word sends /word as the prompt text", async () => {
    const { connect, params } = sequentialTurnConnect([
      { result: result() },
      { result: result() },
    ]);
    const { io, stderr } = fakeIo(["//status", "//status of the build"]);
    await runRepl(cfg(), io, connect, false);
    assert.deepStrictEqual(
      params.map((body) => (body as { prompt: string }).prompt),
      ["/status", "/status of the build"],
    );
    assert.ok(!stderr.some((line) => line.startsWith("unknown command")));
  });

  it("/help lists the REPL commands without a turn", async () => {
    const { connect, params } = sequentialTurnConnect([]);
    const { io, stderr } = fakeIo(["/help"]);
    await runRepl(cfg(), io, connect, false);
    assert.deepStrictEqual(params, []);
    const text = stderr.join("\n");
    for (const word of ["/model", "/fast", "/session", "/friction", "/idea"]) {
      assert.ok(text.includes(word), `expected help to list ${word}`);
    }
  });

  it("skips blank lines and exits on /exit", async () => {
    const { connect, params } = sequentialTurnConnect([
      { result: result() },
    ]);
    const { io } = fakeIo(["   ", "real", "/exit", "never"]);
    await runRepl(cfg(), io, connect, false);
    assert.deepStrictEqual(params.length, 1);
  });

  it("keeps the REPL alive after a turn error", async () => {
    const { connect, params } = sequentialTurnConnect([
      { error: new DomainError("transient") },
      { result: result() },
    ]);
    const { io, stderr } = fakeIo(["one", "two"]);
    await runRepl(cfg(), io, connect, false);
    assert.deepStrictEqual(params.length, 2);
    assert.ok(
      stderr.join("\n").includes("transient"),
      `expected stderr.join("\\n") to include "transient"`,
    );
  });

  it("exits the REPL after cancellation leaves remote work uncertain", async () => {
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
      connect,
      false,
      interrupts,
    );

    assert.strictEqual(turnCalls, 1);
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(prompts.length, 1);
    const renderedError = stderr.join("\n");
    assert.ok(
      renderedError.includes(
        "turn cancellation was not acknowledged; restart the runtime before retrying",
      ),
      `expected ${
        JSON.stringify(renderedError)
      } to include "turn cancellation was not acknowledged; restart the runtime before retrying"`,
    );
    assert.ok(!renderedError.includes("interrupt cleanup failed"));
  });

  it("receipts carry the running session total across turns", async () => {
    const paid = (totalUsd: number) =>
      result({
        cost: {
          estimatedUsd: 0,
          totalUsd,
          basis: "catalog_estimate",
          paidInferenceUsed: true,
        },
      });
    const { connect } = sequentialTurnConnect([
      { result: paid(0.01) },
      { result: paid(0.02) },
    ]);
    const { io, stderr } = fakeIo(["one", "two"]);
    await runRepl(cfg(), io, connect, false);
    const rendered = stderr.join("\n");
    // With no runtime session figure, each receipt shows this REPL's sum of
    // every per-turn cost so far, labelled as that.
    assert.ok(
      rendered.includes("repl total $0.0100"),
      `expected ${JSON.stringify(rendered)} to include "repl total $0.0100"`,
    );
    assert.ok(
      rendered.includes("repl total $0.0300"),
      `expected ${JSON.stringify(rendered)} to include "repl total $0.0300"`,
    );
  });

  it("Ctrl-C cancels one UDS turn and carries its session into the next request", async () => {
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
      connect,
      false,
    );

    assert.ok(
      stdout.join("").includes("partial"),
      `expected stdout.join("") to include "partial"`,
    );
    assert.ok(
      stdout.join("").includes("next"),
      `expected stdout.join("") to include "next"`,
    );
    assert.deepStrictEqual(
      ["[interrupted]"].filter((item) => !stderr.includes(item)),
      [],
    );
    assert.deepStrictEqual(
      stderr.filter((line) => line === "[interrupt requested]"),
      [
        "[interrupt requested]",
      ],
    );
    assert.strictEqual(bodies[0].sessionId, undefined);
    assert.strictEqual(bodies[1].sessionId, result().sessionId);
    assert.strictEqual(raw[raw.length - 1], ERASE_LINE);
  });

  it("an aborted receipt commits its session before fallible rendering", async () => {
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

    await runRepl(cfg({ unix: true }), io, connect);

    assert.deepStrictEqual(bodies.length, 2);
    assert.strictEqual(bodies[0].sessionId, undefined);
    assert.strictEqual(bodies[1].sessionId, firstSessionId);
  });

  it("an aborted receipt commits its session before fallible spinner cleanup", async () => {
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

    await runRepl(cfg({ unix: true }), io, connect);

    assert.deepStrictEqual(bodies.length, 2);
    assert.strictEqual(bodies[0].sessionId, undefined);
    assert.strictEqual(bodies[1].sessionId, firstSessionId);
  });

  it("prints buffered aborted text before the interrupted marker", async () => {
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
      connect,
      false,
      interrupts,
    );

    const textIndex = writes.findIndex((write) =>
      write.includes("buffered partial text")
    );
    const markerIndex = writes.indexOf("err:[interrupted]");
    assert.ok(textIndex >= 0, `expected ${textIndex} >= 0`);
    assert.ok(
      markerIndex > textIndex,
      `expected ${markerIndex} > ${textIndex}`,
    );
  });

  it("Ctrl-C cancels a pending approval read before the next REPL prompt", async () => {
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
        assert.strictEqual(approvalReadSettled, true);
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
      connect,
      true,
      interrupts,
    );

    assert.strictEqual(approvalSignal?.aborted, true);
    assert.strictEqual(approvalReadSettled, true);
    assert.strictEqual(readCount, 3);
  });

  it("a spinner startup failure never installs the in-flight interrupt handler", async () => {
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
      connect,
      false,
      interrupts,
    );

    assert.strictEqual(added, 0);
    assert.strictEqual(removed, 0);
    assert.strictEqual(connectCalls, 0);
  });

  it("does not intercept SIGINT until the UDS connection is established", async () => {
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
      connect,
      false,
      interrupts,
    );

    await connectStarted;
    assert.strictEqual(added, 0);
    finishConnect({
      request: (method) =>
        method === "turn"
          ? Promise.resolve(result())
          : Promise.resolve(undefined),
      close: () => {},
    });
    await pending;

    assert.strictEqual(added, 1);
    assert.strictEqual(removed, 1);
  });

  it("a spinner erase failure cannot prevent an installed turn cancellation", async () => {
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
      connect,
      false,
      interrupts,
    );

    assert.strictEqual(cancellationCalls, 1);
  });
});

// ── parseArgs / resolveConfig / presentation ─────────────────────────────────

describe("runtime lifecycle commands", () => {
  it("malformed trust values render unknown on both surfaces — literal booleans only", () => {
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
      assert.ok(
        statusText.includes("workspace instructions: unknown"),
        `expected ${
          JSON.stringify(statusText)
        } to include "workspace instructions: unknown"`,
      );
      const postureLine = formatPostureLine({
        slug: "x",
        approvePaidSession: false,
        trustWorkspaceInstructions: value as unknown as boolean,
      });
      assert.ok(
        postureLine.includes("workspace instructions: unknown"),
        `expected ${
          JSON.stringify(postureLine)
        } to include "workspace instructions: unknown"`,
      );
    }
  });
});

describe("REPL /model", () => {
  function fakeConnect(
    models: {
      slug: string;
      tier?: number;
      local?: boolean;
      capabilities?: string[];
    }[],
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

  it("/model with no arg prints the active model, slugs, and posture", async () => {
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
    assert.strictEqual(handled, true);
    assert.ok(
      stderr.join("\n").includes("active model: gpt-5.5"),
      `expected stderr.join("\\n") to include "active model: gpt-5.5"`,
    );
    assert.ok(
      stderr.join("\n").includes("claude-opus-4-8"),
      `expected stderr.join("\\n") to include "claude-opus-4-8"`,
    );
    assert.ok(
      stderr.join("\n").includes(
        "posture: gpt-5.5 · tier 2 · hosted · paid off (hosted turns fail closed) · permission operator · workspace instructions: unknown",
      ),
      `expected stderr.join("\\n") to include "posture: gpt-5.5 · tier 2 · hosted · paid off (hosted turns fail closed) · permission operator · workspace instructions: unknown"`,
    );
  });

  it("/model <slug> switches the active model and reprints the posture", async () => {
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
    assert.strictEqual(handled, true);
    assert.strictEqual(config.model, "gpt-5.5");
    assert.ok(
      stderr.join("\n").includes(
        "posture: gpt-5.5 · tier 2 · hosted · paid off (hosted turns fail closed) · permission strict · workspace instructions: unknown",
      ),
      `expected stderr.join("\\n") to include "posture: gpt-5.5 · tier 2 · hosted · paid off (hosted turns fail closed) · permission strict · workspace instructions: unknown"`,
    );
  });

  it("/model <slug> leaves an external runner for native model routing", async () => {
    const { io } = fakeIo();
    const config = cfg({ runner: "fixture" });
    await handleReplModelCommand(
      "/model gpt-5.5",
      config,
      io,
      fakeConnect([{ slug: "gpt-5.5", tier: 2, local: false }]),
    );
    assert.strictEqual(config.model, "gpt-5.5");
    assert.strictEqual(config.runner, undefined);
  });

  it("/model <slug> --approve-paid arms the session paid opt-in", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg();
    await handleReplModelCommand(
      "/model gpt-5.5 --approve-paid",
      config,
      io,
      fakeConnect([{ slug: "gpt-5.5", tier: 2, local: false }]),
    );
    assert.strictEqual(config.model, "gpt-5.5");
    assert.strictEqual(config.approvePaid, true);
    assert.ok(
      stderr.join("\n").includes("paid approved (session)"),
      `expected stderr.join("\\n") to include "paid approved (session)"`,
    );
  });

  it("/model rejects an unknown slug and leaves the active model unchanged", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg({ model: "claude-opus-4-8" });
    await handleReplModelCommand(
      "/model no-such-model",
      config,
      io,
      fakeConnect([{ slug: "claude-opus-4-8" }]),
    );
    assert.strictEqual(config.model, "claude-opus-4-8");
    assert.ok(
      stderr.join("\n").includes("unknown model"),
      `expected stderr.join("\\n") to include "unknown model"`,
    );
  });

  it("a failed switch never arms paid inference as a side effect", async () => {
    const { io } = fakeIo();
    const config = cfg({ model: "claude-opus-4-8" });
    await handleReplModelCommand(
      "/model no-such-model --approve-paid",
      config,
      io,
      fakeConnect([{ slug: "claude-opus-4-8" }]),
    );
    assert.strictEqual(config.model, "claude-opus-4-8");
    assert.strictEqual(config.approvePaid, undefined);
  });

  it("/model <slug> --fast enables fast speed tier on supported model", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg();
    await handleReplModelCommand(
      "/model codex-chatgpt/gpt-5.6-terra --fast",
      config,
      io,
      fakeConnect([{
        slug: "codex-chatgpt/gpt-5.6-terra",
        tier: 2,
        local: false,
        capabilities: ["fast-speed"],
      }]),
    );
    assert.strictEqual(config.model, "codex-chatgpt/gpt-5.6-terra");
    assert.strictEqual(config.fast, true);
    assert.ok(
      stderr.join("\n").includes("⚡ fast"),
      `expected stderr.join("\\n") to include "⚡ fast"`,
    );
  });

  it("/model <slug> --fast rejects fast speed tier on unsupported model", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg();
    await handleReplModelCommand(
      "/model claude-opus-4-8 --fast",
      config,
      io,
      fakeConnect([{ slug: "claude-opus-4-8", tier: 2, local: false }]),
    );
    assert.strictEqual(config.fast, undefined);
    assert.ok(
      stderr.join("\n").includes("fast speed tier is not supported"),
      `expected stderr.join("\\n") to include "fast speed tier is not supported"`,
    );
  });

  it("/model switches to unsupported model and auto-disables fast speed tier", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg({ model: "codex-chatgpt/gpt-5.6-terra", fast: true });
    await handleReplModelCommand(
      "/model claude-opus-4-8",
      config,
      io,
      fakeConnect([
        {
          slug: "codex-chatgpt/gpt-5.6-terra",
          tier: 2,
          local: false,
          capabilities: ["fast-speed"],
        },
        { slug: "claude-opus-4-8", tier: 2, local: false },
      ]),
    );
    assert.strictEqual(config.model, "claude-opus-4-8");
    assert.strictEqual(config.fast, false);
    assert.ok(
      stderr.join("\n").includes(
        'fast speed tier disabled for "claude-opus-4-8"',
      ),
      `expected stderr.join("\\n") to include 'fast speed tier disabled for "claude-opus-4-8"'`,
    );
  });

  it("/model rejects specifying both --fast and --no-fast", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg({ model: "codex-chatgpt/gpt-5.6-terra" });
    const handled = await handleReplModelCommand(
      "/model codex-chatgpt/gpt-5.6-terra --fast --no-fast",
      config,
      io,
      fakeConnect([
        {
          slug: "codex-chatgpt/gpt-5.6-terra",
          tier: 2,
          local: false,
          capabilities: ["fast-speed"],
        },
      ]),
    );
    assert.strictEqual(handled, true);
    assert.ok(
      stderr.join("\n").includes("cannot specify both --fast and --no-fast"),
      `expected stderr.join("\\n") to include "cannot specify both --fast and --no-fast"`,
    );
  });
});

describe("REPL /fast command", () => {
  function fakeConnect(
    models: {
      slug: string;
      tier?: number;
      local?: boolean;
      capabilities?: string[];
    }[],
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

  it("/fast toggles fast speed tier on a supported model", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg({ model: "codex-chatgpt/gpt-5.6-terra" });
    const handled = await handleReplFastCommand(
      "/fast",
      config,
      io,
      fakeConnect([{
        slug: "codex-chatgpt/gpt-5.6-terra",
        tier: 2,
        local: false,
        capabilities: ["fast-speed"],
      }]),
    );
    assert.strictEqual(handled, true);
    assert.strictEqual(config.fast, true);
    assert.ok(
      stderr.join("\n").includes("⚡ fast"),
      `expected stderr.join("\\n") to include "⚡ fast"`,
    );
  });

  it("/fast rejects on unsupported model", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg({ model: "claude-opus-4-8" });
    const handled = await handleReplFastCommand(
      "/fast",
      config,
      io,
      fakeConnect([{ slug: "claude-opus-4-8", tier: 2, local: false }]),
    );
    assert.strictEqual(handled, true);
    assert.strictEqual(config.fast, undefined);
    assert.ok(
      stderr.join("\n").includes("fast speed tier is not supported"),
      `expected stderr.join("\\n") to include "fast speed tier is not supported"`,
    );
  });

  it("/fast rejects when an explicit runner is active", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg({ runner: "codex-chatgpt" });
    const handled = await handleReplFastCommand(
      "/fast",
      config,
      io,
      fakeConnect([]),
    );
    assert.strictEqual(handled, true);
    assert.strictEqual(config.fast, undefined);
    assert.ok(
      stderr.join("\n").includes("explicit runner is active"),
      `expected stderr.join("\\n") to include "explicit runner is active"`,
    );
  });
});

describe("REPL /session command", () => {
  it("/session with no active session shows prompt-first message", async () => {
    const { io, stderr } = fakeIo();
    const state = { turnCount: 0, sessionSpendUsd: 0 };
    const handled = await handleReplSessionCommand(
      "/session",
      cfg(),
      io,
      state,
    );
    assert.strictEqual(handled, true);
    assert.ok(
      stderr.join("\n").includes("no session yet"),
      `expected stderr.join("\\n") to include "no session yet"`,
    );
  });

  it("/session with active session displays identity, turns, spend, and resume instructions", async () => {
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
    assert.strictEqual(handled, true);
    const out = stderr.join("\n");
    assert.ok(
      out.includes("session: 01TEST_ACTIVE"),
      `expected ${JSON.stringify(out)} to include "session: 01TEST_ACTIVE"`,
    );
    assert.ok(
      out.includes("repl turns (this session): 3"),
      `expected ${
        JSON.stringify(out)
      } to include "repl turns (this session): 3"`,
    );
    assert.ok(
      out.includes("repl spend (this session): $0.0425"),
      `expected ${
        JSON.stringify(out)
      } to include "repl spend (this session): $0.0425"`,
    );
    assert.ok(
      out.includes("resume later with: dyfj --session 01TEST_ACTIVE"),
      `expected ${
        JSON.stringify(out)
      } to include "resume later with: dyfj --session 01TEST_ACTIVE"`,
    );
  });

  it("/session switch changes active sessionId and resets counts", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg({ sessionId: "01OLD000000000000000000000" });
    const state = {
      sessionId: "01OLD000000000000000000000",
      turnCount: 5,
      sessionSpendUsd: 0.1,
    };
    const handled = await handleReplSessionCommand(
      "/session switch 01NEW000000000000000000000",
      config,
      io,
      state,
    );
    assert.strictEqual(handled, true);
    assert.strictEqual(state.sessionId, "01NEW000000000000000000000");
    assert.strictEqual(config.sessionId, "01NEW000000000000000000000");
    assert.strictEqual(state.turnCount, 0);
    assert.strictEqual(state.sessionSpendUsd, 0);
    assert.ok(
      stderr.join("\n").includes(
        "switched to session: 01NEW000000000000000000000",
      ),
      `expected stderr.join("\\n") to include "switched to session: 01NEW000000000000000000000"`,
    );
  });

  it("/session switch rejects oversized session identifiers", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg();
    const state = { sessionId: "01OLD", turnCount: 2, sessionSpendUsd: 0.1 };
    const handled = await handleReplSessionCommand(
      `/session switch ${"A".repeat(300)}`,
      config,
      io,
      state,
    );
    assert.strictEqual(handled, true);
    assert.strictEqual(state.sessionId, "01OLD");
    assert.ok(
      stderr.join("\n").includes(
        "session identifier must be non-empty and <= 256 characters",
      ),
      `expected stderr.join("\\n") to include "session identifier must be non-empty and <= 256 characters"`,
    );
  });

  it("/session list lists sessions from RPC seam", async () => {
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
    assert.strictEqual(handled, true);
    assert.ok(
      stderr.join("\n").includes("01S1"),
      `expected stderr.join("\\n") to include "01S1"`,
    );
    assert.ok(
      stderr.join("\n").includes("First task"),
      `expected stderr.join("\\n") to include "First task"`,
    );
  });
});

describe("REPL /friction command", () => {
  it("help names the required friction-checkpoint configuration", async () => {
    const { io, stderr } = fakeIo();
    await handleReplFrictionCommand(
      "/friction help",
      cfg(),
      io,
      { turnCount: 0, sessionSpendUsd: 0 },
    );
    assert.deepStrictEqual(
      [
        "  DYFJ_FRICTION_ISSUE_ID must be set on the runtime",
      ].filter((item) => !stderr.includes(item)),
      [],
    );
    assert.deepStrictEqual(
      [
        "  posted Context: model slug, workspace basename, previous slash command (if any)",
      ].filter((item) => !stderr.includes(item)),
      [],
    );
    assert.deepStrictEqual(
      [
        "  free-text prompts and absolute workspace paths are never posted",
      ].filter((item) => !stderr.includes(item)),
      [],
    );
  });

  it("forwards a truncated slash command and workspace basename", async () => {
    const { io, stderr } = fakeIo();
    const calls: Array<{ method: string; params: unknown }> = [];
    const previousSlashCommand = `/packet ${"x".repeat(200)}`;
    const truncatedSlashCommand = previousSlashCommand.slice(0, 119) + "…";
    assert.deepStrictEqual(Array.from(truncatedSlashCommand).length, 120);
    let approvalHandlerPresent = false;
    const fakeConnect: ConnectFn = (_socket, options) => {
      approvalHandlerPresent = options?.onApproval !== undefined;
      return Promise.resolve({
        request: (method: string, params: unknown) => {
          calls.push({ method, params });
          return Promise.resolve({
            number: "F039",
            commentId: "comment-39",
            firstLine: "F039 · 2026-09-03 · minor · escaped? no",
          });
        },
        close: () => {},
      });
    };
    const state: ReplSessionState = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
      workspace: "/private/workspaces/example-repo",
      lastModelSlug: "model-slug",
      lastReplCommand: previousSlashCommand,
    };

    assert.strictEqual(
      await handleReplFrictionCommand(
        "/friction minor The command needed a multi-line paste.",
        cfg({ unix: true }),
        io,
        state,
        fakeConnect,
      ),
      true,
    );

    assert.strictEqual(approvalHandlerPresent, true);
    assert.deepStrictEqual(calls, [{
      method: "friction/post",
      params: {
        severity: "minor",
        escaped: false,
        text: "The command needed a multi-line paste.",
        context: {
          sessionId: "01ACTIVE_SESS",
          model: "model-slug",
          workspace: "example-repo",
          command: truncatedSlashCommand,
        },
      },
    }]);
    assert.deepStrictEqual(stderr, [
      "F039 · 2026-09-03 · minor · escaped? no",
      "comment id: comment-39",
    ]);
    assert.strictEqual(state.lastFriction?.commentId, "comment-39");
  });

  it("does not forward a free-text previous input", async () => {
    const { io } = fakeIo();
    const calls: Array<{ method: string; params: unknown }> = [];
    const state: ReplSessionState = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
      workspace: "/private/workspaces/example-repo",
      lastModelSlug: "model-slug",
      lastReplCommand: "Summarize the operator's private notes.",
    };

    await handleReplFrictionCommand(
      "/friction minor A concrete failure.",
      cfg({ unix: true }),
      io,
      state,
      () =>
        Promise.resolve({
          request: (method: string, params: unknown) => {
            calls.push({ method, params });
            return Promise.resolve({
              number: "F039",
              commentId: "comment-39",
              firstLine: "F039 · 2026-09-03 · minor · escaped? no",
            });
          },
          close: () => {},
        }),
    );

    assert.partialDeepStrictEqual(calls[0], {
      method: "friction/post",
      params: {
        context: {
          sessionId: "01ACTIVE_SESS",
          model: "model-slug",
          workspace: "example-repo",
        },
      },
    });
    assert.ok(
      !("command" in
        ((calls[0].params as { context: unknown }).context as object)),
    );
  });

  it("last shows only a previously successful receipt", async () => {
    const { io, stderr } = fakeIo();
    const state = {
      turnCount: 0,
      sessionSpendUsd: 0,
      lastFriction: {
        number: "F039",
        commentId: "comment-39",
        firstLine: "F039 · 2026-09-03 · minor · escaped? no",
      },
    };
    await handleReplFrictionCommand(
      "/friction last",
      cfg(),
      io,
      state,
    );
    assert.deepStrictEqual(stderr, [
      "F039 · 2026-09-03 · minor · escaped? no",
      "comment id: comment-39",
    ]);
  });

  it("reports the failed call without printing an unposted number", async () => {
    const { io, stderr } = fakeIo();
    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 0,
      sessionSpendUsd: 0,
    };
    await handleReplFrictionCommand(
      "/friction major A concrete failure.",
      cfg(),
      io,
      state,
      () =>
        Promise.resolve({
          request: () =>
            Promise.reject(
              new DomainError("create_comment failed: operator declined"),
            ),
          close: () => {},
        }),
    );
    assert.ok(
      stderr.join("\n").includes("create_comment failed: operator declined"),
      `expected stderr.join("\\n") to include "create_comment failed: operator declined"`,
    );
    assert.doesNotMatch(stderr.join("\n"), /F\d{3}/);
    assert.ok(!("lastFriction" in (state as object)));
  });

  it("prints the friction text back for retry when the call fails", async () => {
    const { io, stderr } = fakeIo();
    await handleReplFrictionCommand(
      "/friction major --escaped Linear was slow and I lost this.",
      cfg(),
      io,
      { sessionId: "01ACTIVE_SESS", turnCount: 0, sessionSpendUsd: 0 },
      () =>
        Promise.resolve({
          request: () =>
            Promise.reject(
              new DomainError(
                "get_issue failed: External MCP tool call failed: timed out after 30 s waiting for the server.",
              ),
            ),
          close: () => {},
        }),
    );
    assert.deepStrictEqual(stderr, [
      "friction capture failed: get_issue failed: External MCP tool call failed: timed out after 30 s waiting for the server.",
      "retry with: /friction major --escaped Linear was slow and I lost this.",
    ]);
  });

  it("prints the configuration stage without an unposted number", async () => {
    const { io, stderr } = fakeIo();
    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 0,
      sessionSpendUsd: 0,
    };
    await handleReplFrictionCommand(
      "/friction minor A concrete failure.",
      cfg(),
      io,
      state,
      () =>
        Promise.resolve({
          request: () =>
            Promise.reject(
              new DomainError(
                "configuration failed: DYFJ_FRICTION_ISSUE_ID must be set to the operator's friction-checkpoint issue",
              ),
            ),
          close: () => {},
        }),
    );
    assert.deepStrictEqual(stderr, [
      "friction capture failed: configuration failed: DYFJ_FRICTION_ISSUE_ID must be set to the operator's friction-checkpoint issue",
      "retry with: /friction minor A concrete failure.",
    ]);
    assert.doesNotMatch(stderr.join("\n"), /F\d{3}/);
    assert.ok(!("lastFriction" in (state as object)));
  });

  it("rejects an invalid severity without connecting", async () => {
    const { io, stderr } = fakeIo();
    let connected = false;
    await handleReplFrictionCommand(
      "/friction trivial A concrete failure.",
      cfg(),
      io,
      { turnCount: 0, sessionSpendUsd: 0 },
      () => {
        connected = true;
        throw new Error("must not connect");
      },
    );
    assert.strictEqual(connected, false);
    assert.ok(
      stderr.join("\n").includes("invalid friction severity"),
      `expected stderr.join("\\n") to include "invalid friction severity"`,
    );
  });
});

describe("REPL /idea command", () => {
  it("/idea mark captures an idea and emits next-step hint", async () => {
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

    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const handled = await handleReplIdeaCommand(
      "/idea mark Rate limit background autostarts",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    assert.strictEqual(handled, true);
    const out = stderr.join("\n");
    assert.ok(
      out.includes(
        'marked idea [01IDEA_TEST]: "Rate limit background autostarts"',
      ),
      `expected ${
        JSON.stringify(out)
      } to include 'marked idea [01IDEA_TEST]: "Rate limit background autostarts"'`,
    );
    assert.ok(
      out.includes("/packet draft 01IDEA_TEST"),
      `expected ${JSON.stringify(out)} to include "/packet draft 01IDEA_TEST"`,
    );
  });

  it("/idea list displays marked ideas", async () => {
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

    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const handled = await handleReplIdeaCommand(
      "/idea list",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    assert.strictEqual(handled, true);
    assert.ok(
      stderr.join("\n").includes("01IDEA_LIST_1"),
      `expected stderr.join("\\n") to include "01IDEA_LIST_1"`,
    );
    assert.ok(
      stderr.join("\n").includes("Validate DOLT_PORT"),
      `expected stderr.join("\\n") to include "Validate DOLT_PORT"`,
    );
  });
});

describe("REPL /packet command", () => {
  it("/packet draft generates work packet markdown and registers packet", async () => {
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
    assert.strictEqual(handled, true);
    assert.deepStrictEqual(recordedCalls, [
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
    assert.ok(
      stdout.join("\n").includes("# Work Packet: Draft work packet"),
      `expected stdout.join("\\n") to include "# Work Packet: Draft work packet"`,
    );
    assert.ok(
      stderr.join("\n").includes("draft work packet registered: [01PACKET_1]"),
      `expected stderr.join("\\n") to include "draft work packet registered: [01PACKET_1]"`,
    );
  });

  it("/packet draft with event-id passes eventId parameter", async () => {
    const { io, stdout, stderr } = fakeIo();
    const recordedCalls: Array<{ method: string; params: any }> = [];
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: (method: string, params: any) => {
          recordedCalls.push({ method, params });
          if (method === "ideas/get") {
            return Promise.resolve({ idea: null });
          }
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
    assert.strictEqual(handled, true);
    assert.deepStrictEqual(recordedCalls, [
      {
        method: "ideas/get",
        params: {
          ideaId: "evt-0123456789",
        },
      },
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
    assert.ok(
      stdout.join("\n").includes("# Work Packet: Event packet"),
      `expected stdout.join("\\n") to include "# Work Packet: Event packet"`,
    );
    assert.ok(
      stderr.join("\n").includes("draft work packet registered: [01PACKET_2]"),
      `expected stderr.join("\\n") to include "draft work packet registered: [01PACKET_2]"`,
    );
  });

  it("/packet draft with positional evt- target prioritizes existing idea ID", async () => {
    const { io, stdout, stderr } = fakeIo();
    const recordedCalls: Array<{ method: string; params: any }> = [];
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: (method: string, params: any) => {
          recordedCalls.push({ method, params });
          if (method === "ideas/get") {
            return Promise.resolve({
              idea: {
                ideaId: "evt-custom-idea",
                sessionId: "01ACTIVE_SESS",
                label: "Custom Idea Named Evt",
              },
            });
          }
          return Promise.resolve({
            packet: {
              packetId: "01PACKET_3",
              sessionId: params.sessionId,
              title: "Idea packet",
              issueId: null,
            },
            markdown: "# Work Packet: Idea packet",
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
      "/packet draft evt-custom-idea",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    assert.strictEqual(handled, true);
    assert.deepStrictEqual(recordedCalls, [
      {
        method: "ideas/get",
        params: {
          ideaId: "evt-custom-idea",
        },
      },
      {
        method: "packets/draft",
        params: {
          sessionId: "01ACTIVE_SESS",
          ideaId: "evt-custom-idea",
          eventId: undefined,
          issueId: undefined,
          title: undefined,
        },
      },
    ]);
    assert.ok(
      stdout.join("\n").includes("# Work Packet: Idea packet"),
      `expected stdout.join("\\n") to include "# Work Packet: Idea packet"`,
    );
    assert.ok(
      stderr.join("\n").includes("draft work packet registered: [01PACKET_3]"),
      `expected stderr.join("\\n") to include "draft work packet registered: [01PACKET_3]"`,
    );
  });

  it("/packet draft correctly parses --title before --issue in any order", async () => {
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

    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const handled = await handleReplPacketCommand(
      "/packet draft 01IDEA_1 --title Fix startup --issue ISSUE-258",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    assert.strictEqual(handled, true);
    assert.deepStrictEqual(recordedCalls, [
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
    assert.ok(
      stdout.join("\n").includes("# Work Packet: Fix startup"),
      `expected stdout.join("\\n") to include "# Work Packet: Fix startup"`,
    );
  });

  it("/packet draft correctly parses multi-word title followed by --issue", async () => {
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

    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const handled = await handleReplPacketCommand(
      "/packet draft 01IDEA_1 --title Document session behavior --issue ISSUE-258",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    assert.strictEqual(handled, true);
    assert.deepStrictEqual(recordedCalls, [
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
    assert.ok(
      stdout.join("\n").includes("# Work Packet: Document session behavior"),
      `expected stdout.join("\\n") to include "# Work Packet: Document session behavior"`,
    );
  });

  it("/packet draft supports explicit --event and --idea flags", async () => {
    const { io } = fakeIo();
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

    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const handled = await handleReplPacketCommand(
      "/packet draft --event custom-event-id --title Event Flag Test",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    assert.strictEqual(handled, true);
    assert.deepStrictEqual(recordedCalls, [
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

  it("/packet draft supports explicit --idea flag", async () => {
    const { io } = fakeIo();
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

    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const handled = await handleReplPacketCommand(
      "/packet draft --idea 01IDEA_CUSTOM --title Idea Flag Test",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    assert.strictEqual(handled, true);
    assert.deepStrictEqual(recordedCalls, [
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

  it("/packet draft supports targetless drafting from session context", async () => {
    const { io } = fakeIo();
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

    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const handled = await handleReplPacketCommand(
      "/packet draft --issue ISSUE-258 --title Investigate startup",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    assert.strictEqual(handled, true);
    assert.deepStrictEqual(recordedCalls, [
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

  it("/packet draft diagnoses duplicate or conflicting options and invalid option values", async () => {
    const { io, stderr } = fakeIo();
    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };

    await handleReplPacketCommand(
      "/packet draft 01IDEA --event evt-1",
      cfg({ unix: true }),
      io,
      state,
    );
    assert.ok(
      stderr.join("\n").includes(
        "cannot specify both positional target and explicit --idea/--event flag",
      ),
      `expected stderr.join("\\n") to include "cannot specify both positional target and explicit --idea/--event flag"`,
    );

    const io2 = fakeIo();
    await handleReplPacketCommand(
      "/packet draft --idea 01IDEA --event evt-1",
      cfg({ unix: true }),
      io2.io,
      state,
    );
    assert.ok(
      io2.stderr.join("\n").includes("cannot specify both --idea and --event"),
      `expected io2.stderr.join("\\n") to include "cannot specify both --idea and --event"`,
    );

    const io3 = fakeIo();
    await handleReplPacketCommand(
      "/packet draft 01IDEA --issue ISSUE-1 --issue ISSUE-2",
      cfg({ unix: true }),
      io3.io,
      state,
    );
    assert.ok(
      io3.stderr.join("\n").includes("--issue specified multiple times"),
      `expected io3.stderr.join("\\n") to include "--issue specified multiple times"`,
    );

    const io4 = fakeIo();
    await handleReplPacketCommand(
      "/packet draft 01IDEA --issue --isseu",
      cfg({ unix: true }),
      io4.io,
      state,
    );
    assert.ok(
      io4.stderr.join("\n").includes("--issue requires an issue identifier"),
      `expected io4.stderr.join("\\n") to include "--issue requires an issue identifier"`,
    );

    const io5 = fakeIo();
    await handleReplPacketCommand(
      "/packet list extra-arg",
      cfg({ unix: true }),
      io5.io,
      state,
    );
    assert.ok(
      io5.stderr.join("\n").includes("usage: /packet list"),
      `expected io5.stderr.join("\\n") to include "usage: /packet list"`,
    );

    const io6 = fakeIo();
    await handleReplPacketCommand(
      "/packet show 01PACKET extra-arg",
      cfg({ unix: true }),
      io6.io,
      state,
    );
    assert.ok(
      io6.stderr.join("\n").includes("usage: /packet show <packet-id>"),
      `expected io6.stderr.join("\\n") to include "usage: /packet show <packet-id>"`,
    );
  });

  it("/idea list and show validate trailing arguments", async () => {
    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const io1 = fakeIo();
    await handleReplIdeaCommand(
      "/idea list extra-arg",
      cfg({ unix: true }),
      io1.io,
      state,
    );
    assert.ok(
      io1.stderr.join("\n").includes("usage: /idea list"),
      `expected io1.stderr.join("\\n") to include "usage: /idea list"`,
    );

    const io2 = fakeIo();
    await handleReplIdeaCommand(
      "/idea show 01IDEA extra-arg",
      cfg({ unix: true }),
      io2.io,
      state,
    );
    assert.ok(
      io2.stderr.join("\n").includes("usage: /idea show <idea-id>"),
      `expected io2.stderr.join("\\n") to include "usage: /idea show <idea-id>"`,
    );
  });

  it("/session list and /session switch validate trailing arguments", async () => {
    const state = { turnCount: 0, sessionSpendUsd: 0 };
    const io1 = fakeIo();
    await handleReplSessionCommand(
      "/session list extra-arg",
      cfg({ unix: true }),
      io1.io,
      state,
    );
    assert.ok(
      io1.stderr.join("\n").includes("usage: /session list"),
      `expected io1.stderr.join("\\n") to include "usage: /session list"`,
    );

    const io2 = fakeIo();
    await handleReplSessionCommand(
      "/session switch 01SESS extra-arg",
      cfg({ unix: true }),
      io2.io,
      state,
    );
    assert.ok(
      io2.stderr.join("\n").includes("usage: /session switch <sessionId>"),
      `expected io2.stderr.join("\\n") to include "usage: /session switch <sessionId>"`,
    );

    const io3 = fakeIo();
    await handleReplSessionCommand(
      "/session switch 01UAT_SESSION_BETA",
      cfg({ unix: true }),
      io3.io,
      state,
    );
    assert.ok(
      io3.stderr.join("\n").includes(
        "error: session identifier must be a valid 26-character Crockford Base32 identifier",
      ),
      `expected io3.stderr.join("\\n") to include "error: session identifier must be a valid 26-character Crockford Base32 identifier"`,
    );
  });

  it("/packet draft rejects duplicate --title flags", async () => {
    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const { io, stderr } = fakeIo();
    await handleReplPacketCommand(
      "/packet draft 01IDEA --title First --title Second",
      cfg({ unix: true }),
      io,
      state,
    );
    assert.ok(
      stderr.join("\n").includes("error: --title specified multiple times"),
      `expected stderr.join("\\n") to include "error: --title specified multiple times"`,
    );
  });

  it("/packet draft, list, and show work in local mode without unix socket", async () => {
    const state = {
      sessionId: "01LOCAL_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const io1 = fakeIo();
    await handleReplPacketCommand(
      "/packet draft --title Local Work Packet --issue ISSUE-100",
      cfg({ unix: false }),
      io1.io,
      state,
    );
    assert.ok(
      io1.stdout.join("\n").includes("# Work Packet: Local Work Packet"),
      `expected io1.stdout.join("\\n") to include "# Work Packet: Local Work Packet"`,
    );
    assert.ok(
      io1.stderr.join("\n").includes("draft work packet registered"),
      `expected io1.stderr.join("\\n") to include "draft work packet registered"`,
    );

    const match = io1.stderr.join("\n").match(
      /draft work packet registered: \[([^\]]+)\]/,
    );
    const packetId = match ? match[1] : "01PACKET";

    const io2 = fakeIo();
    await handleReplPacketCommand(
      "/packet list",
      cfg({ unix: false }),
      io2.io,
      state,
    );
    assert.ok(
      io2.stderr.join("\n").includes("Work packets for session 01LOCAL_SESS:"),
      `expected io2.stderr.join("\\n") to include "Work packets for session 01LOCAL_SESS:"`,
    );
    assert.ok(
      io2.stderr.join("\n").includes("Local Work Packet"),
      `expected io2.stderr.join("\\n") to include "Local Work Packet"`,
    );

    const io3 = fakeIo();
    await handleReplPacketCommand(
      `/packet show ${packetId}`,
      cfg({ unix: false }),
      io3.io,
      state,
    );
    assert.ok(
      io3.stdout.join("\n").includes("# Work Packet: Local Work Packet"),
      `expected io3.stdout.join("\\n") to include "# Work Packet: Local Work Packet"`,
    );

    const io4 = fakeIo();
    await handleReplPacketCommand(
      "/packet draft MISSING_IDEA",
      cfg({ unix: false }),
      io4.io,
      state,
    );
    assert.ok(
      io4.stderr.join("\n").includes("dyfj: failed to draft packet"),
      `expected io4.stderr.join("\\n") to include "dyfj: failed to draft packet"`,
    );
  });

  it("/idea mark --event rejects option-looking event ID", async () => {
    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const { io, stderr } = fakeIo();
    await handleReplIdeaCommand(
      "/idea mark --event --evnt evt-1 Fix startup",
      cfg({ unix: true }),
      io,
      state,
    );
    assert.ok(
      stderr.join("\n").includes(
        "usage: /idea mark --event <event-id> <label...>",
      ),
      `expected stderr.join("\\n") to include "usage: /idea mark --event <event-id> <label...>"`,
    );
  });

  it("/idea mark rejects unrecognized options", async () => {
    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const { io, stderr } = fakeIo();
    await handleReplIdeaCommand(
      "/idea mark --evnt evt-1 Fix startup",
      cfg({ unix: true }),
      io,
      state,
    );
    assert.ok(
      stderr.join("\n").includes('error: unexpected argument "--evnt"'),
      `expected stderr.join("\\n") to include 'error: unexpected argument "--evnt"'`,
    );
  });

  it("/idea mark rejects single-dash unexpected option flags and option-like event IDs", async () => {
    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const { io: io1, stderr: stderr1 } = fakeIo();
    await handleReplIdeaCommand(
      "/idea mark -evnt evt-1 Fix startup",
      cfg({ unix: true }),
      io1,
      state,
    );
    assert.ok(
      stderr1.join("\n").includes('error: unexpected argument "-evnt"'),
      `expected stderr1.join("\\n") to include 'error: unexpected argument "-evnt"'`,
    );

    const { io: io2, stderr: stderr2 } = fakeIo();
    await handleReplIdeaCommand(
      "/idea mark --event -evnt Fix startup",
      cfg({ unix: true }),
      io2,
      state,
    );
    assert.ok(
      stderr2.join("\n").includes(
        "usage: /idea mark --event <event-id> <label...>",
      ),
      `expected stderr2.join("\\n") to include "usage: /idea mark --event <event-id> <label...>"`,
    );
  });

  it("/packet draft rejects unexpected option flags following --title", async () => {
    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const { io, stderr } = fakeIo();
    await handleReplPacketCommand(
      "/packet draft --title Fix --isseu ISSUE-1",
      cfg({ unix: true }),
      io,
      state,
    );
    assert.ok(
      stderr.join("\n").includes('error: unexpected argument "--isseu"'),
      `expected stderr.join("\\n") to include 'error: unexpected argument "--isseu"'`,
    );
  });

  it("/packet draft rejects single-dash unexpected option flags", async () => {
    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const { io, stderr } = fakeIo();
    await handleReplPacketCommand(
      "/packet draft -isseu ISSUE-1",
      cfg({ unix: true }),
      io,
      state,
    );
    assert.ok(
      stderr.join("\n").includes('error: unexpected argument "-isseu"'),
      `expected stderr.join("\\n") to include 'error: unexpected argument "-isseu"'`,
    );
  });

  it("/idea mark preserves label starting with evt- without explicit --event flag", async () => {
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

    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const handled = await handleReplIdeaCommand(
      "/idea mark evt-driven architecture",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    assert.strictEqual(handled, true);
    assert.deepStrictEqual(recordedCalls, [
      {
        method: "ideas/mark",
        params: {
          sessionId: "01ACTIVE_SESS",
          eventId: undefined,
          label: "evt-driven architecture",
        },
      },
    ]);
    assert.ok(
      stderr.join("\n").includes(
        'marked idea [01IDEA_EVT_LABEL]: "evt-driven architecture"',
      ),
      `expected stderr.join("\\n") to include 'marked idea [01IDEA_EVT_LABEL]: "evt-driven architecture"'`,
    );
  });

  it("/idea mark and /packet draft support local event references with sessionState.events", async () => {
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
    assert.strictEqual(handledIdea, true);
    assert.ok(
      io1.stderr.join("\n").includes("marked idea"),
      `expected io1.stderr.join("\\n") to include "marked idea"`,
    );

    const io2 = fakeIo();
    const handledPacket = await handleReplPacketCommand(
      "/packet draft evt_a_1 --title Local Event Packet",
      cfg({ unix: false }),
      io2.io,
      state,
    );
    assert.strictEqual(handledPacket, true);
    assert.ok(
      io2.stdout.join("\n").includes("# Work Packet: Local Event Packet"),
      `expected io2.stdout.join("\\n") to include "# Work Packet: Local Event Packet"`,
    );
    assert.ok(
      io2.stderr.join("\n").includes("draft work packet registered"),
      `expected io2.stderr.join("\\n") to include "draft work packet registered"`,
    );

    // Rejects non-existent event in local mode
    const io3 = fakeIo();
    await handleReplIdeaCommand(
      "/idea mark --event evt_missing Non-existent",
      cfg({ unix: false }),
      io3.io,
      state,
    );
    assert.ok(
      io3.stderr.join("\n").includes(
        'error: event "evt_missing" not found in current local session context',
      ),
      `expected io3.stderr.join("\\n") to include 'error: event "evt_missing" not found in current local session context'`,
    );
  });

  it("/session list orders sessions by latest activity timestamp (updatedAt)", async () => {
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
                    taskDescription:
                      "Old session created earlier but updated today",
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
    assert.ok(oldIdx >= 0, `expected ${oldIdx} >= 0`);
    assert.ok(newIdx >= 0, `expected ${newIdx} >= 0`);
    assert.ok(oldIdx < newIdx, `expected ${oldIdx} < ${newIdx}`);
  });

  it("/session list sorts non-ISO date strings chronologically rather than alphabetically", async () => {
    const { io, stderr } = fakeIo();
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: () =>
          Promise.resolve({
            projects: [
              {
                sessions: [
                  {
                    sessionId: "01WED_SESS",
                    taskDescription: "Wednesday session",
                    createdAt: "Wed Aug 12 2026 20:58:52 GMT",
                    updatedAt: "Wed Aug 12 2026 20:58:52 GMT",
                  },
                  {
                    sessionId: "01SUN_SESS",
                    taskDescription: "Sunday session created today",
                    createdAt: "Sun Aug 16 2026 05:00:00 GMT",
                    updatedAt: "Sun Aug 16 2026 05:00:00 GMT",
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
    const sunIdx = output.indexOf("01SUN_SESS");
    const wedIdx = output.indexOf("01WED_SESS");
    assert.ok(sunIdx >= 0, `expected ${sunIdx} >= 0`);
    assert.ok(wedIdx >= 0, `expected ${wedIdx} >= 0`);
    // Sunday (Aug 16) must appear before Wednesday (Aug 12) despite 'W' > 'S' alphabetically
    assert.ok(sunIdx < wedIdx, `expected ${sunIdx} < ${wedIdx}`);
    // Verify date is formatted as YYYY-MM-DD
    assert.ok(
      output.includes("2026-08-16"),
      `expected ${JSON.stringify(output)} to include "2026-08-16"`,
    );
    assert.ok(
      output.includes("2026-08-12"),
      `expected ${JSON.stringify(output)} to include "2026-08-12"`,
    );
  });

  it("/idea mark and /packet draft support -- delimiter for option-looking tokens", async () => {
    const { io } = fakeIo();
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

    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const handledIdea = await handleReplIdeaCommand(
      "/idea mark -- Support -Werror builds",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    assert.strictEqual(handledIdea, true);
    assert.strictEqual(recordedCalls[0].params.label, "Support -Werror builds");

    const handledPacket = await handleReplPacketCommand(
      "/packet draft --title -- Document -Werror",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );
    assert.strictEqual(handledPacket, true);
    assert.strictEqual(recordedCalls[1].params.title, "Document -Werror");
  });

  it("/session switch resets local session events", async () => {
    const state: any = {
      sessionId: "01TESTA0000000000000000000",
      turnCount: 3,
      sessionSpendUsd: 0.1,
      events: [{ eventId: "evt_u_1", sessionId: "01TESTA0000000000000000000" }],
      eventCounter: 3,
    };
    const { io } = fakeIo();
    const fakeConnect: ConnectFn = () =>
      Promise.resolve({
        request: () => Promise.resolve({ exists: true }),
        close: () => {},
      });

    await handleReplSessionCommand(
      "/session switch 01TESTB0000000000000000000",
      cfg({ unix: true }),
      io,
      state,
      fakeConnect,
    );

    assert.strictEqual(state.sessionId, "01TESTB0000000000000000000");
    assert.strictEqual(state.turnCount, 0);
    assert.deepStrictEqual(state.events, []);
    assert.strictEqual(state.eventCounter, 3);
  });

  it("/session switch rejects session identifiers with control characters or whitespace", async () => {
    const state: any = {
      sessionId: "01SESSION_A",
      turnCount: 0,
      sessionSpendUsd: 0,
    };
    const { io, stderr } = fakeIo();
    await handleReplSessionCommand(
      "/session switch session\x1Bid",
      cfg({ unix: true }),
      io,
      state,
    );
    assert.ok(
      stderr.join("\n").includes(
        "error: session identifier cannot contain control characters or whitespace",
      ),
      `expected stderr.join("\\n") to include "error: session identifier cannot contain control characters or whitespace"`,
    );
    assert.strictEqual(state.sessionId, "01SESSION_A");
  });

  it("/packet draft -- rejects extra positional arguments", async () => {
    const { io, stderr } = fakeIo();
    const state = {
      sessionId: "01ACTIVE_SESS",
      turnCount: 1,
      sessionSpendUsd: 0,
    };
    const handled = await handleReplPacketCommand(
      "/packet draft -- IDEA_A IDEA_B",
      cfg({ unix: true }),
      io,
      state,
    );
    assert.strictEqual(handled, true);
    assert.ok(
      stderr.join("\n").includes('error: unexpected argument "IDEA_B"'),
      `expected stderr.join("\\n") to include 'error: unexpected argument "IDEA_B"'`,
    );
  });
});

describe("session posture", () => {
  it("formatPostureLine covers paid states and locality", () => {
    assert.strictEqual(
      formatPostureLine({
        slug: "qwen-local",
        tier: 0,
        local: true,
        approvePaidSession: false,
        approvePaidDefault: false,
        permissionLevel: "operator",
      }),
      "posture: qwen-local · tier 0 · local · paid off (hosted turns fail closed) · permission operator · workspace instructions: unknown",
    );
    assert.strictEqual(
      formatPostureLine({
        slug: "claude-opus-4-8",
        tier: 2,
        local: false,
        approvePaidSession: true,
        permissionLevel: "strict",
      }),
      "posture: claude-opus-4-8 · tier 2 · hosted · paid approved (session) · permission strict · workspace instructions: unknown",
    );
    assert.strictEqual(
      formatPostureLine({
        slug: "claude-opus-4-8",
        tier: 2,
        local: false,
        approvePaidSession: false,
        approvePaidDefault: true,
        permissionLevel: "strict",
      }),
      "posture: claude-opus-4-8 · tier 2 · hosted · paid approved (standing config) · permission strict · workspace instructions: unknown",
    );
    assert.strictEqual(
      formatPostureLine({
        slug: "codex-chatgpt/gpt-5.6-terra",
        tier: 2,
        local: false,
        approvePaidSession: true,
        fast: true,
        permissionLevel: "strict",
      }),
      "posture: codex-chatgpt/gpt-5.6-terra · tier 2 · hosted · ⚡ fast · paid approved (session) · permission strict · workspace instructions: unknown",
    );
  });

  it("formatPostureLine surfaces the workspace-instruction trust state", () => {
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
    assert.strictEqual(
      formatPostureLine({ ...base, trustWorkspaceInstructions: true }),
      `${line}trusted`,
    );
    // Literal false pins "off" to real evidence, never inferred from absence.
    assert.strictEqual(
      formatPostureLine({ ...base, trustWorkspaceInstructions: false }),
      `${line}off`,
    );
    assert.strictEqual(formatPostureLine(base), `${line}unknown`);
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

  it("fetchSessionPosture uses the server-resolved bare-turn default", async () => {
    const posture = await fetchSessionPosture(
      cfg(),
      postureConnect({
        defaultTurnModel: { slug: "qwen-local", tier: 0, local: true },
        approvePaidDefault: false,
        permissionLevel: "operator",
      }),
    );
    assert.deepStrictEqual(posture, {
      slug: "qwen-local",
      tier: 0,
      local: true,
      approvePaidSession: false,
      approvePaidDefault: false,
      permissionLevel: "operator",
      trustWorkspaceInstructions: undefined,
    });
  });

  it("fetchSessionPosture carries the runtime's workspace-instruction trust", async () => {
    const posture = await fetchSessionPosture(
      cfg(),
      postureConnect({
        defaultTurnModel: { slug: "qwen-local", tier: 0, local: true },
        permissionLevel: "operator",
        trustWorkspaceInstructions: true,
      }),
    );
    assert.partialDeepStrictEqual(posture, {
      trustWorkspaceInstructions: true,
    });
  });

  it("fetchSessionPosture resolves an explicit model from the model list", async () => {
    const posture = await fetchSessionPosture(
      cfg({ model: "claude-opus-4-8", approvePaid: true }),
      postureConnect(
        { permissionLevel: "strict" },
        [{ slug: "claude-opus-4-8", tier: 2, local: false }],
      ),
    );
    assert.partialDeepStrictEqual(posture, {
      slug: "claude-opus-4-8",
      tier: 2,
      local: false,
      approvePaidSession: true,
      permissionLevel: "strict",
    });
  });

  it("fetchSessionPosture carries the fast option when set", async () => {
    const posture = await fetchSessionPosture(
      cfg({ model: "codex-chatgpt/gpt-5.6-terra", fast: true }),
      postureConnect(
        { permissionLevel: "operator" },
        [{
          slug: "codex-chatgpt/gpt-5.6-terra",
          tier: 2,
          local: false,
          capabilities: ["fast-speed"],
        }],
      ),
    );
    assert.partialDeepStrictEqual(posture, {
      slug: "codex-chatgpt/gpt-5.6-terra",
      fast: true,
    });
  });

  it("fetchSessionPosture names explicit tier/hint routing instead of the bare default", async () => {
    // A session launched with --tier routes every turn explicitly, so the
    // server's bare-turn default would misdescribe it.
    const posture = await fetchSessionPosture(
      cfg({ tier: 2 }),
      postureConnect({
        defaultTurnModel: { slug: "qwen-local", tier: 0, local: true },
        permissionLevel: "operator",
      }),
    );
    assert.partialDeepStrictEqual(posture, {
      slug: "(tier 2 route)",
      tier: 2,
      local: undefined,
    });

    const hinted = await fetchSessionPosture(
      cfg({ hint: "code" }),
      postureConnect({ permissionLevel: "operator" }),
    );
    assert.partialDeepStrictEqual(hinted, { slug: "(hint code route)" });
  });

  it("fetchSessionPosture reports an error when the seam is unreachable", async () => {
    const posture = await fetchSessionPosture(
      cfg(),
      () => Promise.reject(new Error("connection refused")),
    );
    assert.ok("error" in (posture as object));
  });

  it("runRepl prints the posture line at session start on the UDS seam", async () => {
    const { io, stderr } = fakeIo([]);
    await runRepl(
      cfg({ unix: true }),
      io,
      postureConnect({
        defaultTurnModel: { slug: "qwen-local", tier: 0, local: true },
        permissionLevel: "operator",
      }),
    );
    assert.ok(
      stderr.join("\n").includes(
        "posture: qwen-local · tier 0 · local · paid off (hosted turns fail closed) · permission operator · workspace instructions: unknown",
      ),
      `expected stderr.join("\\n") to include "posture: qwen-local · tier 0 · local · paid off (hosted turns fail closed) · permission operator · workspace instructions: unknown"`,
    );
  });

  it("runRepl still opens when the posture read fails", async () => {
    const { io, stderr } = fakeIo([]);
    await runRepl(
      cfg({ unix: true }),
      io,
      () => Promise.reject(new Error("connection refused")),
    );
    assert.ok(!stderr.join("\n").includes("posture:"));
  });
});

// ── Turn-in-flight spinner ───────────────────────────────────────────────────

const ERASE_LINE = "\r\x1b[2K";

describe("runRepl spinner integration", () => {
  it("each turn pauses around output, resumes, and retires at completion", async () => {
    const { connect } = sequentialTurnConnect([
      { frames: [{ t: "delta", text: "first\n" }], result: result() },
      { frames: [{ t: "delta", text: "second\n" }], result: result() },
    ]);
    const { io, raw, stdout } = fakeIo(["one", "two"], { errIsTerminal: true });
    await runRepl(cfg(), io, connect, false);
    // Two turns → a pause erase and a terminal erase for each, with a fresh
    // spinner instance (and therefore a fresh first frame) per turn.
    const erases = raw.filter((write) => write === ERASE_LINE);
    assert.deepStrictEqual(erases.length, 4);
    assert.strictEqual(raw[0], `${ERASE_LINE}⠋ working… 0s`);
    assert.strictEqual(raw[raw.length - 1], ERASE_LINE);
    assert.deepStrictEqual(
      raw.filter((write) => write === `${ERASE_LINE}⠋ working… 0s`).length,
      2,
    );
    assert.ok(
      stdout.join("").includes("first"),
      `expected stdout.join("") to include "first"`,
    );
    assert.ok(
      stdout.join("").includes("second"),
      `expected stdout.join("") to include "second"`,
    );
  });
});

// ── REPL prompt gutter ───────────────────────────────────────────────────────

describe("replPrompt", () => {
  it("plain mode is byte-identical to the historical prompt", () => {
    assert.strictEqual(replPrompt(false), "\ndyfj> ");
  });

  it("color mode carries a bold green gutter", () => {
    assert.strictEqual(replPrompt(true), "\n\x1b[1m\x1b[32mdyfj ❯\x1b[0m ");
  });

  it("runRepl prompts with the plain gutter when color is off", async () => {
    const { io, prompts } = fakeIo([]);
    await runRepl(
      cfg({ color: false }),
      io,
      fakeTurnConnect([], result()),
      false,
    );
    assert.deepStrictEqual(prompts, ["\ndyfj> "]);
  });

  it("runRepl prompts with the styled gutter when color is on", async () => {
    const { io, prompts } = fakeIo([]);
    await runRepl(
      cfg({ color: true }),
      io,
      fakeTurnConnect([], result()),
      false,
    );
    assert.deepStrictEqual(prompts, [replPrompt(true)]);
  });
});

// ── --parse-check (launcher validity contract) ───────────────────────────────

describe("REPL freshness warning", () => {
  const local = `sha256:${"a".repeat(64)}`;
  const old = `sha256:${"b".repeat(64)}`;
  const fingerprint = { head: "x", contentHash: old };

  it("warns that a runtime started with dyfj start is behind, and how to restart it", () => {
    const warning = formatFreshnessWarning(
      { runtimeFingerprint: fingerprint, autostarted: false },
      local,
    );
    assert.match(warning ?? "", /^warning: runtime is behind the working tree; /);
    assert.match(warning ?? "", /`dyfj stop`, then `dyfj start`/);
  });

  it("tells an autostarted runtime's client that it stops after its last client", () => {
    const warning = formatFreshnessWarning(
      { runtimeFingerprint: fingerprint, autostarted: true },
      local,
    );
    assert.match(warning ?? "", /^warning: runtime is behind the working tree; /);
    assert.match(warning ?? "", /10 s after its last client/);
  });

  it("says nothing when the code matches, or either side is unknown or absent", () => {
    assert.equal(
      formatFreshnessWarning({ runtimeFingerprint: { head: "x", contentHash: local } }, local),
      null,
    );
    assert.equal(formatFreshnessWarning({ runtimeFingerprint: fingerprint }, "unknown"), null);
    assert.equal(
      formatFreshnessWarning({ runtimeFingerprint: { head: "x", contentHash: "unknown" } }, local),
      null,
    );
    assert.equal(formatFreshnessWarning({}, local), null);
  });

  it("the posture an older client renders is unchanged by the new status fields", async () => {
    const runtime = {
      defaultTurnModel: { slug: "local-x", tier: 0, local: true },
      approvePaidDefault: false,
      permissionLevel: "strict",
      trustWorkspaceInstructions: false,
    };
    const connectWith = (extra: Record<string, unknown>): ConnectFn => () =>
      Promise.resolve({
        request: () => Promise.resolve({ runtime: { ...runtime, ...extra } }),
        close: () => {},
      } as unknown as Awaited<ReturnType<ConnectFn>>);
    const config: CliConfig = { socket: "/tmp/x.sock", mode: "turn", color: false };
    const before = await fetchSessionPosture(config, connectWith({}));
    const after = await fetchSessionPosture(
      config,
      connectWith({ fingerprint, clients: 3, inFlightTurns: 1 }),
    );
    assert.ok(!("error" in before) && !("error" in after));
    assert.equal(formatPostureLine(after), formatPostureLine(before));
    assert.deepEqual(after.runtimeFingerprint, fingerprint);
  });
});
