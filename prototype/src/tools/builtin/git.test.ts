import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
    assert.deepStrictEqual(buildGitArgv(ROOT, { subcommand: "status" }).argv, [
      "--no-pager",
      "--literal-pathspecs",
      "status",
      "--porcelain=v1",
      "--branch",
    ]);
  });

  it("diff defaults to the working tree and honours staged", () => {
    assert.deepStrictEqual(buildGitArgv(ROOT, { subcommand: "diff" }).argv, [
      "--no-pager",
      "--literal-pathspecs",
      "diff",
    ]);
    assert.deepStrictEqual(
      buildGitArgv(ROOT, { subcommand: "diff", staged: true }).argv,
      ["--no-pager", "--literal-pathspecs", "diff", "--staged"],
    );
    assert.deepStrictEqual(
      buildGitArgv(ROOT, { subcommand: "diff", staged: false }).argv,
      ["--no-pager", "--literal-pathspecs", "diff"],
    );
  });

  it("log bounds the number of commits and clamps an oversized limit", () => {
    const plan = buildGitArgv(ROOT, { subcommand: "log" });
    const argv = plan.argv!;
    assert.ok(
      argv.includes("--max-count=20"),
      `expected ${JSON.stringify(argv)} to include "--max-count=20"`,
    );
    const clamped = buildGitArgv(ROOT, { subcommand: "log", limit: 10_000 });
    const clampedArgv = clamped.argv!;
    assert.ok(
      clampedArgv.includes("--max-count=200"),
      `expected ${JSON.stringify(clampedArgv)} to include "--max-count=200"`,
    );
  });

  it("paths are placed after the -- separator", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "add",
      paths: ["src/a.ts", "src/b.ts"],
    });
    assert.deepStrictEqual(plan.argv, [
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
    assert.deepStrictEqual(plan.argv, [
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
    assert.deepStrictEqual(plan.argv, [
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
    assert.deepStrictEqual(plan.argv, [
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
    assert.strictEqual(plan.argv, undefined);
    assert.ok(
      plan.error!.includes("not available to the agent"),
      `expected plan.error! to include "not available to the agent"`,
    );
    assert.ok(
      plan.error!.includes("operator action"),
      `expected plan.error! to include "operator action"`,
    );
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
      assert.strictEqual(
        buildGitArgv(ROOT, { subcommand: sub }).argv,
        undefined,
      );
    });
  }

  it("an unknown subcommand is refused and lists what is allowed", () => {
    const plan = buildGitArgv(ROOT, { subcommand: "bisect" });
    assert.ok(
      plan.error!.includes("unsupported git subcommand"),
      `expected plan.error! to include "unsupported git subcommand"`,
    );
    for (const allowed of GIT_SUBCOMMANDS) {
      assert.ok(
        plan.error!.includes(allowed),
        `expected plan.error! to include ${JSON.stringify(allowed)}`,
      );
    }
  });

  it("a missing subcommand is refused", () => {
    assert.ok(
      buildGitArgv(ROOT, {}).error!.includes("subcommand is required"),
      `expected buildGitArgv(ROOT, {}).error! to include "subcommand is required"`,
    );
  });

  it("absolute paths and traversal are rejected", () => {
    assert.ok(
      (buildGitArgv(ROOT, { subcommand: "add", paths: ["/etc/passwd"] })
        .error!).includes("relative"),
      `expected buildGitArgv(ROOT, { subcommand: "add", paths: ["/etc/passwd"] })
        .error! to include "relative"`,
    );
    assert.ok(
      (buildGitArgv(ROOT, { subcommand: "add", paths: ["../secrets"] })
        .error!).includes("escapes the workspace root"),
      `expected buildGitArgv(ROOT, { subcommand: "add", paths: ["../secrets"] })
        .error! to include "escapes the workspace root"`,
    );
  });

  it("a pathspec magic prefix is rejected", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "add",
      paths: [":(top)private.txt"],
    });
    assert.ok(
      plan.error!.includes("pathspec magic is disabled"),
      `expected plan.error! to include "pathspec magic is disabled"`,
    );
  });

  it("every argv disables pathspec interpretation", () => {
    for (const sub of GIT_SUBCOMMANDS) {
      const args: Record<string, unknown> = { subcommand: sub };
      if (sub === "add") args.paths = ["a.ts"];
      if (sub === "commit") args.message = "m";
      const argv = buildGitArgv(ROOT, args).argv!;
      assert.ok(
        argv.includes("--literal-pathspecs"),
        `expected ${JSON.stringify(argv)} to include "--literal-pathspecs"`,
      );
    }
  });

  it("a path that looks like a flag is rejected", () => {
    assert.ok(
      (buildGitArgv(ROOT, { subcommand: "add", paths: ["--exec=rm -rf /"] })
        .error!).includes("must not start with '-'"),
      `expected buildGitArgv(ROOT, { subcommand: "add", paths: ["--exec=rm -rf /"] })
        .error! to include "must not start with '-'"`,
    );
  });

  it("add requires a path and commit requires a message", () => {
    assert.ok(
      buildGitArgv(ROOT, { subcommand: "add" }).error!.includes(
        "requires at least one path",
      ),
      `expected buildGitArgv(ROOT, { subcommand: "add" }).error! to include "requires at least one path"`,
    );
    assert.ok(
      buildGitArgv(ROOT, { subcommand: "commit" }).error!.includes(
        "non-empty message",
      ),
      `expected buildGitArgv(ROOT, { subcommand: "commit" }).error! to include "non-empty message"`,
    );
    assert.ok(
      buildGitArgv(ROOT, { subcommand: "commit", message: "   " }).error!
        .includes("non-empty message"),
      `expected buildGitArgv(ROOT, { subcommand: "commit", message: "   " }).error! to include "non-empty message"`,
    );
  });

  it("an oversized commit message is rejected before it is encoded", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "commit",
      message: "x".repeat(5000),
    });
    assert.ok(
      plan.error!.includes("exceeds the 4096-byte limit"),
      `expected plan.error! to include "exceeds the 4096-byte limit"`,
    );
  });

  it("a multibyte message over the byte cap is rejected on its bytes", () => {
    // 1500 four-byte characters: 3000 UTF-16 units (under the length
    // pre-check) but 6000 bytes (over the cap).
    const plan = buildGitArgv(ROOT, {
      subcommand: "commit",
      message: "𝄞".repeat(1500),
    });
    assert.ok(
      plan.error!.includes("6000 bytes"),
      `expected plan.error! to include "6000 bytes"`,
    );
  });

  it("arguments are rejected where they do not apply", () => {
    assert.ok(
      buildGitArgv(ROOT, { subcommand: "status", message: "no" }).error!
        .includes("commit only"),
      `expected buildGitArgv(ROOT, { subcommand: "status", message: "no" }).error! to include "commit only"`,
    );
    assert.ok(
      buildGitArgv(ROOT, { subcommand: "log", staged: true }).error!.includes(
        "diff only",
      ),
      `expected buildGitArgv(ROOT, { subcommand: "log", staged: true }).error! to include "diff only"`,
    );
    assert.ok(
      buildGitArgv(ROOT, { subcommand: "status", limit: 5 }).error!.includes(
        "log only",
      ),
      `expected buildGitArgv(ROOT, { subcommand: "status", limit: 5 }).error! to include "log only"`,
    );
  });

  it("a hostile limit value is rejected instead of coerced", () => {
    // Number() would run these and throw out of buildGitArgv, past the
    // executor's own error handling.
    const hostile = { valueOf: null, toString: null } as unknown;
    assert.ok(
      buildGitArgv(ROOT, { subcommand: "log", limit: hostile }).error!.includes(
        "limit must be an integer",
      ),
      `expected buildGitArgv(ROOT, { subcommand: "log", limit: hostile }).error! to include "limit must be an integer"`,
    );
    assert.ok(
      buildGitArgv(ROOT, { subcommand: "log", limit: "5" }).error!.includes(
        "limit must be an integer",
      ),
      `expected buildGitArgv(ROOT, { subcommand: "log", limit: "5" }).error! to include "limit must be an integer"`,
    );
  });

  it("an oversized single path is rejected", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "add",
      paths: ["a".repeat(5000)],
    });
    assert.ok(
      plan.error!.includes("exceeds 4096 characters"),
      `expected plan.error! to include "exceeds 4096 characters"`,
    );
  });

  it("an unsupported subcommand echo is bounded", () => {
    const plan = buildGitArgv(ROOT, { subcommand: "z".repeat(5000) });
    assert.ok(plan.error!.length < 400, `expected plan.error!.length < 400`);
  });

  it("too many paths are rejected", () => {
    const paths = Array.from({ length: 101 }, (_, i) => `f${i}.ts`);
    assert.ok(
      buildGitArgv(ROOT, { subcommand: "add", paths }).error!.includes(
        "at most 100 paths",
      ),
      `expected buildGitArgv(ROOT, { subcommand: "add", paths }).error! to include "at most 100 paths"`,
    );
  });
});

