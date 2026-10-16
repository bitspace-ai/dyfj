import {
  seedFixtureMemories,
  startIsolatedDoltFixture,
} from "./isolated-dolt-fixture.ts";
import { integrationChildEnvironment } from "./integration-child-environment.ts";
import { selectedDenoExecutable } from "./deno-executable.ts";
import { discoverIntegrationTests, partitionByRuntime } from "./test-files.ts";
import { requireNode, startNodeTests } from "./node-test-lane.ts";
import {
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
// Under the gate: a token carrier for the whole run, and past the backstop,
// stop the step in progress (its child is signalled by pid) and clean up as
// on an interruption. A step or cleanup that does not observe the abort is
// ended by the backstop's own exit.
const supervision = laneSupervision();
startTokenCarrier(supervision, denoExecutable);
const backstop = startBackstop(
  supervision,
  denoExecutable,
  () => abortController.abort(),
);
let failure: unknown;

let fixture: Awaited<ReturnType<typeof startIsolatedDoltFixture>> | undefined;
let mcpTestTempDir: string | undefined;
let udsTestSocketDir: string | undefined;
let denoTestTempDir: string | undefined;
try {
  // Product integration files run under `node --test`; the gate-tooling
  // files under `scripts/` that register with the existing runner run under
  // `deno test` until the gate-tooling port (`test-files.ts`). A product file
  // that registers with the existing runner fails here, before the fixture.
  const integrationFiles = partitionByRuntime(
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
    DENO_BIN: denoExecutable,
  };
  mcpTestTempDir = await Deno.makeTempDir({ prefix: "dyfj-mcp-roundtrip-" });
  // The files that bind real Unix sockets name them inside this directory.
  udsTestSocketDir = await Deno.makeTempDir({ prefix: "dyfj-uds-" });
  // The tests' own temp files go under TMPDIR, pointed at this directory, so
  // the gate-tooling subset's read and write grants cover it alone. Its real
  // path is what is granted and exported: the code under test resolves real
  // paths, and on macOS the temp root /tmp is a symlink to /private/tmp.
  denoTestTempDir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "dyfj-deno-test-" }),
  );
  // Both subsets get this environment; the Node subset also runs the product
  // through DENO_BIN, which `env` carries.
  const testEnv = {
    ...env,
    DYFJ_MCP_TEST_TEMP_DIR: mcpTestTempDir,
    [UDS_TEST_SOCKET_DIR_ENV]: udsTestSocketDir,
    TMPDIR: denoTestTempDir,
  };
  // The product tests run after a failing gate-tooling subset too, so one run
  // reports both; the first failure is the lane's.
  let subsetFailure: unknown;
  // The gate-tooling subset, until the gate-tooling port.
  if (integrationFiles.deno.length > 0) {
    await runChecked(denoExecutable, [
      "test",
      // Ungranted access throws instead of prompting, as it does in CI, so a
      // local run from a terminal never parks on a permission prompt.
      "--no-prompt",
      // The pinned Deno runs the op and resource sanitizers only when asked.
      // They fail the test that leaks a timer or an op or resource the runtime
      // tracks, but they do not see `node:` servers, sockets or child
      // processes (`specs/03-testing.md` §2).
      "--sanitize-ops",
      "--sanitize-resources",
      // The grants of the gate-tooling subset, until the gate-tooling port.
      // The isolated Dolt fixture's own tests start throwaway fixtures: they
      // read the fixture environment (TMPDIR, TEMP, TMP) and the schema, make
      // their temp roots under TMPDIR (the per-run directory above), run
      // `dolt` and connect to 127.0.0.1. The launcher test pins its
      // children's Deno cache through DENO_DIR and reads the Codex profile
      // inputs (DYFJ_NODE_PATH and the toolchain directories), which stay
      // unset here; so does the `deno.json` task-string test.
      `--allow-env=HOME,LOGNAME,PATH,SHELL,TERM,USER,OSTYPE,NODE_V8_COVERAGE,DOLT_HOST,DOLT_PORT,DOLT_USER,DOLT_PASSWORD,DOLT_DATABASE,DENO_BIN,DENO_DIR,DYFJ_ROOT,TMPDIR,TEMP,TMP,DYFJ_NODE_PATH,DYFJ_CODEX_TOOLCHAIN_PATH,DYFJ_CODEX_RUSTUP_HOME`,
      `--allow-read=.,../schema,${denoTestTempDir}`,
      `--allow-write=${denoTestTempDir}`,
      // bash, /bin/bash: the launcher script and its symlink setup. /bin/sh:
      // the `deno.json` task strings under test. ln: symlink fixtures
      // (`Deno.symlink` needs unscoped read and write). /bin/ps, /bin/kill:
      // reaping a launcher-started runtime (`testing/processes.ts`). dolt:
      // the fixture tests. python3: a pseudo-terminal (its `pty` module) for
      // the launcher cases that need an interactive session.
      `--allow-run=${denoExecutable},/bin/kill,/bin/ps,/bin/sh,dolt,bash,/bin/bash,ln,python3`,
      "--allow-net=127.0.0.1",
      // The gate-tooling `*.integration.test.ts` files on the existing
      // runner; every other integration file runs in the Node subset.
      ...integrationFiles.deno,
    ], {
      cwd: prototypeRoot,
      env: testEnv,
      signal: abortController.signal,
    }).catch((error) => {
      if (abortController.signal.aborted) throw error;
      subsetFailure = error;
    });
  }
  const nodeRun = startNodeTests({
    lane: "integration",
    files: integrationFiles.node,
    cwd: prototypeRoot,
    env: integrationChildEnvironment(testEnv),
    // The files run one at a time, as the first subset's do.
    jobs: 1,
  });
  const stopNode = () => nodeRun.kill();
  abortController.signal.addEventListener("abort", stopNode, { once: true });
  const nodeCode = await nodeRun.code;
  abortController.signal.removeEventListener("abort", stopNode);
  throwIfAborted(abortController.signal);
  if (subsetFailure !== undefined) throw subsetFailure;
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
      await Deno.remove(mcpTestTempDir, { recursive: true });
    }
    if (udsTestSocketDir !== undefined) {
      await Deno.remove(udsTestSocketDir, { recursive: true });
    }
    if (denoTestTempDir !== undefined) {
      await Deno.remove(denoTestTempDir, { recursive: true });
    }
    Deno.removeSignalListener("SIGINT", onSigint);
    Deno.removeSignalListener("SIGTERM", onSigterm);
  } finally {
    backstop.clear();
    // Every step has ended, and the fixture is stopped or its cleanup failed:
    // either way a gate lane now stops its own process group, so a same-group
    // descendant does not outlive the lane.
    await stopOwnGroup(supervision, denoExecutable);
  }
}

if (backstop.expired) {
  console.error(
    `dyfj: the integration lane passed its backstop deadline (${
      supervision!.backstopMs
    } ms)`,
  );
  Deno.exit(1);
}
if (interruptedExitCode !== undefined) Deno.exit(interruptedExitCode);
if (failure !== undefined) throw failure;
