// Test-lane supervision against real process groups
// (`specs/notes/test-supervision-evidence.md`): the gate's per-lane deadline,
// the runner's end-of-run group stop and backstop, and the gate's recovery of
// a lane group left behind when the gate and its runner were both killed.
// The lanes are stand-ins (`lane-runner.fixture.ts`) whose child leaves a
// same-group `sleep` grandchild that ignores TERM, the leak class each
// mechanism must clean up.
import {
  LANE_BACKSTOP_ENV,
  LANE_DEADLINE_ENV,
  LANE_TOKEN_ENV,
  laneTokenArgument,
} from "../prototype/scripts/lane-supervision.ts";
import {
  LANE_DEADLINE_EXIT_CODE,
  recoverOrphanedLaneGroups,
  runGate,
} from "./aggregate-test-gate.ts";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(
  new URL("./lane-runner.fixture.ts", import.meta.url),
);
const DRIVER = fileURLToPath(
  new URL("./gate-driver.fixture.ts", import.meta.url),
);
const quiet = { log: () => {}, error: () => {} };
const posix = Deno.build.os !== "windows";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function sh(script: string): Promise<string> {
  const output = await new Deno.Command("/bin/bash", {
    args: ["-c", script],
    stdout: "piped",
    stderr: "null",
  }).output();
  return new TextDecoder().decode(output.stdout).trim();
}

// A zombie counts as gone: in a container whose init does not reap orphans, a
// killed process can linger as one.
async function alive(pid: number): Promise<boolean> {
  const state = await sh(`ps -o stat= -p ${pid} || true`);
  return state !== "" && !state.startsWith("Z");
}

async function liveGroupMembers(group: number): Promise<number[]> {
  const lines = await sh(`ps -A -o pid=,pgid=,stat= || true`);
  return lines.split("\n").flatMap((line) => {
    const [pid, pgid, stat] = line.trim().split(/\s+/);
    return Number(pgid) === group && !stat?.startsWith("Z")
      ? [Number(pid)]
      : [];
  });
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function readFile(path: string): Promise<string | undefined> {
  try {
    const text = (await Deno.readTextFile(path)).trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

async function grandchildPid(dir: string): Promise<number> {
  return Number(
    await waitFor(
      () => readFile(`${dir}/grandchild.pid`),
      10_000,
      "grandchild",
    ),
  );
}

// Live processes whose command line carries `token`: the lane's carrier.
async function tokenCarriers(token: string): Promise<number[]> {
  const lines = await sh("ps -A -ww -o pid=,stat=,command= || true");
  return lines.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    return match && !match[2].startsWith("Z") &&
        match[3].includes(laneTokenArgument(token))
      ? [Number(match[1])]
      : [];
  });
}

// The token of the one lane record left in `<dir>/records`.
async function recordedToken(dir: string): Promise<string> {
  const name = await waitFor(
    async () => {
      try {
        return (await Array.fromAsync(Deno.readDir(`${dir}/records`)))[0]
          ?.name;
      } catch {
        return undefined;
      }
    },
    5_000,
    "the lane record",
  );
  return JSON.parse(await Deno.readTextFile(`${dir}/records/${name}`)).token;
}

async function withDir(
  run: (dir: string, tokens: Set<string>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "dyfj-lane-supervision-" }),
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
      const pid = await readFile(`${dir}/${file}`);
      if (pid !== undefined) {
        await sh(`kill -9 ${Number(pid)} 2>/dev/null || true`);
      }
    }
    try {
      for (const entry of Deno.readDirSync(`${dir}/records`)) {
        tokens.add(entry.name.replace(/\.json(\.partial)?$/, ""));
      }
    } catch {
      // No records.
    }
    const markers = [dir, ...[...tokens].map(laneTokenArgument)];
    for (const line of (await sh("ps -A -ww -o pid=,command=")).split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      if (
        match && markers.some((marker) => match[2].includes(marker)) &&
        Number(match[1]) !== Deno.pid
      ) {
        await sh(`kill -9 ${Number(match[1])} 2>/dev/null || true`);
      }
    }
    await Deno.remove(dir, { recursive: true });
  }
}

