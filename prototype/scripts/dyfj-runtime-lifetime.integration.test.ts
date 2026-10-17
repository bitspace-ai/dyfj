// A runtime's lifetime, end to end through the real launcher and the real
// runtime: one that `dyfj` autostarts serves back-to-back invocations, then
// stops about 10 s after its last client leaves and leaves no process behind;
// one started with `dyfj start` stays up until `dyfj stop`. Each case runs
// under its own HOME and socket, so it never meets the operator's runtime.
// These cases wait out the real 10 s grace, so each takes a while.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
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
  launcherPath = LAUNCHER,
): Promise<Output> {
  return new Promise((resolve, reject) => {
    const child = spawn(BASH, [launcherPath, ...args], {
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

/**
 * Signals `pids`, every process whose command line names `sock`, and their
 * descendants as one process-list scan finds them. The runtime reads its
 * socket from the environment, so its command line does not name it, and a
 * failing case must not leave it running.
 */
async function reapTree(sock: string, pids: number[] = []): Promise<void> {
  const tree = await processTreeContaining(sock);
  await reapPidsAndCommandsContaining(
    [...pids, ...tree.map((node) => node.pid)],
    sock,
  );
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
        await reapTree(sock);
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
        await reapTree(sock, [runtime.pid ?? 0]);
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});

describe("a runtime started with dyfj start on a terminal", () => {
  // A pseudo-terminal whose session leader is a job-control shell, as an
  // operator's terminal pane is. Each `C` written to the driver's stdin types
  // one Ctrl-C into the terminal; the terminal's output is copied to stdout.
  // Not `pty.spawn`, for the reason the launcher test gives.
  const PTY_DRIVER = [
    "import os, pty, select, sys",
    "pid, fd = pty.fork()",
    "if pid == 0: os.execvp(sys.argv[1], sys.argv[1:])",
    "stdin_open = True",
    "while True:",
    "    r, _, _ = select.select([fd] + ([0] if stdin_open else []), [], [])",
    "    if 0 in r:",
    "        data = os.read(0, 64)",
    "        if not data: stdin_open = False",
    "        else: os.write(fd, data.replace(b'C', b'\\x03'))",
    "    if fd in r:",
    "        try: data = os.read(fd, 4096)",
    "        except OSError: break",
    "        if not data: break",
    "        os.write(1, data)",
    "sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))",
  ].join("\n");

  // Two foreground `dyfj start` runs in one terminal, one after the other.
  // When the shell gets the terminal back, it reports whether the runtime's
  // socket was still there (`EARLY`): `dyfj start` must hold the foreground
  // until its runtime has exited, so a repeated Ctrl-C reaches the runtime and
  // not the shell. After each runtime has exited (its socket is gone, then a
  // moment for the process exit itself), the shell prints whether the
  // terminal still generates signals: `isig` or `-isig`.
  const SESSION = [
    "set -m",
    "for run in 1 2; do",
    '  "$0" "$1" --socket "$2" start',
    '  if [ -e "$2" ]; then echo "EARLY$run"; fi',
    '  while [ -e "$2" ]; do sleep 0.1; done',
    "  sleep 1",
    `  echo "MODES$run $(stty -a | tr -s ' ;' '\\n\\n' | grep -E '^-?isig$')"`,
    "done",
  ].join("\n");

  async function waitForStatus(home: string, sock: string): Promise<void> {
    let status: Output | undefined;
    for (let i = 0; i < 150; i++) {
      status = await launcher(home, ["--socket", sock, "status"]);
      if (status.code === 0) return;
      await delay(200);
    }
    assert.fail(`the runtime did not come up: ${status?.stderr ?? ""}`);
  }

  async function waitForGone(pids: number[], ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (pids.some(isAlive) && Date.now() < deadline) await delay(100);
    return !pids.some(isAlive);
  }

  it(
    "stops on one Ctrl-C and leaves the terminal generating signals, so the next one stops too",
    { timeout: 120_000 },
    async () => {
      const { home, sock } = await workspace();
      const driver = spawn(
        "python3",
        ["-c", PTY_DRIVER, BASH, "-c", SESSION, BASH, LAUNCHER, sock],
        {
          env: {
            ...process.env,
            HOME: home,
            DYFJ_SOCKET: "",
            DYFJ_LAUNCHER_DRY_RUN: "",
            DYFJ_CODEX_TOOLCHAIN_PATH: "",
            DYFJ_CODEX_RUSTUP_HOME: "",
          },
          stdio: ["pipe", "pipe", "inherit"],
        },
      );
      let terminal = "";
      driver.stdout.on("data", (chunk: Buffer) => terminal += chunk.toString());
      const closed = new Promise<void>((resolve) => driver.on("close", () => resolve()));
      const pids: number[] = [];
      try {
        for (const run of [1, 2]) {
          await waitForStatus(home, sock);
          // The `start` client and the runtime it spawned; the driver and the
          // shell name the socket too, but outlive both runs.
          const tree = (await processTreeContaining(sock))
            .filter((node) => /(^|[\s/])src\/(cli|server)\/main\.ts\b/.test(node.command))
            .map((node) => node.pid);
          assert.equal(tree.length, 2, `run ${run}: the client and the runtime are running`);
          pids.push(...tree);
          driver.stdin.write("C");
          assert.ok(
            await waitForGone(tree, 10_000),
            `run ${run}: one Ctrl-C stops the runtime within 10 s\n${terminal}`,
          );
          const deadline = Date.now() + 10_000;
          while (!terminal.includes(`MODES${run} `) && Date.now() < deadline) {
            await delay(100);
          }
          assert.match(
            terminal,
            new RegExp(`MODES${run} isig\\b`),
            `run ${run}: the terminal still generates signals\n${terminal}`,
          );
          assert.doesNotMatch(
            terminal,
            new RegExp(`EARLY${run}`),
            `run ${run}: dyfj start held the terminal until its runtime exited`,
          );
        }
        driver.stdin.end();
        await closed;
      } finally {
        if (driver.exitCode === null && driver.signalCode === null) {
          driver.kill("SIGKILL");
        }
        await reapTree(sock, [...pids, driver.pid ?? 0]);
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});

describe("a stale autostarted runtime", () => {
  // A checkout of its own: a copy of prototype/src, so the test can make the
  // runtime stale by changing that copy, with the real dependencies linked.
  async function checkoutCopy(root: string): Promise<{
    launcher: string;
    src: string;
  }> {
    const prototype = fileURLToPath(new URL("..", import.meta.url));
    await mkdir(`${root}/prototype/scripts`, { recursive: true });
    await cp(`${prototype}/src`, `${root}/prototype/src`, { recursive: true });
    await cp(`${prototype}/package.json`, `${root}/prototype/package.json`);
    await writeFile(
      `${root}/prototype/scripts/dyfj-launcher.sh`,
      await readFile(LAUNCHER, "utf8"),
    );
    await symlink(
      fileURLToPath(new URL("../../node_modules", import.meta.url)),
      `${root}/node_modules`,
    );
    return {
      launcher: `${root}/prototype/scripts/dyfj-launcher.sh`,
      src: `${root}/prototype/src`,
    };
  }

  it(
    "is restarted only when nothing else uses it, and otherwise keeps serving with a warning",
    { timeout: 120_000 },
    async () => {
      const { home, sock } = await workspace();
      const { launcher: copy, src } = await checkoutCopy(home);
      const run = (args: string[]) =>
        launcher(home, ["--socket", sock, ...args], copy);
      let held: net.Socket | undefined;
      try {
        const first = await run(["models"]);
        assert.equal(first.code, 0, first.stderr);
        assert.match(first.stderr, /starting it/);
        const original = await processTreeContaining(sock);

        // Another client stays connected while the code changes under it.
        held = net.createConnection(sock);
        await new Promise<void>((resolve, reject) => {
          held!.once("connect", resolve).once("error", reject);
        });
        await writeFile(`${src}/zz-stale.txt`, "changed\n");
        const stale = await run(["status"]);
        assert.match(stale.stdout, /\(runtime is behind the working tree\)/);

        const declined = await run(["models"]);
        assert.equal(declined.code, 0, declined.stderr);
        assert.match(
          declined.stderr,
          /not restarting it because another client is connected/,
        );
        assert.doesNotMatch(declined.stderr, /runtime not running at/);
        assert.ok(
          original.every((node) => isAlive(node.pid)),
          "the shared runtime keeps serving",
        );
        const after = await run(["status"]);
        assert.equal(after.code, 0, after.stderr);
        assert.match(after.stdout, /behind the working tree/);

        // Alone, the next invocation restarts it on the current code.
        held.destroy();
        held = undefined;
        await delay(300);
        const restarted = await run(["models"]);
        assert.equal(restarted.code, 0, restarted.stderr);
        assert.match(restarted.stderr, /behind the working tree; restarting it/);
        assert.match(restarted.stderr, /runtime not running at .*; starting it/);
        assert.ok(original.every((node) => !isAlive(node.pid)));
        const current = await run(["status"]);
        assert.match(current.stdout, /\(matches the working tree\)/);
        await run(["stop"]);
      } finally {
        held?.destroy();
        await reapTree(sock);
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
