import {
  seedFixtureMemories,
  startIsolatedDoltFixture,
} from "./isolated-dolt-fixture.ts";
import { integrationTestAssignments } from "./integration-test-assignment.ts";
import { resolveEsbuildBinary } from "./esbuild-binary.ts";
import { integrationChildEnvironment } from "./integration-child-environment.ts";
import { selectedDenoExecutable } from "./deno-executable.ts";
import { fileURLToPath } from "node:url";

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

async function runChecked(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; signal: AbortSignal },
): Promise<void> {
  throwIfAborted(options.signal);
  const child = new Deno.Command(command, {
    args,
    cwd: options.cwd,
    env: integrationChildEnvironment(options.env),
    clearEnv: true,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await statusOrAbort(child, options.signal);
  if (status.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${status.code}`);
  }
}

const repoRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(
  /[\\\/]$/,
  "",
);
const prototypeRoot = fileURLToPath(new URL("..", import.meta.url)).replace(
  /[\\\/]$/,
  "",
);
const denoExecutable = selectedDenoExecutable();
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
let mcpTestTempDir: string | undefined;
try {
  fixture = await startIsolatedDoltFixture({
    repoRoot,
    signal: abortController.signal,
  });
  throwIfAborted(abortController.signal);
  await seedFixtureMemories(fixture.env);
  const esbuildBinary = await resolveEsbuildBinary(prototypeRoot);
  const env = {
    ...fixture.env,
    DYFJ_ROOT: prototypeRoot,
    DENO_BIN: denoExecutable,
    ESBUILD_BINARY_PATH: `${prototypeRoot}/${esbuildBinary}`,
  };
  mcpTestTempDir = await Deno.makeTempDir({ prefix: "dyfj-mcp-roundtrip-" });
  await runChecked(denoExecutable, [
    "run",
    "-P=test",
    "--allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders,.",
    `--allow-run=bash,${denoExecutable},dolt,${esbuildBinary}`,
    "npm:vitest@3.2.6",
    "run",
    "--root",
    ".",
    "--pool=forks",
    "--poolOptions.forks.singleFork",
    ...integrationTestAssignments.vitest,
  ], { cwd: prototypeRoot, env, signal: abortController.signal });
  await runChecked(denoExecutable, [
    "test",
    "--sloppy-imports",
    "--allow-env=HOME,LOGNAME,PATH,SHELL,TERM,USER,OSTYPE,NODE_V8_COVERAGE,DOLT_HOST,DOLT_PORT,DOLT_USER,DOLT_PASSWORD,DOLT_DATABASE,DENO_BIN,DYFJ_ROOT,DYFJ_MCP_TEST_TEMP_DIR",
    `--allow-read=.,${mcpTestTempDir}`,
    `--allow-write=${mcpTestTempDir}`,
    `--allow-run=${denoExecutable},scripts/mcp-child-wrapper.sh,/bin/kill`,
    "--allow-net=127.0.0.1",
    ...integrationTestAssignments.deno,
  ], {
    cwd: prototypeRoot,
    env: { ...env, DYFJ_MCP_TEST_TEMP_DIR: mcpTestTempDir },
    signal: abortController.signal,
  });
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
  if (mcpTestTempDir !== undefined) {
    await Deno.remove(mcpTestTempDir, { recursive: true });
  }
  Deno.removeSignalListener("SIGINT", onSigint);
  Deno.removeSignalListener("SIGTERM", onSigterm);
}

if (interruptedExitCode !== undefined) Deno.exit(interruptedExitCode);
