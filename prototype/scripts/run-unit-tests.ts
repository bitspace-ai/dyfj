// The `test.unit` lane: every `Deno.test` file outside the integration tier
// (`*.integration.test.ts`) and the golden suite (`testing/golden/`, run by
// its own lane), discovered by `scripts/test-files.ts` and run with
// `deno test --parallel`. Unit and component
// tests may use port fakes and temp directories only, so that child gets read
// access to the prototype and the temp roots, write access to the temp roots,
// env access to TMPDIR, TMP and TEMP only (node:os `tmpdir()` reads them),
// and no run, net, sys, or ffi grant. These grants bind that subset only. Sanitizers are on: in the pinned
// Deno (2.9.6) the op and resource sanitizers are opt-in, so the lane enables
// them explicitly, and a test that leaks an async op, timer, or resource the
// runtime tracks fails at that test; they do not see `node:` resources. A test
// may opt out only with a comment naming the leak and why it is unavoidable
// (`specs/03-testing.md` §2).
//
// A file that registers with `node:test` is routed to `node --test` instead
// (`test-files.ts`), after that subset, with the per-file handle check and no
// permission sandbox (`node-test-lane.ts`, `specs/03-testing.md` §1).
//
// Given arguments (`deno task test:file <path>... [--filter <pattern>]`), it
// runs those instead of the discovered files, routed and run as above, so a
// single unit test file can be iterated on without a full typecheck. An
// integration file (`*.integration.test.ts`) is rejected before either runtime
// starts: it needs the isolated Dolt fixture, and a Node-routed one would run
// unsandboxed (`integrationFileRejection`).
import { selectedDenoExecutable } from "./deno-executable.ts";
import {
  discoverUnitTests,
  isIntegrationTest,
  isTestSource,
  partitionByRuntime,
  type TestRuntime,
} from "./test-files.ts";
import { parallelJobs, requireNode, startNodeTests } from "./node-test-lane.ts";
import {
  killChild,
  laneSupervision,
  startBackstop,
  startTokenCarrier,
  stopOwnGroup,
} from "./lane-supervision.ts";

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
    "--allow-env=TMPDIR,TMP,TEMP",
    ...(filter === undefined ? [] : ["--filter", filter]),
    ...files,
  ];
}

/**
 * Why `test:file` turns `path` away: it runs unit files only. An integration
 * file needs the isolated Dolt fixture, and a Node-routed one would run with
 * no permission sandbox, so it is rejected before either runtime starts.
 */
export function integrationFileRejection(path: string): string {
  return `${path} is an integration test; test:file runs unit test files ` +
    "only, on neither runtime. Run it in the isolated-Dolt integration lane " +
    "with `deno task test` from the repository root.";
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
    } else if (isIntegrationTest(arg)) {
      throw new Error(integrationFileRejection(arg));
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
  let partition: Record<TestRuntime, string[]>;
  try {
    if (Deno.args.length === 0) {
      selection = { files: discoverUnitTests(root) };
      if (selection.files.length === 0) {
        throw new Error("no unit test files found");
      }
    } else {
      selection = parseTestFileArgs(Deno.args);
    }
    partition = partitionByRuntime(root, selection.files);
    requireNode();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(2);
  }
  const deno = selectedDenoExecutable();
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "DENO_JOBS"].flatMap((name) => {
      const value = Deno.env.get(name);
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const supervision = laneSupervision();
  startTokenCarrier(supervision, deno);
  // The backstop ends whichever subset is running when it expires.
  let stopCurrent = () => {};
  const backstop = startBackstop(supervision, deno, () => stopCurrent());
  let code = 0;
  if (partition.deno.length === 0) {
    console.log("test.unit deno test: 0 files");
  } else {
    const child = new Deno.Command(deno, {
      args: unitTestArgs(partition.deno, selection.filter),
      cwd: root,
      clearEnv: true,
      env,
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    stopCurrent = () => killChild(child);
    code = (await child.status).code;
  }
  if (!backstop.expired) {
    // The Node subset runs after a failing first subset too, so one run
    // reports both; the first failure's code is the lane's.
    const node = startNodeTests({
      lane: "test.unit",
      files: partition.node,
      cwd: root,
      env: { ...env, DENO_BIN: deno },
      jobs: parallelJobs(),
      filter: selection.filter,
    });
    stopCurrent = node.kill;
    const nodeCode = await node.code;
    if (code === 0) code = nodeCode;
  }
  backstop.clear();
  await stopOwnGroup(supervision, deno);
  if (backstop.expired) {
    console.error(
      `dyfj: test.unit passed its backstop deadline (${
        supervision!.backstopMs
      } ms)`,
    );
    Deno.exit(1);
  }
  Deno.exit(code);
}
