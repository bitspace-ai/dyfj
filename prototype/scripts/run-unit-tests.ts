// The `test.unit` lane: every test file outside the integration tier
// (`*.integration.test.ts`) and the golden suite (`testing/golden/`, run by
// its own lane), discovered by `scripts/test-files.ts`. Product tests register
// with `node:test` and run under `node --test`, with the per-file handle check
// and no permission sandbox (`node-test-lane.ts`, `specs/03-testing.md` §1).
// Unit and component tests may use port fakes and temp directories only; for
// them that is a rule the tests keep, not a grant.
//
// A file that registers with the retired runner fails discovery
// (`test-files.ts`).
//
// Given arguments (`npm run test:file -- <path>... [--filter <pattern>]`), it
// runs those instead of the discovered files, so a single unit test file can
// be iterated on without a full typecheck. An integration file
// (`*.integration.test.ts`) is rejected before any test starts: it needs the
// isolated Dolt fixture (`integrationFileRejection`).
import process from "node:process";
import {
  discoverUnitTests,
  isIntegrationTest,
  isTestSource,
  nodeTestFiles,
} from "./test-files.ts";
import { parallelJobs, requireNode, startNodeTests } from "./node-test-lane.ts";
import {
  backstopMessage,
  laneSupervision,
  startBackstop,
  startTokenCarrier,
  stopOwnGroup,
} from "./lane-supervision.ts";

/** The caller's variables the lane's `node --test` child receives. */
export const UNIT_LANE_ENVIRONMENT_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
];

/**
 * Why `test:file` turns `path` away: it runs unit files only. An integration
 * file needs the isolated Dolt fixture, so it is rejected before any test
 * starts.
 */
export function integrationFileRejection(path: string): string {
  return `${path} is an integration test; test:file runs unit test files ` +
    "only. Run it in the isolated-Dolt integration lane " +
    "with `npm test` from the repository root.";
}

export const TEST_FILE_USAGE =
  "usage: npm run test:file -- <path>... [--filter <pattern>]";

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
  let files: string[];
  try {
    if (args.length === 0) {
      selection = { files: discoverUnitTests(root) };
      if (selection.files.length === 0) {
        throw new Error("no unit test files found");
      }
    } else {
      selection = parseTestFileArgs(args);
    }
    files = nodeTestFiles(root, selection.files);
    requireNode();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const env = Object.fromEntries(
    UNIT_LANE_ENVIRONMENT_NAMES.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const supervision = laneSupervision();
  startTokenCarrier(supervision);
  // The backstop ends the run when it expires. It can fire as it starts, when
  // the gate is already gone, and then no test starts.
  let stopCurrent = () => {};
  const backstop = startBackstop(supervision, () => stopCurrent());
  let code = 0;
  if (!backstop.expired) {
    const node = startNodeTests({
      lane: "test.unit",
      files,
      cwd: root,
      env,
      jobs: parallelJobs(),
      filter: selection.filter,
    });
    stopCurrent = node.kill;
    code = await node.code;
  }
  backstop.clear();
  await stopOwnGroup(supervision);
  if (backstop.expired) {
    console.error(backstopMessage("test.unit", supervision!, backstop));
    process.exit(1);
  }
  process.exit(code);
}
