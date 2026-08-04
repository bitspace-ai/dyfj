import {
  seedFixtureMemories,
  startIsolatedDoltFixture,
} from "./isolated-dolt-fixture.ts";
import { integrationTestAssignments } from "./integration-test-assignment.ts";

const inheritedEnvironmentNames = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP"];

class IntegrationInterruptedError extends Error {
  constructor() {
    super("isolated Dolt integration interrupted");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new IntegrationInterruptedError();
}

async function stopChild(
  child: ReturnType<Deno.Command["spawn"]>,
): Promise<void> {
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  try {
    await Promise.race([
      child.status,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("shutdown timeout")), 2_000)
      ),
    ]);
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process exited while the timeout elapsed.
    }
    await child.status.catch(() => undefined);
  }
}

async function statusOrAbort(
  child: ReturnType<Deno.Command["spawn"]>,
  signal: AbortSignal,
): Promise<Deno.CommandStatus> {
  const status = child.status;
  if (signal.aborted) {
    await stopChild(child);
    throw new IntegrationInterruptedError();
  }
  let onAbort: (() => void) | undefined;
  const result = await Promise.race([
    status.then((value) => ({ type: "status" as const, value })),
    new Promise<{ type: "aborted" }>((resolve) => {
      onAbort = () => resolve({ type: "aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }),
  ]);
  if (onAbort) signal.removeEventListener("abort", onAbort);
  if (result.type === "status") return result.value;

  await stopChild(child);
  await status.catch(() => undefined);
  throw new IntegrationInterruptedError();
}

function safeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    inheritedEnvironmentNames.flatMap((name) => {
      const value = Deno.env.get(name);
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

async function runChecked(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; signal: AbortSignal },
): Promise<void> {
  throwIfAborted(options.signal);
  const child = new Deno.Command(command, {
    args,
    cwd: options.cwd,
    env: { ...safeEnvironment(), ...options.env },
    clearEnv: true,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await statusOrAbort(child, options.signal);
  if (status.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${status.code}`);
  }
}

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const prototypeRoot = new URL("..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const abortController = new AbortController();
let interruptedExitCode: number | undefined;
const interrupt = (exitCode: number) => {
  if (abortController.signal.aborted) return;
  interruptedExitCode = exitCode;
  abortController.abort();
};
const onSigint = () => interrupt(130);
const onSigterm = () => interrupt(143);
Deno.addSignalListener("SIGINT", onSigint);
Deno.addSignalListener("SIGTERM", onSigterm);

let fixture: Awaited<ReturnType<typeof startIsolatedDoltFixture>> | undefined;
try {
  fixture = await startIsolatedDoltFixture({
    repoRoot,
    signal: abortController.signal,
  });
  throwIfAborted(abortController.signal);
  await seedFixtureMemories(fixture.env);
  const env = {
    ...fixture.env,
    DYFJ_ROOT: prototypeRoot,
    DENO_BIN: Deno.execPath(),
  };
  await runChecked("deno", [
    "run",
    "-P=test",
    "--allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders,.",
    "--allow-run=bash,deno,dolt,node_modules/.deno/esbuild@0.27.7/node_modules/esbuild/bin/esbuild,node_modules/.deno/@esbuild+darwin-arm64@0.27.7/node_modules/@esbuild/darwin-arm64/bin/esbuild",
    "npm:vitest@3.2.6",
    "run",
    "--root",
    ".",
    "--pool=forks",
    "--poolOptions.forks.singleFork",
    ...integrationTestAssignments.vitest,
  ], { cwd: prototypeRoot, env, signal: abortController.signal });
  await runChecked("deno", [
    "test",
    "--allow-env",
    "--allow-read=.",
    "--allow-run=deno",
    "--allow-net=127.0.0.1",
    ...integrationTestAssignments.deno,
  ], { cwd: prototypeRoot, env, signal: abortController.signal });
  await runChecked(
    "cargo",
    ["test", "--test", "schema_round_trip", "--", "--ignored"],
    {
      cwd: `${repoRoot}/core`,
      env: { ...env, SQLX_OFFLINE: "true" },
      signal: abortController.signal,
    },
  );
  throwIfAborted(abortController.signal);
} catch (error) {
  if (!abortController.signal.aborted) throw error;
} finally {
  await fixture?.cleanup();
  Deno.removeSignalListener("SIGINT", onSigint);
  Deno.removeSignalListener("SIGTERM", onSigterm);
}

if (interruptedExitCode !== undefined) Deno.exit(interruptedExitCode);
