import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { SpawnRefusedError } from "../../config/mod.ts";
import type { CliConfig } from "../args.ts";
import { startLocalRuntime } from "./runtime.ts";

const PROTOTYPE_ROOT = new URL("../../..", import.meta.url).pathname;

test("the launcher refuses to start a runtime binary outside the CLI run policy", async () => {
  const home = await mkdtemp(join(tmpdir(), "dyfj-launcher-spawn-"));
  try {
    await assert.rejects(
      startLocalRuntime({ socket: join(home, "s.sock") } as CliConfig, {
        command: "/usr/bin/true",
        cwd: PROTOTYPE_ROOT,
        env: new MapEnv({ HOME: home }),
      }),
      (error: unknown) =>
        error instanceof SpawnRefusedError &&
        error.command === "/usr/bin/true",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
