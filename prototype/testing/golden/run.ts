/**
 * Golden lane runner: `deno task test:golden` and the `test.golden` gate lane,
 * run on Node (`node testing/golden/run.ts`).
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
 * and a stop of its own process group once done. It runs only as a script:
 * importing it runs nothing.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  discoverGoldenTests,
  partitionByRuntime,
} from "../../scripts/test-files.ts";
import { requireNode, startNodeTests } from "../../scripts/node-test-lane.ts";
import { GOLDEN_UPDATE_ENV } from "./snapshots.ts";
import {
  backstopMessage,
  laneSupervision,
  startBackstop,
  startTokenCarrier,
  stopOwnGroup,
} from "../../scripts/lane-supervision.ts";

async function main(suiteArgs: readonly string[]): Promise<number> {
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
        `(got ${unsupported.join(" ")}): node --test does not forward suite ` +
        `arguments to test files, so the only supported one is --update, ` +
        `which reaches the tests as ${GOLDEN_UPDATE_ENV}=1`,
    );
  }

  const root = await mkdtemp(join(tmpdir(), "dyfj_golden_"));
  const forwarded = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP"];
  const env: Record<string, string> = { DYFJ_GOLDEN_ROOT: root };
  for (const name of forwarded) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }

  const supervision = laneSupervision();
  startTokenCarrier(supervision);
  let code = 1;
  let backstop: ReturnType<typeof startBackstop> | undefined;
  try {
    // The backstop ends the run when it expires.
    let stopCurrent = () => {};
    backstop = startBackstop(supervision, () => stopCurrent());
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
    await rm(root, { recursive: true }).catch(() => undefined);
    // Cleared only after the cleanup above, which the backstop also bounds.
    backstop?.clear();
  }
  await stopOwnGroup(supervision);
  if (backstop?.expired) {
    console.error(backstopMessage("test.golden", supervision!, backstop));
    code = 1;
  }
  return code;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
