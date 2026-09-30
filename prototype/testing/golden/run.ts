/**
 * Golden lane runner: `deno task test:golden` and the `test.golden` gate lane.
 *
 * Creates the harness temp root first, so every engine socket path is known
 * before the tests start, then runs the golden tests with least-privilege
 * grants: loopback TCP, the exact Unix socket of each server profile, and
 * process spawn for the selected Deno and Dolt only. Arguments after `--`
 * reach the suite (for example `-- --update`).
 *
 * Under the aggregate gate it is also supervised as a test lane
 * (`scripts/lane-supervision.ts`): a backstop deadline, a lane token carrier,
 * and a stop of its own process group once done.
 */

import { selectedDenoExecutable } from "../../scripts/deno-executable.ts";
import { SERVER_PROFILES, socketPathFor } from "./profiles.ts";
import {
  killChild,
  laneSupervision,
  startBackstop,
  startTokenCarrier,
  stopOwnGroup,
} from "../../scripts/lane-supervision.ts";

const tempWrite = "/tmp,/private/tmp,/var/folders,/private/var/folders";
const deno = selectedDenoExecutable();
const root = await Deno.makeTempDir({ prefix: "dyfj_golden_" });
const forwarded = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP"];
const env: Record<string, string> = { DYFJ_GOLDEN_ROOT: root };
for (const name of forwarded) {
  const value = Deno.env.get(name);
  if (value !== undefined) env[name] = value;
}

const supervision = laneSupervision();
startTokenCarrier(supervision, deno);
let code = 1;
let backstopExpired = false;
try {
  const child = new Deno.Command(deno, {
    args: [
      "test",
      `--allow-env=${[...forwarded, "DYFJ_GOLDEN_ROOT"].join(",")}`,
      `--allow-read=..,${tempWrite}`,
      // Only an explicit update may write snapshots; the lane cannot.
      `--allow-write=${tempWrite}${
        Deno.args.includes("--update") ? ",testing/golden/snapshots" : ""
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
      "testing/golden/",
      ...(Deno.args.length > 0 ? ["--", ...Deno.args] : []),
    ],
    cwd: new URL("../..", import.meta.url),
    clearEnv: true,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const backstop = startBackstop(
    supervision,
    deno,
    () => killChild(child),
  );
  code = (await child.status).code;
  backstop.clear();
  backstopExpired = backstop.expired;
} finally {
  await Deno.remove(root, { recursive: true }).catch(() => undefined);
}
await stopOwnGroup(supervision, deno);
if (backstopExpired) {
  console.error(
    `dyfj: test.golden passed its backstop deadline (${
      supervision!.backstopMs
    } ms)`,
  );
  code = 1;
}
Deno.exit(code);
