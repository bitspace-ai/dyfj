import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { assertConnectAllowed } from "../../config/mod.ts";
import { resolveRuntimeLaunch } from "./runtime.ts";

async function withRoot(
  dotEnv: string,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "dyfj-launch-"));
  try {
    await writeFile(join(root, ".env"), dotEnv);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a non-default Dolt endpoint from .env reaches the runtime's policy and the guard", async () => {
  await withRoot("DOLT_HOST=db.example.test\nDOLT_PORT=3307\n", async (root) => {
    const launch = await resolveRuntimeLaunch(root, "/run/wb.sock", false, {
      env: new MapEnv({ HOME: root }),
    });
    assert.ok(launch.policy.net.includes("db.example.test:3307"));
    assert.doesNotThrow(() =>
      assertConnectAllowed(launch.policy, "db.example.test", 3307)
    );
  });
});

test("an ambient Dolt endpoint wins over .env, as it does for the runtime", async () => {
  await withRoot("DOLT_PORT=3307\n", async (root) => {
    const launch = await resolveRuntimeLaunch(root, "/run/wb.sock", false, {
      env: new MapEnv({ HOME: root, DOLT_PORT: "3308" }),
    });
    assert.strictEqual(launch.policy.dolt, "127.0.0.1:3308");
  });
});

test("the runtime gets no --env-file, and .env names outside the policy stay out", async () => {
  await withRoot(
    "DYFJ_WORKBENCH_TIER=1\nDYFJ_TEST_ENV_FILE_ONLY=from-dotenv\n",
    async (root) => {
      const launch = await resolveRuntimeLaunch(root, "/run/wb.sock", false, {
        env: new MapEnv({ HOME: root, PATH: "/usr/bin" }),
      });
      assert.ok(!launch.args.some((arg) => arg.startsWith("--env-file")));
      assert.strictEqual(launch.env.DYFJ_WORKBENCH_TIER, "1");
      assert.strictEqual(launch.env.DYFJ_TEST_ENV_FILE_ONLY, undefined);
      assert.strictEqual(launch.env.PATH, "/usr/bin");
    },
  );
});

test("the runtime listens on the socket the client resolved", async () => {
  await withRoot("", async (root) => {
    const launch = await resolveRuntimeLaunch(root, "/run/flag.sock", false, {
      env: new MapEnv({ HOME: root, DYFJ_SOCKET: "/run/ambient.sock" }),
    });
    assert.strictEqual(launch.env.DYFJ_SOCKET, "/run/flag.sock");
  });
});

test("the runtime's policy may start the Node executable running the client", async () => {
  await withRoot("", async (root) => {
    const launch = await resolveRuntimeLaunch(root, "/run/wb.sock", false, {
      env: new MapEnv({ HOME: root }),
    });
    assert.ok(launch.policy.run.includes(process.execPath));
  });
});
