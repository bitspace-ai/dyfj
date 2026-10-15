// The per-file leak check for test files that run under `node --test`
// (`specs/03-testing.md` §1). The Node lanes preload it into each file's
// process with `--import` (`scripts/node-test-lane.ts`).
//
// At load it records the live resource types as a baseline. A root `after()`
// hook then compares what is still live with that baseline, once the event
// loop has had a few turns to release handles that were already closing.
// Before each look it waits for everything already written to the process's
// stdout and stderr to be flushed: stdout is the runner's channel to its
// parent `node --test`, and on platforms where pipe writes are asynchronous
// (macOS) a write still in flight on it is the runner's own output, not a
// leak. Anything beyond the baseline after that is a leak: the check prints
// the file and the leaked types and fails the process. It sets the exit code
// rather than exiting at once, so the runner's report of the file's tests is
// not cut off; a bounded fallback then exits, so a leaked server, timer or
// child process can neither pass nor hang the run.
//
// It is per file, so it is coarser than a per-test check: it names the file
// that leaked, not the test, and a leak that a later test in the same file
// cleans up goes unseen.
import { after } from "node:test";
import process from "node:process";
import type { Writable } from "node:stream";
import { leakedResources, leakReport } from "./node-handle-leaks.ts";

// A handle being closed when the last test ends, such as a server whose
// close callback has run, is released by the event loop a turn or two later,
// so the check looks again for this many turns before it reports.
const SETTLE_TURNS = 10;

// How long one flush of stdout or stderr may take. A write still pending
// after this is reported like any other live resource.
const FLUSH_BOUND_MS = 5_000;

// How long a leaking file's process is left to finish reporting its tests
// before the check flushes its output and exits.
const EXIT_GRACE_MS = 1_000;

const baseline = process.getActiveResourcesInfo();

/**
 * Resolves once everything written to `stream` before the call has been
 * handed to the system, or after `FLUSH_BOUND_MS`. Its timer is cleared on
 * the flush, so it is not live when the check reads the resource list.
 */
function flushed(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FLUSH_BOUND_MS);
    stream.write("", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function flushOutput(): Promise<unknown> {
  return Promise.all([flushed(process.stdout), flushed(process.stderr)]);
}

async function leaked(): Promise<string[]> {
  let found: string[] = [];
  for (let turn = 0; turn <= SETTLE_TURNS; turn++) {
    await flushOutput();
    found = leakedResources(baseline, process.getActiveResourcesInfo());
    if (found.length === 0) return found;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return found;
}

async function check(): Promise<void> {
  const found = await leaked();
  if (found.length === 0) return;
  console.error(leakReport(process.argv[1] ?? "<unknown file>", found));
  process.exitCode = 1;
  // A leaked handle that keeps the event loop alive would hang the file.
  // Unreferenced, so a file whose leak does not hold the loop exits on its
  // own, with the failing code.
  setTimeout(() => {
    flushOutput().then(() => process.exit(1));
  }, EXIT_GRACE_MS).unref();
}

after(() => {
  setImmediate(() => void check());
});
