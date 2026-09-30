// Runs the aggregate gate over one supervised stand-in lane
// (`lane-runner.fixture.ts`), as its own process, so the supervision tests can
// SIGKILL the gate mid-lane. Lane records go to `<dir>/records`.
//
// Usage: gate-driver.fixture.ts <dir> <exit|hang> <deadline-ms>
import { runGate } from "./aggregate-test-gate.ts";

const [dir, mode, deadline] = Deno.args;
const runner = new URL("./lane-runner.fixture.ts", import.meta.url).pathname;
const code = await runGate({
  lanes: [{
    label: "Stand-in test lane",
    command: Deno.execPath(),
    commandLabel: "deno",
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      `--allow-write=${dir}`,
      "--allow-run",
      runner,
      mode!,
      dir!,
    ],
    deadlineMs: Number(deadline),
  }],
  laneRecordDir: `${dir}/records`,
});
Deno.exit(code);
