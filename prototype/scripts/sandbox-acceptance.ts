// BIT-662 acceptance check 5, opt-in (`npm run test:sandbox-acceptance` in
// prototype/): `npm ci` in a fresh linked worktree of this repository, run
// through the srt sandbox the way the bash tool runs a command, with the
// registry-only allowlist and no ask callback, so nothing can prompt. It
// needs the network, so it is not part of `npm test`.
//
// `npm run test:fast` does not pass inside srt yet: on macOS the sandbox
// refuses to run the setuid `/bin/ps` that the gate's lane supervision uses,
// and the gate sets its lanes' TMPDIR to /tmp, which the sandbox cannot
// write (BIT-806). Until then an agent runs it with bash's prompted
// `unsandboxed` escape. `--with-test-fast` also runs it here, to show where
// it stands; its result is reported and does not change the exit status.
//
// The worktree is detached at HEAD under the system temp directory and
// removed afterwards; the repository gains no branch.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runBounded } from "../src/tools/builtin/bounded-process.ts";
import { buildSafeBashEnv } from "../src/tools/builtin/exec.ts";
import {
  bootSandbox,
  describeSandbox,
} from "../src/tools/builtin/srt-sandbox.ts";
import { SANDBOX_NPM_CACHE } from "../src/tools/builtin/srt-policy.ts";
import { listenLoopbackProbe } from "../src/transport/mod.ts";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

const repo = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const parent = realpathSync(mkdtempSync(join(tmpdir(), "dyfj-srt-acceptance-")));
const worktree = join(parent, "dyfj");

async function host(args: string[]): Promise<void> {
  const result = await runBounded({
    command: "git",
    args: ["-C", repo, ...args],
    cwd: repo,
    env: buildSafeBashEnv(),
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

const withTestFast = process.argv.includes("--with-test-fast");
let failed = false;
try {
  await host(["worktree", "add", "--detach", "-q", worktree, "HEAD"]);
  const sandbox = await bootSandbox({ listenProbe: listenLoopbackProbe });
  console.log(describeSandbox(sandbox.status));
  if (sandbox.status.state !== "on") {
    throw new Error("the sandbox is off; acceptance check 5 cannot run");
  }
  const env = { ...buildSafeBashEnv(), npm_config_cache: SANDBOX_NPM_CACHE };
  const commands = ["npm ci --no-audit --no-fund"];
  if (withTestFast) commands.push("npm run test:fast");
  for (const command of commands) {
    const started = Date.now();
    const result = await sandbox.runShell(command, {
      root: worktree,
      cwd: worktree,
      timeoutMs: 30 * 60_000,
      env,
    });
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(
      `\n### ${command}: exit ${result.code}${
        result.timedOut ? " (timed out)" : ""
      } after ${seconds} s`,
    );
    console.log(`${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-25).join("\n"));
    if (result.code !== 0) {
      if (command.startsWith("npm ci")) {
        failed = true;
        break;
      }
      console.log("(test:fast inside srt is a known gap, BIT-806; not counted)");
    }
  }
} finally {
  // srt's proxies run in this process; reset closes them so it can exit.
  await SandboxManager.reset().catch(() => {});
  await host(["worktree", "remove", "--force", worktree]).catch((error) =>
    console.error(`cleanup: ${(error as Error).message}`)
  );
  rmSync(parent, { recursive: true, force: true });
}
console.log(
  failed
    ? "\nacceptance check 5 (npm ci inside srt): FAIL"
    : "\nacceptance check 5 (npm ci inside srt): PASS",
);
process.exitCode = failed ? 1 : 0;
