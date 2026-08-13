import { assertIntegrationTestAssignments } from "./integration-test-assignment.ts";
import { selectedDenoExecutable } from "./deno-executable.ts";

const ignoredDirectories = new Set([".git", ".vitest-tmp", "node_modules"]);
const vitestTestSourcePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function isTestSource(path: string): boolean {
  return vitestTestSourcePattern.test(path);
}

export function testSourcesFromPaths(paths: string[]): string[] {
  return paths.filter(isTestSource).sort();
}

export async function discoverTestSources(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory) {
        if (!ignoredDirectories.has(entry.name)) await walk(path);
      } else if (entry.isFile && isTestSource(path)) {
        files.push(path);
      }
    }
  }
  await walk(root);
  return testSourcesFromPaths(files);
}

function relativeTo(root: string, path: string): string {
  const prefix = `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

if (import.meta.main) {
  const root = Deno.cwd();
  const files = await discoverTestSources(root);
  if (files.length === 0) throw new Error("no test files found");
  assertIntegrationTestAssignments(files.map((file) => relativeTo(root, file)));
  const output = await new Deno.Command(selectedDenoExecutable(), {
    args: ["check", "--sloppy-imports", ...files],
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
