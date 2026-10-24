import { captureThrow } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSessionRef, parseArgs, resolveConfig } from "./args.ts";

describe("parseArgs", () => {
  it("bare args is the REPL", () => {
    assert.strictEqual(parseArgs([]).command, "repl");
  });
  it("exec joins the prompt words", () => {
    const p = parseArgs(["exec", "summarize", "the", "repo"]);
    assert.strictEqual(p.command, "exec");
    assert.strictEqual(p.prompt, "summarize the repo");
  });
  it("-p is an exec alias", () => {
    const p = parseArgs(["-p", "hello"]);
    assert.partialDeepStrictEqual(p, { command: "exec", prompt: "hello" });
  });
  it("parses only the declared external runners", () => {
    assert.strictEqual(
      parseArgs(["--runner", "fixture", "exec", "hi"]).overrides.runner,
      "fixture",
    );
    assert.strictEqual(
      parseArgs([
        "--runner",
        "codex-chatgpt",
        "exec",
        "hi",
      ]).overrides.runner,
      "codex-chatgpt",
    );
    assert.ok(
      (parseArgs(["--runner", "vendor", "exec", "hi"]).error ?? "").includes(
        "runner must be fixture or codex-chatgpt",
      ),
      `expected parseArgs(["--runner", "vendor", "exec", "hi"]).error ?? "" to include "runner must be fixture or codex-chatgpt"`,
    );
  });

  it("parses --fast and --no-fast flags", () => {
    assert.strictEqual(parseArgs(["--fast"]).overrides.fast, true);
    assert.strictEqual(parseArgs(["--no-fast"]).overrides.fast, false);
  });

  it("allows the Codex ChatGPT runner in REPL and with session resume", () => {
    assert.partialDeepStrictEqual(parseArgs(["--runner", "codex-chatgpt"]), {
      command: "repl",
      overrides: { runner: "codex-chatgpt" },
    });
    assert.partialDeepStrictEqual(
      parseArgs([
        "--runner",
        "codex-chatgpt",
        "--session",
        "01ABCDEF0123456789ABCDEF01",
        "exec",
        "hi",
      ]),
      {
        command: "exec",
        prompt: "hi",
        overrides: {
          runner: "codex-chatgpt",
          sessionId: "01ABCDEF0123456789ABCDEF01",
        },
      },
    );
    for (const command of ["status", "models", "sessions", "start", "stop"]) {
      assert.ok(
        (parseArgs(["--runner", "codex-chatgpt", command]).error ?? "")
          .includes(`--runner cannot be combined with '${command}'`),
        `expected parseArgs(["--runner", "codex-chatgpt", command]).error ?? "" to include \`--runner cannot be combined with '\${command}'\``,
      );
    }
    assert.ok(
      (parseArgs(["--runner", "codex-chatgpt", "status", "-p", "hi"]).error ??
        "").includes("--runner cannot be combined with 'status'"),
      `expected parseArgs(["--runner", "codex-chatgpt", "status", "-p", "hi"]).error ??
        "" to include "--runner cannot be combined with 'status'"`,
    );
  });

  it("rejects explicit model routing alongside a runner", () => {
    for (
      const routing of [
        ["--model", "model"],
        ["--tier", "1"],
        ["--hint", "code"],
        ["--fast"],
        ["--no-fast"],
      ]
    ) {
      assert.ok(
        (parseArgs(["--runner", "fixture", ...routing, "exec", "hi"]).error ??
          "").includes("runner cannot be combined"),
        `expected parseArgs(["--runner", "fixture", ...routing, "exec", "hi"]).error ??
          "" to include "runner cannot be combined"`,
      );
    }
  });
  it("collects routing flags", () => {
    const p = parseArgs([
      "--model",
      "m",
      "--tier",
      "2",
      "--hint",
      "code",
      "exec",
      "hi",
    ]);
    assert.partialDeepStrictEqual(p.overrides, {
      model: "m",
      tier: 2,
      hint: "code",
    });
    assert.strictEqual(p.prompt, "hi");
    assert.strictEqual(
      parseArgs(["--workspace", "/ws", "exec", "hi"]).overrides.workspace,
      "/ws",
    );
  });
  it("rejects an invalid tier", () => {
    assert.ok(
      (parseArgs(["--tier", "9", "exec", "x"]).error ?? "").includes("tier"),
      `expected parseArgs(["--tier", "9", "exec", "x"]).error ?? "" to include "tier"`,
    );
  });
  it("rejects an unknown flag", () => {
    assert.ok(
      (parseArgs(["--wat"]).error ?? "").includes("unknown flag"),
      `expected parseArgs(["--wat"]).error ?? "" to include "unknown flag"`,
    );
  });
  it("rejects retired HTTP transport flags", () => {
    assert.ok(
      (parseArgs(["--server", "http://h"]).error ?? "").includes(
        "unknown flag",
      ),
      `expected parseArgs(["--server", "http://h"]).error ?? "" to include "unknown flag"`,
    );
    assert.ok(
      (parseArgs(["--unix"]).error ?? "").includes("unknown flag"),
      `expected parseArgs(["--unix"]).error ?? "" to include "unknown flag"`,
    );
    assert.ok(
      (parseArgs(["--key", "k"]).error ?? "").includes("unknown flag"),
      `expected parseArgs(["--key", "k"]).error ?? "" to include "unknown flag"`,
    );
  });
  it("canonicalizes a valid --session value", () => {
    assert.strictEqual(
      parseArgs(["--session", "workbench-01ktz1xwcn7jmgs5e8kakfezkr"])
        .overrides.sessionId,
      "01KTZ1XWCN7JMGS5E8KAKFEZKR",
    );
  });
  it("rejects a garbage --session as a parse error, not a throw", () => {
    const p = parseArgs(["--session", "garbage-value"]);
    assert.strictEqual(p.command, "help");
    assert.ok(
      (p.error ?? "").includes("dyfj sessions"),
      `expected p.error ?? "" to include "dyfj sessions"`,
    );
    // main prefixes "dyfj: "; the parse error must not carry its own.
    assert.doesNotMatch(p.error ?? "", /^dyfj:/);
  });
  it("--help asks for help", () => {
    assert.strictEqual(parseArgs(["--help"]).command, "help");
  });
  it("'models' and 'sessions' are their own commands", () => {
    assert.strictEqual(parseArgs(["models"]).command, "models");
    assert.strictEqual(parseArgs(["sessions"]).command, "sessions");
  });
  it("'status' and 'start' are their own commands", () => {
    assert.strictEqual(parseArgs(["status"]).command, "status");
    assert.strictEqual(parseArgs(["start"]).command, "start");
  });
  it("accepts the internal launcher marker only on start", () => {
    assert.partialDeepStrictEqual(
      parseArgs(["start", "--launcher-autostarted"]),
      {
        command: "start",
        launcherAutostarted: true,
      },
    );
    assert.partialDeepStrictEqual(parseArgs(["-p", "--launcher-autostarted"]), {
      command: "exec",
      prompt: "--launcher-autostarted",
    });
  });
  it("rejects the internal launcher marker outside start", () => {
    for (
      const argv of [
        ["--launcher-autostarted"],
        ["status", "--launcher-autostarted"],
        ["start", "extra", "--launcher-autostarted"],
        ["-p", "hello", "start", "--launcher-autostarted"],
        ["start", "--launcher-autostarted", "--help"],
      ]
    ) {
      assert.ok(
        (parseArgs(argv).error ?? "").includes(
          "--launcher-autostarted is valid only with start",
        ),
        `expected parseArgs(argv).error ?? "" to include "--launcher-autostarted is valid only with start"`,
      );
    }
  });
  it("--socket overrides the socket path", () => {
    assert.strictEqual(
      parseArgs(["--socket", "/run/x.sock", "models"]).overrides.socket,
      "/run/x.sock",
    );
  });
  it("--approve-paid sets the paid opt-in", () => {
    assert.strictEqual(
      parseArgs(["--approve-paid", "exec", "x"]).overrides.approvePaid,
      true,
    );
  });
  it("--tool-steps sets the session's tool-step limit within the bound", () => {
    assert.strictEqual(
      parseArgs(["--tool-steps", "12", "exec", "x"]).overrides.toolSteps,
      12,
    );
    for (const value of ["0", "65", "1.5", "-3", "many"]) {
      assert.strictEqual(
        parseArgs(["--tool-steps", value, "exec", "x"]).error,
        "--tool-steps must be an integer from 1 through 64",
        value,
      );
    }
  });
  it("--mode sets the context mode", () => {
    assert.strictEqual(
      parseArgs(["--mode", "ask", "exec", "x"]).overrides.mode,
      "ask",
    );
  });
  it("rejects an invalid mode", () => {
    assert.ok(
      (parseArgs(["--mode", "wat", "exec", "x"]).error ?? "").includes("mode"),
      `expected parseArgs(["--mode", "wat", "exec", "x"]).error ?? "" to include "mode"`,
    );
  });
  it("'ask' is a one-shot ask-mode exec", () => {
    const p = parseArgs(["ask", "what", "is", "this", "repo"]);
    assert.strictEqual(p.command, "exec");
    assert.strictEqual(p.prompt, "what is this repo");
    assert.strictEqual(p.overrides.mode, "ask");
  });
  it("'ask' requires a prompt", () => {
    assert.ok(
      (parseArgs(["ask"]).error ?? "").includes("ask requires a prompt"),
      `expected parseArgs(["ask"]).error ?? "" to include "ask requires a prompt"`,
    );
  });
  it("rejects conflicting --fast and --no-fast flags", () => {
    assert.ok(
      (parseArgs(["--fast", "--no-fast", "exec", "x"]).error ?? "").includes(
        "cannot specify both --fast and --no-fast",
      ),
      `expected parseArgs(["--fast", "--no-fast", "exec", "x"]).error ?? "" to include "cannot specify both --fast and --no-fast"`,
    );
    assert.ok(
      (parseArgs(["--no-fast", "--fast", "exec", "x"]).error ?? "").includes(
        "cannot specify both --fast and --no-fast",
      ),
      `expected parseArgs(["--no-fast", "--fast", "exec", "x"]).error ?? "" to include "cannot specify both --fast and --no-fast"`,
    );
  });
});

