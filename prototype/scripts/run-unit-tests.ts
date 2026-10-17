// The `test.unit` lane: every test file outside the integration tier
// (`*.integration.test.ts`) and the golden suite (`testing/golden/`, run by
// its own lane), discovered by `scripts/test-files.ts`. Product tests register
// with `node:test` and run under `node --test`, with the per-file handle check
// and no permission sandbox (`node-test-lane.ts`, `specs/03-testing.md` §1).
// Unit and component tests may use port fakes and temp directories only; for
// them that is a rule the tests keep, not a grant.
//
// Until the gate-tooling port, the gate-tooling tests under `scripts/` that
// register with the existing runtime's runner (`test-files.ts`) run first,
// with `deno test --parallel`. That child gets read access to the prototype
// and the temp roots, write access to the temp roots, env access to TMPDIR,
// TMP and TEMP only (node:os `tmpdir()` reads them), and no run, net, sys, or
// ffi grant. Its sanitizers are on: in the pinned Deno (2.9.6) the op and
// resource sanitizers are opt-in, so the lane enables them explicitly. A test
// may opt out only with a comment naming the leak and why it is unavoidable
// (`specs/03-testing.md` §2).
//
// The runner itself runs on Node, from `node`; the selected Deno reaches it as
// DENO_BIN, which the `deno task` entries and the gate set.
//
// Given arguments (`deno task test:file <path>... [--filter <pattern>]`), it
// runs those instead of the discovered files, routed and run as above, so a
// single unit test file can be iterated on without a full typecheck. An
// integration file (`*.integration.test.ts`) is rejected before either runtime
// starts: it needs the isolated Dolt fixture, and a Node-routed one would run
// unsandboxed (`integrationFileRejection`).
import { spawn } from "node:child_process";
import process from "node:process";
import { requiredDenoExecutable } from "./deno-executable.ts";
import {
  discoverUnitTests,
  isIntegrationTest,
  isTestSource,
  partitionByRuntime,
  type TestRuntime,
} from "./test-files.ts";
import { parallelJobs, requireNode, startNodeTests } from "./node-test-lane.ts";
import {
  backstopMessage,
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

/**
 * The `deno test` arguments for the gate-tooling subset (`scripts/` files on
 * the existing runner), until the gate-tooling port.
 */
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
  const root = process.cwd();
  const args = process.argv.slice(2);
  let selection: { files: string[]; filter?: string };
  let partition: Record<TestRuntime, string[]>;
  let deno: string;
  try {
    if (args.length === 0) {
      selection = { files: discoverUnitTests(root) };
      if (selection.files.length === 0) {
        throw new Error("no unit test files found");
      }
    } else {
      selection = parseTestFileArgs(args);
    }
    partition = partitionByRuntime(root, selection.files);
    requireNode();
    deno = requiredDenoExecutable();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "DENO_JOBS"].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const supervision = laneSupervision();
  startTokenCarrier(supervision);
  // The backstop ends whichever subset is running when it expires.
  let stopCurrent = () => {};
  const backstop = startBackstop(supervision, () => stopCurrent());
  let code = 0;
  // The gate-tooling subset, until the gate-tooling port; empty when
  // `test:file` names product files only.
  if (partition.deno.length > 0) {
    const child = spawn(deno, unitTestArgs(partition.deno, selection.filter), {
      cwd: root,
      env,
      stdio: "inherit",
    });
    stopCurrent = () => killChild(child);
    code = await new Promise<number>((resolve) => {
      child.once("error", () => resolve(1));
      child.once("exit", (exitCode) => resolve(exitCode ?? 1));
    });
  }
  if (!backstop.expired) {
    // The product tests run after a failing gate-tooling subset too, so one
    // run reports both; the first failure's code is the lane's.
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
  await stopOwnGroup(supervision);
  if (backstop.expired) {
    console.error(backstopMessage("test.unit", supervision!, backstop));
    process.exit(1);
  }
  process.exit(code);
}
