// Typechecks a glob-derived file list (`scripts/test-files.ts`). `sources`
// covers every non-test module under the source roots; `tests` covers every
// test file of either framework. Both the `check` task and the aggregate gate
// run this script, so there is no hand-maintained list to drift.
import { assertIntegrationTestAssignments } from "./integration-test-assignment.ts";
import { selectedDenoExecutable } from "./deno-executable.ts";
import { discoverTestSources, discoverTypecheckSources } from "./test-files.ts";

export type TypecheckScope = "sources" | "tests";

export function parseTypecheckScope(args: readonly string[]): TypecheckScope {
  if (args.length === 1 && (args[0] === "sources" || args[0] === "tests")) {
    return args[0];
  }
  throw new Error("usage: typecheck.ts <sources|tests>");
}

export function typecheckFiles(root: string, scope: TypecheckScope): string[] {
  if (scope === "sources") return discoverTypecheckSources(root);
  const files = discoverTestSources(root);
  assertIntegrationTestAssignments(files);
  return files;
}

if (import.meta.main) {
  let scope: TypecheckScope;
  try {
    scope = parseTypecheckScope(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(64);
  }
  const root = Deno.cwd();
  const files = typecheckFiles(root, scope);
  if (files.length === 0) throw new Error(`no ${scope} files found`);
  const output = await new Deno.Command(selectedDenoExecutable(), {
    args: ["check", ...files],
    cwd: root,
    clearEnv: true,
    env: Object.fromEntries(
      ["PATH", "HOME", "TMPDIR", "TEMP", "TMP"].flatMap((name) => {
        const value = Deno.env.get(name);
        return value === undefined ? [] : [[name, value]];
      }),
    ),
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  Deno.exit(output.code);
}
