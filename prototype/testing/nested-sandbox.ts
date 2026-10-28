// Whether this process is already inside a macOS sandbox, in which case a test
// that starts a sandbox of its own cannot run: macOS refuses to nest one
// (`sandbox_apply: Operation not permitted`). A test that really starts a
// sandbox passes the reason as its `skip`, so the run says why it did not run
// (a `# SKIP <reason>` line and a skipped count) instead of passing without
// checking anything. Outside a sandbox the reason is undefined and the test
// runs as before (BIT-806).
//
// The check starts a no-op sandbox with `sandbox-exec` and reads the refusal.
// Only macOS is checked: elsewhere, and whenever the probe cannot tell (no
// `sandbox-exec`, or another failure), the answer is "not nested" and the
// test runs and reports its own result.
import { spawnSync } from "node:child_process";

export interface ProbeOutcome {
  /** The probe's exit status; null when it did not start or was signalled. */
  status: number | null;
  stderr: string;
}

export type SandboxProbe = () => ProbeOutcome;

const PROBE_PROFILE = "(version 1)(allow default)";
const REFUSAL = /sandbox_apply: Operation not permitted/;

function runSandboxExec(): ProbeOutcome {
  const result = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", PROBE_PROFILE, "/usr/bin/true"],
    { encoding: "utf8", env: {}, timeout: 10_000 },
  );
  return { status: result.status, stderr: result.stderr ?? "" };
}

/**
 * Why a test that starts its own sandbox cannot run here, or undefined when it
 * can. `platform` and `probe` are injectable for the helper's own tests.
 */
export function nestedSandboxSkipReason(
  platform: string = process.platform,
  probe: SandboxProbe = runSandboxExec,
): string | undefined {
  if (platform !== "darwin") return undefined;
  const outcome = probe();
  if (outcome.status === 0 || !REFUSAL.test(outcome.stderr)) return undefined;
  return "this process is already inside a sandbox, and macOS refuses to " +
    "nest one (sandbox-exec: sandbox_apply: Operation not permitted)";
}
