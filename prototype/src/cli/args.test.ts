import {
  assertEquals,
  assertMatch,
  assertNotMatch,
  assertObjectMatch,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { normalizeSessionRef, parseArgs, resolveConfig } from "./args.ts";

describe("parseArgs", () => {
  it("bare args is the REPL", () => {
    assertStrictEquals(parseArgs([]).command, "repl");
  });
  it("exec joins the prompt words", () => {
    const p = parseArgs(["exec", "summarize", "the", "repo"]);
    assertStrictEquals(p.command, "exec");
    assertStrictEquals(p.prompt, "summarize the repo");
  });
  it("-p is an exec alias", () => {
    const p = parseArgs(["-p", "hello"]);
    assertObjectMatch(p, { command: "exec", prompt: "hello" });
  });
  it("parses only the declared external runners", () => {
    assertStrictEquals(
      parseArgs(["--runner", "fixture", "exec", "hi"]).overrides.runner,
      "fixture",
    );
    assertStrictEquals(
      parseArgs([
        "--runner",
        "codex-chatgpt",
        "exec",
        "hi",
      ]).overrides.runner,
      "codex-chatgpt",
    );
    assertStringIncludes(
      parseArgs(["--runner", "vendor", "exec", "hi"]).error ?? "",
      "runner must be fixture or codex-chatgpt",
    );
  });

  it("parses --fast and --no-fast flags", () => {
    assertStrictEquals(parseArgs(["--fast"]).overrides.fast, true);
    assertStrictEquals(parseArgs(["--no-fast"]).overrides.fast, false);
  });

  it("allows the Codex ChatGPT runner in REPL and with session resume", () => {
    assertObjectMatch(parseArgs(["--runner", "codex-chatgpt"]), {
      command: "repl",
      overrides: { runner: "codex-chatgpt" },
    });
    assertObjectMatch(
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
      assertStringIncludes(
        parseArgs(["--runner", "codex-chatgpt", command]).error ?? "",
        `--runner cannot be combined with '${command}'`,
      );
    }
    assertStringIncludes(
      parseArgs(["--runner", "codex-chatgpt", "status", "-p", "hi"]).error ??
        "",
      "--runner cannot be combined with 'status'",
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
      assertStringIncludes(
        parseArgs(["--runner", "fixture", ...routing, "exec", "hi"]).error ??
          "",
        "runner cannot be combined",
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
    assertObjectMatch(p.overrides, {
      model: "m",
      tier: 2,
      hint: "code",
    });
    assertStrictEquals(p.prompt, "hi");
    assertStrictEquals(
      parseArgs(["--workspace", "/ws", "exec", "hi"]).overrides.workspace,
      "/ws",
    );
  });
  it("rejects an invalid tier", () => {
    assertStringIncludes(
      parseArgs(["--tier", "9", "exec", "x"]).error ?? "",
      "tier",
    );
  });
  it("rejects an unknown flag", () => {
    assertStringIncludes(parseArgs(["--wat"]).error ?? "", "unknown flag");
  });
  it("rejects retired HTTP transport flags", () => {
    assertStringIncludes(
      parseArgs(["--server", "http://h"]).error ?? "",
      "unknown flag",
    );
    assertStringIncludes(parseArgs(["--unix"]).error ?? "", "unknown flag");
    assertStringIncludes(parseArgs(["--key", "k"]).error ?? "", "unknown flag");
  });
  it("canonicalizes a valid --session value", () => {
    assertStrictEquals(
      parseArgs(["--session", "workbench-01ktz1xwcn7jmgs5e8kakfezkr"])
        .overrides.sessionId,
      "01KTZ1XWCN7JMGS5E8KAKFEZKR",
    );
  });
  it("rejects a garbage --session as a parse error, not a throw", () => {
    const p = parseArgs(["--session", "garbage-value"]);
    assertStrictEquals(p.command, "help");
    assertStringIncludes(p.error ?? "", "dyfj sessions");
    // main prefixes "dyfj: "; the parse error must not carry its own.
    assertNotMatch(p.error ?? "", /^dyfj:/);
  });
  it("--help asks for help", () => {
    assertStrictEquals(parseArgs(["--help"]).command, "help");
  });
  it("'models' and 'sessions' are their own commands", () => {
    assertStrictEquals(parseArgs(["models"]).command, "models");
    assertStrictEquals(parseArgs(["sessions"]).command, "sessions");
  });
  it("'status' and 'start' are their own commands", () => {
    assertStrictEquals(parseArgs(["status"]).command, "status");
    assertStrictEquals(parseArgs(["start"]).command, "start");
  });
  it("accepts the internal launcher marker only on start", () => {
    assertObjectMatch(parseArgs(["start", "--launcher-autostarted"]), {
      command: "start",
      launcherAutostarted: true,
    });
    assertObjectMatch(parseArgs(["-p", "--launcher-autostarted"]), {
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
      assertStringIncludes(
        parseArgs(argv).error ?? "",
        "--launcher-autostarted is valid only with start",
      );
    }
  });
  it("--socket overrides the socket path", () => {
    assertStrictEquals(
      parseArgs(["--socket", "/run/x.sock", "models"]).overrides.socket,
      "/run/x.sock",
    );
  });
  it("--approve-paid sets the paid opt-in", () => {
    assertStrictEquals(
      parseArgs(["--approve-paid", "exec", "x"]).overrides.approvePaid,
      true,
    );
  });
  it("--mode sets the context mode", () => {
    assertStrictEquals(
      parseArgs(["--mode", "ask", "exec", "x"]).overrides.mode,
      "ask",
    );
  });
  it("rejects an invalid mode", () => {
    assertStringIncludes(
      parseArgs(["--mode", "wat", "exec", "x"]).error ?? "",
      "mode",
    );
  });
  it("'ask' is a one-shot ask-mode exec", () => {
    const p = parseArgs(["ask", "what", "is", "this", "repo"]);
    assertStrictEquals(p.command, "exec");
    assertStrictEquals(p.prompt, "what is this repo");
    assertStrictEquals(p.overrides.mode, "ask");
  });
  it("'ask' requires a prompt", () => {
    assertStringIncludes(
      parseArgs(["ask"]).error ?? "",
      "ask requires a prompt",
    );
  });
  it("rejects conflicting --fast and --no-fast flags", () => {
    assertStringIncludes(
      parseArgs(["--fast", "--no-fast", "exec", "x"]).error ?? "",
      "cannot specify both --fast and --no-fast",
    );
    assertStringIncludes(
      parseArgs(["--no-fast", "--fast", "exec", "x"]).error ?? "",
      "cannot specify both --fast and --no-fast",
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
    assertStrictEquals(c.model, "flagmodel");
    assertStrictEquals(c.color, false);
  });
  it("enables color on a TTY", () => {
    const c = resolveConfig({}, { get: () => undefined }, true);
    assertStrictEquals(c.color, true);
  });
  it("defaults unix to true; an explicit unix: false is honored", () => {
    assertStrictEquals(resolveConfig({}, { get: () => undefined }).unix, true);
    assertStrictEquals(
      resolveConfig({ unix: false }, { get: () => undefined }).unix,
      false,
    );
    assertStrictEquals(
      resolveConfig({ unix: true }, { get: () => undefined }).unix,
      true,
    );
  });
  it("mode defaults to turn and honors the override", () => {
    assertStrictEquals(
      resolveConfig({}, { get: () => undefined }).mode,
      "turn",
    );
    assertStrictEquals(
      resolveConfig({ mode: "ask" }, { get: () => undefined }).mode,
      "ask",
    );
  });
  it("fast option carries through resolveConfig", () => {
    assertStrictEquals(
      resolveConfig({ fast: true }, { get: () => undefined }).fast,
      true,
    );
    assertStrictEquals(
      resolveConfig({ fast: false }, { get: () => undefined }).fast,
      false,
    );
    assertStrictEquals(
      resolveConfig({}, { get: () => undefined }).fast,
      undefined,
    );
  });
  it("workspace defaults to cwd; flag and env override it", () => {
    assertStrictEquals(
      resolveConfig({}, { get: () => undefined }, false, "/work/dir").workspace,
      "/work/dir",
    );
    const env = new Map([["DYFJ_WORKSPACE", "/env/ws"]]);
    assertStrictEquals(
      resolveConfig({}, { get: (k) => env.get(k) }, false, "/cwd").workspace,
      "/env/ws",
    );
    assertStrictEquals(
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
    assertStrictEquals(
      resolveConfig({}, { get: () => undefined }, false, "/cwd")
        .workspaceExplicit,
      false,
    );
    assertStrictEquals(
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
    assertStrictEquals(
      resolveConfig({}, { get: (k) => env.get(k) }, false, "/cwd")
        .workspaceExplicit,
      true,
    );
  });
  it("socket defaults via DYFJ_SOCKET and the --socket override", () => {
    const env = new Map([["DYFJ_SOCKET", "/run/dyfj.sock"]]);
    assertStrictEquals(
      resolveConfig({}, { get: (k) => env.get(k) }).socket,
      "/run/dyfj.sock",
    );
    assertStrictEquals(
      resolveConfig({ socket: "/flag.sock" }, { get: (k) => env.get(k) })
        .socket,
      "/flag.sock",
    );
  });
});

describe("normalizeSessionRef", () => {
  it("accepts the slug exactly as dyfj sessions lists it", () => {
    assertStrictEquals(
      normalizeSessionRef("workbench-01ktz1xwcn7jmgs5e8kakfezkr"),
      "01KTZ1XWCN7JMGS5E8KAKFEZKR",
    );
  });

  it("accepts a bare session id in either case", () => {
    assertStrictEquals(
      normalizeSessionRef("01KTZ1XWCN7JMGS5E8KAKFEZKR"),
      "01KTZ1XWCN7JMGS5E8KAKFEZKR",
    );
    assertStrictEquals(
      normalizeSessionRef("01ktz1xwcn7jmgs5e8kakfezkr"),
      "01KTZ1XWCN7JMGS5E8KAKFEZKR",
    );
  });

  it("rejects garbage with a pointer to dyfj sessions", () => {
    const error = assertThrows(
      () => normalizeSessionRef("not-a-session"),
      Error,
    );
    assertMatch(error.message, /dyfj sessions/);
  });
});

describe("parseArgs for stop subcommand", () => {
  it("parses bare stop command", () => {
    const parsed = parseArgs(["stop"]);
    assertEquals(parsed, {
      command: "stop",
      json: false,
      overrides: {},
    });
  });

  it("parses stop with custom socket path", () => {
    const parsed = parseArgs(["stop", "--socket", "/custom/path.sock"]);
    assertEquals(parsed, {
      command: "stop",
      json: false,
      overrides: { socket: "/custom/path.sock" },
    });
  });

  it("rejects stop with positional prompt argument", () => {
    const parsed = parseArgs(["stop", "prompt"]);
    assertStrictEquals(parsed.command, "help");
    assertStringIncludes(parsed.error ?? "", "unknown command: stop");
  });

  it("rejects --launcher-autostarted on stop", () => {
    const parsed = parseArgs(["--launcher-autostarted", "stop"]);
    assertStrictEquals(parsed.command, "help");
    assertStringIncludes(
      parsed.error ?? "",
      "--launcher-autostarted is valid only with start",
    );
  });
});
