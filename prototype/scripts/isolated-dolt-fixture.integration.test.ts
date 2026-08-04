import { describe, expect, test } from "vitest";
import { startIsolatedDoltFixture } from "./isolated-dolt-fixture";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

async function portIsClosed(port: number): Promise<boolean> {
  try {
    const connection = await Deno.connect({ hostname: "127.0.0.1", port });
    connection.close();
    return false;
  } catch {
    return true;
  }
}

describe("isolated Dolt fixture", () => {
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
      await expect(Deno.stat(failedRoot)).rejects.toThrow();
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
      await expect(Deno.stat(interruptedRoot)).rejects.toThrow();
      expect(await portIsClosed(interruptedPort)).toBe(true);
    },
    30_000,
  );
});
