import { describe, expect, test } from "vitest";
import { startIsolatedDoltFixture, waitForSql } from "./isolated-dolt-fixture";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(
  /[\\\/]$/,
  "",
);

async function portIsClosed(port: number): Promise<boolean> {
  try {
    const connection = await Deno.connect({ hostname: "127.0.0.1", port });
    connection.close();
    return false;
  } catch (error) {
    if (error instanceof Deno.errors.ConnectionRefused) return true;
    throw error;
  }
}

describe("isolated Dolt fixture", () => {
  test("interrupts a readiness probe stalled after TCP accept", async () => {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (listener.addr as Deno.NetAddr).port;
    const connections: Deno.Conn[] = [];
    const acceptTask = (async () => {
      try {
        while (true) connections.push(await listener.accept());
      } catch (error) {
        if (!(error instanceof Deno.errors.BadResource)) throw error;
      }
    })();
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => abortController.abort(), 50);

    try {
      await expect(
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
      ).rejects.toThrow("isolated Dolt fixture setup interrupted");
    } finally {
      clearTimeout(abortTimer);
      listener.close();
      for (const connection of connections) connection.close();
      await acceptTask;
    }
  });

  test(
    "cleans the child and temporary root when setup fails after readiness",
    async () => {
      let failedRoot = "";
      let failedPort = 0;
      await expect(
        startIsolatedDoltFixture({
          repoRoot,
          prefix: "dyfj_fixture_failure_",
          afterReady: async ({ root, port }) => {
            failedRoot = root;
            failedPort = port;
            throw new Error("forced fixture setup failure");
          },
        }),
      ).rejects.toThrow("forced fixture setup failure");

      expect(failedRoot).not.toBe("");
      await expect(Deno.stat(failedRoot)).rejects.toBeInstanceOf(
        Deno.errors.NotFound,
      );
      expect(await portIsClosed(failedPort)).toBe(true);
    },
    30_000,
  );

  test(
    "cleans the child and temporary root when setup is interrupted",
    async () => {
      const abortController = new AbortController();
      let interruptedRoot = "";
      let interruptedPort = 0;
      await expect(
        startIsolatedDoltFixture({
          repoRoot,
          prefix: "dyfj_fixture_interrupt_",
          signal: abortController.signal,
          afterReady: async ({ root, port }) => {
            interruptedRoot = root;
            interruptedPort = port;
            abortController.abort();
          },
        }),
      ).rejects.toThrow("isolated Dolt fixture setup interrupted");

      expect(interruptedRoot).not.toBe("");
      await expect(Deno.stat(interruptedRoot)).rejects.toBeInstanceOf(
        Deno.errors.NotFound,
      );
      expect(await portIsClosed(interruptedPort)).toBe(true);
    },
    30_000,
  );
});
