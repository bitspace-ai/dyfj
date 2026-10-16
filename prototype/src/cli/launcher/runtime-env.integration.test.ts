import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { RUNTIME_NODE_PERMISSION_FLAGS } from "../../config/mod.ts";
import type { CliConfig } from "../args.ts";
import { startLocalRuntime } from "./runtime.ts";

// A stand-in prototype root whose "engine" writes the environment and the
// Node arguments it was started with to env.json, so the test sees exactly
// what the launcher passed.
const ENGINE = `
import { writeFileSync } from "node:fs";
import process from "node:process";
writeFileSync("env.json", JSON.stringify({
  env: process.env,
  execPath: process.execPath,
  execArgv: process.execArgv,
}));
`;

async function standInRoot(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "dyfj-launcher-env-"));
  const home = join(root, "home");
  await mkdir(join(root, "src", "server"), { recursive: true });
  await mkdir(home);
  // One policy name and one name outside the policy, present only here.
  await writeFile(
    join(root, ".env"),
    "DYFJ_WORKBENCH_TIER=1\nDYFJ_TEST_ENV_FILE_ONLY=from-dotenv\n",
  );
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
      DENO_DIR: join(root, "deno-dir"),
      DYFJ_TEST_OUTSIDE_POLICY: "must-not-reach-the-runtime",
      DYFJ_TEST_SECOND_OUTSIDER: "must-not-reach-the-runtime",
    });
    const code = await startLocalRuntime(
      { socket: join(root, "s.sock") } as CliConfig,
      { cwd: root, env: ambient },
    );
    assert.strictEqual(code, 0);
    const recorded = JSON.parse(
      await readFile(join(root, "env.json"), "utf8"),
    ) as { env: Record<string, string>; execPath: string; execArgv: string[] };
    const seen = recorded.env;
    // The runtime runs on this Node, as plain node.
    assert.strictEqual(recorded.execPath, process.execPath);
    assert.deepStrictEqual(recorded.execArgv, [...RUNTIME_NODE_PERMISSION_FLAGS]);
    assert.deepStrictEqual(recorded.execArgv, []);
    assert.strictEqual(seen.NODE_OPTIONS, undefined);
    assert.strictEqual(seen.DYFJ_SOCKET, join(root, "s.sock"));
    assert.strictEqual(seen.ANTHROPIC_API_KEY, "sk-forwarded");
    assert.strictEqual(seen.HOME, home);
    for (const name of ["TMPDIR", "TMP", "TEMP"]) {
      assert.strictEqual(seen[name], ambient.get(name), name);
    }
    // The replaced runtime's module cache is not forwarded.
    assert.strictEqual(seen.DENO_DIR, undefined);
    assert.strictEqual(seen.DYFJ_TEST_OUTSIDE_POLICY, undefined);
    // .env fills a policy name and nothing else.
    assert.strictEqual(seen.DYFJ_WORKBENCH_TIER, "1");
    assert.strictEqual(seen.DYFJ_TEST_ENV_FILE_ONLY, undefined);
    assert.strictEqual(seen.DYFJ_TEST_SECOND_OUTSIDER, undefined);
    // Nothing else reaches it. macOS sets __CF_USER_TEXT_ENCODING in every
    // new process itself; no parent passes it.
    assert.deepStrictEqual(
      Object.keys(seen).filter((name) =>
        ![
          "__CF_USER_TEXT_ENCODING",
          "DYFJ_WORKBENCH_TIER",
          "PATH",
          "HOME",
          "ANTHROPIC_API_KEY",
          "TMPDIR",
          "TMP",
          "TEMP",
          "DYFJ_SOCKET",
        ].includes(name)
      ),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
