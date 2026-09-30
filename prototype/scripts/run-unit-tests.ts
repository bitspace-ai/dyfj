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
import { discoverUnitTests } from "./test-files.ts";

export const TEMP_ROOTS = [
  "/tmp",
  "/private/tmp",
  "/var/folders",
  "/private/var/folders",
] as const;

export function unitTestArgs(files: readonly string[]): string[] {
  const temp = TEMP_ROOTS.join(",");
  return [
    "test",
    "--parallel",
    "--sanitize-ops",
    "--sanitize-resources",
    "--no-prompt",
    `--allow-read=.,${temp}`,
    `--allow-write=${temp}`,
    ...files,
  ];
}

if (import.meta.main) {
  const root = Deno.cwd();
  const files = Deno.args.length > 0 ? Deno.args : discoverUnitTests(root);
  if (files.length === 0) throw new Error("no unit test files found");
  const output = await new Deno.Command(selectedDenoExecutable(), {
    args: unitTestArgs(files),
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
