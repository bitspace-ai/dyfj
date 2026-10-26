/**
 * `--tool-steps` and `/steps` through the real launcher and the TypeScript
 * REPL, against a real runtime socket whose runtime is a stub that records
 * the limit each turn arrives with. Piped input is not a terminal, so the
 * launcher routes the session to the TypeScript REPL. The Rust REPL's half is
 * its launcher pass-through test and its own argument-to-turn-body test.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { integrationChildEnvironment } from "../../scripts/integration-child-environment.ts";
import { turnResult as result } from "../../testing/builders/turn-client.ts";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { udsTestSocket } from "../../testing/servers/uds-sockets.ts";
import { serveWorkbenchUnix } from "../server/main.ts";
import { MemoryStore } from "../store/mod.ts";

const LAUNCHER = fileURLToPath(
  new URL("../../scripts/dyfj-launcher.sh", import.meta.url),
);
const BASH = process.platform === "darwin" ? "/bin/bash" : "bash";

interface Run {
  code: number | null;
  stderr: string;
}

/**
 * Run the launcher with `args`, typing `lines` one at a time: each goes in
 * when the REPL prints its prompt, because the REPL reads with
 * `readline.question` and drops a line that arrives while it is busy. Stdin
 * ends after the last line has been read. After 20 s the child is killed, so
 * a hung launcher or REPL fails the test rather than hanging it.
 */
function launch(args: string[], lines: string[], home: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(BASH, [LAUNCHER, "--no-autostart", ...args], {
      env: integrationChildEnvironment({
        HOME: home,
        NO_COLOR: "1",
        DYFJ_REPL: "",
        DYFJ_LAUNCHER_DRY_RUN: "",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    let stdout = "";
    let sent = 0;
    const prompts = () => stdout.split("dyfj> ").length - 1;
    const feed = () => {
      while (sent < prompts() && sent < lines.length) {
        child.stdin.write(`${lines[sent++]}\n`);
      }
      if (sent === lines.length && prompts() > lines.length) child.stdin.end();
    };
    const timeout = setTimeout(() => {
      child.stdin.end();
      child.kill("SIGKILL");
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      feed();
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

describe("--tool-steps and /steps through the launcher's TypeScript REPL", () => {
  it("sends the session's limit on each turn, shows it, and refuses one above the ceiling", async () => {
    const sock = udsTestSocket("cli-tool-steps");
    const home = await mkdtemp(join(tmpdir(), "dyfj-tool-steps-"));
    const seen: (number | undefined)[] = [];
    const server = await serveWorkbenchUnix(sock, {
      store: new MemoryStore(),
      env: new MapEnv(),
      engineConfig: {
        defaultCompanionModel: null,
        permissionLevel: "strict",
        approvePaidDefault: false,
        trustWorkspaceInstructions: false,
        defaultSessionBudgetUsd: 1,
        defaultPerCallBudgetUsd: 0.1,
        defaultDailyBudgetUsd: 25,
        defaultTurnBudgetUsd: 4,
        defaultRunawayStallUsd: 0.5,
        maxToolSteps: 32,
        maxToolStepsCeiling: 48,
      },
      runRuntime: (async (input: { maxToolSteps?: number }) => {
        seen.push(input.maxToolSteps);
        // A well-formed session id, so the REPL's next turn may name it.
        return result({ text: "ok", sessionId: "01ABCDEF0123456789ABCDEF01" });
      }) as never,
    });
    try {
      const run = await launch(
        ["--socket", sock, "--tool-steps", "2"],
        ["/steps", "first", "/steps 49", "/steps 4", "second"],
        home,
      );
      assert.strictEqual(run.code, 0, run.stderr);
      assert.ok(
        run.stderr.includes("tool-step limit: 2 (ceiling 48)"),
        run.stderr,
      );
      assert.ok(
        run.stderr.includes(
          "refused: 49 is above the tool-step ceiling of 48; the limit stays 2",
        ),
        run.stderr,
      );
      assert.ok(
        run.stderr.includes("tool-step limit: 4 (ceiling 48)"),
        run.stderr,
      );
      // The launch flag reached the first turn, and /steps 4 the second.
      assert.deepStrictEqual(seen, [2, 4]);

      const refused = await launch(
        ["--socket", sock, "--tool-steps", "65"],
        ["never sent"],
        home,
      );
      assert.strictEqual(refused.code, 2, refused.stderr);
      assert.ok(
        refused.stderr.includes(
          "--tool-steps must be an integer from 1 through 64",
        ),
        refused.stderr,
      );
      assert.deepStrictEqual(seen, [2, 4], "a refused launch sends no turn");
    } finally {
      await server.close();
      await unlink(sock).catch(() => {});
      await rm(home, { recursive: true, force: true });
    }
  });
});
