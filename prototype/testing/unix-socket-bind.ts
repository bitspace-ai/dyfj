// Whether this process may bind a Unix socket in its temp directory. A suite
// whose tests need a real socket server passes the reason as its `skip`, so a
// run where the sandbox refuses the bind says why it did not run (a
// `# SKIP <reason>` line and a skipped count) instead of passing without
// checking anything (BIT-806).
//
// The bind is probed in a child process (below). Two guards keep a skip from
// hiding a real problem:
// - Only a refusal of the probe's own bind (EPERM) skips. Any other bind
//   error returns no reason, so the suite runs and fails on it.
// - Under CI nothing skips: the suite runs, and a refused bind fails it. The
//   gate that matters can never go quiet on these suites.
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

export type BindOutcome = { ok: true } | { ok: false; code: string | undefined };

// The probe runs in a child process, so the process that calls it opens no
// socket, pipe or file handle of its own: the per-file handle check
// (`node-handle-check.ts`) fails a test file that leaves one live. The child
// makes a directory under the one it is given, binds a Unix socket there,
// closes it, removes the directory, and reports through its exit code:
// 0 bound, 10 refused with EPERM, 11 any other error (its code on stdout).
const EXIT_BOUND = 0;
const EXIT_EPERM = 10;
const EXIT_OTHER = 11;

const PROBE_PROGRAM = `
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
let made;
const finish = (code, error) => {
  if (made !== undefined) rmSync(made, { recursive: true, force: true });
  if (error !== undefined) process.stdout.write(String(error.code ?? ""));
  process.exit(code);
};
const fail = (error) =>
  finish(error.code === "EPERM" ? ${EXIT_EPERM} : ${EXIT_OTHER}, error);
try {
  made = mkdtempSync(join(process.argv[1], "dyfj-bind-probe-"));
} catch (error) {
  fail(error);
}
const server = createServer();
server.once("error", fail);
server.listen(join(made, "s.sock"), () => {
  server.close(() => finish(${EXIT_BOUND}));
});
`;

/** What the probe child's exit says about the bind. */
export function bindOutcomeFromExit(
  status: number | null,
  stdout: string,
): BindOutcome {
  if (status === EXIT_BOUND) return { ok: true };
  if (status === EXIT_EPERM) return { ok: false, code: "EPERM" };
  return { ok: false, code: stdout.trim() === "" ? undefined : stdout.trim() };
}

/** Binds a throwaway Unix socket under `dir`, in a child process, and closes it again. */
export function probeUnixSocketBind(dir: string = tmpdir()): BindOutcome {
  try {
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", PROBE_PROGRAM, dir],
      { env: {}, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 },
    );
    return { ok: true };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: Buffer | string };
    return bindOutcomeFromExit(
      failure.status ?? null,
      failure.stdout === undefined ? "" : String(failure.stdout),
    );
  }
}

/** Whether the environment says this is a CI run. */
export function inCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const ci = env.CI?.trim().toLowerCase();
  return (ci !== undefined && ci !== "" && ci !== "false" && ci !== "0") ||
    env.GITHUB_ACTIONS === "true";
}

/**
 * Why a suite that needs a Unix socket server cannot run here, or undefined
 * when it should run: the bind works, the run is CI, or the probe failed for a
 * reason other than a sandbox refusal.
 */
export function unixSocketSkipReason(
  outcome: BindOutcome,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (outcome.ok || outcome.code !== "EPERM" || inCi(env)) return undefined;
  return "this process may not bind a Unix socket in its temp directory " +
    "(EPERM, as inside a sandbox); the suite runs, and a refusal fails it, under CI";
}

/** The probe and the decision for this process, for a suite's `skip` option. */
export function unixSocketBindSkip(): Promise<string | undefined> {
  return Promise.resolve(
    unixSocketSkipReason(probeUnixSocketBind(), process.env),
  );
}
