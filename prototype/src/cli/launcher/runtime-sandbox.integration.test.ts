// The runtime runs as plain node, however the launcher starts it (decision
// D32, S4). Node writes a process's `--permission` flags into the
// `NODE_OPTIONS` of every process it starts, so a sandboxed client would
// sandbox the runtime it starts, and a sandboxed runtime every Node process
// its tools start. These tests drive the real launcher against a stand-in
// prototype root: the real client sources, and a stand-in engine that records
// how it was started and what a `node` started through the exec tools' bash
// can do.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PROTOTYPE = fileURLToPath(new URL("../../..", import.meta.url));

// Records the engine's own launch, then runs `node` through the exec tools'
// bash, as a model's tool call would, and records what that child can do.
const ENGINE = `
import { writeFileSync } from "node:fs";
import process from "node:process";
import { runBounded } from "../tools/builtin/bounded-process.ts";

const PROBE = [
  "const fs = require('node:fs');",
  "let write = 'ok';",
  "try { fs.writeFileSync(process.argv[1], 'x'); } catch (e) { write = e.code; }",
  "let addon;",
  "try { process.dlopen({ exports: {} }, '/nonexistent/dyfj-probe.node'); }",
  "catch (e) { addon = e.code; }",
  "console.log(JSON.stringify({ permission: process.permission === undefined",
  "  ? 'off' : 'on', nodeOptions: process.env.NODE_OPTIONS ?? null, write, addon }));",
].join(" ");

const child = await runBounded({
  command: "bash",
  args: ["-c", 'node -e "$0" "$1"', PROBE, process.cwd() + "/child-write"],
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  timeoutMs: 20_000,
});
const name = process.argv.includes("--autostarted")
  ? "autostarted.json"
  : "foreground.json";
writeFileSync(name, JSON.stringify({
  execArgv: process.execArgv,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  permission: process.permission === undefined ? "off" : "on",
  bashChild: JSON.parse(child.stdout),
}));
`;

interface Recorded {
  execArgv: string[];
  nodeOptions: string | null;
  permission: "on" | "off";
  bashChild: {
    permission: "on" | "off";
    nodeOptions: string | null;
    write: string;
    addon: string;
  };
}

/** A prototype root whose every `src/` entry is the real one but the engine. */
async function standInRoot(root: string): Promise<void> {
  await mkdir(join(root, "scripts"));
  await copyFile(
    join(PROTOTYPE, "scripts", "dyfj-launcher.sh"),
    join(root, "scripts", "dyfj-launcher.sh"),
  );
  await mkdir(join(root, "src", "server"), { recursive: true });
  for (const entry of await readdir(join(PROTOTYPE, "src"))) {
    if (entry === "server") continue;
    await symlink(join(PROTOTYPE, "src", entry), join(root, "src", entry));
  }
  await writeFile(join(root, "src", "server", "main.ts"), ENGINE);
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = await readFile(path, "utf8");
      if (text.length > 0) return text;
    } catch {
      // Not written yet.
    }
    if (Date.now() > deadline) throw new Error(`${path} was never written`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
}

function assertPlainNode(recorded: Recorded): void {
  assert.deepStrictEqual(recorded.execArgv, []);
  assert.strictEqual(recorded.permission, "off");
  assert.strictEqual(recorded.nodeOptions, null);
  // A `node` run through the exec tools' bash inherits no sandbox: it can
  // write, and it tries to load an addon (a missing file fails to open,
  // rather than being refused as ERR_DLOPEN_DISABLED).
  assert.deepStrictEqual(recorded.bashChild, {
    permission: "off",
    nodeOptions: null,
    write: "ok",
    addon: "ERR_DLOPEN_FAILED",
  });
}

describe("the launcher starts the runtime as plain node", () => {
  let root = "";
  let env: Record<string, string> = {};

  before(async () => {
    // A short path: a Unix socket path is limited to about 100 bytes.
    root = await mkdtemp(join(tmpdir(), "dyfj-sbx-"));
    await standInRoot(root);
    await mkdir(join(root, "home"));
    env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(root, "home"),
      DYFJ_SOCKET: join(root, "wb.sock"),
      DYFJ_REPL: "ts",
    };
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("through dyfj start", async () => {
    const child = spawn(
      "bash",
      [join(root, "scripts", "dyfj-launcher.sh"), "start"],
      { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    await exited(child);
    assert.strictEqual(child.exitCode, 0, stderr);
    assertPlainNode(
      JSON.parse(await readFile(join(root, "foreground.json"), "utf8")),
    );
  });

  it("through autostart's background start", async () => {
    // The stand-in engine never listens, so the launcher would wait out its
    // probes; it is stopped once the background start has recorded.
    const child = spawn(
      "bash",
      [join(root, "scripts", "dyfj-launcher.sh"), "exec", "hello"],
      { cwd: root, env, stdio: ["ignore", "ignore", "ignore"] },
    );
    try {
      assertPlainNode(
        JSON.parse(await waitForFile(join(root, "autostarted.json"), 60_000)),
      );
    } finally {
      child.kill("SIGKILL");
      await exited(child);
    }
  });
});