type RunnerMode = "exit" | "hang" | "stall" | "second-step";

function runnerArgs(mode: RunnerMode, dir: string): string[] {
  return [
    "run",
    "--allow-env",
    "--allow-read",
    `--allow-write=${dir}`,
    "--allow-run",
    RUNNER,
    mode,
    dir,
  ];
}

Deno.test({
  name: "a lane past its deadline fails and leaves no same-group survivor",
  ignore: !posix,
  async fn() {
    await withDir(async (dir) => {
      const code = await runGate({
        lanes: [{
          label: "Stand-in test lane",
          command: Deno.execPath(),
          commandLabel: "deno",
          args: runnerArgs("hang", dir),
          deadlineMs: 1_500,
        }],
        laneRecordDir: `${dir}/records`,
        out: quiet,
      });
      assert(code === LANE_DEADLINE_EXIT_CODE, `deadline exit code: ${code}`);
      const pid = await grandchildPid(dir);
      assert(!(await alive(pid)), "the grandchild survived the deadline");
      const records = [...Deno.readDirSync(`${dir}/records`)];
      assert(records.length === 0, "the lane record was left behind");
    });
  },
});

Deno.test({
  name:
    "with the gate SIGKILLed, the runner stops its own group once its work is done",
  ignore: !posix,
  async fn() {
    await withDir(async (dir) => {
      const gate = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-env",
          "--allow-read",
          "--allow-write",
          "--allow-run",
          DRIVER,
          dir,
          "exit",
          "60000",
        ],
        stdout: "null",
        stderr: "null",
      }).spawn();
      const pid = await grandchildPid(dir);
      gate.kill("SIGKILL");
      await gate.status;
      assert(await alive(pid), "the grandchild should outlive the gate");
      // Only now may the lane's test finish.
      await Deno.writeTextFile(`${dir}/release`, "");
      const done = await waitFor(
        () => readFile(`${dir}/runner.done`),
        15_000,
        "the runner",
      );
      assert(done === "ok", `runner outcome: ${done}`);
      await waitFor(
        async () => (await alive(pid)) ? undefined : true,
        5_000,
        "the grandchild to be stopped",
      );
      const token = await recordedToken(dir);
      assert(
        (await tokenCarriers(token)).length === 0,
        "the token carrier survived the group stop",
      );
    });
  },
});

Deno.test({
  name: "with no gate, the runner's backstop ends a hang and stops its group",
  ignore: !posix,
  async fn() {
    await withDir(async (dir, tokens) => {
      const token = crypto.randomUUID();
      tokens.add(token);
      const runner = new Deno.Command(Deno.execPath(), {
        args: runnerArgs("hang", dir),
        env: {
          [LANE_DEADLINE_ENV]: "500",
          [LANE_BACKSTOP_ENV]: "1500",
          [LANE_TOKEN_ENV]: token,
        },
        // Its own group, as the gate starts a lane.
        detached: true,
        stdout: "null",
        stderr: "null",
      }).spawn();
      const pid = await grandchildPid(dir);
      const status = await runner.status;
      assert(status.code === 1, `backstop exit code: ${status.code}`);
      assert(
        (await readFile(`${dir}/runner.done`)) === "backstop",
        "the runner did not report its backstop",
      );
      await waitFor(
        async () => (await alive(pid)) ? undefined : true,
        5_000,
        "the grandchild to be stopped",
      );
      assert(
        (await tokenCarriers(token)).length === 0,
        "the token carrier survived the group stop",
      );
    });
  },
});

