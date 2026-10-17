// A runtime's lifetime, end to end through the real launcher and the real
// runtime: one that `dyfj` autostarts serves back-to-back invocations, then
// stops about 10 s after its last client leaves and leaves no process behind;
// one started with `dyfj start` stays up until `dyfj stop`. Each case runs
// under its own HOME and socket, so it never meets the operator's runtime.
// These cases wait out the real 10 s grace, so each takes a while.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  processTreeContaining,
  reapPidsAndCommandsContaining,
} from "../testing/processes.ts";

const LAUNCHER = fileURLToPath(new URL("./dyfj-launcher.sh", import.meta.url));
const BASH = process.platform === "darwin" ? "/bin/bash" : "bash";
const GRACE_MS = 10_000;

interface Output {
  code: number | null;
  stdout: string;
  stderr: string;
}

function launcher(
  home: string,
  args: string[],
): Promise<Output> {
  return new Promise((resolve, reject) => {
    const child = spawn(BASH, [LAUNCHER, ...args], {
      env: {
        ...process.env,
        HOME: home,
        DYFJ_SOCKET: "",
        DYFJ_AUTOSTART: "1",
        DYFJ_LAUNCHER_DRY_RUN: "",
        DYFJ_CODEX_TOOLCHAIN_PATH: "",
        DYFJ_CODEX_RUSTUP_HOME: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false);
}

async function workspace(): Promise<{ home: string; sock: string }> {
  // A short real path: a socket path has a length limit, and the runtime
  // compares resolved paths.
  const home = await realpath(await mkdtemp(join(tmpdir(), "dyfj-l1-")));
  return { home, sock: `${home}/l1.sock` };
}

async function logText(home: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const dir = `${home}/.dyfj/log`;
  const names = await readdir(dir).catch(() => [] as string[]);
  const texts = await Promise.all(
    names.map((name) => readFile(`${dir}/${name}`, "utf8")),
  );
  return texts.join("\n");
}

describe("an autostarted runtime's lifetime", () => {
  it(
    "serves back-to-back dyfj exec calls, then stops about 10 s after the last, leaving nothing behind",
    { timeout: 90_000 },
    async () => {
      const { home, sock } = await workspace();
      try {
        const first = await launcher(home, ["--socket", sock, "exec", "hi"]);
        assert.match(first.stderr, /starting it/, first.stderr);
        const tree = await processTreeContaining(sock);
        assert.ok(tree.length > 0, "the autostarted runtime is running");

        const second = await launcher(home, ["--socket", sock, "exec", "again"]);
        const lastClientLeft = Date.now();
        assert.doesNotMatch(second.stderr, /starting it/, second.stderr);
        assert.deepEqual(
          (await processTreeContaining(sock)).map((node) => node.pid).sort(),
          tree.map((node) => node.pid).sort(),
          "the second call reused the same runtime processes",
        );
        assert.equal(
          (await logText(home)).match(/dyfj autostart at/g)?.length,
          1,
          "exactly one autostart",
        );

        // Inside the grace it is still up.
        await delay(Math.max(0, lastClientLeft + GRACE_MS - 2_000 - Date.now()));
        assert.ok(
          tree.every((node) => isAlive(node.pid)),
          "the runtime is still up inside the grace",
        );

        // Then it goes, every process in its tree with it.
        const deadline = lastClientLeft + GRACE_MS + 10_000;
        while (tree.some((node) => isAlive(node.pid)) && Date.now() < deadline) {
          await delay(200);
        }
        const elapsed = Date.now() - lastClientLeft;
        assert.ok(
          tree.every((node) => !isAlive(node.pid)),
          `the runtime's processes are gone (${elapsed} ms after the last client)\n${await logText(home)}`,
        );
        assert.ok(elapsed >= GRACE_MS - 1_500, `stopped after ${elapsed} ms`);
        assert.deepEqual(await processTreeContaining(sock), [], "no orphans");
        assert.equal(await exists(sock), false, "the socket is removed");
        assert.match(await logText(home), /no client for 10 s; stopping/);
      } finally {
        await reapPidsAndCommandsContaining([], sock);
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});

describe("a runtime started with dyfj start", () => {
  it(
    "stays up after its last client leaves, until dyfj stop",
    { timeout: 90_000 },
    async () => {
      const { home, sock } = await workspace();
      const runtime = spawn(BASH, [LAUNCHER, "--socket", sock, "start"], {
        env: {
          ...process.env,
          HOME: home,
          DYFJ_SOCKET: "",
          DYFJ_LAUNCHER_DRY_RUN: "",
          DYFJ_CODEX_TOOLCHAIN_PATH: "",
          DYFJ_CODEX_RUSTUP_HOME: "",
        },
        stdio: ["ignore", "ignore", "ignore"],
      });
      const closed = new Promise<void>((resolve) => runtime.on("close", () => resolve()));
      try {
        let status: Output | undefined;
        for (let i = 0; i < 100; i++) {
          status = await launcher(home, ["--socket", sock, "status"]);
          if (status.code === 0) break;
          await delay(200);
        }
        assert.equal(status?.code, 0, status?.stderr ?? "no status");
        assert.match(status!.stdout, /launch: manual/);

        await delay(GRACE_MS + 2_000);
        const later = await launcher(home, ["--socket", sock, "status"]);
        assert.equal(later.code, 0, `still up after the grace: ${later.stderr}`);

        const stop = await launcher(home, ["--socket", sock, "stop"]);
        assert.equal(stop.code, 0, stop.stderr);
        await closed;
        assert.deepEqual(await processTreeContaining(sock), [], "no orphans");
      } finally {
        if (runtime.exitCode === null && runtime.signalCode === null) {
          runtime.kill("SIGTERM");
        }
        await reapPidsAndCommandsContaining([runtime.pid ?? 0], sock);
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
