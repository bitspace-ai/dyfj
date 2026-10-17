// Test-lane supervision reaches the Node subset of a lane: `node --test` and
// the process it starts for each file stay in the lane's process group, so
// the gate's deadline stops a test file that hangs
// (`specs/notes/test-supervision-evidence.md`). The lane is a stand-in
// (`node-lane-runner.fixture.ts`) that starts its Node subset as the real
// runners do.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LANE_DEADLINE_EXIT_CODE, runGate } from "./aggregate-test-gate.ts";

const RUNNER = fileURLToPath(
  new URL("./node-lane-runner.fixture.ts", import.meta.url),
);
const quiet = { log: () => {}, error: () => {} };

const HANG = `
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import process from "node:process";
test("never ends", () => {
  writeFileSync(process.env.DYFJ_FIXTURE_DIR + "/file.pid", String(process.pid));
  setInterval(() => {}, 1000);
  return new Promise(() => {});
});
`;

function sh(script: string): string {
  return execFileSync("/bin/bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

// A zombie counts as gone, as in `lane-supervision.test.ts`.
function alive(pid: number): boolean {
  const state = sh(`ps -o stat= -p ${pid} || true`);
  return state !== "" && !state.startsWith("Z");
}

async function gone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

test("a hung node --test file is stopped at its lane's deadline", {
  skip: process.platform === "win32",
}, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dyfj-node-lane-")));
  const pidFile = join(dir, "file.pid");
  try {
    writeFileSync(join(dir, "hang.test.mjs"), HANG);
    const code = await runGate({
      lanes: [{
        label: "Stand-in Node test lane",
        command: "node",
        args: [RUNNER, dir],
        deadlineMs: 3_000,
      }],
      laneRecordDir: join(dir, "records"),
      out: quiet,
    });
    assert.equal(code, LANE_DEADLINE_EXIT_CODE);
    assert.ok(existsSync(pidFile), "the hung test file never started");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(
      await gone(pid, 5_000),
      "the hung test file's process survived the deadline",
    );
  } finally {
    if (existsSync(pidFile)) {
      sh(
        `kill -9 ${Number(readFileSync(pidFile, "utf8"))} 2>/dev/null || true`,
      );
    }
    for (const line of sh("ps -A -ww -o pid=,command=").split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      if (match && match[2].includes(dir)) {
        sh(`kill -9 ${Number(match[1])} 2>/dev/null || true`);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
