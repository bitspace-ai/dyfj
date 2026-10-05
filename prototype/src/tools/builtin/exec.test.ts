import {
  assert,
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
import { redactToolCall } from "../redaction.ts";
import {
  type BashResult,
  type BashRunner,
  buildSafeBashEnv,
  defineBash,
  executeBash,
  resolveBashTimeoutMs,
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

    it("output held open after an emptied group points outside the group", async () => {
      assertStringIncludes(
        await run({ group: "stopped", exited: true, outputClosed: false }),
        "a process outside its group held the output open and may still be running",
      );
    });

    it("output held open after a survivor or an unsignallable group does not infer where the holder is", async () => {
      for (const group of ["survived", "unavailable"] as const) {
        const out = await run({ group, exited: true, outputClosed: false });
        assertStringIncludes(
          out,
          "the output was still held open after the stop, so a process may still be running",
        );
        assertFalse(out.includes("outside its group"));
      }
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

// The per-call timeout (`timeoutSec`): resolution, the ceiling, where an
// out-of-range value is refused, what the operator is shown, and what the
// durable event records.
describe("bash timeoutSec", () => {
  const context = { authzBasis: "policy:allow:operator-approved" };
  const operator = { permissionLevel: "operator", loopback: true } as const;

  it("an absent timeout keeps the 120 s default", () => {
    assertEquals(resolveBashTimeoutMs(undefined), { timeoutMs: 120_000 });
  });

  it("a requested timeout is taken in whole seconds, up to the ceiling", () => {
    assertEquals(resolveBashTimeoutMs(300), { timeoutMs: 300_000 });
    assertEquals(resolveBashTimeoutMs(600), { timeoutMs: 600_000 });
    assertEquals(resolveBashTimeoutMs(1), { timeoutMs: 1_000 });
  });

  it("a value above the ceiling is refused with a message naming 600 s, not clamped", () => {
    const resolved = resolveBashTimeoutMs(601);
    assert("error" in resolved, "601 must not resolve to a timeout");
    assertStringIncludes(resolved.error, "600 s");
  });

  it("zero, negative and fractional values are refused", () => {
    for (const value of [0, -1, 1.5, Number.NaN, "300", null]) {
      assert(
        "error" in resolveBashTimeoutMs(value),
        `${String(value)} must be refused`,
      );
    }
  });

  it("the executor hands the resolved timeout to the runner", async () => {
    const seen: number[] = [];
    const runner: BashRunner = (_command, _cwd, timeoutMs) => {
      seen.push(timeoutMs);
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout: "ok\n",
        stderr: "",
        timedOut: false,
      });
    };
    const bash = defineBash("/work", { runner });
    assertStrictEquals(
      await bash.executor(
        call({ command: "echo ok", timeoutSec: 300 }),
        context,
      ),
      "exit 0\nok",
    );
    await bash.executor(call({ command: "echo ok" }), context);
    assertEquals(seen, [300_000, 120_000]);
  });

  it("policy refuses a timeout above the ceiling before any approval, naming the ceiling", () => {
    const policy = evaluateCommandPolicy(
      defineBash("/work"),
      call({ command: "deno task test", timeoutSec: 601 }),
      operator,
    );
    assertStrictEquals(policy.decision, "deny");
    assertStrictEquals(policy.authzBasis, "policy:deny:invalid-arguments");
    assertStringIncludes(policy.reason ?? "", "timeoutSec must be at most 600");
    // The corrective feedback shows the model the accepted range.
    assertStringIncludes(
      policy.reason ?? "",
      '"timeoutSec": integer (optional, 1 to 600)',
    );
  });

  it("policy refuses zero, negative and fractional timeouts", () => {
    for (const timeoutSec of [0, -5, 1.5, "300"]) {
      const policy = evaluateCommandPolicy(
        defineBash("/work"),
        call({ command: "ls", timeoutSec }),
        operator,
      );
      assertStrictEquals(
        policy.decision,
        "deny",
        `${String(timeoutSec)} must be denied`,
      );
      assertStrictEquals(policy.authzBasis, "policy:deny:invalid-arguments");
    }
  });

  it("the executor refuses a timeout above the ceiling without running anything", async () => {
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
    const out = await defineBash("/work", { runner }).executor(
      call({ command: "echo", timeoutSec: 601 }),
      context,
    );
    assertMatch(out, /^error: /);
    assertStringIncludes(out, "600 s");
    assertStrictEquals(ran, false);
  });

  it("the approval title shows the effective timeout", () => {
    const bash = defineBash("/work");
    assertStrictEquals(
      bash.approvalTitle!(call({ command: "deno task test", timeoutSec: 300 })),
      "Run Bash Command (timeout 300 s)",
    );
    assertStrictEquals(
      bash.approvalTitle!(call({ command: "ls" })),
      "Run Bash Command (timeout 120 s)",
    );
    // The listed title stays stable; only the approval prompt varies.
    assertStrictEquals(bash.title, "Run Bash Command");
  });

  it("the description states the default and the ceiling", () => {
    const bash = defineBash("/work");
    assertStringIncludes(bash.description, "120 s");
    assertStringIncludes(bash.description, "600 s");
    const property = bash.inputSchema.properties!.timeoutSec;
    assertEquals(
      {
        type: property.type,
        minimum: property.minimum,
        maximum: property.maximum,
      },
      { type: "integer", minimum: 1, maximum: 600 },
    );
    assertStringIncludes(property.description ?? "", "600");
  });

  it("the timeout is recorded on the durable tool_call event like any other argument", () => {
    const bash = defineBash("/work");
    const redacted = redactToolCall(
      bash,
      call({ command: "deno task test", timeoutSec: 300 }),
      {
        decision: "allow",
        authzBasis: "policy:allow:operator-approved",
        isError: false,
        result: "exit 0",
      },
    );
    assertEquals(redacted.arguments, {
      command: "deno task test",
      timeoutSec: 300,
    });
    assertStrictEquals(redacted.result, "[redacted]");
  });
});
