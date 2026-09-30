// A stand-in test-lane runner for the gate's supervision tests
// (`lane-supervision.test.ts`). It is supervised the way the real runners
// are: a lane token carrier, the backstop around its child, then a stop of its
// own process group. The child leaves a same-group `sleep` grandchild that
// ignores TERM and writes its pid to `<dir>/grandchild.pid`, then exits after
// 1.5 s, or never (`hang`). After the child:
//
// - `stall`: the runner's own work hangs without observing the backstop, so
//   only the backstop's exit ends it (3 s after the backstop).
// - `second-step`: the runner runs a second step with no token of its own, a
//   `sleep` whose pid is in `<dir>/second-step.pid`, and waits on it.
//
// The runner writes `<dir>/runner.done` (`ok` or `backstop`) just before a
// normal exit.
//
// Usage: lane-runner.fixture.ts <exit|hang|stall|second-step> <dir>
import {
  killChild,
  laneSupervision,
  startBackstop,
  startTokenCarrier,
  stopOwnGroup,
} from "../prototype/scripts/lane-supervision.ts";

const MODES = ["exit", "hang", "stall", "second-step"];
const [mode, dir] = Deno.args;
if (!MODES.includes(mode) || dir === undefined) {
  console.error(`usage: lane-runner.fixture.ts <${MODES.join("|")}> <dir>`);
  Deno.exit(64);
}
const deno = Deno.execPath();
const supervision = laneSupervision();
startTokenCarrier(supervision, deno);
const program = [
  `new Deno.Command("/bin/bash", { args: ["-c", ${
    JSON.stringify(
      `trap '' TERM; sleep 60 >/dev/null 2>&1 & echo $! > '${dir}/grandchild.pid'`,
    )
  }] }).outputSync();`,
  mode === "hang"
    ? "setInterval(() => {}, 1000);"
    : "await new Promise((resolve) => setTimeout(resolve, 1500));",
].join("\n");
const child = new Deno.Command(deno, {
  args: ["eval", "--allow-run=/bin/bash", program],
  stdout: "null",
  stderr: "null",
}).spawn();
const backstop = startBackstop(
  supervision,
  deno,
  () => killChild(child),
  // Short for `stall`, which only the backstop's exit ends; the default for
  // the rest, which stay well inside it.
  mode === "stall" ? 3_000 : undefined,
);
await child.status;
if (mode === "stall") {
  await new Promise(() => setInterval(() => {}, 1000));
}
if (mode === "second-step") {
  await new Deno.Command("/bin/bash", {
    args: ["-c", `echo $$ > '${dir}/second-step.pid'; exec sleep 60`],
    stdout: "null",
    stderr: "null",
  }).output();
}
backstop.clear();
await stopOwnGroup(supervision, deno);
await Deno.writeTextFile(
  `${dir}/runner.done`,
  backstop.expired ? "backstop" : "ok",
);
Deno.exit(backstop.expired ? 1 : 0);
