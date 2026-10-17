// The isolated-Dolt integration lane's runner, run on Node
// (`node scripts/isolated-dolt-integration.ts`): starts the isolated Dolt
// fixture, runs the integration files under `node --test`, then the Rust
// schema round trip, and cleans up.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  seedFixtureMemories,
  startIsolatedDoltFixture,
} from "./isolated-dolt-fixture.ts";
import { integrationChildEnvironment } from "./integration-child-environment.ts";
import { discoverIntegrationTests, nodeTestFiles } from "./test-files.ts";
import { requireNode, startNodeTests } from "./node-test-lane.ts";
import {
  backstopMessage,
  laneSupervision,
  startBackstop,
  startTokenCarrier,
  stopOwnGroup,
} from "./lane-supervision.ts";
import { fileURLToPath } from "node:url";
import { UDS_TEST_SOCKET_DIR_ENV } from "../testing/servers/uds-sockets.ts";

class IntegrationInterruptedError extends Error {
  constructor() {
    super("isolated Dolt integration interrupted");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new IntegrationInterruptedError();
}

interface ChildStatus {
  code: number;
}

// The child's exit, as a status whose code is 1 for a signal or a failed
// start.
function childStatus(child: ChildProcess): Promise<ChildStatus> {
  return new Promise((resolve) => {
    child.once("error", () => resolve({ code: 1 }));
    child.once("exit", (code) => resolve({ code: code ?? 1 }));
  });
}

async function stopChild(
  child: ChildProcess,
  status: Promise<ChildStatus>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  try {
    await Promise.race([
      status,
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
    await status;
  }
}

async function statusOrAbort(
  child: ChildProcess,
  status: Promise<ChildStatus>,
  signal: AbortSignal,
): Promise<ChildStatus> {
  if (signal.aborted) {
    await stopChild(child, status);
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

  await stopChild(child, status);
  await status;
  throw new IntegrationInterruptedError();
}

async function runChecked(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; signal: AbortSignal },
): Promise<void> {
  throwIfAborted(options.signal);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: integrationChildEnvironment(options.env),
    stdio: "inherit",
  });
  const status = await statusOrAbort(
    child,
    childStatus(child),
    options.signal,
  );
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
const abortController = new AbortController();
let interruptedExitCode: number | undefined;
const interrupt = (exitCode: number) => {
  if (abortController.signal.aborted) return;
  interruptedExitCode = exitCode;
  abortController.abort();
};
const onSigint = () => interrupt(130);
const onSigterm = () => interrupt(143);
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
// Under the gate: a token carrier for the whole run, and past the backstop,
// or once the gate is gone, stop the step in progress (its child is signalled
// by pid) and clean up as on an interruption. A step or cleanup that does not
// observe the abort is ended by the backstop's own exit.
const supervision = laneSupervision();
startTokenCarrier(supervision);
const backstop = startBackstop(supervision, () => abortController.abort());
let failure: unknown;

let fixture: Awaited<ReturnType<typeof startIsolatedDoltFixture>> | undefined;
let mcpTestTempDir: string | undefined;
let udsTestSocketDir: string | undefined;
let testTempDir: string | undefined;
try {
  // The backstop can fire as it starts, when the gate is already gone.
  throwIfAborted(abortController.signal);
  // Every integration file runs under `node --test`. A file that registers
  // with the retired runner fails here, before the fixture (`test-files.ts`).
  const integrationFiles = nodeTestFiles(
    prototypeRoot,
    discoverIntegrationTests(prototypeRoot),
  );
  requireNode();
  fixture = await startIsolatedDoltFixture({
    repoRoot,
    signal: abortController.signal,
  });
  throwIfAborted(abortController.signal);
  await seedFixtureMemories(fixture.env);
  const env = {
    ...fixture.env,
    DYFJ_ROOT: prototypeRoot,
  };
  mcpTestTempDir = await mkdtemp(join(tmpdir(), "dyfj-mcp-roundtrip-"));
  // The files that bind real Unix sockets name them inside this directory.
  udsTestSocketDir = await mkdtemp(join(tmpdir(), "dyfj-uds-"));
  // The tests' own temp files go under TMPDIR, pointed at this directory and
  // removed with it. Its real path is what is exported: the code under test
  // resolves real paths, and on macOS the temp root /tmp is a symlink to
  // /private/tmp.
  testTempDir = await realpath(await mkdtemp(join(tmpdir(), "dyfj-test-")));
  const testEnv = {
    ...env,
    DYFJ_MCP_TEST_TEMP_DIR: mcpTestTempDir,
    [UDS_TEST_SOCKET_DIR_ENV]: udsTestSocketDir,
    TMPDIR: testTempDir,
  };
  const nodeRun = startNodeTests({
    lane: "integration",
    files: integrationFiles,
    cwd: prototypeRoot,
    env: integrationChildEnvironment(testEnv),
    // The files share one Dolt fixture, so they run one at a time.
    jobs: 1,
  });
  const stopNode = () => nodeRun.kill();
  abortController.signal.addEventListener("abort", stopNode, { once: true });
  const nodeCode = await nodeRun.code;
  abortController.signal.removeEventListener("abort", stopNode);
  throwIfAborted(abortController.signal);
  if (nodeCode !== 0) {
    throw new Error(
      `node --test over the integration files failed with ${nodeCode}`,
    );
  }
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
  if (!abortController.signal.aborted) failure = error;
} finally {
  try {
    await fixture?.cleanup();
    if (mcpTestTempDir !== undefined) {
      await rm(mcpTestTempDir, { recursive: true });
    }
    if (udsTestSocketDir !== undefined) {
      await rm(udsTestSocketDir, { recursive: true });
    }
    if (testTempDir !== undefined) {
      await rm(testTempDir, { recursive: true });
    }
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  } finally {
    backstop.clear();
    // Every step has ended, and the fixture is stopped or its cleanup failed:
    // either way a gate lane now stops its own process group, so a same-group
    // descendant does not outlive the lane.
    await stopOwnGroup(supervision);
  }
}

if (backstop.expired) {
  console.error(
    backstopMessage("the integration lane", supervision!, backstop),
  );
  process.exit(1);
}
if (interruptedExitCode !== undefined) process.exit(interruptedExitCode);
if (failure !== undefined) throw failure;
