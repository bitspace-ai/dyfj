type DirEntryLike = Pick<Deno.DirEntry, "name" | "isFile">;

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type SchemaDirectory = "current" | "catalog" | "migrations" | "history";

export type SchemaApplyPlan = Record<SchemaDirectory, string[]>;

const schemaDirectories: SchemaDirectory[] = [
  "current",
  "catalog",
  "migrations",
  "history",
];

const decoder = new TextDecoder();
const encoder = new TextEncoder();

class SchemaValidationInterruptedError extends Error {
  constructor() {
    super("schema validation interrupted");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SchemaValidationInterruptedError();
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
    throw new SchemaValidationInterruptedError();
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
  throw new SchemaValidationInterruptedError();
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

export function assertEventsTablePresent(output: string): void {
  if (!/\bevents\b/.test(output)) {
    throw new Error("events table was not found after schema validation");
  }
}

async function runCommand(
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

async function runChecked(
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

async function readSchemaApplyPlan(schemaDir: URL): Promise<SchemaApplyPlan> {
  const entriesByDirectory: Partial<Record<SchemaDirectory, Deno.DirEntry[]>> =
    {};

  for (const directory of schemaDirectories) {
    entriesByDirectory[directory] = await readDirectoryEntries(
      new URL(`${directory}/`, schemaDir),
    );
  }

  return buildSchemaApplyPlan(entriesByDirectory);
}

async function initDoltRepository(
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

async function validateFileSequence(
  schemaDir: URL,
  files: string[],
  label: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  const tempDir = await Deno.makeTempDir({
    prefix: "dyfj-schema-validate-",
  });
  console.log(`Validating ${label}: ${files.length} files in ${tempDir}`);

  try {
    await initDoltRepository(tempDir, signal);

    for (const file of files) {
      throwIfAborted(signal);
      console.log(`Applying schema/${file}`);
      await runChecked("dolt", ["sql"], {
        cwd: tempDir,
        input: await Deno.readTextFile(new URL(file, schemaDir)),
        label: `schema/${file}`,
        signal,
      });
    }

    const tables = await runChecked("dolt", [
      "sql",
      "-q",
      "SHOW TABLES LIKE 'events'",
    ], {
      cwd: tempDir,
      label: "SHOW TABLES LIKE 'events'",
      signal,
    });
    assertEventsTablePresent(tables.stdout);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

export type SchemaValidationScope = "all" | "current" | "history";

export function parseSchemaValidationScope(
  args: string[],
): SchemaValidationScope {
  if (args.length > 1) {
    throw new Error(
      "usage: validate-schema.ts [--current-only|--history-only]",
    );
  }
  const argument = args[0];
  if (argument === undefined) return "all";
  if (argument === "--current-only") return "current";
  if (argument === "--history-only") return "history";
  throw new Error(
    "usage: validate-schema.ts [--current-only|--history-only]",
  );
}

export async function validateSchema(
  scope: SchemaValidationScope = "all",
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const schemaDir = new URL("./", import.meta.url);
  const plan = await readSchemaApplyPlan(schemaDir);
  assertSchemaApplyPlan(plan);

  const currentFiles = [
    ...plan.current,
    ...plan.catalog,
  ];
  if (scope === "all" || scope === "current") {
    await validateFileSequence(
      schemaDir,
      currentFiles,
      "current schema",
      signal,
    );
  }
  // Forward migrations are an upgrade path for pre-baseline databases, so they
  // are validated on top of the historical replay end-state (the old-world
  // shape), not on top of the baseline they are already folded into.
  if (scope === "all" || scope === "history") {
    await validateFileSequence(
      schemaDir,
      [...plan.history, ...plan.migrations],
      "historical replay + forward migrations",
      signal,
    );
  }

  throwIfAborted(signal);
  console.log("Schema validation passed.");
}

if (import.meta.main) {
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
  let exitCode = 0;
  try {
    await validateSchema(
      parseSchemaValidationScope(Deno.args),
      abortController.signal,
    );
    if (interruptedExitCode !== undefined) exitCode = interruptedExitCode;
  } catch (error) {
    if (interruptedExitCode !== undefined) {
      exitCode = interruptedExitCode;
    } else {
      console.error(error instanceof Error ? error.message : error);
      exitCode = 1;
    }
  } finally {
    Deno.removeSignalListener("SIGINT", onSigint);
    Deno.removeSignalListener("SIGTERM", onSigterm);
  }
  if (exitCode !== 0) Deno.exit(exitCode);
}
