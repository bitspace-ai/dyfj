// A stand-in test-lane runner for the gate's supervision tests
// (`lane-supervision.test.ts`). It is supervised the way the real runners
// are: a lane token carrier, the backstop around its steps, then a stop of its
// own process group. The child leaves a same-group `sleep` grandchild that
// ignores TERM and writes its pid to `<dir>/grandchild.pid`, then exits once
// the test creates `<dir>/release` (`exit`), never (`hang`), or after 1.5 s.
// After the child:
//
// - `stall`: the runner's own work hangs without observing the backstop, so
//   only the backstop's exit ends it (3 s after the backstop).
// - `second-step`: the runner runs a second step with no token of its own, a
//   `sleep` whose pid is in `<dir>/second-step.pid`, and waits on it.
//
// The runner writes `<dir>/runner.done` (`ok` or `backstop`) just before a
// normal exit.
//
// Usage: node lane-runner.fixture.ts <exit|hang|stall|second-step> <dir>
import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import {
  killChild,
  laneSupervision,
  startBackstop,
  startTokenCarrier,
  stopOwnGroup,
} from "../prototype/scripts/lane-supervision.ts";

const MODES = ["exit", "hang", "stall", "second-step"];
const [mode, dir] = process.argv.slice(2);
if (mode === undefined || !MODES.includes(mode) || dir === undefined) {
  console.error(`usage: lane-runner.fixture.ts <${MODES.join("|")}> <dir>`);
  process.exit(64);
}
const supervision = laneSupervision();
startTokenCarrier(supervision);
// The child's program is fixed text: the directory and how to finish reach
// it as script arguments, and reach `bash` as a positional parameter.
const CHILD_PROGRAM = `
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
const [dir, finish] = process.argv.slice(1);
execFileSync("/bin/bash", [
  "-c",
  "trap '' TERM; sleep 60 >/dev/null 2>&1 & echo $! > \\"$1/grandchild.pid\\"",
  "grandchild",
  dir,
], { stdio: "ignore" });
const released = () => {
  try {
    return statSync(dir + "/release").isFile();
  } catch {
    return false;
  }
};
if (finish === "never") {
  setInterval(() => {}, 1000);
} else if (finish === "release") {
  while (!released()) await new Promise((resolve) => setTimeout(resolve, 50));
} else {
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
`;

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

const finish = mode === "hang" ? "never" : mode === "exit" ? "release" : "soon";
let current = spawn(
  process.execPath,
  ["--input-type=module", "-e", CHILD_PROGRAM, dir, finish],
  { stdio: "ignore" },
);
const backstop = startBackstop(
  supervision,
  () => killChild(current),
  // Short for `stall`, which only the backstop's exit ends; the default for
  // the rest, which stay well inside it.
  mode === "stall" ? 3_000 : undefined,
);
await exited(current);
if (mode === "stall") {
  await new Promise(() => setInterval(() => {}, 1000));
}
if (mode === "second-step" && !backstop.expired) {
  current = spawn("/bin/bash", [
    "-c",
    'echo $$ > "$1/second-step.pid"; exec sleep 60',
    "second-step",
    dir,
  ], { stdio: "ignore" });
  await exited(current);
}
backstop.clear();
await stopOwnGroup(supervision);
writeFileSync(`${dir}/runner.done`, backstop.expired ? "backstop" : "ok");
process.exit(backstop.expired ? 1 : 0);
