/**
 * The dotenv subset the launcher reads, shared so the CLI resolves the same
 * value the spawned runtime reads through `--env-file=.env`.
 */

import type { Env } from "./env.ts";

/**
 * Read one variable from env-file text (KEY=VALUE lines; `export` prefix,
 * surrounding quotes, comments, and blank lines tolerated). Just enough of the
 * dotenv shape for the launcher to resolve the same value the spawned runtime
 * will read via --env-file=.env.
 */
export function envFileVar(text: string, name: string): string | undefined {
  for (const line of text.split("\n")) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/,
    );
    if (match === null || match[1] !== name) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

/**
 * Resolve a variable the way the spawned runtime will see it: `--env-file`
 * never overrides a variable already defined in the inherited environment, so
 * any DEFINED ambient value wins, including an empty one. Only an unset
 * variable falls back to `<cwd>/.env`; an unreadable file yields undefined.
 */
export async function readLauncherEnvVar(
  cwd: string,
  name: string,
  readTextFile: (path: string) => Promise<string>,
  env: Env,
): Promise<string | undefined> {
  const ambient = env.get(name);
  if (ambient !== undefined) return ambient;
  try {
    return envFileVar(await readTextFile(`${cwd}/.env`), name);
  } catch {
    return undefined;
  }
}
