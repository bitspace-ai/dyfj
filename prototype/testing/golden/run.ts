/**
 * Golden lane runner: `deno task test:golden` and the `test.golden` gate lane.
 *
 * Creates the harness temp root (`DYFJ_GOLDEN_ROOT`, where the engine sockets
 * live), then runs the golden tests under `node --test` with
 * the per-file handle check (`scripts/node-test-lane.ts`). `node --test`
 * passes a test file no arguments, so `--update` (for example
 * `deno task test:golden --update`), the one suite argument the golden suite
 * takes, reaches the tests as `DYFJ_GOLDEN_UPDATE=1`, and `snapshots.ts`
 * refuses every snapshot write without it: with no permission sandbox under
 * `node --test`, the guard is in code. Any other argument is refused before
 * the run starts. A golden file that registers with the existing runtime's
 * runner fails discovery (`scripts/test-files.ts`).
 *
 * Under the aggregate gate it is also supervised as a test lane
 * (`scripts/lane-supervision.ts`): a backstop deadline, a lane token carrier,
 * and a stop of its own process group once done.
 */

import { selectedDenoExecutable } from "../../scripts/deno-executable.ts";
import {
  discoverGoldenTests,
  partitionByRuntime,
} from "../../scripts/test-files.ts";
import { requireNode, startNodeTests } from "../../scripts/node-test-lane.ts";
import { GOLDEN_UPDATE_ENV } from "./snapshots.ts";
import {
  laneSupervision,
  startBackstop,
  startTokenCarrier,
  stopOwnGroup,
} from "../../scripts/lane-supervision.ts";
import { fileURLToPath } from "node:url";

const suiteArgs = Deno.args;
const prototypeRoot = fileURLToPath(new URL("../..", import.meta.url));
// Every golden file runs under `node --test`; one that registers with the
// existing runtime's runner fails here (`scripts/test-files.ts`).
const goldenFiles = partitionByRuntime(
  prototypeRoot,
  discoverGoldenTests(prototypeRoot),
).node;
requireNode();
const update = suiteArgs.includes("--update");
const unsupported = suiteArgs.filter((arg) => arg !== "--update");
if (unsupported.length > 0) {
  throw new Error(
    `dyfj: the golden suite takes no arguments other than --update ` +
      `(got ${unsupported.join(" ")}): node --test passes a test file none`,
  );
}

const deno = selectedDenoExecutable();
const root = await Deno.makeTempDir({ prefix: "dyfj_golden_" });
const forwarded = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP"];
// The harness spawns the product with the same executable (`testing/deno-bin.ts`).
const env: Record<string, string> = { DYFJ_GOLDEN_ROOT: root, DENO_BIN: deno };
for (const name of forwarded) {
  const value = Deno.env.get(name);
  if (value !== undefined) env[name] = value;
}

const supervision = laneSupervision();
startTokenCarrier(supervision, deno);
let code = 1;
let backstop: ReturnType<typeof startBackstop> | undefined;
try {
  // The backstop ends the run when it expires.
  let stopCurrent = () => {};
  backstop = startBackstop(supervision, deno, () => stopCurrent());
  const node = startNodeTests({
    lane: "test.golden",
    files: goldenFiles,
    cwd: prototypeRoot,
    env: update ? { ...env, [GOLDEN_UPDATE_ENV]: "1" } : env,
    // The files run one at a time.
    jobs: 1,
  });
  stopCurrent = node.kill;
  code = await node.code;
} finally {
  await Deno.remove(root, { recursive: true }).catch(() => undefined);
  // Cleared only after the cleanup above, which the backstop also bounds.
  backstop?.clear();
}
await stopOwnGroup(supervision, deno);
if (backstop?.expired) {
  console.error(
    `dyfj: test.golden passed its backstop deadline (${
      supervision!.backstopMs
    } ms)`,
  );
  code = 1;
}
Deno.exit(code);
