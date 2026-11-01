// The isolated Dolt fixture: a temporary Dolt repository with the current
// schema and catalog applied and a SQL server on a free loopback port. The
// integration lane's runner starts it on the existing runtime and the golden
// harness starts it under `node --test`, so it is written to node: builtins
// and runs unchanged on either (decision D32).
import { Buffer } from "node:buffer";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import mysql from "mysql2/promise";

export interface IsolatedDoltFixture {
  pid: number;
  root: string;
  database: string;
  port: number;
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

export interface IsolatedDoltFixtureOptions {
  repoRoot: string;
  prefix?: string;
  /** Keep all disposable data under this instance root. */
  parent?: string;
  signal?: AbortSignal;
  afterReady?: (fixture: Omit<IsolatedDoltFixture, "cleanup">) => Promise<void>;
}

/** A spawned child and its exit, which rejects when it could not start. */
interface Child {
  process: ChildProcess;
  status: Promise<number | null>;
}

interface ChildOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

const shutdownTimeoutMs = 2_000;
const readinessTimeoutMs = 10_000;
const readinessProbeTimeoutMs = 1_000;
const bindAttempts = 3;
const fixtureEnvironmentNames = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP"];

function fixtureEnvironment(): Record<string, string> {
  return Object.fromEntries(
    fixtureEnvironmentNames.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

interface FixturePool {
  execute(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

interface FixtureConnection {
  execute(sql: string | { sql: string; timeout: number }): Promise<unknown>;
  end(): Promise<void>;
  destroy(): void;
}

function createFixturePool(env: Record<string, string>): FixturePool {
  // The npm declaration bridge drops mysql2's mixed-in promise methods.
  return mysql.createPool({
    host: env.DOLT_HOST,
    port: Number(env.DOLT_PORT),
    user: env.DOLT_USER,
    password: env.DOLT_PASSWORD,
    database: env.DOLT_DATABASE,
    connectionLimit: 1,
    connectTimeout: readinessProbeTimeoutMs,
  }) as unknown as FixturePool;
}

function createFixtureConnection(
  env: Record<string, string>,
): Promise<FixtureConnection> {
  return mysql.createConnection({
    host: env.DOLT_HOST,
    port: Number(env.DOLT_PORT),
    user: env.DOLT_USER,
    password: env.DOLT_PASSWORD,
    database: env.DOLT_DATABASE,
    connectTimeout: readinessProbeTimeoutMs,
  }) as unknown as Promise<FixtureConnection>;
}

class FixtureSetupAbortedError extends Error {
  constructor() {
    super("isolated Dolt fixture setup interrupted");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new FixtureSetupAbortedError();
}

function spawnChild(
  command: string,
  args: string[],
  options: { cwd: string; stdin: "ignore" | "pipe"; output: "ignore" | "pipe" },
): Child {
  const home = join(options.cwd, "home");
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: {
      ...fixtureEnvironment(),
      HOME: home,
      TMPDIR: home,
      TMP: home,
      TEMP: home,
    },
    stdio: [options.stdin, options.output, options.output],
  });
  const status = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  // A spawn failure is reported where the status is awaited; until then it
  // must not surface as an unhandled rejection.
  status.catch(() => undefined);
  return { process: child, status };
}

/** Collects a piped child's output once its streams close. */
function collectOutput(child: Child): Promise<ChildOutput> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.process.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.process.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
  const closed = new Promise<void>((resolve) =>
    child.process.once("close", () => resolve())
  );
  return child.status.then(async (code) => {
    await closed;
    return {
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
  });
}

async function outputOrAbort(
  child: Child,
  signal: AbortSignal | undefined,
): Promise<ChildOutput> {
  const output = collectOutput(child);
  if (!signal) return await output;
  if (signal.aborted) {
    await stopChild(child);
    throw new FixtureSetupAbortedError();
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
  if (result.type === "output") return result.value;

  await stopChild(child);
  await output.catch(() => undefined);
  throw new FixtureSetupAbortedError();
}

async function runChecked(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; signal?: AbortSignal },
): Promise<string> {
  throwIfAborted(options.signal);
  const child = spawnChild(command, args, {
    cwd: options.cwd,
    stdin: options.input === undefined ? "ignore" : "pipe",
    output: "pipe",
  });
  const outputPromise = outputOrAbort(child, options.signal);
  let inputError: unknown;
  if (options.input !== undefined) {
    const stdin = child.process.stdin!;
    // A write error after the first one (an early exit closes the pipe) is
    // the same failure; the listener keeps it from going unhandled.
    stdin.on("error", (error) => inputError ??= error);
    try {
      await new Promise<void>((resolve, reject) => {
        stdin.once("error", reject);
        stdin.end(options.input, () => resolve());
      });
    } catch (error) {
      inputError = error;
      await stopChild(child);
    }
  }
  const output = await outputPromise;
  if (inputError !== undefined && output.code === 0) throw inputError;
  const { stdout, stderr } = output;
  if (output.code !== 0) {
    throw new Error(
      `${command} ${
        args.join(" ")
      } failed (${output.code})\n${stdout}\n${stderr}`,
    );
  }
  return stdout;
}

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });
  const address = listener.address();
  const port = typeof address === "object" && address !== null
    ? address.port
    : 0;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

async function executeReadinessProbe(
  connection: FixtureConnection,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  throwIfAborted(signal);
  const execution = connection.execute({ sql: "SELECT 1", timeout: timeoutMs });
  if (!signal) {
    await execution;
    return;
  }

  let onAbort: (() => void) | undefined;
  const result = await Promise.race([
    execution.then(
      () => ({ type: "complete" as const }),
      (error) => ({ type: "error" as const, error }),
    ),
    new Promise<{ type: "aborted" }>((resolve) => {
      onAbort = () => resolve({ type: "aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }),
  ]);
  if (onAbort) signal.removeEventListener("abort", onAbort);
  if (result.type === "complete") return;
  if (result.type === "error") throw result.error;

  connection.destroy();
  throw new FixtureSetupAbortedError();
}

async function connectOrAbort(
  env: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<FixtureConnection> {
  const connection = createFixtureConnection(env);
  if (!signal) return await connection;

  let onAbort: (() => void) | undefined;
  const result = await Promise.race([
    connection.then(
      (value) => ({ type: "connected" as const, value }),
      (error) => ({ type: "error" as const, error }),
    ),
    new Promise<{ type: "aborted" }>((resolve) => {
      onAbort = () => resolve({ type: "aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }),
  ]);
  if (onAbort) signal.removeEventListener("abort", onAbort);
  if (result.type === "connected") return result.value;
  if (result.type === "error") throw result.error;

  void connection.then((value) => value.destroy(), () => undefined);
  throw new FixtureSetupAbortedError();
}

export async function waitForSql(
  env: Record<string, string>,
  signal: AbortSignal | undefined,
  timeoutMs = readinessTimeoutMs,
): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    throwIfAborted(signal);
    let connection: FixtureConnection | undefined;
    try {
      connection = await connectOrAbort(env, signal);
      const remainingMs = timeoutMs - (Date.now() - start);
      await executeReadinessProbe(
        connection,
        signal,
        Math.max(1, Math.min(readinessProbeTimeoutMs, remainingMs)),
      );
      return;
    } catch (error) {
      lastError = error;
      throwIfAborted(signal);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      if (connection) {
        if (signal?.aborted) connection.destroy();
        else await connection.end().catch(() => undefined);
      }
    }
  }
  throw new Error(
    `Dolt SQL server did not become ready: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function hasExited(child: Child): boolean {
  const { exitCode, signalCode, pid } = child.process;
  return pid === undefined || exitCode !== null || signalCode !== null;
}

async function stopChild(child: Child): Promise<void> {
  if (hasExited(child)) return;
  child.process.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      child.status,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("shutdown timeout")),
          shutdownTimeoutMs,
        );
      }),
    ]);
  } catch {
    // The process may have exited while the timeout elapsed.
    if (!hasExited(child)) child.process.kill("SIGKILL");
    await child.status.catch(() => undefined);
  } finally {
    // A child that exits in time must not leave the timeout pending.
    clearTimeout(timer);
  }
}

async function applySqlFiles(
  root: string,
  schemaRoot: string,
  directories: string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  for (const directory of directories) {
    throwIfAborted(signal);
    const files: string[] = [];
    const entries = await readdir(`${schemaRoot}/${directory}`, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".sql")) files.push(entry.name);
    }
    for (const file of files.sort()) {
      throwIfAborted(signal);
      await runChecked("dolt", ["sql"], {
        cwd: root,
        input: await readFile(`${schemaRoot}/${directory}/${file}`, "utf8"),
        signal,
      });
    }
  }
}

function databaseNameFor(root: string): string {
  const name = root.split(/[\\/]/).at(-1);
  if (!name || !/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(
      `fixture directory does not form a safe database name: ${root}`,
    );
  }
  return name;
}

async function startSqlServer(
  root: string,
  database: string,
  signal: AbortSignal | undefined,
): Promise<{ child: Child; env: Record<string, string>; port: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= bindAttempts; attempt++) {
    throwIfAborted(signal);
    const port = await freePort();
    const child = spawnChild("dolt", [
      "sql-server",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ], { cwd: root, stdin: "ignore", output: "ignore" });
    const env = {
      DOLT_HOST: "127.0.0.1",
      DOLT_PORT: String(port),
      DOLT_USER: "root",
      DOLT_PASSWORD: "",
      DOLT_DATABASE: database,
      DATABASE_URL: `mysql://root@127.0.0.1:${port}/${database}`,
    };
    try {
      await waitForSql(env, signal);
      return { child, env, port };
    } catch (error) {
      lastError = error;
      await stopChild(child);
      throwIfAborted(signal);
    }
  }
  throw new Error(
    `Dolt SQL server did not bind after ${bindAttempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function startIsolatedDoltFixture(
  options: IsolatedDoltFixtureOptions,
): Promise<IsolatedDoltFixture> {
  const root = await mkdtemp(
    join(options.parent ?? tmpdir(), options.prefix ?? "dyfj_fixture_"),
  );
  let child: Child | undefined;
  let cleaned = false;
  try {
    throwIfAborted(options.signal);
    await mkdir(join(root, "home"));
    await runChecked("dolt", [
      "init",
      "--name",
      "DYFJ Integration Fixture",
      "--email",
      "fixture@example.invalid",
    ], { cwd: root, signal: options.signal });
    await applySqlFiles(root, `${options.repoRoot}/schema`, [
      "current",
      "catalog",
    ], options.signal);

    throwIfAborted(options.signal);
    const database = databaseNameFor(root);
    const server = await startSqlServer(root, database, options.signal);
    child = server.child;
    const fixture = {
      pid: child.process.pid!,
      root,
      database,
      port: server.port,
      env: server.env,
    };
    await options.afterReady?.(fixture);
    throwIfAborted(options.signal);
    return {
      ...fixture,
      cleanup: async () => {
        if (cleaned) return;
        if (child) await stopChild(child);
        await rm(root, { recursive: true });
        cleaned = true;
      },
    };
  } catch (error) {
    if (child) await stopChild(child);
    try {
      await rm(root, { recursive: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "isolated Dolt fixture setup and cleanup failed",
      );
    }
    throw error;
  }
}

export async function seedFixtureMemories(
  env: Record<string, string>,
): Promise<void> {
  const pool = createFixturePool(env);
  try {
    await pool.execute(
      "INSERT INTO memories (memory_id, slug, type, visibility, inject, name, description, content) VALUES " +
        "('mem_fixture_user', 'fixture_user_private', 'user', 'private', 'always', 'Fixture Private User', 'private fixture row', 'private multiline\\ncontent')," +
        "('mem_fixture_feedback', 'fixture_feedback_shareable', 'feedback', 'shareable', 'index', 'Fixture Shareable Feedback', 'shareable fixture row', 'shareable content')," +
        "('mem_fixture_project', 'fixture_project_public', 'project', 'public', 'index', 'Fixture Public Project', 'public fixture project row', 'public project content')," +
        "('mem_fixture_reference', 'fixture_reference_client_safe', 'reference', 'client_safe', 'index', 'Fixture Client Safe Reference', 'client-safe fixture reference row', 'client-safe reference content');",
    );
  } finally {
    await pool.end();
  }
}
