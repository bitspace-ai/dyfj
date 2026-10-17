// Runs named test files under `node --test` for a gate lane that has no
// runner of its own (decision D32): the lane's files, one at a time, through
// the shared Node runner (`prototype/scripts/node-test-lane.ts`), with the
// per-file handle check and the lane's count line.
//
// Usage (from the repository root):
//   node scripts/run-node-test-files.ts --lane <name> <file>...
//
// The child gets PATH, HOME and the temp variables, and nothing else. Written to node: builtins only, like the shared runner, so
// it adds nothing to the runtime.neutral ratchet.
import process from "node:process";
import {
  requireNode,
  startNodeTests,
} from "../prototype/scripts/node-test-lane.ts";

const USAGE = "usage: run-node-test-files.ts --lane <name> <file>...";

export function parseArgs(
  args: readonly string[],
): { lane: string; files: string[] } {
  if (args[0] !== "--lane" || args[1] === undefined || args.length < 3) {
    throw new Error(USAGE);
  }
  const files = args.slice(2);
  if (files.some((file) => file.startsWith("-"))) throw new Error(USAGE);
  return { lane: args[1], files };
}

/** The caller's variables the `node --test` child receives. */
export const FORWARDED_ENVIRONMENT_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
];

async function main(): Promise<number> {
  let selection: { lane: string; files: string[] };
  try {
    selection = parseArgs(process.argv.slice(2));
    requireNode();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const env: Record<string, string> = {};
  for (const name of FORWARDED_ENVIRONMENT_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const run = startNodeTests({
    lane: selection.lane,
    files: selection.files,
    cwd: process.cwd(),
    env,
    jobs: 1,
  });
  return await run.code;
}

if (import.meta.main) process.exit(await main());
