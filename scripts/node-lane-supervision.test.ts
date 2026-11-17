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
import { before, test } from "node:test";
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
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function processes(): { pid: number; group: number; stat: string; command: string }[] {
  let listing: string;
  try {
    listing = sh("ps -A -ww -o pid=,pgid=,stat=,command=");
  } catch (cause) {
    throw new Error(`ps failed: ${String(cause)}`, { cause });
  }
  return listing.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    return match
      ? [{
        pid: Number(match[1]),
        group: Number(match[2]),
        stat: match[3],
        command: match[4],
      }]
      : [];
  });
}

before(() => {
  if (process.platform === "win32") return;
  try {
    processes();
  } catch (cause) {
    throw new Error(
      `ps is refused; this test must run where processes can be listed: ${String(cause)}`,
      { cause },
    );
  }
});

// A zombie counts as gone, as in `lane-supervision.test.ts`.
function alive(pid: number): boolean {
  return processes().some((row) => row.pid === pid && !row.stat.startsWith("Z"));
}

function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
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
  const groupFile = join(dir, "group");
  let runFailed = false;
  let runError: unknown;
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
  } catch (error) {
    runFailed = true;
    runError = error;
    throw error;
  } finally {
    const errors: unknown[] = [];
    const attempt = (action: () => void) => {
      try {
        action();
      } catch (error) {
        errors.push(error);
      }
    };
    const groupErrors = new Map<number, unknown>();
    // The runner registers its group before starting children; records may be gone.
    attempt(() => {
      if (!existsSync(groupFile)) return;
      const group = Number(readFileSync(groupFile, "utf8"));
      assert.ok(Number.isSafeInteger(group) && group > 1, "invalid fixture group");
      try {
        kill(-group);
      } catch (error) {
        groupErrors.set(group, error);
      }
    });
    attempt(() => {
      const rows = processes();
      // macOS can return EPERM for a group containing only an unreaped zombie.
      for (const [group, error] of groupErrors) {
        if (
          (error as NodeJS.ErrnoException).code === "EPERM" &&
          !rows.some((row) => row.group === group && !row.stat.startsWith("Z"))
        ) groupErrors.delete(group);
      }
      for (const row of rows) {
        if (row.command.includes(dir) && row.pid !== process.pid) {
          attempt(() => kill(row.pid));
        }
      }
    });
    errors.push(...groupErrors.values());
    attempt(() => rmSync(dir, { recursive: true, force: true }));
    if (errors.length > 0) {
      throw new AggregateError(
        runFailed ? [runError, ...errors] : errors,
        runFailed ? "fixture run and cleanup failed" : "fixture cleanup failed",
      );
    }
  }
});
