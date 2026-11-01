import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import process from "node:process";
import { test } from "node:test";
import { prototypeRoot } from "./disposable-runtime.ts";

const command = `${prototypeRoot}/scripts/scratch-runtime.ts`;
const delay = () => new Promise((resolve) => setTimeout(resolve, 50));
function run(args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, [command, ...args], {
    cwd: prototypeRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => stdout += chunk);
  child.stderr.on("data", (chunk) => stderr += chunk);
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { child, closed, stdout: () => stdout, stderr: () => stderr };
}
async function snapshot(root: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = `${root}/${name}`;
    const info = await stat(path);
    result.push([
      name,
      info.size,
      info.mtimeMs,
      info.isDirectory() ? null : info.atimeMs,
    ]);
    if (info.isDirectory()) result.push(await snapshot(path));
  }
  return result;
}

test("scratch up, dyfj exec, receipt and down leave only recorded evidence", {
  timeout: 120_000,
}, async () => {
  const operator = await mkdtemp("/tmp/dyfj_op_");
  await mkdir(`${operator}/.dyfj/run`, { recursive: true });
  await mkdir(`${operator}/.dolt`);
  await writeFile(
    `${operator}/.dyfj/config.toml`,
    "invalid operator configuration [",
  );
  await writeFile(
    `${operator}/.dolt/config_global.json`,
    "invalid operator configuration",
  );
  let connections = 0;
  const socketTrap = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  const doltTrap = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) =>
    socketTrap.listen(`${operator}/.dyfj/run/workbench.sock`, resolve)
  );
  await new Promise<void>((resolve) =>
    doltTrap.listen(0, "127.0.0.1", resolve)
  );
  const address = doltTrap.address();
  assert(address && typeof address !== "string");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: operator,
    DYFJ_ROOT: `${operator}/.dyfj`,
    DYFJ_SOCKET: `${operator}/.dyfj/run/workbench.sock`,
    DOLT_HOST: "127.0.0.1",
    DOLT_PORT: String(address.port),
    DOLT_USER: "operator",
    OPENAI_API_KEY: "operator-key-must-not-be-inherited",
    DYFJ_WORKBENCH_MODEL: "operator-model",
  };
  const before = await snapshot(operator);
  const up = run(["up"], env);
  let state:
    | { root: string; env: Record<string, string>; processes: number[] }
    | undefined;
  try {
    const deadline = Date.now() + 60_000;
    while (!up.stdout().includes("\n")) {
      assert(
        Date.now() < deadline && up.child.exitCode === null,
        `up failed: ${up.stderr()}`,
      );
      await delay();
    }
    const path = up.stdout().trim();
    state = JSON.parse(await readFile(path, "utf8"));
    assert(state);
    assert(!JSON.stringify(state).includes("operator-key"));
    assert(!Object.values(state.env).includes(operator));
    const exports = run(["env", "--state", path], env);
    assert.equal(await exports.closed, 0, exports.stderr());
    assert(exports.stdout().includes(`export HOME='${state.root}/home'`));
    // Launch the product CLI's actual exec command and read its full receipt.
    // Bare /receipt is not a command in either existing REPL.
    const turn = run(["exec", "--state", path, "Say hello."], env);
    assert.equal(await turn.closed, 0, turn.stderr());
    const reply = JSON.parse(turn.stdout());
    assert.equal(reply.text, "Scratch reply.");
    assert.equal(reply.cost.paidInferenceUsed, false);
    assert.match(reply.receipt, /Workbench receipt/);
    const evidence = run(["evidence", "--state", path], env);
    assert.equal(await evidence.closed, 0, evidence.stderr());
    assert.match(evidence.stdout(), /Workbench receipt/);
    assert.match(evidence.stdout(), /Scratch Local/);
    const down = run(["down", "--state", path], env);
    assert.equal(await down.closed, 0, down.stderr());
    assert.match(down.stdout(), /Commit: [a-f0-9]{40}/);
    assert.match(down.stdout(), /dyfj exec --json/);
    assert.match(down.stdout(), /Scratch reply\./);
    assert.match(down.stdout(), /Teardown: complete/);
    assert.equal(await up.closed, 0, up.stderr());
    await assert.rejects(stat(state.root), { code: "ENOENT" });
    for (const pid of state.processes) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
    assert.equal(
      connections,
      0,
      "operator socket or Dolt endpoint was contacted",
    );
    assert.deepEqual(
      await snapshot(operator),
      before,
      "operator files were accessed or changed",
    );
  } finally {
    up.child.kill("SIGTERM");
    await up.closed;
    if (state) await rm(state.root, { recursive: true, force: true });
    await Promise.all([
      new Promise<void>((resolve) => socketTrap.close(() => resolve())),
      new Promise<void>((resolve) => doltTrap.close(() => resolve())),
    ]);
    await rm(operator, { recursive: true, force: true });
  }
});
