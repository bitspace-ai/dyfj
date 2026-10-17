// Runs the aggregate gate over one supervised stand-in lane
// (`lane-runner.fixture.ts`, under `node`), as its own process, so the
// supervision tests can SIGKILL the gate mid-lane. Lane records go to
// `<dir>/records`.
//
// Usage: gate-driver.fixture.ts <dir> <exit|hang|second-step> <deadline-ms>
import { runGate } from "./aggregate-test-gate.ts";
import { fileURLToPath } from "node:url";

const [dir, mode, deadline] = Deno.args;
const runner = fileURLToPath(
  new URL("./lane-runner.fixture.ts", import.meta.url),
);
const code = await runGate({
  lanes: [{
    label: "Stand-in test lane",
    command: "node",
    args: [runner, mode!, dir!],
    deadlineMs: Number(deadline),
  }],
  laneRecordDir: `${dir}/records`,
});
Deno.exit(code);
