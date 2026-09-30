// The `test.unit` lane: every `Deno.test` file outside the integration tier
// (`*.integration.test.ts`) and the golden suite (`testing/golden/`, run by
// its own lane), discovered by `scripts/test-files.ts` and run with
// `deno test --parallel`. Unit and component
// tests may use port fakes and temp directories only, so the child gets read
// access to the prototype and the temp roots, write access to the temp roots,
// and no run, net, env, sys, or ffi grant. Sanitizers are on: in the pinned
// Deno (2.9.6) the op and resource sanitizers are opt-in, so the lane enables
// them explicitly, and a test that leaks an async op, timer, or resource fails
// at that test. A test may opt out only with a comment naming the leak and why
// it is unavoidable (`specs/03-testing.md` §2).
//
// Given arguments (`deno task test:file <path>... [--filter <pattern>]`), it
// runs those instead of the discovered files, under the same grants and
// sanitizers, so a single unit test file can be iterated on without a full
// typecheck. An integration file needs the integration lane's grants and
// fixture, so it fails here on its first ungranted access.
import { selectedDenoExecutable } from "./deno-executable.ts";
import { discoverUnitTests, isTestSource } from "./test-files.ts";

export const TEMP_ROOTS = [
  "/tmp",
  "/private/tmp",
  "/var/folders",
  "/private/var/folders",
] as const;

export function unitTestArgs(
  files: readonly string[],
  filter?: string,
): string[] {
  const temp = TEMP_ROOTS.join(",");
  return [
    "test",
    "--parallel",
    "--sanitize-ops",
    "--sanitize-resources",
    "--no-prompt",
    `--allow-read=.,${temp}`,
    `--allow-write=${temp}`,
    ...(filter === undefined ? [] : ["--filter", filter]),
    ...files,
  ];
}

export const TEST_FILE_USAGE =
  "usage: deno task test:file <path>... [--filter <pattern>]";

/**
 * `test:file`'s arguments: one or more test file paths and at most one
 * `--filter <pattern>`. Anything else is rejected, so the lane's grants and
 * sanitizers cannot be changed from the command line and a missing path never
 * falls back to running every test.
 */
export function parseTestFileArgs(
  args: readonly string[],
): { files: string[]; filter?: string } {
  const files: string[] = [];
  let filter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--filter") {
      const pattern = args[i + 1];
      if (filter !== undefined || pattern === undefined) {
        throw new Error(TEST_FILE_USAGE);
      }
      filter = pattern;
      i++;
    } else if (arg.startsWith("-") || !isTestSource(arg)) {
      throw new Error(TEST_FILE_USAGE);
    } else {
      files.push(arg);
    }
  }
  if (files.length === 0) throw new Error(TEST_FILE_USAGE);
  return filter === undefined ? { files } : { files, filter };
}

if (import.meta.main) {
  const root = Deno.cwd();
  let selection: { files: string[]; filter?: string };
  if (Deno.args.length === 0) {
    selection = { files: discoverUnitTests(root) };
    if (selection.files.length === 0) {
      throw new Error("no unit test files found");
    }
  } else {
    try {
      selection = parseTestFileArgs(Deno.args);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      Deno.exit(2);
    }
  }
  const output = await new Deno.Command(selectedDenoExecutable(), {
    args: unitTestArgs(selection.files, selection.filter),
    cwd: root,
    clearEnv: true,
    env: Object.fromEntries(
      ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "DENO_JOBS"].flatMap((name) => {
        const value = Deno.env.get(name);
        return value === undefined ? [] : [[name, value]];
      }),
    ),
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  Deno.exit(output.code);
}
