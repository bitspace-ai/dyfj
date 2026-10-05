import {
  assertArrayIncludes,
  assertEquals,
  assertFalse,
  assertLess,
  assertLessOrEqual,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { CommandCall } from "../definition.ts";
import { buildToolCatalog } from "../catalog.ts";
import { RootAnchors } from "./root-anchors.ts";
import { evaluateCommandPolicy } from "../policy.ts";
import { buildCommandToolCallEventPayload } from "../invoke.ts";
import {
  buildGitArgv,
  executeGit,
  GIT_SUBCOMMANDS,
  type GitResult,
  type GitRunner,
} from "./git.ts";

const ROOT = "/work";

// A canned runner so these tests never spawn git. It also records what it was
// asked to run, which is the point of the tool: the argv is the security
// surface.
function recordingRunner(
  result: Partial<GitResult> = {},
): { runner: GitRunner; calls: Array<{ args: string[]; cwd: string }> } {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runner: GitRunner = (args, cwd) => {
    calls.push({ args: [...args], cwd });
    return Promise.resolve({
      code: result.code ?? 0,
      signal: result.signal ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: result.timedOut ?? false,
      termination: result.termination,
    });
  };
  return { runner, calls };
}

describe("buildGitArgv", () => {
  it("status asks for porcelain output with branch detail", () => {
    assertEquals(buildGitArgv(ROOT, { subcommand: "status" }).argv, [
      "--no-pager",
      "--literal-pathspecs",
      "status",
      "--porcelain=v1",
      "--branch",
    ]);
  });

  it("diff defaults to the working tree and honours staged", () => {
    assertEquals(buildGitArgv(ROOT, { subcommand: "diff" }).argv, [
      "--no-pager",
      "--literal-pathspecs",
      "diff",
    ]);
    assertEquals(
      buildGitArgv(ROOT, { subcommand: "diff", staged: true }).argv,
      ["--no-pager", "--literal-pathspecs", "diff", "--staged"],
    );
    assertEquals(
      buildGitArgv(ROOT, { subcommand: "diff", staged: false }).argv,
      ["--no-pager", "--literal-pathspecs", "diff"],
    );
  });

  it("log bounds the number of commits and clamps an oversized limit", () => {
    const plan = buildGitArgv(ROOT, { subcommand: "log" });
    assertArrayIncludes(plan.argv!, ["--max-count=20"]);
    const clamped = buildGitArgv(ROOT, { subcommand: "log", limit: 10_000 });
    assertArrayIncludes(clamped.argv!, ["--max-count=200"]);
  });

  it("paths are placed after the -- separator", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "add",
      paths: ["src/a.ts", "src/b.ts"],
    });
    assertEquals(plan.argv, [
      "--no-pager",
      "--literal-pathspecs",
      "add",
      "--",
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("commit passes the message as a value, not a flag", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "commit",
      message: "--not-a-flag",
    });
    assertEquals(plan.argv, [
      "--no-pager",
      "--literal-pathspecs",
      "commit",
      "-m",
      "--not-a-flag",
    ]);
  });

  it("commit can be restricted to named paths", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "commit",
      message: "msg",
      paths: ["src/a.ts"],
    });
    assertEquals(plan.argv, [
      "--no-pager",
      "--literal-pathspecs",
      "commit",
      "-m",
      "msg",
      "--",
      "src/a.ts",
    ]);
  });

  it("nested paths are normalized relative to the workspace root", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "add",
      paths: ["./src/../src/a.ts"],
    });
    assertEquals(plan.argv, [
      "--no-pager",
      "--literal-pathspecs",
      "add",
      "--",
      "src/a.ts",
    ]);
  });
});

