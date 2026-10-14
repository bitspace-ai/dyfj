// Node load probe for the TypeScript tier's move to Node (decision D32).
//
// Node runs `.ts` by stripping types without transforming them, so a module
// that holds syntax stripping cannot erase fails to load. This probe imports
// every git-tracked non-test module under `prototype/src` and `contracts/`
// with the `node` running it, one dynamic import each, and reports each
// module's result. A module whose import throws is a failure; importing runs
// top-level code only, so runtime-specific calls inside functions are not
// reached.
//
// Run from the repository root, with Node 22.18 or later on PATH (type
// stripping is on by default from there):
//   node scripts/node-load-probe.ts
//
// It is a manual check, not a gate lane: the gate's environment has no
// `node`. The gate tooling's port to Node makes it one. It covers non-test
// modules under the two roots only.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isTestSource } from "../prototype/scripts/test-files.ts";

export const PROBE_ROOTS = ["prototype/src", "contracts"] as const;

/**
 * Whether a tracked path is a module the probe loads. Test files are those
 * test discovery recognises, so the two share one definition.
 */
export function isProbedModule(path: string): boolean {
  return path.endsWith(".ts") && !isTestSource(path) &&
    PROBE_ROOTS.some((root) => path.startsWith(`${root}/`));
}

function trackedModules(root: string): string[] {
  const listing = execFileSync(
    "git",
    ["ls-files", "-z", "--", ...PROBE_ROOTS],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return listing.split("\0").filter(isProbedModule).sort();
}

export interface ProbeResult {
  path: string;
  error?: string;
}

async function probe(root: string): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const path of trackedModules(root)) {
    try {
      await import(pathToFileURL(join(root, path)).href);
      results.push({ path });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = String((error as Error).message ?? error).split("\n")[0];
      results.push({ path, error: code ? `${code}: ${message}` : message });
    }
  }
  return results;
}

async function main(root: string): Promise<number> {
  console.log(`node ${process.version}`);
  const results = await probe(root);
  for (const { path, error } of results) {
    console.log(
      error === undefined ? `ok   ${path}` : `FAIL ${path}: ${error}`,
    );
  }
  const failed = results.filter((result) => result.error !== undefined);
  console.log(
    `node-load-probe: ${results.length - failed.length} of ` +
      `${results.length} modules loaded, ${failed.length} failed`,
  );
  return failed.length > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Exit explicitly: a module's top-level code may leave a handle open.
  process.exit(await main(process.cwd()));
}
