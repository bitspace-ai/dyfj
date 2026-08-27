import { selectedDenoExecutable } from "../prototype/scripts/deno-executable.ts";

export interface GateLane {
  label: string;
  command: string;
  commandLabel?: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface RunGateOptions {
  root?: string;
  lanes?: GateLane[];
  out?: Pick<Console, "log" | "error">;
  signal?: AbortSignal;
}

const inheritedEnvironmentNames = [
  "PATH",
  "HOME",
  "CARGO_HOME",
  "RUSTUP_HOME",
];
const laneShutdownTimeoutMs = 10_000;

function formatCommand(lane: GateLane): string {
  return [lane.commandLabel ?? lane.command, ...lane.args].join(" ");
}

function safeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    inheritedEnvironmentNames.flatMap((name) => {
      const value = Deno.env.get(name);
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function interruptedExitCode(signal: AbortSignal): number {
  return signal.reason === "SIGTERM" ? 143 : 130;
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
        setTimeout(
          () => reject(new Error("shutdown timeout")),
          laneShutdownTimeoutMs,
        )
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
  signal: AbortSignal | undefined,
): Promise<{ status?: Deno.CommandStatus; aborted: boolean }> {
  const status = child.status;
  if (!signal) return { status: await status, aborted: false };
  if (signal.aborted) {
    await stopChild(child);
    return { aborted: true };
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
  if (result.type === "status") return { status: result.value, aborted: false };

  await stopChild(child);
  return { aborted: true };
}

export function productionLanes(
  root = Deno.cwd(),
  denoExecutable = selectedDenoExecutable(),
): GateLane[] {
  const prototype = `${root}/prototype`;
  const core = `${root}/core`;
  const home = Deno.env.get("HOME");
  const homeRun = home !== undefined && home.startsWith("/")
    ? `,${home}/.dyfj/run`
    : "";
  return [
    {
      label: "Retired-surface scan",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "test",
        `--allow-read=${root}`,
        "--allow-run=git",
        "scripts/retired-surface-scan.ts",
      ],
      cwd: root,
    },
    {
      label: "Aggregate gate orchestration tests",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "test",
        "--allow-env=PATH,HOME,TMPDIR,TEMP,TMP,CARGO_HOME,RUSTUP_HOME,DYFJ_AGGREGATE_SENTINEL",
        "--allow-read=.",
        "--allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders",
        `--allow-run=${denoExecutable},ln`,
        "scripts/aggregate-test-gate.test.ts",
      ],
      cwd: root,
    },
    {
      label: "Prototype source typecheck",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "check",
        "--sloppy-imports",
        "src/workbench.ts",
        "src/jsonrpc.ts",
        "src/jsonrpc-peer.ts",
        "src/uds-server.ts",
        "src/uds-path.ts",
        "src/uds-client.ts",
        "src/uds-serve.ts",
        "mcp/server.ts",
        "src/cli.ts",
        "scripts/esbuild-binary.ts",
        "scripts/deno-executable.ts",
        "scripts/integration-child-environment.ts",
        "scripts/run-vitest.ts",
        "scripts/test-process-harness.ts",
        "scripts/test-process-reaper.ts",
        "scripts/isolated-dolt-fixture.ts",
        "scripts/isolated-dolt-integration.ts",
      ],
      cwd: prototype,
    },
    {
      label: "Prototype test-file typecheck",
      command: denoExecutable,
      commandLabel: "deno",
      args: ["task", "check:tests"],
      cwd: prototype,
      env: { DENO_BIN: denoExecutable },
    },
    {
      label: "Prototype unit Vitest suite",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "run",
        "--allow-env",
        `--allow-read=.,..,/tmp,/private/tmp,/var/folders,/private/var/folders${homeRun}`,
        `--allow-write=.,/tmp,/private/tmp,/var/folders,/private/var/folders${homeRun}`,
        `--allow-run=${denoExecutable},/bin/kill,/bin/ps,/bin/bash`,
        "scripts/run-vitest.ts",
        "run",
        "--root",
        ".",
        "--pool=threads",
        "--exclude",
        "**/*.integration.{test,spec}.?(c|m)[jt]s?(x)",
      ],
      cwd: prototype,
      env: { TMPDIR: "/tmp", DENO_BIN: denoExecutable },
    },
    {
      label: "Schema unit tests",
      command: denoExecutable,
      commandLabel: "deno",
      args: ["test", "--allow-read=schema", "schema/validate-schema.test.ts"],
      cwd: root,
    },
    {
      label: "Current-schema apply validation",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "run",
        "--allow-read=schema",
        "--allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders",
        "--allow-run=dolt",
        "schema/validate-schema.ts",
        "--current-only",
      ],
      cwd: root,
    },
    {
      label: "Historical replay plus forward-migration validation",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "run",
        "--allow-read=schema",
        "--allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders",
        "--allow-run=dolt",
        "schema/validate-schema.ts",
        "--history-only",
      ],
      cwd: root,
    },
    {
      label: "Offline-metadata Rust tests",
      command: "cargo",
      args: ["test"],
      cwd: core,
      env: { SQLX_OFFLINE: "true" },
    },
    {
      label: "Isolated Dolt integration lane",
      command: denoExecutable,
      commandLabel: "deno",
      args: [
        "run",
        "--allow-env=PATH,HOME,TMPDIR,TEMP,TMP,CARGO_HOME,RUSTUP_HOME,DENO_BIN,DYFJ_ROOT",
        "--allow-read=.,..",
        "--allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders,.",
        `--allow-run=${denoExecutable},dolt,cargo`,
        "--allow-net=127.0.0.1",
        "scripts/isolated-dolt-integration.ts",
      ],
      cwd: prototype,
      env: { TMPDIR: "/tmp", DENO_BIN: denoExecutable },
    },
  ];
}

