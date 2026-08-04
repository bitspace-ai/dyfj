import mysql from "mysql2/promise";

export interface IsolatedDoltFixture {
  root: string;
  database: string;
  port: number;
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

export interface IsolatedDoltFixtureOptions {
  repoRoot: string;
  prefix?: string;
  signal?: AbortSignal;
  afterReady?: (fixture: Omit<IsolatedDoltFixture, "cleanup">) => Promise<void>;
}

type Child = ReturnType<Deno.Command["spawn"]>;

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const shutdownTimeoutMs = 2_000;
const readinessTimeoutMs = 10_000;
const bindAttempts = 3;
const fixtureEnvironmentNames = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP"];

function fixtureEnvironment(): Record<string, string> {
  return Object.fromEntries(
    fixtureEnvironmentNames.flatMap((name) => {
      const value = Deno.env.get(name);
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

interface FixturePool {
  execute(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

function createFixturePool(env: Record<string, string>): FixturePool {
  // Deno's npm declaration bridge drops mysql2's mixed-in promise methods.
  return mysql.createPool({
    host: env.DOLT_HOST,
    port: Number(env.DOLT_PORT),
    user: env.DOLT_USER,
    password: env.DOLT_PASSWORD,
    database: env.DOLT_DATABASE,
    connectionLimit: 1,
  }) as unknown as FixturePool;
}

class FixtureSetupAbortedError extends Error {
  constructor() {
    super("isolated Dolt fixture setup interrupted");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new FixtureSetupAbortedError();
}

async function outputOrAbort(
  child: Child,
  signal: AbortSignal | undefined,
): Promise<Deno.CommandOutput> {
  const output = child.output();
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
  const child = new Deno.Command(command, {
    args,
    cwd: options.cwd,
    clearEnv: true,
    env: fixtureEnvironment(),
    stdin: options.input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (options.input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(encoder.encode(options.input));
    await writer.close();
  }
  const output = await outputOrAbort(child, options.signal);
  const stdout = decoder.decode(output.stdout);
  const stderr = decoder.decode(output.stderr);
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
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function waitForSql(
  env: Record<string, string>,
  signal: AbortSignal | undefined,
  timeoutMs = readinessTimeoutMs,
): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    throwIfAborted(signal);
    try {
      const pool = createFixturePool(env);
      await pool.execute("SELECT 1");
      await pool.end();
      return;
    } catch (error) {
      lastError = error;
      throwIfAborted(signal);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(
    `Dolt SQL server did not become ready: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function stopChild(child: Child): Promise<void> {
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
          shutdownTimeoutMs,
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

async function applySqlFiles(
  root: string,
  schemaRoot: string,
  directories: string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  for (const directory of directories) {
    throwIfAborted(signal);
    const files: string[] = [];
    for await (const entry of Deno.readDir(`${schemaRoot}/${directory}`)) {
      if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
    }
    for (const file of files.sort()) {
      throwIfAborted(signal);
      await runChecked("dolt", ["sql"], {
        cwd: root,
        input: await Deno.readTextFile(`${schemaRoot}/${directory}/${file}`),
        signal,
      });
    }
  }
}

function databaseNameFor(root: string): string {
  const name = root.split("/").at(-1);
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
    const child = new Deno.Command("dolt", {
      args: [
        "sql-server",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      cwd: root,
      clearEnv: true,
      env: fixtureEnvironment(),
      stdout: "piped",
      stderr: "piped",
    }).spawn();
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
  const root = await Deno.makeTempDir({
    prefix: options.prefix ?? "dyfj_fixture_",
  });
  let child: Child | undefined;
  let cleaned = false;
  try {
    throwIfAborted(options.signal);
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
        cleaned = true;
        if (child) await stopChild(child);
        await Deno.remove(root, { recursive: true });
      },
    };
  } catch (error) {
    if (child) await stopChild(child);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
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
