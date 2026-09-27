import {
  assertSchemaApplyPlan,
  readSchemaApplyPlan,
  runChecked,
  throwIfAborted,
  withSchemaRepository,
} from "./dolt-apply.ts";

export function assertEventsTablePresent(output: string): void {
  if (!/\bevents\b/.test(output)) {
    throw new Error("events table was not found after schema validation");
  }
}

async function validateFileSequence(
  schemaDir: URL,
  files: string[],
  label: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  await withSchemaRepository(
    schemaDir,
    files,
    label,
    signal,
    async (repository) => {
      const tables = await runChecked("dolt", [
        "sql",
        "-q",
        "SHOW TABLES LIKE 'events'",
      ], {
        cwd: repository,
        label: "SHOW TABLES LIKE 'events'",
        signal,
      });
      assertEventsTablePresent(tables.stdout);
    },
  );
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