describe("resolveConfig", () => {
  it("overrides beat env, env beats defaults", () => {
    const env = new Map([
      ["DYFJ_WORKBENCH_MODEL", "envmodel"],
      ["NO_COLOR", "1"],
    ]);
    const c = resolveConfig(
      { model: "flagmodel" },
      { get: (k) => env.get(k) },
      true,
    );
    assert.strictEqual(c.model, "flagmodel");
    assert.strictEqual(c.color, false);
  });
  it("enables color on a TTY", () => {
    const c = resolveConfig({}, { get: () => undefined }, true);
    assert.strictEqual(c.color, true);
  });
  it("defaults unix to true; an explicit unix: false is honored", () => {
    assert.strictEqual(resolveConfig({}, { get: () => undefined }).unix, true);
    assert.strictEqual(
      resolveConfig({ unix: false }, { get: () => undefined }).unix,
      false,
    );
    assert.strictEqual(
      resolveConfig({ unix: true }, { get: () => undefined }).unix,
      true,
    );
  });
  it("mode defaults to turn and honors the override", () => {
    assert.strictEqual(
      resolveConfig({}, { get: () => undefined }).mode,
      "turn",
    );
    assert.strictEqual(
      resolveConfig({ mode: "ask" }, { get: () => undefined }).mode,
      "ask",
    );
  });
  it("fast option carries through resolveConfig", () => {
    assert.strictEqual(
      resolveConfig({ fast: true }, { get: () => undefined }).fast,
      true,
    );
    assert.strictEqual(
      resolveConfig({ fast: false }, { get: () => undefined }).fast,
      false,
    );
    assert.strictEqual(
      resolveConfig({}, { get: () => undefined }).fast,
      undefined,
    );
  });
  it("workspace defaults to cwd; flag and env override it", () => {
    assert.strictEqual(
      resolveConfig({}, { get: () => undefined }, false, "/work/dir").workspace,
      "/work/dir",
    );
    const env = new Map([["DYFJ_WORKSPACE", "/env/ws"]]);
    assert.strictEqual(
      resolveConfig({}, { get: (k) => env.get(k) }, false, "/cwd").workspace,
      "/env/ws",
    );
    assert.strictEqual(
      resolveConfig(
        { workspace: "/flag/ws" },
        { get: (k) => env.get(k) },
        false,
        "/cwd",
      )
        .workspace,
      "/flag/ws",
    );
  });
  it("marks workspace explicit only when set via flag or env", () => {
    assert.strictEqual(
      resolveConfig({}, { get: () => undefined }, false, "/cwd")
        .workspaceExplicit,
      false,
    );
    assert.strictEqual(
      resolveConfig(
        { workspace: "/w" },
        { get: () => undefined },
        false,
        "/cwd",
      )
        .workspaceExplicit,
      true,
    );
    const env = new Map([["DYFJ_WORKSPACE", "/env"]]);
    assert.strictEqual(
      resolveConfig({}, { get: (k) => env.get(k) }, false, "/cwd")
        .workspaceExplicit,
      true,
    );
  });
  it("socket defaults via DYFJ_SOCKET and the --socket override", () => {
    const env = new Map([["DYFJ_SOCKET", "/run/dyfj.sock"]]);
    assert.strictEqual(
      resolveConfig({}, { get: (k) => env.get(k) }).socket,
      "/run/dyfj.sock",
    );
    assert.strictEqual(
      resolveConfig({ socket: "/flag.sock" }, { get: (k) => env.get(k) })
        .socket,
      "/flag.sock",
    );
  });
});