// Runs the gate driver over a supervised stand-in lane, waits for `ready`
// (the pids the test expects to be stopped), SIGKILLs the gate and the runner,
// then runs a later gate's recovery and checks the orphaned group is gone.
async function doubleCrashIsRecovered(
  dir: string,
  mode: RunnerMode,
  ready: () => Promise<number[]>,
  { recordLeftPartial = false } = {},
): Promise<void> {
  const gate = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      DRIVER,
      dir,
      mode,
      "60000",
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();
  const pids = await ready();
  const token = await recordedToken(dir);
  const record = JSON.parse(
    await Deno.readTextFile(`${dir}/records/${token}.json`),
  );
  // The double crash: gate and runner both killed outright.
  gate.kill("SIGKILL");
  await gate.status;
  await sh(`kill -9 ${Number(record.group)} 2>/dev/null || true`);
  if (recordLeftPartial) {
    // As if the gate had been killed between writing and renaming it.
    await Deno.rename(
      `${dir}/records/${token}.json`,
      `${dir}/records/${token}.json.partial`,
    );
  }
  for (const pid of pids) {
    assert(await alive(pid), `${pid} should outlive the gate and runner`);
  }
  assert(
    (await liveGroupMembers(record.group)).length > 0,
    "the orphaned group should still have members",
  );
  // The carrier's token trails a command line wider than a terminal's
  // default 80 columns, which a truncating `ps` would cut off.
  const carrier = (await sh("ps -A -ww -o command=")).split("\n")
    .find((line) => line.includes(laneTokenArgument(token)));
  assert(
    carrier !== undefined && carrier.indexOf(laneTokenArgument(token)) > 80,
    "the lane token should sit past column 80",
  );

  await recoverOrphanedLaneGroups(`${dir}/records`, quiet);

  await waitFor(
    async () =>
      (await liveGroupMembers(record.group)).length === 0 ? true : undefined,
    5_000,
    "the orphaned group to be stopped",
  );
  for (const pid of pids) {
    assert(!(await alive(pid)), `${pid} survived recovery`);
  }
  assert(
    [...Deno.readDirSync(`${dir}/records`)].length === 0,
    "the record was not dropped",
  );
}

Deno.test({
  name:
    "a later gate run stops a lane group whose gate and runner were both killed",
  ignore: !posix,
  async fn() {
    await withDir((dir) =>
      doubleCrashIsRecovered(dir, "hang", async () => [
        await grandchildPid(dir),
      ])
    );
  },
});

Deno.test({
  name:
    "a gate killed between its teardown's TERM and KILL leaves a recoverable group",
  ignore: !posix,
  async fn() {
    await withDir(async (dir) => {
      const gate = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-env",
          "--allow-read",
          "--allow-write",
          "--allow-run",
          DRIVER,
          dir,
          "hang",
          // Long enough that the lane is fully set up, carrier included,
          // before its TERM: a TERM during setup can end the group outright.
          "6000",
        ],
        stdout: "null",
        stderr: "null",
      }).spawn();
      const pid = await grandchildPid(dir);
      const token = await recordedToken(dir);
      const record = JSON.parse(
        await Deno.readTextFile(`${dir}/records/${token}.json`),
      );
      // The carrier is up, with time to install its TERM handler, well
      // before the deadline.
      await waitFor(
        async () =>
          (await tokenCarriers(token)).length === 1 ? true : undefined,
        4_000,
        "the token carrier",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Past the deadline the gate TERMs the group: the runner exits, and the
      // gate waits out its grace for the grandchild, which ignores TERM.
      await waitFor(
        async () => (await alive(record.group)) ? undefined : true,
        15_000,
        "the deadline's TERM to end the runner",
      );
      try {
        gate.kill("SIGKILL");
      } catch {
        const { code } = await gate.status;
        throw new Error(
          `the gate had already exited (code ${code}) before its KILL`,
        );
      }
      await gate.status;
      assert(await alive(pid), "the grandchild should outlive the gate");
      assert(
        (await tokenCarriers(token)).length === 1,
        "the token carrier should still hold the token",
      );

      await recoverOrphanedLaneGroups(`${dir}/records`, quiet);

      await waitFor(
        async () =>
          (await liveGroupMembers(record.group)).length === 0
            ? true
            : undefined,
        5_000,
        "the orphaned group to be stopped",
      );
      assert(!(await alive(pid)), "the grandchild survived recovery");
    });
  },
});

