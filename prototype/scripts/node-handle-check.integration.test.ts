// The per-file Node handle check (`testing/node-handle-check.ts`) run the way
// the lanes run it (`node-test-lane.ts`): a file that leaves a `node:net`
// server, an interval or a child process live fails with its file and the
// leaked types named, and does not hang the run; a clean file passes.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import { startNodeTests } from "./node-test-lane.ts";

const dir = mkdtempSync(join(tmpdir(), "dyfj-node-handle-check-"));
after(() => {
  try {
    const pid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
    if (pid > 0) process.kill(pid, "SIGKILL");
  } catch {
    // The child fixture did not run, or its child has already gone.
  }
  rmSync(dir, { recursive: true, force: true });
});

const FIXTURES: Record<string, string> = {
  "clean.mjs": `
import { test } from "node:test";
import { createServer } from "node:net";
test("closes what it opens", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => server.close(resolve));
  clearInterval(setInterval(() => {}, 1000));
});
`,
  "leaked-server.mjs": `
import { test } from "node:test";
import { createServer } from "node:net";
test("leaves a server listening", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
});
`,
  "leaked-interval.mjs": `
import { test } from "node:test";
test("leaves an interval running", () => {
  setInterval(() => {}, 1000);
});
`,
  "leaked-child.mjs": `
import { test } from "node:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
test("leaves a child process running", () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(join(dir, "child.pid"))}, String(child.pid));
});
`,
};
for (const [name, source] of Object.entries(FIXTURES)) {
  writeFileSync(join(dir, name), source);
}

async function run(file: string): Promise<{ code: number; output: string }> {
  let output = "";
  const result = startNodeTests({
    lane: "fixture",
    files: [file],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    jobs: 1,
    log: (line) => output += `${line}\n`,
    write: (chunk) => output += String(chunk),
  });
  return { code: await result.code, output };
}

test("a clean file passes the handle check", { timeout: 30_000 }, async () => {
  const { code, output } = await run("clean.mjs");
  assert.equal(code, 0, output);
  assert.doesNotMatch(output, /dyfj node handle check/);
  assert.match(output, /fixture node --test: ok \| 1 passed \| 0 failed/);
});

for (
  const [file, leaked] of [
    ["leaked-server.mjs", "TCPServerWrap"],
    ["leaked-interval.mjs", "Timeout"],
    ["leaked-child.mjs", "ProcessWrap"],
  ] as const
) {
  test(`${file} fails the handle check, naming ${leaked}`, {
    timeout: 30_000,
  }, async () => {
    const { code, output } = await run(file);
    assert.notEqual(code, 0, output);
    assert.match(
      output,
      new RegExp(
        `dyfj node handle check: \\S*${file.replace(".", "\\.")} left \\d+ ` +
          `resource\\(s\\) live after its tests: [^\\n]*${leaked}`,
      ),
    );
    // The file's own test passed; the file failed the check.
    assert.match(output, /fixture node --test: FAILED \| 1 passed \| 1 failed/);
  });
}