export async function runGate(options: RunGateOptions = {}): Promise<number> {
  const out = options.out ?? console;
  const lanes = options.lanes ?? productionLanes(options.root ?? Deno.cwd());
  for (const lane of lanes) {
    if (options.signal?.aborted) return interruptedExitCode(options.signal);
    const commandText = formatCommand(lane);
    const start = performance.now();
    out.log(`▶ ${lane.label}: ${commandText}`);
    try {
      const child = new Deno.Command(lane.command, {
        args: lane.args,
        cwd: lane.cwd,
        env: { ...safeEnvironment(), ...(lane.env ?? {}) },
        clearEnv: true,
        stdout: "inherit",
        stderr: "inherit",
      }).spawn();
      const result = await statusOrAbort(child, options.signal);
      const elapsedMs = Math.round(performance.now() - start);
      if (result.aborted) {
        out.error(`✗ ${lane.label}: interrupted (${elapsedMs}ms)`);
        return interruptedExitCode(options.signal!);
      }
      const status = result.status!;
      if (status.code !== 0) {
        out.error(
          `✗ ${lane.label}: failure (${elapsedMs}ms, exit ${status.code})`,
        );
        return status.code || 1;
      }
      out.log(`✓ ${lane.label}: success (${elapsedMs}ms)`);
    } catch (error) {
      const elapsedMs = Math.round(performance.now() - start);
      out.error(
        `✗ ${lane.label}: failure (${elapsedMs}ms, unavailable: ${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return 127;
    }
  }
  if (options.signal?.aborted) return interruptedExitCode(options.signal);
  out.log("✓ aggregate test gate passed");
  return 0;
}

if (import.meta.main) {
  const abortController = new AbortController();
  const onSigint = () => abortController.abort("SIGINT");
  const onSigterm = () => abortController.abort("SIGTERM");
  Deno.addSignalListener("SIGINT", onSigint);
  Deno.addSignalListener("SIGTERM", onSigterm);
  let exitCode: number;
  try {
    exitCode = await runGate({ signal: abortController.signal });
  } finally {
    Deno.removeSignalListener("SIGINT", onSigint);
    Deno.removeSignalListener("SIGTERM", onSigterm);
  }
  Deno.exit(exitCode);
}