Deno.test({
  name: "a complete record still under its partial name is recovered",
  ignore: !posix,
  async fn() {
    await withDir((dir) =>
      doubleCrashIsRecovered(
        dir,
        "hang",
        async () => [await grandchildPid(dir)],
        { recordLeftPartial: true },
      )
    );
  },
});

Deno.test({
  name:
    "recovery also stops a lane killed in a later step that carries no token",
  ignore: !posix,
  async fn() {
    await withDir((dir) =>
      doubleCrashIsRecovered(dir, "second-step", async () => [
        await grandchildPid(dir),
        Number(
          await waitFor(
            () => readFile(`${dir}/second-step.pid`),
            10_000,
            "the second step",
          ),
        ),
      ])
    );
  },
});

Deno.test({
  name: "a runner stalled past its backstop still stops its group and exits",
  ignore: !posix,
  async fn() {
    await withDir(async (dir, tokens) => {
      const token = crypto.randomUUID();
      tokens.add(token);
      const runner = new Deno.Command(Deno.execPath(), {
        args: runnerArgs("stall", dir),
        env: {
          [LANE_DEADLINE_ENV]: "2000",
          [LANE_BACKSTOP_ENV]: "3000",
          [LANE_TOKEN_ENV]: token,
        },
        detached: true,
        stdout: "null",
        stderr: "null",
      }).spawn();
      const pid = await grandchildPid(dir);
      const status = await runner.status;
      assert(status.code === 1, `stalled runner exit code: ${status.code}`);
      assert(
        (await readFile(`${dir}/runner.done`)) === undefined,
        "a stalled runner should not reach its normal exit",
      );
      await waitFor(
        async () => (await alive(pid)) ? undefined : true,
        5_000,
        "the grandchild to be stopped",
      );
      assert(
        (await tokenCarriers(token)).length === 0,
        "the token carrier survived the group stop",
      );
    });
  },
});

Deno.test({
  name:
    "a record whose group no longer carries its lane token is dropped unsignalled",
  ignore: !posix,
  async fn() {
    await withDir(async (dir) => {
      // A live group that is not the recorded lane: same numeric group, no token.
      const bystander = new Deno.Command(Deno.execPath(), {
        args: ["eval", "setInterval(() => {}, 1000)"],
        detached: true,
        stdout: "null",
        stderr: "null",
      }).spawn();
      try {
        // A gate pid that is no longer running.
        const exited = new Deno.Command(Deno.execPath(), {
          args: ["eval", ""],
        }).spawn();
        await exited.status;
        const token = crypto.randomUUID();
        await Deno.mkdir(`${dir}/records`);
        await Deno.writeTextFile(
          `${dir}/records/${token}.json`,
          JSON.stringify({ gatePid: exited.pid, group: bystander.pid, token }),
        );
        assert(
          !(await sh(`ps -A -ww -o command=`)).includes(
            laneTokenArgument(token),
          ),
          "no process should carry the token",
        );

        await recoverOrphanedLaneGroups(`${dir}/records`, quiet);

        assert(await alive(bystander.pid), "a bystander group was signalled");
        assert(
          [...Deno.readDirSync(`${dir}/records`)].length === 0,
          "the stale record was not dropped",
        );
      } finally {
        bystander.kill("SIGKILL");
        await bystander.status;
      }
    });
  },
});

Deno.test({
  name: "recovery leaves a record still being written alone",
  ignore: !posix,
  async fn() {
    await withDir(async (dir) => {
      // A concurrent gate's record mid-write: empty, under its partial name.
      await Deno.mkdir(`${dir}/records`);
      const partial = `${dir}/records/${crypto.randomUUID()}.json.partial`;
      await Deno.writeTextFile(partial, "");

      await recoverOrphanedLaneGroups(`${dir}/records`, quiet);

      assert(
        (await readFile(partial)) === undefined &&
          (await Deno.stat(partial)).isFile,
        "a partial record should be left in place",
      );
    });
  },
});
