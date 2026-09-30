// Test-lane supervision against real process groups
// (`specs/notes/test-supervision-evidence.md`): the gate's per-lane deadline,
// the runner's end-of-run group stop and backstop, and the gate's recovery of
// a lane group left behind when the gate and its runner were both killed.
// The lanes are stand-ins (`lane-runner.fixture.ts`) whose child leaves a
// same-group `sleep` grandchild, the leak class each mechanism must clean up.
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

const RUNNER = new URL("./lane-runner.fixture.ts", import.meta.url).pathname;
const DRIVER = new URL("./gate-driver.fixture.ts", import.meta.url).pathname;
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

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "dyfj-lane-supervision-" }),
  );
  try {
    await run(dir);
  } finally {
    // Cleanup that holds when an assertion failed mid-test: the grandchild,
    // and every process whose command line names this test's directory (the
    // gate driver, the stand-in runner and its child).
    const pid = await readFile(`${dir}/grandchild.pid`);
    if (pid !== undefined) {
      await sh(`kill -9 ${Number(pid)} 2>/dev/null || true`);
    }
    for (const line of (await sh("ps -A -ww -o pid=,command=")).split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      if (match && match[2].includes(dir) && Number(match[1]) !== Deno.pid) {
        await sh(`kill -9 ${Number(match[1])} 2>/dev/null || true`);
      }
    }
    await Deno.remove(dir, { recursive: true });
  }
}

function runnerArgs(mode: "exit" | "hang", dir: string): string[] {
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
    });
  },
});

Deno.test({
  name: "with no gate, the runner's backstop ends a hang and stops its group",
  ignore: !posix,
  async fn() {
    await withDir(async (dir) => {
      const runner = new Deno.Command(Deno.execPath(), {
        args: runnerArgs("hang", dir),
        env: {
          [LANE_DEADLINE_ENV]: "500",
          [LANE_BACKSTOP_ENV]: "1500",
          [LANE_TOKEN_ENV]: crypto.randomUUID(),
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
    });
  },
});

Deno.test({
  name:
    "a later gate run stops a lane group whose gate and runner were both killed",
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
          "60000",
        ],
        stdout: "null",
        stderr: "null",
      }).spawn();
      const pid = await grandchildPid(dir);
      const recordName = await waitFor(
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
      const record = JSON.parse(
        await Deno.readTextFile(`${dir}/records/${recordName}`),
      );
      // The double crash: gate and runner both killed outright.
      gate.kill("SIGKILL");
      await gate.status;
      await sh(`kill -9 ${Number(record.group)} 2>/dev/null || true`);
      assert(await alive(pid), "the grandchild should outlive both");
      assert(
        (await liveGroupMembers(record.group)).length > 0,
        "the orphaned group should still hold the test child",
      );
      // The token trails a command line wider than a terminal's default 80
      // columns, which a truncating `ps` would cut off.
      const carrier = (await sh("ps -A -ww -o command=")).split("\n")
        .find((line) => line.includes(laneTokenArgument(record.token)));
      assert(
        carrier !== undefined &&
          carrier.indexOf(laneTokenArgument(record.token)) > 80,
        "the lane token should sit past column 80",
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
      assert(
        [...Deno.readDirSync(`${dir}/records`)].length === 0,
        "the record was not dropped",
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