describe("buildGitArgv refusals", () => {
  it("push is refused by name, with the reason", () => {
    const plan = buildGitArgv(ROOT, { subcommand: "push" });
    assertStrictEquals(plan.argv, undefined);
    assertStringIncludes(plan.error!, "not available to the agent");
    assertStringIncludes(plan.error!, "operator action");
  });

  for (
    const sub of [
      "pull",
      "fetch",
      "remote",
      "reset",
      "rebase",
      "checkout",
      "clean",
      "stash",
      "cherry-pick",
    ]
  ) {
    it(`${sub} is refused`, () => {
      assertStrictEquals(
        buildGitArgv(ROOT, { subcommand: sub }).argv,
        undefined,
      );
    });
  }

  it("an unknown subcommand is refused and lists what is allowed", () => {
    const plan = buildGitArgv(ROOT, { subcommand: "bisect" });
    assertStringIncludes(plan.error!, "unsupported git subcommand");
    for (const allowed of GIT_SUBCOMMANDS) {
      assertStringIncludes(plan.error!, allowed);
    }
  });

  it("a missing subcommand is refused", () => {
    assertStringIncludes(
      buildGitArgv(ROOT, {}).error!,
      "subcommand is required",
    );
  });

  it("absolute paths and traversal are rejected", () => {
    assertStringIncludes(
      buildGitArgv(ROOT, { subcommand: "add", paths: ["/etc/passwd"] })
        .error!,
      "relative",
    );
    assertStringIncludes(
      buildGitArgv(ROOT, { subcommand: "add", paths: ["../secrets"] })
        .error!,
      "escapes the workspace root",
    );
  });

  it("a pathspec magic prefix is rejected", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "add",
      paths: [":(top)private.txt"],
    });
    assertStringIncludes(plan.error!, "pathspec magic is disabled");
  });

  it("every argv disables pathspec interpretation", () => {
    for (const sub of GIT_SUBCOMMANDS) {
      const args: Record<string, unknown> = { subcommand: sub };
      if (sub === "add") args.paths = ["a.ts"];
      if (sub === "commit") args.message = "m";
      assertArrayIncludes(buildGitArgv(ROOT, args).argv!, [
        "--literal-pathspecs",
      ]);
    }
  });

  it("a path that looks like a flag is rejected", () => {
    assertStringIncludes(
      buildGitArgv(ROOT, { subcommand: "add", paths: ["--exec=rm -rf /"] })
        .error!,
      "must not start with '-'",
    );
  });

  it("add requires a path and commit requires a message", () => {
    assertStringIncludes(
      buildGitArgv(ROOT, { subcommand: "add" }).error!,
      "requires at least one path",
    );
    assertStringIncludes(
      buildGitArgv(ROOT, { subcommand: "commit" }).error!,
      "non-empty message",
    );
    assertStringIncludes(
      buildGitArgv(ROOT, { subcommand: "commit", message: "   " }).error!,
      "non-empty message",
    );
  });

  it("an oversized commit message is rejected before it is encoded", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "commit",
      message: "x".repeat(5000),
    });
    assertStringIncludes(plan.error!, "exceeds the 4096-byte limit");
  });

  it("a multibyte message over the byte cap is rejected on its bytes", () => {
    // 1500 four-byte characters: 3000 UTF-16 units (under the length
    // pre-check) but 6000 bytes (over the cap).
    const plan = buildGitArgv(ROOT, {
      subcommand: "commit",
      message: "𝄞".repeat(1500),
    });
    assertStringIncludes(plan.error!, "6000 bytes");
  });

  it("arguments are rejected where they do not apply", () => {
    assertStringIncludes(
      buildGitArgv(ROOT, { subcommand: "status", message: "no" }).error!,
      "commit only",
    );
    assertStringIncludes(
      buildGitArgv(ROOT, { subcommand: "log", staged: true }).error!,
      "diff only",
    );
    assertStringIncludes(
      buildGitArgv(ROOT, { subcommand: "status", limit: 5 }).error!,
      "log only",
    );
  });

  it("a hostile limit value is rejected instead of coerced", () => {
    // Number() would run these and throw out of buildGitArgv, past the
    // executor's own error handling.
    const hostile = { valueOf: null, toString: null } as unknown;
    assertStringIncludes(
      buildGitArgv(ROOT, { subcommand: "log", limit: hostile }).error!,
      "limit must be an integer",
    );
    assertStringIncludes(
      buildGitArgv(ROOT, { subcommand: "log", limit: "5" }).error!,
      "limit must be an integer",
    );
  });

  it("an oversized single path is rejected", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "add",
      paths: ["a".repeat(5000)],
    });
    assertStringIncludes(plan.error!, "exceeds 4096 characters");
  });

  it("an unsupported subcommand echo is bounded", () => {
    const plan = buildGitArgv(ROOT, { subcommand: "z".repeat(5000) });
    assertLess(plan.error!.length, 400);
  });

  it("too many paths are rejected", () => {
    const paths = Array.from({ length: 101 }, (_, i) => `f${i}.ts`);
    assertStringIncludes(
      buildGitArgv(ROOT, { subcommand: "add", paths }).error!,
      "at most 100 paths",
    );
  });
});

