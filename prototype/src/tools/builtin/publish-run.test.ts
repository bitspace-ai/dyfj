import assert from "node:assert/strict";
import process from "node:process";
import { describe, it } from "node:test";
import { composeRuntimePolicy } from "../../config/mod.ts";
import { startPublishCommand } from "./publish-run.ts";

const posix = process.platform !== "win32";

/** The runtime policy plus this node binary, which the fixtures run. */
function policy() {
  const base = composeRuntimePolicy();
  return { ...base, run: [...base.run, process.execPath] };
}

/**
 * A command that starts a descendant in its own process group, sharing the
 * command's stdout, prints the descendant's pid, then waits: the group stop
 * cannot reach the descendant, and the descendant keeps the pipe open.
 */
const ESCAPEE = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
child.unref();
process.stdout.write("escapee " + child.pid + "\\n");
setTimeout(() => {}, 30000);
`;

describe("publish run: a stopped run settles", () => {
  for (const how of ["timeout", "cancel"] as const) {
    it(
      `settles on ${how} even when an escaped descendant holds the pipe`,
      { skip: !posix, timeout: 15_000 },
      async () => {
        const handle = startPublishCommand(
          {
            argv: [process.execPath, "-e", ESCAPEE],
            cwd: process.cwd(),
            env: { PATH: process.env["PATH"] ?? "" },
            timeoutMs: how === "timeout" ? 1_000 : 60_000,
          },
          policy(),
        );
        if (how === "cancel") setTimeout(() => handle.cancel(), 1_000);
        const started = Date.now();
        const result = await handle.result;
        const pid = Number(/escapee (\d+)/u.exec(result.output)?.[1]);
        try {
          assert.ok(Date.now() - started < 10_000, "settled within the bound");
          assert.strictEqual(result.pipesLeftOpen, true);
          assert.strictEqual(how === "timeout" ? result.timedOut : result.cancelled, true);
        } finally {
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // Already gone.
            }
          }
        }
      },
    );
  }
});
