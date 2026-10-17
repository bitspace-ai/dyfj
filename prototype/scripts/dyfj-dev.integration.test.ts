// `dyfj dev` end to end, through the real launcher, the real supervisor, the
// real runtime and the real Rust REPL (built by the supervisor, as it is for
// the operator). The runtime uses the lane's isolated Dolt, from the
// environment, so a fixture-runner turn can run against it. The REPL reads piped input here, so each case types its
// commands into the launcher's stdin. Each case runs under its own HOME and
// socket, so it never meets the operator's runtime.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { connectUnixClient } from "../src/transport/mod.ts";
import {
  type ProcessNode,
  processTreeContaining,
  reapPidsAndCommandsContaining,
} from "../testing/processes.ts";

const LAUNCHER = fileURLToPath(new URL("./dyfj-launcher.sh", import.meta.url));
/** A module the server reaches; the test only touches its timestamps. */
const RUNTIME_MODULE = fileURLToPath(new URL("../src/engine/agent-loop.ts", import.meta.url));
const BASH = process.platform === "darwin" ? "/bin/bash" : "bash";
/** The first case may build the REPL from cold. */
const BOOT_MS = 240_000;
const GRACE_MS = 10_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

interface Dev {
  child: ChildProcess;
  output: () => string;
  waitFor: (pattern: RegExp, ms?: number) => Promise<void>;
  closed: Promise<number | null>;
}

function dyfjDev(home: string, sock: string): Dev {
  const child = spawn(BASH, [LAUNCHER, "dev", "--socket", sock], {
    env: {
      ...process.env,
      HOME: home,
      XDG_RUNTIME_DIR: "",
      DYFJ_SOCKET: "",
      DYFJ_LAUNCHER_DRY_RUN: "",
      DYFJ_CODEX_TOOLCHAIN_PATH: "",
      DYFJ_CODEX_RUSTUP_HOME: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let text = "";
  child.stdout!.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
  child.stderr!.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
  const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return {
    child,
    output: () => text,
    closed,
    async waitFor(pattern, ms = 30_000) {
      const deadline = Date.now() + ms;
      while (!pattern.test(text) && Date.now() < deadline) await delay(100);
      assert.match(text, pattern);
    },
  };
}

async function workspace(): Promise<{ home: string; sock: string }> {
  // A short real path: a socket path has a length limit.
  const home = await realpath(await mkdtemp(join(tmpdir(), "dyfj-dev-")));
  return { home, sock: `${home}/d.sock` };
}

async function allGone(tree: ProcessNode[], ms: number): Promise<number> {
  const started = Date.now();
  while (tree.some((node) => isAlive(node.pid)) && Date.now() - started < ms) {
    await delay(200);
  }
  return Date.now() - started;
}

const exists = (path: string) => stat(path).then(() => true, () => false);

describe("dyfj dev", () => {
  it(
    "runs the REPL on its own runtime, reloads it on /reload, and leaves nothing behind on /quit",
    { timeout: BOOT_MS + 60_000 },
    async () => {
      const { home, sock } = await workspace();
      const dev = dyfjDev(home, sock);
      let tree: ProcessNode[] = [];
      try {
        await dev.waitFor(/^posture: /m, BOOT_MS);
        tree = await processTreeContaining(sock);
        assert.ok(tree.length >= 3, `supervisor, REPL and runtime: ${JSON.stringify(tree)}`);

        dev.child.stdin!.write("/reload\n");
        await dev.waitFor(/runtime reloaded \(reload requested\)/);
        const reloaded = await processTreeContaining(sock);

        dev.child.stdin!.write("/quit\n");
        assert.equal(await dev.closed, 0, dev.output());
        const elapsed = await allGone([...tree, ...reloaded], 15_000);
        assert.deepEqual(
          [...tree, ...reloaded].filter((node) => isAlive(node.pid)),
          [],
          `no orphans (${elapsed} ms after quit)\n${dev.output()}`,
        );
        assert.equal(await exists(sock), false, "the socket is removed");
      } finally {
        dev.child.kill("SIGKILL");
        await reapPidsAndCommandsContaining(tree.map((node) => node.pid), sock);
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it(
    "a save during a turn restarts the runtime only after the turn ends",
    { timeout: BOOT_MS + 60_000 },
    async () => {
      const { home, sock } = await workspace();
      const dev = dyfjDev(home, sock);
      let tree: ProcessNode[] = [];
      try {
        await dev.waitFor(/^posture: /m, BOOT_MS);
        tree = await processTreeContaining(sock);

        // A turn the fixture agent holds open until it is cancelled.
        let streamed = "";
        const client = await connectUnixClient(sock, {
          onStream: (frame) => (streamed += JSON.stringify(frame)),
        });
        const turnId = randomUUID();
        const turn = client.request("turn", {
          prompt: "FIXTURE_CANCEL",
          mode: "turn",
          runner: "fixture",
          workspace: home,
          turnId,
        }).catch((error: unknown) => error);
        const deadline = Date.now() + 30_000;
        while (!streamed.includes("partial") && Date.now() < deadline) await delay(100);
        assert.match(streamed, /partial/, `the fixture turn is running: ${streamed.slice(-900)}`);

        // A save mid-turn: touching the timestamps is a save to the watcher,
        // and the module's contents stay as they are.
        const now = new Date();
        await utimes(RUNTIME_MODULE, now, now);
        await delay(3_000);
        assert.doesNotMatch(dev.output(), /runtime disconnected/, "no restart while the turn runs");

        await client.request("turn/cancel", { turnId });
        await turn;
        client.close();
        await dev.waitFor(/runtime reloaded \(1 file changed\)/, 30_000);

        dev.child.stdin!.write("/quit\n");
        assert.equal(await dev.closed, 0, dev.output());
      } finally {
        dev.child.kill("SIGKILL");
        await reapPidsAndCommandsContaining(tree.map((node) => node.pid), sock);
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it(
    "a supervisor killed outright leaves a runtime that stops 10 s after its last client",
    { timeout: BOOT_MS + 60_000 },
    async () => {
      const { home, sock } = await workspace();
      const dev = dyfjDev(home, sock);
      let tree: ProcessNode[] = [];
      try {
        await dev.waitFor(/^posture: /m, BOOT_MS);
        tree = await processTreeContaining(sock);
        assert.ok(tree.length >= 3, JSON.stringify(tree));

        // The launcher exec'd the supervisor, so this is the supervisor.
        dev.child.kill("SIGKILL");
        await dev.closed;
        // The REPL is still a client; ending its input lets it quit.
        dev.child.stdin!.destroy();
        const lastClientLeft = Date.now();
        const elapsed = await allGone(tree, GRACE_MS + 15_000);
        assert.deepEqual(
          tree.filter((node) => isAlive(node.pid)),
          [],
          `everything stopped (${elapsed} ms after the REPL's input ended)\n${dev.output()}`,
        );
        assert.ok(Date.now() - lastClientLeft >= GRACE_MS - 1_500, "the runtime waited out its grace");
      } finally {
        await reapPidsAndCommandsContaining(tree.map((node) => node.pid), sock);
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
