/**
 * Golden lane runner: `deno task test:golden` and the `test.golden` gate lane.
 *
 * Creates the harness temp root first, so every engine socket path is known
 * before the tests start, then runs the golden tests with least-privilege
 * grants: loopback TCP, the exact Unix socket of each server profile, and
 * process spawn for the selected Deno and Dolt only. `--update` (for example
 * `deno task test:golden --update`) is the one suite argument the golden
 * files use: it lets them rewrite their snapshots.
 *
 * A golden file that registers with `node:test` runs after the rest, under
 * `node --test` with the per-file handle check (`scripts/node-test-lane.ts`)
 * and the same environment. `node --test` passes such a file no arguments,
 * so `--update` reaches it as `DYFJ_GOLDEN_UPDATE=1`, and `snapshots.ts`
 * refuses every snapshot write without it: with no permission sandbox on
 * that runtime, the guard is in code. Any other suite argument cannot reach
 * such a file, so a run that passes one while one exists fails before it
 * starts.
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
import { fileURLToPath } from "node:url";
import { SERVER_PROFILES, socketPathFor } from "./profiles.ts";
import { GOLDEN_UPDATE_ENV } from "./snapshots.ts";
import {
  killChild,
  laneSupervision,
  startBackstop,
  startTokenCarrier,
  stopOwnGroup,
} from "../../scripts/lane-supervision.ts";

const tempWrite = "/tmp,/private/tmp,/var/folders,/private/var/folders";
const suiteArgs = Deno.args;
const prototypeRoot = fileURLToPath(new URL("../..", import.meta.url));
// Each golden file runs on the runtime its own registrations name
// (`scripts/test-files.ts`); a file that names both fails here.
const goldenFiles = partitionByRuntime(
  prototypeRoot,
  discoverGoldenTests(prototypeRoot),
);
requireNode();
// `node --test` runs each file in its own process and passes it no
// arguments, so `--update` reaches a Node golden file as an environment
// variable instead (`snapshots.ts`). Nothing else can reach one.
const update = suiteArgs.includes("--update");
const unreachable = suiteArgs.filter((arg) => arg !== "--update");
if (goldenFiles.node.length > 0 && unreachable.length > 0) {
  throw new Error(
    `dyfj: suite arguments other than --update (${unreachable.join(" ")}) ` +
      "reach only the golden files on the first runtime; these run under " +
      `node --test: ${goldenFiles.node.join(", ")}`,
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
// The backstop ends whichever subset is running when it expires.
let stopCurrent = () => {};
try {
  backstop = startBackstop(supervision, deno, () => stopCurrent());
  if (goldenFiles.deno.length === 0) {
    console.log("test.golden deno test: 0 files");
    code = 0;
  } else {
    const child = new Deno.Command(deno, {
      args: [
        "test",
        // `node:child_process` reads NODE_V8_COVERAGE on every spawn.
        `--allow-env=${
          [...forwarded, "DYFJ_GOLDEN_ROOT", "DENO_BIN", "NODE_V8_COVERAGE"]
            .join(",")
        }`,
        `--allow-read=..,${tempWrite}`,
        // Only an explicit update may write snapshots; the lane cannot.
        `--allow-write=${tempWrite}${
          update ? ",testing/golden/snapshots" : ""
        }`,
        `--allow-run=${deno},dolt`,
        `--allow-net=${
          [
            "127.0.0.1",
            ...SERVER_PROFILES.map((profile) =>
              `unix:${socketPathFor(root, profile)}`
            ),
          ].join(",")
        }`,
        ...goldenFiles.deno,
        ...(suiteArgs.length > 0 ? ["--", ...suiteArgs] : []),
      ],
      cwd: prototypeRoot,
      clearEnv: true,
      env,
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    stopCurrent = () => killChild(child);
    code = (await child.status).code;
  }
  if (!backstop.expired) {
    const node = startNodeTests({
      lane: "test.golden",
      files: goldenFiles.node,
      cwd: prototypeRoot,
      env: update ? { ...env, [GOLDEN_UPDATE_ENV]: "1" } : env,
      // The files run one at a time, as the first subset's do.
      jobs: 1,
    });
    stopCurrent = node.kill;
    const nodeCode = await node.code;
    if (code === 0) code = nodeCode;
  }
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
