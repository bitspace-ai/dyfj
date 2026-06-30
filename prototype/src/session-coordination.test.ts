import { describe, expect, test } from "vitest";
import {
  buildRadar,
  type CoordinationRuntime,
  exitCoordinationClaim,
  heartbeatCoordinationClaim,
  hookCheck,
  loadCoordinationClaims,
  pathsOverlap,
  reconcileCoordinationClaims,
  resolveCoordinationStorePaths,
  startCoordinationClaim,
} from "./session-coordination";

function env(home: string) {
  const values = new Map([
    ["HOME", home],
    ["DYFJ_COORDINATION_HOME", `${home}/coordination`],
  ]);
  return { get: (key: string) => values.get(key) };
}

function fakeGit(repoRoot: string, branch = "main", targetHead = "base123") {
  const calls: string[][] = [];
  const command: CoordinationRuntime["command"] = async (_cmd, args) => {
    calls.push(args);
    const gitArgs = args.slice(2);
    if (gitArgs.join(" ") === "rev-parse --show-toplevel") {
      return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
    }
    if (gitArgs.join(" ") === "branch --show-current") {
      return { code: 0, stdout: `${branch}\n`, stderr: "" };
    }
    if (gitArgs.join(" ") === "rev-parse HEAD") {
      return { code: 0, stdout: "base123\n", stderr: "" };
    }
    if (gitArgs.join(" ") === `rev-parse ${branch}`) {
      return { code: 0, stdout: `${targetHead}\n`, stderr: "" };
    }
    return {
      code: 1,
      stdout: "",
      stderr: `unexpected git args: ${gitArgs.join(" ")}`,
    };
  };
  return { command, calls };
}