describe("executeGit", () => {
  it("runs the built argv in the workspace root", async () => {
    const { runner, calls } = recordingRunner({ stdout: "## main\n" });
    const out = await executeGit(ROOT, { subcommand: "status" }, { runner });
    assertEquals(calls.length, 1);
    assertStrictEquals(calls[0].cwd, ROOT);
    assertEquals(calls[0].args, [
      "--no-pager",
      "--literal-pathspecs",
      "status",
      "--porcelain=v1",
      "--branch",
    ]);
    assertStrictEquals(out, "exit 0\n## main");
  });

  it("a refused call never reaches the runner", async () => {
    const { runner, calls } = recordingRunner();
    const out = await executeGit(ROOT, { subcommand: "push" }, { runner });
    assertEquals(calls.length, 0);
    assertStringIncludes(out, "not available to the agent");
  });

  it("a non-zero exit returns status and stderr rather than throwing", async () => {
    const { runner } = recordingRunner({
      code: 1,
      stderr: "nothing to commit\n",
    });
    const out = await executeGit(
      ROOT,
      { subcommand: "commit", message: "msg" },
      { runner },
    );
    assertStringIncludes(out, "exit 1");
    assertStringIncludes(out, "nothing to commit");
  });

  it("a timeout is reported as a killed run", async () => {
    const { runner } = recordingRunner({ timedOut: true, code: 137 });
    const out = await executeGit(ROOT, { subcommand: "status" }, {
      runner,
      timeoutMs: 50,
    });
    assertStringIncludes(out, "timed out after 50ms (killed)");
  });

  it("a timeout that stopped git's process group says the output ends at the deadline", async () => {
    const { runner } = recordingRunner({
      timedOut: true,
      code: 143,
      termination: { group: "stopped", outputClosed: true },
    });
    const out = await executeGit(ROOT, { subcommand: "status" }, {
      runner,
      timeoutMs: 50,
    });
    assertStringIncludes(
      out,
      "timed out after 50ms (killed; output shown up to the deadline)",
    );
    assertFalse(out.includes("may survive"));
  });

  it("a signal is reported instead of an exit code", async () => {
    const { runner } = recordingRunner({ code: 0, signal: "SIGTERM" });
    const out = await executeGit(ROOT, { subcommand: "status" }, { runner });
    assertStringIncludes(out, "exit by signal SIGTERM");
  });

  it("output is truncated at the byte cap", async () => {
    const { runner } = recordingRunner({ stdout: "x".repeat(500) });
    const out = await executeGit(ROOT, { subcommand: "diff" }, {
      runner,
      maxBytes: 100,
    });
    assertStringIncludes(out, "[truncated at 100 bytes]");
    assertLess(out.length, 300);
  });

  it("truncation counts bytes, not UTF-16 units", async () => {
    // 100 four-byte characters: 400 bytes, 200 UTF-16 units.
    const { runner } = recordingRunner({ stdout: "𝄞".repeat(100) });
    const out = await executeGit(ROOT, { subcommand: "diff" }, {
      runner,
      maxBytes: 100,
    });
    const body = out.split("\n")[1] ?? "";
    assertLessOrEqual(new TextEncoder().encode(body).byteLength, 100);
  });

  it("a pathless commit in a subdirectory workspace warns about scope", async () => {
    const calls: string[][] = [];
    const runner: GitRunner = (args) => {
      calls.push([...args]);
      const isRevParse = args.includes("rev-parse");
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout: isRevParse ? "/repo\n" : "[main abc1234] msg\n",
        stderr: "",
        timedOut: false,
      });
    };
    const out = await executeGit("/repo/component", {
      subcommand: "commit",
      message: "msg",
    }, { runner });
    assertArrayIncludes(calls[0], ["rev-parse"]);
    assertStringIncludes(out, "records every staged change");
    assertStringIncludes(out, "exit 0");
  });

  it("a commit at the repository root carries no scope warning", async () => {
    const runner: GitRunner = (args) =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: args.includes("rev-parse") ? "/repo\n" : "[main abc1234] msg\n",
        stderr: "",
        timedOut: false,
      });
    const out = await executeGit("/repo", {
      subcommand: "commit",
      message: "m",
    }, {
      runner,
    });
    assertFalse(out.includes("records every staged change"));
  });

  it("a commit with explicit paths skips the repository-scope check", async () => {
    const calls: string[][] = [];
    const runner: GitRunner = (args) => {
      calls.push([...args]);
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
      });
    };
    await executeGit("/repo/component", {
      subcommand: "commit",
      message: "m",
      paths: ["a.ts"],
    }, { runner });
    assertEquals(calls.length, 1);
    assertFalse(calls[0].includes("rev-parse"));
  });

  it("a runner failure is returned as a tool error", async () => {
    const failing: GitRunner = () => Promise.reject(new Error("git not found"));
    const out = await executeGit(ROOT, { subcommand: "status" }, {
      runner: failing,
    });
    assertStrictEquals(out, "error: cannot run git: git not found");
  });
});

