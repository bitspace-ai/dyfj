import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import type { CliConfig } from "../args.ts";
import { startLocalRuntime } from "./runtime.ts";

// A stand-in prototype root: its serve-unix profile may read every variable,
// and its "engine" writes the environment it was given to env.json, so the
// test sees exactly what the launcher passed.
const ENGINE = `
import { writeFileSync } from "node:fs";
import process from "node:process";
writeFileSync("env.json", JSON.stringify(process.env));
`;

async function standInRoot(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "dyfj-launcher-env-"));
  const home = join(root, "home");
  await mkdir(join(root, "src", "server"), { recursive: true });
  await mkdir(home);
  await writeFile(
    join(root, "deno.json"),
    JSON.stringify({
      permissions: {
        "serve-unix": { env: true, read: true, write: true },
      },
    }),
  );
  await writeFile(join(root, ".env"), "");
  await writeFile(join(root, "src", "server", "main.ts"), ENGINE);
  return { root, home };
}

test("the runtime receives only policy names and the platform variables", async () => {
  const { root, home } = await standInRoot();
  try {
    const ambient = new MapEnv({
      PATH: process.env.PATH ?? "",
      HOME: home,
      ANTHROPIC_API_KEY: "sk-forwarded",
      TMPDIR: join(root, "tmpdir"),
      TMP: join(root, "tmp"),
      TEMP: join(root, "temp"),
      DENO_DIR: process.env.DENO_DIR ?? join(root, "deno-dir"),
      DYFJ_TEST_OUTSIDE_POLICY: "must-not-reach-the-runtime",
      DYFJ_TEST_SECOND_OUTSIDER: "must-not-reach-the-runtime",
    });
    const code = await startLocalRuntime(
      { socket: join(root, "s.sock") } as CliConfig,
      { command: "deno", cwd: root, env: ambient },
    );
    assert.strictEqual(code, 0);
    const seen = JSON.parse(
      await readFile(join(root, "env.json"), "utf8"),
    ) as Record<string, string>;
    assert.strictEqual(seen.ANTHROPIC_API_KEY, "sk-forwarded");
    assert.strictEqual(seen.HOME, home);
    for (const name of ["TMPDIR", "TMP", "TEMP", "DENO_DIR"]) {
      assert.strictEqual(seen[name], ambient.get(name), name);
    }
    assert.strictEqual(seen.DYFJ_TEST_OUTSIDE_POLICY, undefined);
    assert.strictEqual(seen.DYFJ_TEST_SECOND_OUTSIDER, undefined);
    // Nothing else reaches it. macOS sets __CF_USER_TEXT_ENCODING in every
    // new process itself; no parent passes it.
    assert.deepStrictEqual(
      Object.keys(seen).filter((name) =>
        ![
          "__CF_USER_TEXT_ENCODING",
          "PATH",
          "HOME",
          "ANTHROPIC_API_KEY",
          "TMPDIR",
          "TMP",
          "TEMP",
          "DENO_DIR",
        ].includes(name)
      ),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