describe("normalizeSessionRef", () => {
  it("accepts the slug exactly as dyfj sessions lists it", () => {
    assert.strictEqual(
      normalizeSessionRef("workbench-01ktz1xwcn7jmgs5e8kakfezkr"),
      "01KTZ1XWCN7JMGS5E8KAKFEZKR",
    );
  });

  it("accepts a bare session id in either case", () => {
    assert.strictEqual(
      normalizeSessionRef("01KTZ1XWCN7JMGS5E8KAKFEZKR"),
      "01KTZ1XWCN7JMGS5E8KAKFEZKR",
    );
    assert.strictEqual(
      normalizeSessionRef("01ktz1xwcn7jmgs5e8kakfezkr"),
      "01KTZ1XWCN7JMGS5E8KAKFEZKR",
    );
  });

  it("rejects garbage with a pointer to dyfj sessions", () => {
    const error = captureThrow(
      () => normalizeSessionRef("not-a-session"),
      Error,
    );
    assert.match(error.message, /dyfj sessions/);
  });
});

describe("parseArgs for stop subcommand", () => {
  it("parses bare stop command", () => {
    const parsed = parseArgs(["stop"]);
    assert.deepStrictEqual(parsed, {
      command: "stop",
      json: false,
      overrides: {},
    });
  });

  it("parses stop with custom socket path", () => {
    const parsed = parseArgs(["stop", "--socket", "/custom/path.sock"]);
    assert.deepStrictEqual(parsed, {
      command: "stop",
      json: false,
      overrides: { socket: "/custom/path.sock" },
    });
  });

  it("rejects stop with positional prompt argument", () => {
    const parsed = parseArgs(["stop", "prompt"]);
    assert.strictEqual(parsed.command, "help");
    assert.ok(
      (parsed.error ?? "").includes("unknown command: stop"),
      `expected parsed.error ?? "" to include "unknown command: stop"`,
    );
  });

  it("rejects --launcher-autostarted on stop", () => {
    const parsed = parseArgs(["--launcher-autostarted", "stop"]);
    assert.strictEqual(parsed.command, "help");
    assert.ok(
      (parsed.error ?? "").includes(
        "--launcher-autostarted is valid only with start",
      ),
      `expected parsed.error ?? "" to include "--launcher-autostarted is valid only with start"`,
    );
  });
});
