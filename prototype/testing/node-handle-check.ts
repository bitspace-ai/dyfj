// The per-file leak check for test files that run under `node --test`
// (`specs/03-testing.md` §1). The Node lanes preload it into each file's
// process with `--import` (`scripts/node-test-lane.ts`).
//
// At load it records the live resource types as a baseline. A root `after()`
// hook then compares what is still live with that baseline, once the event
// loop has had a few turns to release handles that were already closing. Anything beyond it is a leak: the check prints the file
// and the leaked types, and exits the process with a failing code, so a
// leaked server, timer or child process can neither pass nor hang the run.
//
// It is per file, so it is coarser than a per-test check: it names the file
// that leaked, not the test, and a leak that a later test in the same file
// cleans up goes unseen.
import { after } from "node:test";
import process from "node:process";
import { leakedResources, leakReport } from "./node-handle-leaks.ts";

// A handle being closed when the last test ends, such as a server whose
// close callback has run, is released by the event loop a turn or two later,
// so the check looks again for this many turns before it reports.
const SETTLE_TURNS = 10;

const baseline = process.getActiveResourcesInfo();

function check(turnsLeft: number): void {
  const leaked = leakedResources(baseline, process.getActiveResourcesInfo());
  if (leaked.length === 0) return;
  if (turnsLeft > 0) {
    setImmediate(() => check(turnsLeft - 1));
    return;
  }
  console.error(leakReport(process.argv[1] ?? "<unknown file>", leaked));
  process.exitCode = 1;
  process.exit(1);
}

after(() => {
  setImmediate(() => check(SETTLE_TURNS));
});