describe("session coordination primitives", () => {
  test("pathsOverlap catches exact, parent, and root scopes", () => {
    expect(pathsOverlap("src", "src")).toBe(true);
    expect(pathsOverlap("src", "src/cli.ts")).toBe(true);
    expect(pathsOverlap(".", "README.md")).toBe(true);
    expect(pathsOverlap("src", "docs")).toBe(false);
  });

  test("startCoordinationClaim records a coordination claim and writes a launch packet", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const repo = `${dir}/repo`;
      await Deno.mkdir(repo);
      const git = fakeGit(repo);
      const runtime: CoordinationRuntime = {
        env: env(dir),
        command: git.command,
        now: () => new Date("2026-06-27T12:00:00Z"),
        uuid: () => "00000000-0000-4000-8000-000000000001",
      };
      const claim = await startCoordinationClaim({
        workItemRef: "WORK-1",
        repo,
        intent: "test coordination",
        scopePaths: ["src", "src"],
        agentId: "codex",
      }, runtime);

      expect(claim.id).toBe("claim_00000000000040008000");
      expect(claim.scopePaths).toEqual(["src"]);
      expect(await loadCoordinationClaims(runtime)).toHaveLength(1);
      expect(await Deno.readTextFile(claim.launchPacketPath)).toContain(
        "test coordination",
      );
      const paths = resolveCoordinationStorePaths(runtime.env);
      expect(await Deno.readTextFile(paths.registryPath)).toContain("WORK-1");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("radar warns on path overlap and stale base", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const repo = `${dir}/repo`;
      await Deno.mkdir(repo);
      let n = 0;
      const runtime: CoordinationRuntime = {
        env: env(dir),
        command: fakeGit(repo, "main", "newhead456").command,
        now: () => new Date("2026-06-27T12:00:00Z"),
        uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      };
      await startCoordinationClaim({
        workItemRef: "WORK-1",
        repo,
        intent: "edit cli",
        scopePaths: ["src"],
      }, runtime);
      await startCoordinationClaim({
        workItemRef: "WORK-2",
        repo,
        intent: "edit cli tests",
        scopePaths: ["src/cli.test.ts"],
      }, runtime);

      const radar = await buildRadar(runtime);
      expect(radar.warnings.map((w) => w.code)).toContain("path-overlap");
      expect(radar.warnings.map((w) => w.code)).toContain("stale-base");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("exitCoordinationClaim records an exit receipt", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const repo = `${dir}/repo`;
      await Deno.mkdir(repo);
      const runtime: CoordinationRuntime = {
        env: env(dir),
        command: fakeGit(repo).command,
        uuid: () => "00000000-0000-4000-8000-000000000001",
      };
      const claim = await startCoordinationClaim({
        workItemRef: "WORK-1",
        repo,
        intent: "finish coordination claim",
        scopePaths: ["README.md"],
      }, runtime);
      const exited = await exitCoordinationClaim(
        claim.id,
        "completed",
        "finished",
        runtime,
      );
      expect(exited.status).toBe("completed");
      expect(await Deno.readTextFile(exited.exitReceiptPath!)).toContain(
        "finished",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("heartbeatCoordinationClaim refreshes the last heartbeat", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const repo = `${dir}/repo`;
      await Deno.mkdir(repo);
      let timestamp = "2026-06-27T12:00:00Z";
      const runtime: CoordinationRuntime = {
        env: env(dir),
        command: fakeGit(repo).command,
        now: () => new Date(timestamp),
        uuid: () => "00000000-0000-4000-8000-000000000001",
      };
      const claim = await startCoordinationClaim({
        workItemRef: "WORK-1",
        repo,
        intent: "keep alive",
        scopePaths: ["README.md"],
      }, runtime);
      timestamp = "2026-06-27T12:30:00Z";
      const heartbeat = await heartbeatCoordinationClaim(claim.id, runtime);
      expect(heartbeat.lastHeartbeatAt).toBe("2026-06-27T12:30:00.000Z");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("radar warns when a coordination heartbeat is stale", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const repo = `${dir}/repo`;
      await Deno.mkdir(repo);
      let timestamp = "2026-06-27T12:00:00Z";
      const runtime: CoordinationRuntime = {
        env: env(dir),
        command: fakeGit(repo).command,
        now: () => new Date(timestamp),
        uuid: () => "00000000-0000-4000-8000-000000000001",
      };
      await startCoordinationClaim({
        workItemRef: "WORK-1",
        repo,
        intent: "quiet coordination claim",
        scopePaths: ["README.md"],
      }, runtime);
      timestamp = "2026-06-27T15:00:00Z";
      const radar = await buildRadar(runtime);
      expect(radar.warnings.map((w) => w.code)).toContain(
        "missing-heartbeat",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("reconcileCoordinationClaims warns when the workspace branch drifts", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const repo = `${dir}/repo`;
      await Deno.mkdir(repo);
      let branch = "main";
      const command: CoordinationRuntime["command"] = async (_cmd, args) => {
        const gitArgs = args.slice(2);
        if (gitArgs.join(" ") === "rev-parse --show-toplevel") {
          return { code: 0, stdout: `${repo}\n`, stderr: "" };
        }
        if (gitArgs.join(" ") === "branch --show-current") {
          return { code: 0, stdout: `${branch}\n`, stderr: "" };
        }
        if (gitArgs.join(" ") === "rev-parse HEAD") {
          return { code: 0, stdout: "base123\n", stderr: "" };
        }
        if (gitArgs.join(" ") === "rev-parse main") {
          return { code: 0, stdout: "base123\n", stderr: "" };
        }
        return {
          code: 1,
          stdout: "",
          stderr: `unexpected git args: ${gitArgs.join(" ")}`,
        };
      };
      const runtime: CoordinationRuntime = {
        env: env(dir),
        command,
      };
      await startCoordinationClaim({
        workItemRef: "WORK-1",
        repo,
        intent: "branch drift",
        scopePaths: ["README.md"],
      }, runtime);
      branch = "feature/drift";
      const result = await reconcileCoordinationClaims(runtime);
      expect(result.warnings.map((w) => w.code)).toContain("branch-drift");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("hookCheck warns when the workspace has no active coordination claim", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const repo = `${dir}/repo`;
      await Deno.mkdir(repo);
      const warnings = await hookCheck(repo, {
        env: env(dir),
        command: fakeGit(repo).command,
      });
      expect(warnings.map((w) => w.code)).toEqual(["unregistered-workspace"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});
