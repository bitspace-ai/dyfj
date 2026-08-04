#!/usr/bin/env -S deno run --allow-env=PATH,HOME,TMPDIR,TEMP,TMP,CARGO_HOME,RUSTUP_HOME --allow-read=. --allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders --allow-run=deno,cargo,dolt --allow-net=127.0.0.1
export interface GateLane {
  label: string;
  command: string;
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

const decoder = new TextDecoder();
const inheritedEnvironmentNames = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CARGO_HOME",
  "RUSTUP_HOME",
];

function formatCommand(lane: GateLane): string {
  return [lane.command, ...lane.args].join(" ");
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

async function outputOrAbort(
  child: ReturnType<Deno.Command["spawn"]>,
  signal: AbortSignal | undefined,
): Promise<{ output?: Deno.CommandOutput; aborted: boolean }> {
  const output = child.output();
  if (!signal) return { output: await output, aborted: false };
  if (signal.aborted) {
    await stopChild(child);
    return { aborted: true };
  }

  let onAbort: (() => void) | undefined;
  const result = await Promise.race([
    output.then((value) => ({ type: "output" as const, value })),
    new Promise<{ type: "aborted" }>((resolve) => {
      onAbort = () => resolve({ type: "aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }),
  ]);
  if (onAbort) signal.removeEventListener("abort", onAbort);
  if (result.type === "output") return { output: result.value, aborted: false };

  await stopChild(child);
  return { aborted: true };
}

export function productionLanes(root = Deno.cwd()): GateLane[] {
  const prototype = `${root}/prototype`;
  const core = `${root}/core`;
  return [
    {
      label: "Aggregate gate orchestration tests",
      command: "deno",
      args: [
        "test",
        "--allow-env=PATH,HOME,TMPDIR,TEMP,TMP,CARGO_HOME,RUSTUP_HOME,DYFJ_AGGREGATE_SENTINEL",
        "--allow-read=.",
        "--allow-run=deno",
        "scripts/aggregate-test-gate.test.ts",
      ],
      cwd: root,
    },
    {
      label: "Prototype source typecheck",
      command: "deno",
      args: [
        "check",
        "--sloppy-imports",
        "src/http.ts",
        "src/workbench.ts",
        "src/jsonrpc.ts",
        "src/jsonrpc-peer.ts",
        "src/uds-server.ts",
        "src/uds-path.ts",
        "src/uds-client.ts",
        "src/uds-serve.ts",
        "src/mcp-client.ts",
        "mcp/server.ts",
        "src/cli.ts",
        "scripts/isolated-dolt-fixture.ts",
        "scripts/isolated-dolt-integration.ts",
      ],
      cwd: prototype,
    },
    {
      label: "Prototype test-file typecheck",
      command: "deno",
      args: ["task", "check:tests"],
      cwd: prototype,
    },
    {
      label: "Prototype unit Vitest suite",
      command: "deno",
      args: [
        "run",
        "-P=test",
        "--allow-read=.,..,/tmp,/private/tmp,/var/folders,/private/var/folders",
        "--allow-write=.,/tmp,/private/tmp,/var/folders,/private/var/folders",
        "npm:vitest@3.2.6",
        "run",
        "--root",
        ".",
        "--pool=threads",
        "--exclude",
        "**/*.integration.test.ts",
      ],
      cwd: prototype,
      env: { TMPDIR: "/tmp" },
    },
    {
      label: "Schema unit tests",
      command: "deno",
      args: ["test", "--allow-read=schema", "schema/validate-schema.test.ts"],
      cwd: root,
    },
    {
      label: "Current-schema apply validation",
      command: "deno",
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
      command: "deno",
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
      label: "Database-free Rust tests",
      command: "cargo",
      args: ["test"],
      cwd: core,
      env: { SQLX_OFFLINE: "true" },
    },
    {
      label: "Isolated Dolt integration lane",
      command: "deno",
      args: [
        "run",
        "--allow-env=PATH,HOME,TMPDIR,TEMP,TMP,DENO_BIN,DYFJ_ROOT",
        "--allow-read=.,..",
        "--allow-write=/tmp,/private/tmp,/var/folders,/private/var/folders,.",
        "--allow-run=deno,dolt,cargo",
        "--allow-net=127.0.0.1",
        "scripts/isolated-dolt-integration.ts",
      ],
      cwd: prototype,
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
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const result = await outputOrAbort(child, options.signal);
      const elapsedMs = Math.round(performance.now() - start);
      if (result.aborted) {
        out.error(`✗ ${lane.label}: interrupted (${elapsedMs}ms)`);
        return interruptedExitCode(options.signal!);
      }
      const output = result.output!;
      const stdout = decoder.decode(output.stdout);
      const stderr = decoder.decode(output.stderr);
      if (stdout) out.log(stdout.trimEnd());
      if (stderr) out.error(stderr.trimEnd());
      if (output.code !== 0) {
        out.error(
          `✗ ${lane.label}: failure (${elapsedMs}ms, exit ${output.code})`,
        );
        return output.code || 1;
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
