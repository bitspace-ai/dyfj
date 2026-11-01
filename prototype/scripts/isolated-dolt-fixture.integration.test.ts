import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { connect } from "node:net";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  startIsolatedDoltFixture,
  waitForSql,
} from "./isolated-dolt-fixture.ts";
import { startMuteListener } from "../testing/servers/listeners.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(
  /[\\\/]$/,
  "",
);

// The two fixture-setup cases carry a 30s bound themselves: the deadline
// aborts setup through the fixture's own signal, which fails the case and
// stops the stalled `dolt` child, where a node:test timeout would fail the
// case and leave setup running.
const FIXTURE_CASE_DEADLINE_MS = 30_000;

async function withDeadline<T>(
  run: (deadline: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIXTURE_CASE_DEADLINE_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function portIsClosed(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve(true);
      else reject(error);
    });
  });
}

function errorIncluding(message: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && error.message.includes(message);
}

function assertNotFound(path: string): Promise<void> {
  return assert.rejects(() => stat(path), { code: "ENOENT" });
}

describe("isolated Dolt fixture", () => {
  it("disables Dolt metrics in the fixture HOME, so no background writer races cleanup", async () => {
    const fixture = await withDeadline((signal) =>
      startIsolatedDoltFixture({ repoRoot, signal })
    );
    try {
      const config = JSON.parse(
        await readFile(`${fixture.root}/home/.dolt/config_global.json`, "utf8"),
      );
      assert.equal(config["metrics.disabled"], "true");
      const events = await readdir(`${fixture.root}/home/.dolt/eventsData`)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [] as string[];
          throw error;
        });
      assert.deepEqual(events.filter((name) => name.endsWith(".devts")), []);
    } finally {
      await fixture.cleanup();
    }
    await assert.rejects(stat(fixture.root), { code: "ENOENT" });
  });

  it("interrupts a readiness probe stalled after TCP accept", async () => {
    const listener = await startMuteListener({
      hostname: "127.0.0.1",
      port: 0,
    });
    if (listener.addr.transport !== "tcp") {
      throw new Error("expected a TCP listener");
    }
    const port = listener.addr.port;
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => abortController.abort(), 50);

    try {
      await assert.rejects(
        () =>
          waitForSql(
            {
              DOLT_HOST: "127.0.0.1",
              DOLT_PORT: String(port),
              DOLT_USER: "root",
              DOLT_PASSWORD: "",
              DOLT_DATABASE: "stalled",
            },
            abortController.signal,
            5_000,
          ),
        errorIncluding("isolated Dolt fixture setup interrupted"),
      );
    } finally {
      clearTimeout(abortTimer);
      await listener.close();
    }
  });

  it("cleans the child and temporary root when setup fails after readiness", async () => {
    let failedRoot = "";
    let failedPort = 0;
    await withDeadline((deadline) =>
      assert.rejects(
        () =>
          startIsolatedDoltFixture({
            repoRoot,
            prefix: "dyfj_fixture_failure_",
            signal: deadline,
            afterReady: async ({ root, port }) => {
              failedRoot = root;
              failedPort = port;
              throw new Error("forced fixture setup failure");
            },
          }),
        errorIncluding("forced fixture setup failure"),
      )
    );

    assert.notStrictEqual(failedRoot, "");
    await assertNotFound(failedRoot);
    assert.strictEqual(await portIsClosed(failedPort), true);
  });

  it("cleans the child and temporary root when setup is interrupted", async () => {
    const abortController = new AbortController();
    let interruptedRoot = "";
    let interruptedPort = 0;
    await withDeadline((deadline) =>
      assert.rejects(
        () =>
          startIsolatedDoltFixture({
            repoRoot,
            prefix: "dyfj_fixture_interrupt_",
            signal: AbortSignal.any([abortController.signal, deadline]),
            afterReady: async ({ root, port }) => {
              interruptedRoot = root;
              interruptedPort = port;
              abortController.abort();
            },
          }),
        errorIncluding("isolated Dolt fixture setup interrupted"),
      )
    );

    // A deadline abort rejects with the same message, but only before
    // afterReady has run, so the root check below still fails that case.
    assert.notStrictEqual(interruptedRoot, "");
    await assertNotFound(interruptedRoot);
    assert.strictEqual(await portIsClosed(interruptedPort), true);
  });
});
