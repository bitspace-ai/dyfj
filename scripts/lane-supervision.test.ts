// Test-lane supervision against real process groups
// (`specs/notes/test-supervision-evidence.md`): the gate's per-lane deadline,
// the runner's end-of-run group stop and backstop, the lane helpers' exit
// when their parent dies, and the gate's recovery of a lane group left
// behind with its token still held. The lanes are stand-ins
// (`lane-runner.fixture.ts`) whose child leaves a same-group `sleep`
// grandchild that ignores TERM, the leak class each mechanism must clean up.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  LANE_BACKSTOP_ENV,
  LANE_DEADLINE_ENV,
  LANE_PARENT_ENV,
  LANE_TOKEN_ENV,
  laneTokenArgument,
} from "../prototype/scripts/lane-supervision.ts";
import {
  LANE_DEADLINE_EXIT_CODE,
  recoverOrphanedLaneGroups,
  runGate,
} from "./aggregate-test-gate.ts";

const RUNNER = fileURLToPath(
  new URL("./lane-runner.fixture.ts", import.meta.url),
);
const DRIVER = fileURLToPath(
  new URL("./gate-driver.fixture.ts", import.meta.url),
);
const quiet = { log: () => {}, error: () => {} };
const SUPERVISION_URL = new URL(
  "../prototype/scripts/lane-supervision.ts",
  import.meta.url,
).href;
const skip = process.platform === "win32";
// An explicit environment for every child: the gate driver gets the names
// the gate itself forwards, and nothing else from this process.
function childEnv(): Record<string, string> {
  return Object.fromEntries(
    ["PATH", "HOME", "TMPDIR"].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function sh(script: string): string {
  return execFileSync("/bin/bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

interface ProcessRow {
  pid: number;
  group: number;
  stat: string;
  command: string;
}

function processes(): ProcessRow[] {
  return sh("ps -A -ww -o pid=,pgid=,stat=,command= || true").split("\n")
    .flatMap((line) => {
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

// A zombie counts as gone: in a container whose init does not reap orphans, a
// killed process can linger as one.
function live(): ProcessRow[] {
  return processes().filter((row) => !row.stat.startsWith("Z"));
}

function alive(pid: number): boolean {
  return live().some((row) => row.pid === pid);
}

function liveGroupMembers(group: number): number[] {
  return live().filter((row) => row.group === group).map((row) => row.pid);
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function readText(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

function grandchildPid(dir: string): Promise<number> {
  return waitFor(() => readText(`${dir}/grandchild.pid`), 10_000, "grandchild")
    .then(Number);
}

// Live processes whose command line carries `token`: the lane's carrier.
function tokenCarriers(token: string): number[] {
  return live().filter((row) => row.command.includes(laneTokenArgument(token)))
    .map((row) => row.pid);
}

interface LaneRecord {
  gatePid: number;
  group: number;
  token: string;
}

// The one lane record left in `<dir>/records`.
async function laneRecord(dir: string): Promise<LaneRecord> {
  const name = await waitFor(
    () => {
      try {
        return readdirSync(`${dir}/records`).find((entry) =>
          entry.endsWith(".json")
        );
      } catch {
        return undefined;
      }
    },
    5_000,
    "the lane record",
  );
  return JSON.parse(readFileSync(`${dir}/records/${name}`, "utf8"));
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once("exit", (code) => resolve(code));
  });
}

function startGateDriver(dir: string, mode: RunnerMode, deadlineMs: number) {
  return spawn(process.execPath, [
    DRIVER,
    dir,
    mode,
    String(deadlineMs),
  ], { env: childEnv(), stdio: "ignore" });
}

// Waits until every pid in `pids` is gone, and fails naming each survivor by
// pid and command line when one is still running after `timeoutMs`.
async function allGone(pids: readonly number[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const survivors = live().filter((row) => pids.includes(row.pid));
    if (survivors.length === 0) return;
    if (Date.now() > deadline) {
      assert.fail(
        `${survivors.length} lane process(es) survived ${timeoutMs} ms:\n` +
          survivors.map((row) => `  ${row.pid} ${row.command.slice(0, 160)}`)
            .join("\n"),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function withDir(
  run: (dir: string, tokens: Set<string>) => Promise<void>,
): Promise<void> {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "dyfj-lane-supervision-")),
  );
  const tokens = new Set<string>();
  try {
    await run(dir, tokens);
  } finally {
    // Cleanup that holds when an assertion failed mid-test: the grandchild
    // and second step, every process whose command line names this test's
    // directory (the gate driver, the stand-in runner and its child), and the
    // carrier of every token the test used or a record names.
    for (const file of ["grandchild.pid", "second-step.pid"]) {
      const pid = readText(`${dir}/${file}`);
      if (pid !== undefined) sh(`kill -9 ${Number(pid)} 2>/dev/null || true`);
    }
    try {
      for (const entry of readdirSync(`${dir}/records`)) {
        tokens.add(entry.replace(/\.json(\.partial)?$/, ""));
      }
    } catch {
      // No records.
    }
    const markers = [dir, ...[...tokens].map(laneTokenArgument)];
    for (const row of processes()) {
      if (
        markers.some((marker) => row.command.includes(marker)) &&
        row.pid !== process.pid
      ) {
        sh(`kill -9 ${row.pid} 2>/dev/null || true`);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

type RunnerMode = "exit" | "hang" | "stall" | "second-step";

function runnerArgs(mode: RunnerMode, dir: string): string[] {
  return [RUNNER, mode, dir];
}

// The supervision a gate hands its lane runner, with this process as the
// runner's expected parent, as the gate is for a real lane.
function supervisionEnv(
  supervision: { deadlineMs: number; backstopMs: number; token: string },
  parentPid = process.pid,
): Record<string, string> {
  return {
    [LANE_DEADLINE_ENV]: String(supervision.deadlineMs),
    [LANE_BACKSTOP_ENV]: String(supervision.backstopMs),
    [LANE_TOKEN_ENV]: supervision.token,
    [LANE_PARENT_ENV]: String(parentPid),
  };
}

function startRunner(
  mode: RunnerMode,
  dir: string,
  supervision: { deadlineMs: number; backstopMs: number; token: string },
  { path = process.env.PATH ?? "" } = {},
): ChildProcess {
  return spawn("node", runnerArgs(mode, dir), {
    env: { ...childEnv(), PATH: path, ...supervisionEnv(supervision) },
    // Its own group, as the gate starts a lane.
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

test("a lane past its deadline fails and leaves no same-group survivor", {
  skip,
}, async () => {
  await withDir(async (dir) => {
    const code = await runGate({
      lanes: [{
        label: "Stand-in test lane",
        command: "node",
        args: runnerArgs("hang", dir),
        deadlineMs: 1_500,
      }],
      laneRecordDir: `${dir}/records`,
      out: quiet,
    });
    assert.equal(code, LANE_DEADLINE_EXIT_CODE, "deadline exit code");
    const pid = await grandchildPid(dir);
    assert.ok(!alive(pid), "the grandchild survived the deadline");
    assert.deepEqual(readdirSync(`${dir}/records`), [], "a record was left");
  });
});

// The lane's processes once it is fully set up: every member of its group
// (the runner, its carrier, its child and the grandchild), the carrier found
// by its token, and anything else naming the test's directory but the gate.
async function laneProcesses(
  dir: string,
  gate: ChildProcess,
): Promise<{ record: LaneRecord; grandchild: number; pids: number[] }> {
  const grandchild = await grandchildPid(dir);
  const record = await laneRecord(dir);
  await waitFor(
    () => tokenCarriers(record.token).length === 1 ? true : undefined,
    5_000,
    "the token carrier",
  );
  const pids = new Set([
    ...liveGroupMembers(record.group),
    ...tokenCarriers(record.token),
    ...live().filter((row) => row.command.includes(dir)).map((row) => row.pid),
  ]);
  pids.delete(gate.pid!);
  assert.ok(pids.has(record.group), "the runner should be running");
  assert.ok(pids.has(grandchild), "the grandchild should be running");
  return { record, grandchild, pids: [...pids] };
}

test("a SIGKILLed gate leaves no lane helper or lane process running", {
  skip,
}, async () => {
  await withDir(async (dir) => {
    // A deadline, and so a backstop, far past the bound below: only the
    // helpers' own exit can end the lane in time.
    const gate = startGateDriver(dir, "hang", 120_000);
    const { pids } = await laneProcesses(dir, gate);
    gate.kill("SIGKILL");
    await exited(gate);
    await allGone(pids, 10_000);
  });
});

for (const mode of ["hang", "second-step"] as const) {
  test(
    `with the gate and its runner SIGKILLed in the ${mode} step, the carrier stops the lane group`,
    {
      skip,
    },
    async () => {
      await withDir(async (dir) => {
        const gate = startGateDriver(dir, mode, 120_000);
        const lane = await laneProcesses(dir, gate);
        const pids = [...lane.pids];
        if (mode === "second-step") {
          const step = Number(
            await waitFor(
              () => readText(`${dir}/second-step.pid`),
              10_000,
              "the second step",
            ),
          );
          // A step started after the lane was set up, with no token of its own.
          pids.push(step);
        }
        // The double crash: gate and runner both killed outright.
        gate.kill("SIGKILL");
        await exited(gate);
        sh(`kill -9 ${lane.record.group} 2>/dev/null || true`);
        await allGone(pids, 10_000);
        assert.deepEqual(liveGroupMembers(lane.record.group), []);
      });
    },
  );
}

test("a gate killed between its teardown's TERM and KILL leaves no survivor", {
  skip,
}, async () => {
  await withDir(async (dir) => {
    // Long enough that the lane is fully set up, carrier included, before
    // its TERM: a TERM during setup can end the group outright.
    const gate = startGateDriver(dir, "hang", 6_000);
    const { record, pids } = await laneProcesses(dir, gate);
    // The carrier has time to install its TERM handler, well before the
    // deadline.
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Past the deadline the gate TERMs the group: the runner exits, and the
    // gate waits out its grace for the grandchild, which ignores TERM.
    await waitFor(
      () => alive(record.group) ? undefined : true,
      15_000,
      "the deadline's TERM to end the runner",
    );
    assert.equal(gate.exitCode, null, "the gate exited before its KILL");
    gate.kill("SIGKILL");
    await exited(gate);
    await allGone(pids, 10_000);
  });
});

// A lane group as a gate and a runner killed outright would leave it if its
// carrier had not stopped it: the group's leader holds the token on its
// command line and ignores TERM, and a same-group `sleep` ignores TERM too.
// The record names a gate pid that is no longer running.
async function orphanedGroup(
  dir: string,
): Promise<{ record: LaneRecord; pids: number[] }> {
  const token = randomUUID();
  const program = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
const sleeper = spawn("/bin/bash", ["-c", "trap '' TERM; exec sleep 60"], {
  stdio: "ignore",
});
writeFileSync(process.argv[1] + "/second-step.pid", String(sleeper.pid));
setInterval(() => {}, 1000);
`;
  const leader = spawn(
    "node",
    ["--input-type=module", "-e", program, dir, laneTokenArgument(token)],
    { detached: true, stdio: "ignore", env: childEnv() },
  );
  leader.unref();
  const sleeper = Number(
    await waitFor(
      () => readText(`${dir}/second-step.pid`),
      10_000,
      "the orphaned group's sleeper",
    ),
  );
  const gone = spawn("node", ["-e", ""], { env: childEnv(), stdio: "ignore" });
  await exited(gone);
  const record = { gatePid: gone.pid!, group: leader.pid!, token };
  mkdirSync(`${dir}/records`, { recursive: true });
  writeFileSync(`${dir}/records/${token}.json`, JSON.stringify(record));
  return { record, pids: [leader.pid!, sleeper] };
}

for (const partial of [false, true]) {
  test(
    partial
      ? "a complete record still under its partial name is recovered"
      : "a later gate run stops an orphaned lane group that still holds its token",
    { skip },
    async () => {
      await withDir(async (dir) => {
        const { record, pids } = await orphanedGroup(dir);
        if (partial) {
          // As if the gate had been killed between writing and renaming it.
          renameSync(
            `${dir}/records/${record.token}.json`,
            `${dir}/records/${record.token}.json.partial`,
          );
        }
        // The token trails a command line wider than a terminal's default
        // 80 columns, which a truncating `ps` would cut off.
        const holder = processes().find((row) =>
          row.command.includes(laneTokenArgument(record.token))
        );
        assert.ok(
          holder !== undefined &&
            holder.command.indexOf(laneTokenArgument(record.token)) > 80,
          "the lane token should sit past column 80",
        );
        for (const pid of pids) assert.ok(alive(pid), `${pid} should be up`);

        await recoverOrphanedLaneGroups(`${dir}/records`, quiet);

        await waitFor(
          () => liveGroupMembers(record.group).length === 0 ? true : undefined,
          5_000,
          "the orphaned group to be stopped",
        );
        for (const pid of pids) assert.ok(!alive(pid), `${pid} survived`);
        assert.deepEqual(readdirSync(`${dir}/records`), []);
      });
    },
  );
}

test("with no gate, the runner's backstop ends a hang and stops its group", {
  skip,
}, async () => {
  await withDir(async (dir, tokens) => {
    const token = randomUUID();
    tokens.add(token);
    const runner = startRunner("hang", dir, {
      deadlineMs: 500,
      backstopMs: 1500,
      token,
    });
    const pid = await grandchildPid(dir);
    assert.equal(await exited(runner), 1, "backstop exit code");
    assert.equal(
      readText(`${dir}/runner.done`),
      "backstop",
      "the runner did not report its backstop",
    );
    await waitFor(
      () => alive(pid) ? undefined : true,
      5_000,
      "the grandchild to be stopped",
    );
    assert.deepEqual(tokenCarriers(token), [], "the carrier survived");
  });
});

test("a runner stalled past its backstop still stops its group and exits", {
  skip,
}, async () => {
  await withDir(async (dir, tokens) => {
    const token = randomUUID();
    tokens.add(token);
    const runner = startRunner("stall", dir, {
      deadlineMs: 2000,
      backstopMs: 3000,
      token,
    });
    const pid = await grandchildPid(dir);
    assert.equal(await exited(runner), 1, "stalled runner exit code");
    assert.equal(
      readText(`${dir}/runner.done`),
      undefined,
      "a stalled runner should not reach its normal exit",
    );
    await waitFor(
      () => alive(pid) ? undefined : true,
      5_000,
      "the grandchild to be stopped",
    );
    assert.deepEqual(tokenCarriers(token), [], "the carrier survived");
  });
});

test(
  "a record whose group no longer carries its lane token is dropped unsignalled",
  {
    skip,
  },
  async () => {
    await withDir(async (dir) => {
      // A live group that is not the recorded lane: same numeric group, no token.
      const bystander = spawn("node", ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        env: childEnv(),
        stdio: "ignore",
      });
      try {
        // A gate pid that is no longer running.
        const gone = spawn("node", ["-e", ""], {
          env: childEnv(),
          stdio: "ignore",
        });
        await exited(gone);
        const token = randomUUID();
        mkdirSync(`${dir}/records`);
        writeFileSync(
          `${dir}/records/${token}.json`,
          JSON.stringify({ gatePid: gone.pid, group: bystander.pid, token }),
        );
        assert.deepEqual(tokenCarriers(token), [], "no process carries it");

        await recoverOrphanedLaneGroups(`${dir}/records`, quiet);

        assert.ok(alive(bystander.pid!), "a bystander group was signalled");
        assert.deepEqual(readdirSync(`${dir}/records`), []);
      } finally {
        bystander.kill("SIGKILL");
        await exited(bystander);
      }
    });
  },
);

test(
  "recovery leaves a record still being written alone",
  { skip },
  async () => {
    await withDir(async (dir) => {
      // A concurrent gate's record mid-write: empty, under its partial name.
      mkdirSync(`${dir}/records`);
      const partial = `${dir}/records/${randomUUID()}.json.partial`;
      writeFileSync(partial, "");

      await recoverOrphanedLaneGroups(`${dir}/records`, quiet);

      assert.equal(readText(partial), undefined);
      assert.ok(statSync(partial).isFile(), "the partial record was removed");
    });
  },
);

// Waits until the group has no live member, then checks it stays empty: a
// helper that is about to start a step must not repopulate it.
async function groupEmpties(group: number, timeoutMs: number) {
  await waitFor(
    () => liveGroupMembers(group).length === 0 ? true : undefined,
    timeoutMs,
    `lane group ${group} to empty`,
  ).catch(() => {
    assert.fail(
      `lane group ${group} still has live members after ${timeoutMs} ms:\n` +
        live().filter((row) => row.group === group)
          .map((row) => `  ${row.pid} ${row.command.slice(0, 160)}`)
          .join("\n"),
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.deepEqual(liveGroupMembers(group), [], "the group was repopulated");
}

test("a runner whose gate exited before the runner started stops its lane", {
  skip,
}, async () => {
  await withDir(async (dir, tokens) => {
    const token = randomUUID();
    tokens.add(token);
    // A stand-in gate that starts the lane runner in a group of its own and
    // exits at once, before the runner has loaded anything.
    const launcher = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [runner, dir, env] = process.argv.slice(1);
const child = spawn("node", [runner, "hang", dir], {
  detached: true,
  stdio: "ignore",
  env: { ...JSON.parse(env), ${
      JSON.stringify(LANE_PARENT_ENV)
    }: String(process.pid) },
});
writeFileSync(dir + "/runner.pid", String(child.pid));
process.exit(0);
`;
    const gate = spawn("node", [
      "--input-type=module",
      "-e",
      launcher,
      RUNNER,
      dir,
      JSON.stringify({
        ...childEnv(),
        ...supervisionEnv({ deadlineMs: 120_000, backstopMs: 180_000, token }),
      }),
    ], { env: childEnv(), stdio: "ignore" });
    await exited(gate);
    const runner = Number(
      await waitFor(() => readText(`${dir}/runner.pid`), 5_000, "the runner"),
    );
    await groupEmpties(runner, 10_000);
    assert.deepEqual(tokenCarriers(token), [], "the carrier survived");
  });
});

test(
  "a carrier whose runner exited before the carrier started stops the lane group",
  {
    skip,
  },
  async () => {
    await withDir(async (dir, tokens) => {
      const token = randomUUID();
      tokens.add(token);
      // A stand-in runner, leading a group of its own, that leaves a
      // TERM-ignoring member in it, starts its carrier and exits at once,
      // before the carrier has loaded anything.
      const runnerProgram = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { startTokenCarrier } from ${JSON.stringify(SUPERVISION_URL)};
const [dir, token] = process.argv.slice(1);
const sleeper = spawn("/bin/bash", ["-c", "trap '' TERM; exec sleep 60"], {
  stdio: "ignore",
});
writeFileSync(dir + "/second-step.pid", String(sleeper.pid));
startTokenCarrier({
  deadlineMs: 120000, backstopMs: 180000, token, parentPid: process.ppid,
});
process.exit(0);
`;
      const runner = spawn(
        "node",
        ["--input-type=module", "-e", runnerProgram, dir, token],
        { detached: true, env: childEnv(), stdio: "ignore" },
      );
      await exited(runner);
      await groupEmpties(runner.pid!, 10_000);
      assert.deepEqual(tokenCarriers(token), [], "the carrier survived");
    });
  },
);

// --- Lane supervision without `ps` (BIT-806) ------------------------------
//
// Inside the srt sandbox on macOS the setuid `ps` is refused, so the lane's
// process list is unavailable. These tests make that deterministic with a
// `ps` that fails and records that it was called, and observe liveness only
// with `kill(-group, 0)`, which needs no `ps`.

// Whether any process is left in `group`.
function groupExists(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function groupGone(group: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(group)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

// A directory holding a `ps` that fails and notes each call in `<dir>/ps-called`;
// returns a PATH with it first.
function failingPsPath(dir: string): string {
  mkdirSync(`${dir}/shim`);
  writeFileSync(
    `${dir}/shim/ps`,
    `#!/bin/sh\necho called >> "${dir}/ps-called"\nexit 1\n`,
    { mode: 0o755 },
  );
  return `${dir}/shim:${process.env.PATH ?? ""}`;
}

function psWasCalled(dir: string): boolean {
  return readText(`${dir}/ps-called`) !== undefined;
}

// Runs `run` with this process's PATH replaced, as the gate takes the PATH it
// hands a lane from its own environment.
async function withPath(path: string, run: () => Promise<void>): Promise<void> {
  const prior = process.env.PATH;
  process.env.PATH = path;
  try {
    await run();
  } finally {
    if (prior === undefined) delete process.env.PATH;
    else process.env.PATH = prior;
  }
}

test(
  "the gate's group teardown kills a lane's grandchild with no ps",
  { skip },
  async () => {
    await withDir(async (dir) => {
      // The leader leaves a TERM-ignoring grandchild in its group and exits
      // at once, so only the gate's teardown can end the group.
      const leader = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [dir] = process.argv.slice(1);
const child = spawn("/bin/bash", ["-c", "trap '' TERM; exec sleep 60"], {
  stdio: "ignore",
});
writeFileSync(dir + "/grandchild.pid", String(child.pid));
writeFileSync(dir + "/leader.pid", String(process.pid));
process.exit(0);
`;
      let code = -1;
      await withPath(failingPsPath(dir), async () => {
        code = await runGate({
          lanes: [{
            label: "Stand-in lane that leaves a grandchild",
            command: "node",
            args: ["--input-type=module", "-e", leader, dir],
          }],
          out: quiet,
        });
      });
      assert.equal(code, 0, "the lane's own result is unchanged");
      const group = Number(readText(`${dir}/leader.pid`));
      const grandchild = Number(readText(`${dir}/grandchild.pid`));
      assert.ok(group > 1 && grandchild > 1, "the lane recorded its pids");
      assert.ok(await groupGone(group, 5_000), "the lane group is not empty");
      assert.throws(() => process.kill(grandchild, 0), "the grandchild survived");
      assert.ok(!psWasCalled(dir), "the gate's teardown called ps");
    });
  },
);

// A stand-in runner that leaves a TERM-ignoring member in its group, stops
// its own group and, if it is still there, exits 7. `parent` is the gate pid
// it was told to expect.
const GROUP_STOP_RUNNER = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { stopOwnGroup } from ${JSON.stringify(SUPERVISION_URL)};
const [dir, token, parent] = process.argv.slice(1);
const sleeper = spawn("/bin/bash", ["-c", "trap '' TERM; exec sleep 60"], {
  stdio: "ignore",
});
writeFileSync(dir + "/grandchild.pid", String(sleeper.pid));
await stopOwnGroup({
  deadlineMs: 120000, backstopMs: 180000, token, parentPid: Number(parent),
});
process.exit(7);
`;

function startGroupStopRunner(
  dir: string,
  token: string,
  parent: number,
): { runner: ChildProcess; stderr: () => string } {
  const runner = spawn(
    "node",
    ["--input-type=module", "-e", GROUP_STOP_RUNNER, dir, token, String(parent)],
    {
      env: { ...childEnv(), PATH: failingPsPath(dir) },
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  runner.stderr!.setEncoding("utf8");
  runner.stderr!.on("data", (chunk: string) => (stderr += chunk));
  return { runner, stderr: () => stderr };
}

function exitedWith(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

test(
  "a group stop that cannot list processes leaves the group to a gate that is still there",
  { skip },
  async () => {
    await withDir(async (dir) => {
      // The runner's parent is the gate it expects (this process).
      const { runner, stderr } = startGroupStopRunner(
        dir,
        randomUUID(),
        process.pid,
      );
      try {
        const { code, signal } = await exitedWith(runner);
        assert.equal(signal, null, "the runner was killed by its own stop");
        assert.equal(code, 7, "the runner kept its own exit code");
        assert.doesNotMatch(stderr(), /killing the whole lane group/);
        // The gate's teardown, not the runner, ends what is left.
        assert.ok(groupExists(runner.pid!), "the stop killed the group");
      } finally {
        try {
          process.kill(-runner.pid!, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    });
  },
);

test(
  "a group stop that cannot list processes kills the whole group when its gate is gone",
  { skip },
  async () => {
    await withDir(async (dir) => {
      // Pid 2 is not the runner's parent, as for a gate that has died.
      const { runner, stderr } = startGroupStopRunner(dir, randomUUID(), 2);
      await exitedWith(runner);
      assert.ok(await groupGone(runner.pid!, 10_000), "the group survived");
      assert.match(stderr(), /could not list the lane's processes/);
    });
  },
);

test(
  "a gate lane whose runner cannot list processes keeps its exit code and leaves no group",
  { skip },
  async () => {
    await withDir(async (dir) => {
      let code = -1;
      let group = 0;
      await withPath(failingPsPath(dir), async () => {
        const gate = runGate({
          lanes: [{
            label: "Stand-in test lane",
            command: "node",
            args: runnerArgs("exit", dir),
            deadlineMs: 60_000,
          }],
          laneRecordDir: `${dir}/records`,
          out: quiet,
        });
        await grandchildPid(dir);
        group = (await laneRecord(dir)).group;
        writeFileSync(`${dir}/release`, "");
        code = await gate;
      });
      assert.equal(code, 0, "the runner's exit code was replaced");
      assert.ok(await groupGone(group, 10_000), "the lane group survived");
    });
  },
);