function call(
  args: Record<string, unknown>,
  overrides: Partial<CommandCall> = {},
): CommandCall {
  return {
    commandId: "git",
    callId: "call-123",
    caller: { principalId: "operator", principalType: "human" },
    arguments: args,
    ...overrides,
  };
}

describe("buildCommandToolCallEventPayload", () => {
  it("the real git command stays approval-gated under the operator profile", () => {
    // The tool's own claim is that every git call reaches an approver. That
    // holds because of the exec-class effect in its registered envelope, so
    // pin the registered definition rather than a local fixture of it.
    const registry = buildToolCatalog({ rootAnchors: new RootAnchors() }, {
      workspaceRoot: "/work",
    });
    const git = registry.lookup("git")!;
    assertArrayIncludes(git.permission.effects, ["run.process"]);
    for (
      const args of [
        { subcommand: "status" },
        { subcommand: "log" },
        { subcommand: "add", paths: ["a.ts"] },
        { subcommand: "commit", message: "m" },
      ]
    ) {
      const policy = evaluateCommandPolicy(
        git,
        call(args, { commandId: "git" }),
        { permissionLevel: "operator", loopback: true },
      );
      assertStrictEquals(policy.decision, "ask");
    }
  });

  it("the real git command denies unrunnable calls before the approval prompt", () => {
    // Both cases must be denied by policy, not by the executor: a call that
    // can never run should not cost the operator an approval decision.
    const registry = buildToolCatalog({ rootAnchors: new RootAnchors() }, {
      workspaceRoot: "/work",
    });
    const git = registry.lookup("git")!;
    for (
      const args of [
        { subcommand: "push" }, // outside the exposed enum
        { subcommand: "log", limit: 1.5 }, // fractional, schema says integer
      ]
    ) {
      const policy = evaluateCommandPolicy(
        git,
        call(args, { commandId: "git" }),
        { permissionLevel: "operator", loopback: true },
      );
      assertStrictEquals(policy.decision, "deny");
      assertStrictEquals(policy.authzBasis, "policy:deny:invalid-arguments");
    }
  });

  it("the real git command keeps its result out of the persisted event", () => {
    const registry = buildToolCatalog({ rootAnchors: new RootAnchors() }, {
      workspaceRoot: "/work",
    });
    const git = registry.lookup("git")!;
    assertStrictEquals(git.redactResult, true);

    // A hook or credential helper runs inside git's process tree and can print
    // anything it can read, so the durable event must carry the sentinel even
    // though the model sees the real output in-turn.
    const payload = buildCommandToolCallEventPayload(
      call({ subcommand: "status" }, { commandId: "git" }),
      {
        decision: "allow" as const,
        authzBasis: "policy:allow:operator-approved",
        isError: false as const,
        result:
          "exit 0\nhook printed ANTHROPIC_API_KEY=fixture-should-not-persist",
      },
      {
        eventId: "01TESTEVENT0000000000000000",
        sessionId: "01TESTSESSION00000000000000",
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
      },
      git,
    );
    assertStrictEquals(payload.tool_result, "[redacted]");
    assertFalse(
      (payload.tool_result as string).includes("ANTHROPIC_API_KEY"),
    );
    // Arguments stay legible: knowing WHICH git operation ran is the point.
    assertStringIncludes(JSON.stringify(payload.tool_arguments), "status");
  });
});