describe("executeGit", () => {
  it("runs the built argv in the workspace root", async () => {
    const { runner, calls } = recordingRunner({ stdout: "## main\n" });
    const out = await executeGit(ROOT, { subcommand: "status" }, { runner });
    assert.deepStrictEqual(calls.length, 1);
    assert.strictEqual(calls[0].cwd, ROOT);
    assert.deepStrictEqual(calls[0].args, [
      "--no-pager",
      "--literal-pathspecs",
      "status",
      "--porcelain=v1",
      "--branch",
    ]);
    assert.strictEqual(out, "exit 0\n## main");
  });

  it("a refused call never reaches the runner", async () => {
    const { runner, calls } = recordingRunner();
    const out = await executeGit(ROOT, { subcommand: "push" }, { runner });
    assert.deepStrictEqual(calls.length, 0);
    assert.ok(
      out.includes("not available to the agent"),
      `expected ${JSON.stringify(out)} to include "not available to the agent"`,
    );
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
    assert.ok(
      out.includes("exit 1"),
      `expected ${JSON.stringify(out)} to include "exit 1"`,
    );
    assert.ok(
      out.includes("nothing to commit"),
      `expected ${JSON.stringify(out)} to include "nothing to commit"`,
    );
  });

  it("a timeout is reported as a killed run", async () => {
    const { runner } = recordingRunner({ timedOut: true, code: 137 });
    const out = await executeGit(ROOT, { subcommand: "status" }, {
      runner,
      timeoutMs: 50,
    });
    assert.ok(
      out.includes("timed out after 50ms (killed)"),
      `expected ${
        JSON.stringify(out)
      } to include "timed out after 50ms (killed)"`,
    );
  });

  it("a timeout that stopped git's process group says the output ends at the deadline", async () => {
    const { runner } = recordingRunner({
      timedOut: true,
      code: 143,
      termination: { group: "stopped", exited: true, outputClosed: true },
    });
    const out = await executeGit(ROOT, { subcommand: "status" }, {
      runner,
      timeoutMs: 50,
    });
    assert.ok(
      out.includes(
        "timed out after 50ms (killed; output shown up to the deadline)",
      ),
      `expected ${
        JSON.stringify(out)
      } to include "timed out after 50ms (killed; output shown up to the deadline)"`,
    );
    assert.ok(!out.includes("may survive"));
  });

  it("a signal is reported instead of an exit code", async () => {
    const { runner } = recordingRunner({ code: 0, signal: "SIGTERM" });
    const out = await executeGit(ROOT, { subcommand: "status" }, { runner });
    assert.ok(
      out.includes("exit by signal SIGTERM"),
      `expected ${JSON.stringify(out)} to include "exit by signal SIGTERM"`,
    );
  });

  it("output is truncated at the byte cap", async () => {
    const { runner } = recordingRunner({ stdout: "x".repeat(500) });
    const out = await executeGit(ROOT, { subcommand: "diff" }, {
      runner,
      maxBytes: 100,
    });
    assert.ok(
      out.includes("[truncated at 100 bytes]"),
      `expected ${JSON.stringify(out)} to include "[truncated at 100 bytes]"`,
    );
    assert.ok(out.length < 300, `expected out.length < 300`);
  });

  it("truncation counts bytes, not UTF-16 units", async () => {
    // 100 four-byte characters: 400 bytes, 200 UTF-16 units.
    const { runner } = recordingRunner({ stdout: "𝄞".repeat(100) });
    const out = await executeGit(ROOT, { subcommand: "diff" }, {
      runner,
      maxBytes: 100,
    });
    const body = out.split("\n")[1] ?? "";
    assert.ok(
      (new TextEncoder().encode(body).byteLength) <= 100,
      `expected new TextEncoder().encode(body).byteLength <= 100`,
    );
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
    const first = calls[0];
    assert.ok(
      first.includes("rev-parse"),
      `expected ${JSON.stringify(first)} to include "rev-parse"`,
    );
    assert.ok(
      out.includes("records every staged change"),
      `expected ${
        JSON.stringify(out)
      } to include "records every staged change"`,
    );
    assert.ok(
      out.includes("exit 0"),
      `expected ${JSON.stringify(out)} to include "exit 0"`,
    );
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
    assert.ok(!out.includes("records every staged change"));
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
    assert.deepStrictEqual(calls.length, 1);
    assert.ok(!calls[0].includes("rev-parse"));
  });

  it("a runner failure is returned as a tool error", async () => {
    const failing: GitRunner = () => Promise.reject(new Error("git not found"));
    const out = await executeGit(ROOT, { subcommand: "status" }, {
      runner: failing,
    });
    assert.strictEqual(out, "error: cannot run git: git not found");
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
    const effects = git.permission.effects;
    assert.ok(
      effects.includes("run.process"),
      `expected ${JSON.stringify(effects)} to include "run.process"`,
    );
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
      assert.strictEqual(policy.decision, "ask");
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
      assert.strictEqual(policy.decision, "deny");
      assert.strictEqual(policy.authzBasis, "policy:deny:invalid-arguments");
    }
  });

  it("the real git command keeps its result out of the persisted event", () => {
    const registry = buildToolCatalog({ rootAnchors: new RootAnchors() }, {
      workspaceRoot: "/work",
    });
    const git = registry.lookup("git")!;
    assert.strictEqual(git.redactResult, true);

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
    assert.strictEqual(payload.tool_result, "[redacted]");
    assert.ok(!(payload.tool_result as string).includes("ANTHROPIC_API_KEY"));
    // Arguments stay legible: knowing WHICH git operation ran is the point.
    assert.ok(
      JSON.stringify(payload.tool_arguments).includes("status"),
      `expected JSON.stringify(payload.tool_arguments) to include "status"`,
    );
  });
});
