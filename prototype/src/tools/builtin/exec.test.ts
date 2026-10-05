import {
  assertEquals,
  assertFalse,
  assertMatch,
  assertNotEquals,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import type { CommandCall } from "../definition.ts";
import { buildToolCatalog } from "../catalog.ts";
import { RootAnchors } from "./root-anchors.ts";
import { evaluateCommandPolicy } from "../policy.ts";
import {
  type BashResult,
  type BashRunner,
  buildSafeBashEnv,
  defineBash,
  executeBash,
} from "./exec.ts";

// A canned runner so these tests never spawn a real process.
const cannedRunner = (
  stdout: string,
  stderr = "",
  code = 0,
  extra: { signal?: string | null; timedOut?: boolean } = {},
): BashRunner =>
() =>
  Promise.resolve({
    code,
    signal: extra.signal ?? null,
    stdout,
    stderr,
    timedOut: extra.timedOut ?? false,
  });

describe("executeBash", () => {
  it("returns exit status and stdout on success", async () => {
    const out = await executeBash("/work", "echo hi", {
      runner: cannedRunner("hi\n"),
    });
    assertStrictEquals(out, "exit 0\nhi");
  });

  it("captures a non-zero exit and stderr", async () => {
    const out = await executeBash("/work", "false", {
      runner: cannedRunner("", "boom\n", 1),
    });
    assertStringIncludes(out, "exit 1");
    assertStringIncludes(out, "boom");
  });

  it("combines stdout and stderr", async () => {
    const out = await executeBash("/work", "x", {
      runner: cannedRunner("out\n", "err\n"),
    });
    assertStringIncludes(out, "out");
    assertStringIncludes(out, "err");
  });

  it("rejects an empty command without invoking the runner", async () => {
    let ran = false;
    const runner: BashRunner = () => {
      ran = true;
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
      });
    };
    assertStrictEquals(
      await executeBash("/work", "   ", { runner }),
      "error: empty command",
    );
    assertStrictEquals(ran, false);
  });

  it("reports a timeout", async () => {
    const out = await executeBash("/work", "sleep 999", {
      timeoutMs: 50,
      runner: cannedRunner("", "", 137, { timedOut: true }),
    });
    assertMatch(out, /timed out after 50ms/);
  });

  describe("timeout status line", () => {
    const timedOut =
      (termination: BashResult["termination"]): BashRunner => () =>
        Promise.resolve({
          code: 143,
          signal: null,
          stdout: "partial\n",
          stderr: "",
          timedOut: true,
          termination,
        });
    const run = (termination: BashResult["termination"]) =>
      executeBash("/work", "x", {
        timeoutMs: 50,
        runner: timedOut(termination),
      });

    it("a stopped group reads as a clean kill with output up to the deadline", async () => {
      assertStrictEquals(
        await run({ group: "stopped", exited: true, outputClosed: true }),
        "timed out after 50ms (killed; output shown up to the deadline)\npartial",
      );
    });

    it("a group member that outlived SIGKILL is reported", async () => {
      assertStringIncludes(
        await run({ group: "survived", exited: true, outputClosed: true }),
        "a process in its group was still running after SIGKILL",
      );
    });

    it("a group that could not be signalled says descendants may survive", async () => {
      assertStringIncludes(
        await run({ group: "unavailable", exited: true, outputClosed: true }),
        "its process group could not be signalled, so descendants may survive",
      );
    });

    it("a command still present after SIGKILL is reported with its exit status unavailable", async () => {
      assertStringIncludes(
        await run({ group: "survived", exited: false, outputClosed: false }),
        "the command itself had not exited after SIGKILL, so its exit status is unavailable",
      );
    });

    it("output held open after the stop is reported", async () => {
      assertStringIncludes(
        await run({ group: "stopped", exited: true, outputClosed: false }),
        "a process outside its group held the output open and may still be running",
      );
    });
  });

  it("truncates output past the byte cap", async () => {
    const out = await executeBash("/work", "yes", {
      maxBytes: 10,
      runner: cannedRunner("0123456789ABCDEF"),
    });
    assertStringIncludes(out, "[truncated at 10 characters]");
  });

  it("surfaces a runner failure as an error result (never throws)", async () => {
    const runner: BashRunner = () => Promise.reject(new Error("spawn EACCES"));
    assertMatch(
      await executeBash("/work", "x", { runner }),
      /^error: cannot run command: spawn EACCES/,
    );
  });
});

describe("buildSafeBashEnv", () => {
  const SAFE = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TZ",
    "TMPDIR",
  ]);

  it("forwards only non-secret keys and never the projected secrets", () => {
    // Secrets present in the parent env must NOT be forwarded to bash
    // (CWE-532). The env is injected, so the test never touches Deno.env.
    const env = buildSafeBashEnv(
      new MapEnv({
        PATH: "/usr/bin:/bin",
        TERM: "dumb",
        ANTHROPIC_API_KEY: "fixture-should-not-leak",
        DOLT_PASSWORD: "test-should-not-leak",
        DYFJ_MEMORY_MCP_TOKEN: "bearer-should-not-leak",
      }),
    );
    for (const key of Object.keys(env)) {
      assertStrictEquals(SAFE.has(key), true);
    }
    assertFalse(Object.hasOwn(env, "ANTHROPIC_API_KEY"));
    assertFalse(Object.hasOwn(env, "DOLT_PASSWORD"));
    assertFalse(Object.hasOwn(env, "DYFJ_MEMORY_MCP_TOKEN"));
    // PATH must be forwarded so commands still resolve.
    assertNotEquals(env.PATH, undefined);
    assertEquals(env, { PATH: "/usr/bin:/bin", TERM: "dumb" });
  });
});

function call(
  args: Record<string, unknown>,
  overrides: Partial<CommandCall> = {},
): CommandCall {
  return {
    commandId: "bash",
    callId: "call-123",
    caller: { principalId: "operator", principalType: "human" },
    arguments: args,
    ...overrides,
  };
}

describe("operator permission profile", () => {
  it("the real bash command always asks under the operator profile", () => {
    const bash = defineBash("/work");
    const policy = evaluateCommandPolicy(
      bash,
      call({ command: "ls" }, { commandId: "bash" }),
      { permissionLevel: "operator", loopback: true },
    );
    assertStrictEquals(policy.decision, "ask");
  });
});

describe("buildCommandToolCallEventPayload", () => {
  it("the real bash command marks its result for redaction", () => {
    const registry = buildToolCatalog({ rootAnchors: new RootAnchors() }, {
      workspaceRoot: "/work",
    });
    assertStrictEquals(registry.lookup("bash")!.redactResult, true);
  });
});
