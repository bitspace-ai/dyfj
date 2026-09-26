// The `test.unit` lane: every non-integration `Deno.test` file, discovered by
// `scripts/test-files.ts`, run with `deno test --parallel`. Unit and component
// tests may use port fakes and temp directories only, so the child gets read
// access to the prototype and the temp roots, write access to the temp roots,
// and no run, net, env, sys, or ffi grant. Sanitizers stay at Deno's default
// (on).
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
    "--no-prompt",
    "--sloppy-imports",
    `--allow-read=.,${temp}`,
    `--allow-write=${temp}`,
    ...files,
  ];
}

if (import.meta.main) {
  const root = Deno.cwd();
  const files = discoverUnitTests(root);
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
