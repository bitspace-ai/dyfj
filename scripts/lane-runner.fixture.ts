// A stand-in test-lane runner for the gate's supervision tests
// (`lane-supervision.test.ts`). It runs one child the way the real runners run
// `deno test`: with the lane token on its command line and under the backstop,
// then stops its own process group. The child leaves a same-group `sleep`
// grandchild and writes its pid to `<dir>/grandchild.pid`, then exits after
// 1.5 s (`exit`) or never (`hang`). The runner writes `<dir>/runner.done`
// (`ok` or `backstop`) just before it exits.
//
// Usage: lane-runner.fixture.ts <exit|hang> <dir>
import {
  killChild,
  laneScriptArgs,
  laneSupervision,
  startBackstop,
  stopOwnGroup,
} from "../prototype/scripts/lane-supervision.ts";

const [mode, dir] = Deno.args;
if ((mode !== "exit" && mode !== "hang") || dir === undefined) {
  console.error("usage: lane-runner.fixture.ts <exit|hang> <dir>");
  Deno.exit(64);
}
const deno = Deno.execPath();
const supervision = laneSupervision();
const program = [
  `new Deno.Command("/bin/bash", { args: ["-c", ${
    JSON.stringify(
      `sleep 60 >/dev/null 2>&1 & echo $! > '${dir}/grandchild.pid'`,
    )
  }] }).outputSync();`,
  mode === "hang"
    ? "setInterval(() => {}, 1000);"
    : "await new Promise((resolve) => setTimeout(resolve, 1500));",
].join("\n");
const child = new Deno.Command(deno, {
  args: [
    "eval",
    "--allow-run=/bin/bash",
    program,
    ...laneScriptArgs(supervision),
  ],
  stdout: "null",
  stderr: "null",
}).spawn();
const backstop = startBackstop(supervision, () => killChild(child));
await child.status;
backstop.clear();
await stopOwnGroup(supervision, deno);
await Deno.writeTextFile(
  `${dir}/runner.done`,
  backstop.expired ? "backstop" : "ok",
);
Deno.exit(backstop.expired ? 1 : 0);
