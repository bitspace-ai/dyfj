import { describe, expect, test } from "vitest";
import {
  buildGitArgv,
  executeGit,
  GIT_SUBCOMMANDS,
  type GitResult,
  type GitRunner,
} from "./git-tools";

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
    });
  };
  return { runner, calls };
}

describe("buildGitArgv", () => {
  test("status asks for porcelain output with branch detail", () => {
    expect(buildGitArgv(ROOT, { subcommand: "status" }).argv).toEqual([
      "--no-pager",
      "--literal-pathspecs",
      "status",
      "--porcelain=v1",
      "--branch",
    ]);
  });

  test("diff defaults to the working tree and honours staged", () => {
    expect(buildGitArgv(ROOT, { subcommand: "diff" }).argv).toEqual([
      "--no-pager",
      "--literal-pathspecs",
      "diff",
    ]);
    expect(buildGitArgv(ROOT, { subcommand: "diff", staged: true }).argv)
      .toEqual(["--no-pager", "--literal-pathspecs", "diff", "--staged"]);
    expect(buildGitArgv(ROOT, { subcommand: "diff", staged: false }).argv)
      .toEqual(["--no-pager", "--literal-pathspecs", "diff"]);
  });

  test("log bounds the number of commits and clamps an oversized limit", () => {
    const plan = buildGitArgv(ROOT, { subcommand: "log" });
    expect(plan.argv).toContain("--max-count=20");
    const clamped = buildGitArgv(ROOT, { subcommand: "log", limit: 10_000 });
    expect(clamped.argv).toContain("--max-count=200");
  });

  test("paths are placed after the -- separator", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "add",
      paths: ["src/a.ts", "src/b.ts"],
    });
    expect(plan.argv).toEqual([
      "--no-pager",
      "--literal-pathspecs",
      "add",
      "--",
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  test("commit passes the message as a value, not a flag", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "commit",
      message: "--not-a-flag",
    });
    expect(plan.argv).toEqual([
      "--no-pager",
      "--literal-pathspecs",
      "commit",
      "-m",
      "--not-a-flag",
    ]);
  });

  test("commit can be restricted to named paths", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "commit",
      message: "msg",
      paths: ["src/a.ts"],
    });
    expect(plan.argv).toEqual([
      "--no-pager",
      "--literal-pathspecs",
      "commit",
      "-m",
      "msg",
      "--",
      "src/a.ts",
    ]);
  });

  test("nested paths are normalized relative to the workspace root", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "add",
      paths: ["./src/../src/a.ts"],
    });
    expect(plan.argv).toEqual([
      "--no-pager",
      "--literal-pathspecs",
      "add",
      "--",
      "src/a.ts",
    ]);
  });
});

describe("buildGitArgv refusals", () => {
  test("push is refused by name, with the reason", () => {
    const plan = buildGitArgv(ROOT, { subcommand: "push" });
    expect(plan.argv).toBeUndefined();
    expect(plan.error).toContain("not available to the agent");
    expect(plan.error).toContain("operator action");
  });

  test.each([
    "pull",
    "fetch",
    "remote",
    "reset",
    "rebase",
    "checkout",
    "clean",
    "stash",
    "cherry-pick",
  ])("%s is refused", (sub) => {
    expect(buildGitArgv(ROOT, { subcommand: sub }).argv).toBeUndefined();
  });

  test("an unknown subcommand is refused and lists what is allowed", () => {
    const plan = buildGitArgv(ROOT, { subcommand: "bisect" });
    expect(plan.error).toContain("unsupported git subcommand");
    for (const allowed of GIT_SUBCOMMANDS) {
      expect(plan.error).toContain(allowed);
    }
  });

  test("a missing subcommand is refused", () => {
    expect(buildGitArgv(ROOT, {}).error).toContain("subcommand is required");
  });

  test("absolute paths and traversal are rejected", () => {
    expect(
      buildGitArgv(ROOT, { subcommand: "add", paths: ["/etc/passwd"] })
        .error,
    ).toContain("relative");
    expect(
      buildGitArgv(ROOT, { subcommand: "add", paths: ["../secrets"] })
        .error,
    ).toContain("escapes the workspace root");
  });

  test("a pathspec magic prefix is rejected", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "add",
      paths: [":(top)private.txt"],
    });
    expect(plan.error).toContain("pathspec magic is disabled");
  });

  test("every argv disables pathspec interpretation", () => {
    for (const sub of GIT_SUBCOMMANDS) {
      const args: Record<string, unknown> = { subcommand: sub };
      if (sub === "add") args.paths = ["a.ts"];
      if (sub === "commit") args.message = "m";
      expect(buildGitArgv(ROOT, args).argv).toContain("--literal-pathspecs");
    }
  });

  test("a path that looks like a flag is rejected", () => {
    expect(
      buildGitArgv(ROOT, { subcommand: "add", paths: ["--exec=rm -rf /"] })
        .error,
    ).toContain("must not start with '-'");
  });

  test("add requires a path and commit requires a message", () => {
    expect(buildGitArgv(ROOT, { subcommand: "add" }).error).toContain(
      "requires at least one path",
    );
    expect(buildGitArgv(ROOT, { subcommand: "commit" }).error).toContain(
      "non-empty message",
    );
    expect(
      buildGitArgv(ROOT, { subcommand: "commit", message: "   " }).error,
    ).toContain("non-empty message");
  });

  test("an oversized commit message is rejected before it is encoded", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "commit",
      message: "x".repeat(5000),
    });
    expect(plan.error).toContain("exceeds the 4096-byte limit");
  });

  test("a multibyte message over the byte cap is rejected on its bytes", () => {
    // 1500 four-byte characters: 3000 UTF-16 units (under the length
    // pre-check) but 6000 bytes (over the cap).
    const plan = buildGitArgv(ROOT, {
      subcommand: "commit",
      message: "𝄞".repeat(1500),
    });
    expect(plan.error).toContain("6000 bytes");
  });

  test("arguments are rejected where they do not apply", () => {
    expect(
      buildGitArgv(ROOT, { subcommand: "status", message: "no" }).error,
    ).toContain("commit only");
    expect(
      buildGitArgv(ROOT, { subcommand: "log", staged: true }).error,
    ).toContain("diff only");
    expect(
      buildGitArgv(ROOT, { subcommand: "status", limit: 5 }).error,
    ).toContain("log only");
  });

  test("a hostile limit value is rejected instead of coerced", () => {
    // Number() would run these and throw out of buildGitArgv, past the
    // executor's own error handling.
    const hostile = { valueOf: null, toString: null } as unknown;
    expect(buildGitArgv(ROOT, { subcommand: "log", limit: hostile }).error)
      .toContain("limit must be an integer");
    expect(buildGitArgv(ROOT, { subcommand: "log", limit: "5" }).error)
      .toContain("limit must be an integer");
  });

  test("an oversized single path is rejected", () => {
    const plan = buildGitArgv(ROOT, {
      subcommand: "add",
      paths: ["a".repeat(5000)],
    });
    expect(plan.error).toContain("exceeds 4096 characters");
  });

  test("an unsupported subcommand echo is bounded", async () => {
    const plan = buildGitArgv(ROOT, { subcommand: "z".repeat(5000) });
    expect(plan.error!.length).toBeLessThan(400);
  });

  test("too many paths are rejected", () => {
    const paths = Array.from({ length: 101 }, (_, i) => `f${i}.ts`);
    expect(buildGitArgv(ROOT, { subcommand: "add", paths }).error).toContain(
      "at most 100 paths",
    );
  });
});

