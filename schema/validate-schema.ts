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
  options: { cwd: string; input?: string },
): Promise<CommandResult> {
  const child = new Deno.Command(command, {
    args,
    cwd: options.cwd,
    stdin: options.input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  if (options.input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(encoder.encode(options.input));
    await writer.close();
  }

  const output = await child.output();

  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

async function runChecked(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; label: string },
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

async function initDoltRepository(tempDir: string): Promise<void> {
  await runChecked("dolt", [
    "init",
    "--name",
    "DYFJ Schema Validation",
    "--email",
    "schema-validation@example.invalid",
  ], {
    cwd: tempDir,
    label: "dolt init",
  });
}

async function validateFileSequence(
  schemaDir: URL,
  files: string[],
  label: string,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "dyfj-schema-validate-",
  });
  console.log(`Validating ${label}: ${files.length} files in ${tempDir}`);

  try {
    await initDoltRepository(tempDir);

    for (const file of files) {
      console.log(`Applying schema/${file}`);
      await runChecked("dolt", ["sql"], {
        cwd: tempDir,
        input: await Deno.readTextFile(new URL(file, schemaDir)),
        label: `schema/${file}`,
      });
    }

    const tables = await runChecked("dolt", [
      "sql",
      "-q",
      "SHOW TABLES LIKE 'events'",
    ], {
      cwd: tempDir,
      label: "SHOW TABLES LIKE 'events'",
    });
    assertEventsTablePresent(tables.stdout);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

export async function validateSchema(): Promise<void> {
  const schemaDir = new URL("./", import.meta.url);
  const plan = await readSchemaApplyPlan(schemaDir);
  assertSchemaApplyPlan(plan);

  const currentFiles = [
    ...plan.current,
    ...plan.catalog,
    ...plan.migrations,
  ];
  await validateFileSequence(schemaDir, currentFiles, "current schema");
  await validateFileSequence(schemaDir, plan.history, "historical replay");

  console.log("Schema validation passed.");
}

if (import.meta.main) {
  try {
    await validateSchema();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }
}
