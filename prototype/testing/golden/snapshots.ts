/**
 * Golden snapshot I/O: the one place that reads or writes a snapshot file.
 *
 * Only an explicit update may write a snapshot (`specs/03-testing.md` §4).
 * The golden runner (`run.ts`) turns `--update` into `DYFJ_GOLDEN_UPDATE=1`
 * for the test process, and `writeSnapshot` throws unless that variable is
 * set, so a plain run can neither create nor overwrite a snapshot.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { AssertionError } from "node:assert";
import process from "node:process";

/** Set to `1` by `run.ts --update`; any other value is a plain run. */
export const GOLDEN_UPDATE_ENV = "DYFJ_GOLDEN_UPDATE";

type Env = Readonly<Record<string, string | undefined>>;

export function updateMode(env: Env = process.env): boolean {
  return env[GOLDEN_UPDATE_ENV] === "1";
}

/**
 * Writes snapshot `id` under `dir`. Throws, writing nothing, unless update
 * mode is on: before the golden suite ran under `node --test`, the runner's
 * write grant enforced this, and the guard now lives here.
 */
export async function writeSnapshot(
  dir: string,
  id: string,
  content: string,
  env: Env = process.env,
): Promise<void> {
  if (!updateMode(env)) {
    throw new Error(
      `dyfj: golden snapshot ${id} may be written only in update mode ` +
        `(${GOLDEN_UPDATE_ENV}=1, set by \`npm run test:golden -- --update\`)`,
    );
  }
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${id}.json`, content);
}

function firstDifference(expected: string, actual: string): string {
  const a = expected.split("\n");
  const b = actual.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}\n- ${a[i] ?? "<missing>"}\n+ ${
        b[i] ?? "<missing>"
      }`;
    }
  }
  return "(no line difference)";
}

/**
 * Compares `value` with snapshot `id` under `dir`. In update mode it writes
 * the snapshot instead; otherwise a missing or different snapshot fails
 * without being written.
 */
export async function matchSnapshot(
  dir: string,
  id: string,
  value: unknown,
  env: Env = process.env,
): Promise<void> {
  const actual = `${JSON.stringify(value, null, 2)}\n`;
  if (updateMode(env)) {
    await writeSnapshot(dir, id, actual, env);
    return;
  }
  let expected: string;
  try {
    expected = await readFile(`${dir}/${id}.json`, "utf8");
  } catch (error) {
    if (
      (error instanceof Error &&
        (error as { code?: unknown }).code === "ENOENT")
    ) {
      throw new AssertionError({
        message:
          `missing golden snapshot ${id}; run npm run test:golden -- --update`,
      });
    }
    throw error;
  }
  if (expected !== actual) {
    throw new AssertionError({
      message: `golden snapshot ${id} changed at ${
        firstDifference(expected, actual)
      }`,
    });
  }
}
