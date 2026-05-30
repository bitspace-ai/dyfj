type DirEntryLike = Pick<Deno.DirEntry, "name" | "isFile">;

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function migrationFileNames(entries: Iterable<DirEntryLike>): string[] {
  return Array.from(entries)
    .filter((entry) => entry.isFile && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
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

export async function validateSchema(): Promise<void> {
  const schemaDir = new URL("./", import.meta.url);
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(schemaDir)) {
    entries.push(entry);
  }

  const files = migrationFileNames(entries);
  if (files.length === 0) {
    throw new Error("no schema/*.sql files found");
  }

  const tempDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "dyfj-schema-validate-",
  });
  console.log(`Validating ${files.length} schema migrations in ${tempDir}`);

  try {
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
