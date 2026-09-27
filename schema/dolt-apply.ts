/**
 * Disposable Dolt repositories for the schema tooling: read the apply plan
 * from `schema/`, create a fresh repository, apply a file sequence to it, and
 * query it. Shared by `validate-schema.ts`, `codegen.ts` and
 * `equivalence.ts`. Nothing here connects to or mutates a long-running Dolt
 * SQL server.
 */

export type DirEntryLike = Pick<Deno.DirEntry, "name" | "isFile">;

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

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class SchemaRunInterruptedError extends Error {
  constructor() {
    super("schema run interrupted");
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SchemaRunInterruptedError();
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
): Promise<Deno.CommandOutput> {
  const output = child.output();
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
  const child = new Deno.Command(command, {
    args,
    cwd: options.cwd,
    stdin: options.input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const outputPromise = outputOrAbort(child, options.signal);
  let inputError: unknown;
  if (options.input !== undefined) {
    const writer = child.stdin.getWriter();
    try {
      await writer.write(encoder.encode(options.input));
      await writer.close();
    } catch (error) {
      inputError = error;
      await stopChild(child);
    } finally {
      writer.releaseLock();
    }
  }

  const output = await outputPromise;
  if (inputError !== undefined && output.code === 0) throw inputError;

  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
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
): Promise<Deno.DirEntry[]> {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(directory)) {
      entries.push(entry);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return [];
    }
    throw error;
  }

  return entries;
}

export async function readSchemaApplyPlan(
  schemaDir: URL,
): Promise<SchemaApplyPlan> {
  const entriesByDirectory: Partial<Record<SchemaDirectory, Deno.DirEntry[]>> =
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
  const repository = await Deno.makeTempDir({ prefix: "dyfj-schema-" });
  console.log(`Applying ${label}: ${files.length} files in ${repository}`);
  try {
    await initDoltRepository(repository, signal);
    for (const file of files) {
      throwIfAborted(signal);
      console.log(`Applying schema/${file}`);
      await runChecked("dolt", ["sql"], {
        cwd: repository,
        input: await Deno.readTextFile(new URL(file, schemaDir)),
        label: `schema/${file}`,
        signal,
      });
    }
    return await use(repository);
  } finally {
    await Deno.remove(repository, { recursive: true });
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