describe("executeGit", () => {
  test("runs the built argv in the workspace root", async () => {
    const { runner, calls } = recordingRunner({ stdout: "## main\n" });
    const out = await executeGit(ROOT, { subcommand: "status" }, { runner });
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(ROOT);
    expect(calls[0].args).toEqual([
      "--no-pager",
      "--literal-pathspecs",
      "status",
      "--porcelain=v1",
      "--branch",
    ]);
    expect(out).toBe("exit 0\n## main");
  });

  test("a refused call never reaches the runner", async () => {
    const { runner, calls } = recordingRunner();
    const out = await executeGit(ROOT, { subcommand: "push" }, { runner });
    expect(calls).toHaveLength(0);
    expect(out).toContain("not available to the agent");
  });

  test("a non-zero exit returns status and stderr rather than throwing", async () => {
    const { runner } = recordingRunner({
      code: 1,
      stderr: "nothing to commit\n",
    });
    const out = await executeGit(
      ROOT,
      { subcommand: "commit", message: "msg" },
      { runner },
    );
    expect(out).toContain("exit 1");
    expect(out).toContain("nothing to commit");
  });

  test("a timeout is reported as a killed run", async () => {
    const { runner } = recordingRunner({ timedOut: true, code: 137 });
    const out = await executeGit(ROOT, { subcommand: "status" }, {
      runner,
      timeoutMs: 50,
    });
    expect(out).toContain("timed out after 50ms (git killed");
  });

  test("a signal is reported instead of an exit code", async () => {
    const { runner } = recordingRunner({ code: 0, signal: "SIGTERM" });
    const out = await executeGit(ROOT, { subcommand: "status" }, { runner });
    expect(out).toContain("exit by signal SIGTERM");
  });

  test("output is truncated at the byte cap", async () => {
    const { runner } = recordingRunner({ stdout: "x".repeat(500) });
    const out = await executeGit(ROOT, { subcommand: "diff" }, {
      runner,
      maxBytes: 100,
    });
    expect(out).toContain("[truncated at 100 bytes]");
    expect(out.length).toBeLessThan(300);
  });

  test("truncation counts bytes, not UTF-16 units", async () => {
    // 100 four-byte characters: 400 bytes, 200 UTF-16 units.
    const { runner } = recordingRunner({ stdout: "𝄞".repeat(100) });
    const out = await executeGit(ROOT, { subcommand: "diff" }, {
      runner,
      maxBytes: 100,
    });
    const body = out.split("\n")[1] ?? "";
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(100);
  });

  test("a pathless commit in a subdirectory workspace warns about scope", async () => {
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
    expect(calls[0]).toContain("rev-parse");
    expect(out).toContain("records every staged change");
    expect(out).toContain("exit 0");
  });

  test("a commit at the repository root carries no scope warning", async () => {
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
    expect(out).not.toContain("records every staged change");
  });

  test("a commit with explicit paths skips the repository-scope check", async () => {
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
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("rev-parse");
  });

  test("a runner failure is returned as a tool error", async () => {
    const failing: GitRunner = () => Promise.reject(new Error("git not found"));
    const out = await executeGit(ROOT, { subcommand: "status" }, {
      runner: failing,
    });
    expect(out).toBe("error: cannot run git: git not found");
  });
});
