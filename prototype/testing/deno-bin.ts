// The `deno` executable that test support spawns to run the product: the
// engine server and CLI under the golden harness, and the hard-killed listener
// that leaves a stale socket file. The product runs under `deno` until the
// launcher moves to Node, so test support takes the binary from `DENO_BIN`,
// which every lane that reaches these helpers sets and grants.

import { isAbsolute } from "node:path";
import { processEnv } from "../src/config/env.ts";

/** `DENO_BIN`, or a clear error when a run did not set it. */
export function denoBin(): string {
  const bin = processEnv.get("DENO_BIN");
  if (bin === undefined || bin === "") {
    throw new Error(
      "DENO_BIN is unset: test support spawns the product with the deno " +
        "executable it names; run through a deno task or gate lane, or set it",
    );
  }
  if (!isAbsolute(bin)) {
    throw new Error(`DENO_BIN must be an absolute path, not ${bin}`);
  }
  return bin;
}

/**
 * The variables of `names` that are set here, for a child's whole
 * environment. `node:child_process` copies every variable when given no
 * `env`, which a lane's env grant, a list of names, does not allow; a child
 * gets exactly the variables its lane forwards instead.
 */
export function inheritedEnv(
  names: readonly string[] = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP"],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = processEnv.get(name);
    if (value !== undefined) env[name] = value;
  }
  return env;
}
