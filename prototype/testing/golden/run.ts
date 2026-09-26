/**
 * Golden lane runner: `deno task test:golden` and the `test.golden` gate lane.
 *
 * Creates the harness temp root first, so every engine socket path is known
 * before the tests start, then runs the golden tests with least-privilege
 * grants: loopback TCP, the exact Unix socket of each server profile, and
 * process spawn for the selected Deno and Dolt only. Arguments after `--`
 * reach the suite (for example `-- --update`).
 */

import { selectedDenoExecutable } from "../../scripts/deno-executable.ts";
import { SERVER_PROFILES, socketPathFor } from "./profiles.ts";

const tempWrite = "/tmp,/private/tmp,/var/folders,/private/var/folders";
const deno = selectedDenoExecutable();
const root = await Deno.makeTempDir({ prefix: "dyfj_golden_" });
const forwarded = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP"];
const env: Record<string, string> = { DYFJ_GOLDEN_ROOT: root };
for (const name of forwarded) {
  const value = Deno.env.get(name);
  if (value !== undefined) env[name] = value;
}

let code = 1;
try {
  const child = new Deno.Command(deno, {
    args: [
      "test",
      "--sloppy-imports",
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
  code = (await child.status).code;
} finally {
  await Deno.remove(root, { recursive: true }).catch(() => undefined);
}
Deno.exit(code);
