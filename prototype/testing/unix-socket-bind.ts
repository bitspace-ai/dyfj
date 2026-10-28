// Whether this process may bind a Unix socket in its temp directory. A suite
// whose tests need a real socket server passes the reason as its `skip`, so a
// run where the sandbox refuses the bind says why it did not run: a
// `# SKIP <reason>` line, and a skipped test that puts it in the run's skipped
// count (node:test does not count the tests of a skipped suite, so each suite
// adds one explicit skipped test), instead of passing without checking
// anything (BIT-806).
//
// The bind is probed in a child process (below). Two guards keep a skip from
// hiding a real problem:
// - Only an EPERM from the probe's own bind skips. Any other error returns no
//   reason, so the suite runs and fails on it; that includes an error (EPERM
//   too) from making the probe's directory, which says nothing about binding.
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
// 0 bound, 10 the bind was refused with EPERM, 11 the bind failed otherwise,
// 12 the directory could not be made (its error code on stdout for 11 and 12).
// The phase is in the exit code because only a refused bind may skip.
const EXIT_BOUND = 0;
const EXIT_EPERM = 10;
const EXIT_OTHER = 11;
const EXIT_DIRECTORY = 12;

const PROBE_PROGRAM = `
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
let made;
const finish = (status, code) => {
  if (made !== undefined) rmSync(made, { recursive: true, force: true });
  if (code !== undefined) process.stdout.write(String(code));
  process.exit(status);
};
try {
  made = mkdtempSync(join(process.argv[1], "dyfj-bind-probe-"));
} catch (error) {
  finish(${EXIT_DIRECTORY}, error.code);
}
const server = createServer();
server.once("error", (error) =>
  finish(error.code === "EPERM" ? ${EXIT_EPERM} : ${EXIT_OTHER}, error.code)
);
server.listen(join(made, "s.sock"), () => {
  server.close(() => finish(${EXIT_BOUND}));
});
`;

/**
 * What the probe child's exit says about the bind. Only a refused bind reads
 * as exactly `EPERM`; a failure to make the directory is `mkdtemp:<code>`, so
 * it can never be taken for a refused bind.
 */
export function bindOutcomeFromExit(
  status: number | null,
  stdout: string,
): BindOutcome {
  if (status === EXIT_BOUND) return { ok: true };
  if (status === EXIT_EPERM) return { ok: false, code: "EPERM" };
  const code = stdout.trim() === "" ? undefined : stdout.trim();
  if (status === EXIT_DIRECTORY) {
    return { ok: false, code: `mkdtemp:${code ?? "unknown"}` };
  }
  return { ok: false, code };
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
