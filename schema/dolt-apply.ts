/**
 * Disposable Dolt repositories for the schema tooling: read the apply plan
 * from `schema/`, create a fresh repository, apply a file sequence to it, and
 * query it. Shared by `validate-schema.ts`, `codegen.ts` and
 * `equivalence.ts`. Nothing here connects to or mutates a long-running Dolt
 * SQL server.
 *
 * Written to `node:` builtins only (decision D32), so it runs unchanged under
 * either runtime. Under the existing runtime, a `node:child_process` spawn
 * reads `NODE_V8_COVERAGE` and the forwarded variables below, so every
 * permission list that reaches this module grants them.
 */
import { Buffer } from "node:buffer";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export type DirEntryLike = { name: string; isFile: boolean };

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type SchemaDirectory = "current" | "catalog" | "migrations" | "history";

export type SchemaApplyPlan = Record<SchemaDirectory, string[]>;

const schemaDirectories: SchemaDirectory[] = [
  "current",
  "catalog",
  "migrations",
  "history",
];

// The child's whole environment. With no explicit environment,
// node:child_process copies every variable, which a grant of named
// variables forbids.
const childEnvironmentNames = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP"];

function childEnvironment(): Record<string, string> {
  return Object.fromEntries(
    childEnvironmentNames.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

export class SchemaRunInterruptedError extends Error {
  constructor() {
    super("schema run interrupted");
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SchemaRunInterruptedError();
}

/** A spawned child and its exit code, which rejects when it could not start. */
interface Child {
  process: ChildProcess;
  status: Promise<number>;
}

/**
 * A signalled exit reports 128 plus the signal number, the shell's
 * convention, which the existing runtime's process API also follows.
 */
function exitCode(code: number | null, signal: string | null): number {
  if (code !== null) return code;
  const signals: Record<string, number | undefined> = constants.signals;
  return 128 + (signal === null ? 0 : signals[signal] ?? 0);
}

function spawnChild(
  command: string,
  args: string[],
  options: { cwd: string; stdin: "ignore" | "pipe" },
): Child {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: childEnvironment(),
    stdio: [options.stdin, "pipe", "pipe"],
  });
  const status = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(exitCode(code, signal)));
  });
  // A spawn failure is reported where the status is awaited; until then it
  // must not surface as an unhandled rejection.
  status.catch(() => undefined);
  return { process: child, status };
}

function hasExited(child: Child): boolean {
  return child.process.exitCode !== null || child.process.signalCode !== null;
}

async function stopChild(child: Child): Promise<void> {
  if (hasExited(child)) return;
  try {
    child.process.kill("SIGTERM");
  } catch {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      child.status,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("shutdown timeout")), 2_000);
      }),
    ]);
  } catch {
    // The process may have exited while the timeout elapsed.
    if (!hasExited(child)) child.process.kill("SIGKILL");
    await child.status.catch(() => undefined);
  } finally {
    clearTimeout(timer);
  }
}

/** Collects a piped child's output once its streams close. */
function collectOutput(child: Child): Promise<CommandResult> {
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
): Promise<CommandResult> {
  const output = collectOutput(child);
  if (!signal) return await output;
  if (signal.aborted) {
    await stopChild(child);
    await output.catch(() => undefined);
    throw new SchemaRunInterruptedError();
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
  throw new SchemaRunInterruptedError();
}

export function migrationFileNames(entries: Iterable<DirEntryLike>): string[] {
  return Array.from(entries)
    .filter((entry) => entry.isFile && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

function prefixedFileNames(
  directory: SchemaDirectory,
  entries: Iterable<DirEntryLike> | undefined,
): string[] {
  return migrationFileNames(entries ?? [])
    .map((fileName) => `${directory}/${fileName}`);
}

export function buildSchemaApplyPlan(
  entriesByDirectory: Partial<Record<SchemaDirectory, Iterable<DirEntryLike>>>,
): SchemaApplyPlan {
  return {
    current: prefixedFileNames("current", entriesByDirectory.current),
    catalog: prefixedFileNames("catalog", entriesByDirectory.catalog),
    migrations: prefixedFileNames("migrations", entriesByDirectory.migrations),
    history: prefixedFileNames("history", entriesByDirectory.history),
  };
}

export function assertSchemaApplyPlan(plan: SchemaApplyPlan): void {
  if (plan.current.length === 0) {
    throw new Error("no schema/current/*.sql baseline files found");
  }
  if (plan.history.length === 0) {
    throw new Error("no schema/history/*.sql replay files found");
  }
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; signal?: AbortSignal },
): Promise<CommandResult> {
  throwIfAborted(options.signal);
  const child = spawnChild(command, args, {
    cwd: options.cwd,
    stdin: options.input === undefined ? "ignore" : "pipe",
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
  return output;
}

export async function runChecked(
  command: string,
  args: string[],
  options: {
    cwd: string;
    input?: string;
    label: string;
    signal?: AbortSignal;
  },
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      [
        `${options.label} failed with exit code ${result.code}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ].filter(Boolean).join("\n"),
    );
  }

  return result;
}

async function readDirectoryEntries(
  directory: URL,
): Promise<DirEntryLike[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
    }));
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function readSchemaApplyPlan(
  schemaDir: URL,
): Promise<SchemaApplyPlan> {
  const entriesByDirectory: Partial<Record<SchemaDirectory, DirEntryLike[]>> =
    {};

  for (const directory of schemaDirectories) {
    entriesByDirectory[directory] = await readDirectoryEntries(
      new URL(`${directory}/`, schemaDir),
    );
  }

  return buildSchemaApplyPlan(entriesByDirectory);
}

export async function initDoltRepository(
  tempDir: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  await runChecked("dolt", [
    "init",
    "--name",
    "DYFJ Schema Validation",
    "--email",
    "schema-validation@example.invalid",
  ], {
    cwd: tempDir,
    label: "dolt init",
    signal,
  });
}

/**
 * Apply `files` (paths relative to `schemaDir`) to a fresh repository, run
 * `use` against it, and remove it afterwards.
 */
export async function withSchemaRepository<T>(
  schemaDir: URL,
  files: readonly string[],
  label: string,
  signal: AbortSignal | undefined,
  use: (repository: string) => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  const repository = await mkdtemp(join(tmpdir(), "dyfj-schema-"));
  console.log(`Applying ${label}: ${files.length} files in ${repository}`);
  try {
    await initDoltRepository(repository, signal);
    for (const file of files) {
      throwIfAborted(signal);
      console.log(`Applying schema/${file}`);
      await runChecked("dolt", ["sql"], {
        cwd: repository,
        input: await readFile(new URL(file, schemaDir), "utf8"),
        label: `schema/${file}`,
        signal,
      });
    }
    return await use(repository);
  } finally {
    await rm(repository, { recursive: true });
  }
}

/**
 * Run one query against a repository and return its rows. Dolt's JSON output
 * omits NULL columns and prints nothing for an empty result.
 */
export async function queryRows(
  repository: string,
  sql: string,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>[]> {
  const result = await runChecked("dolt", ["sql", "-r", "json", "-q", sql], {
    cwd: repository,
    label: sql,
    signal,
  });
  const text = result.stdout.trim();
  if (text === "") return [];
  const parsed = JSON.parse(text) as { rows?: Record<string, unknown>[] };
  return parsed.rows ?? [];
}
