import {
  assertNotStrictEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  startIsolatedDoltFixture,
  waitForSql,
} from "./isolated-dolt-fixture.ts";
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
  it("interrupts a readiness probe stalled after TCP accept", async () => {
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
      await assertRejects(
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
        Error,
        "isolated Dolt fixture setup interrupted",
      );
    } finally {
      clearTimeout(abortTimer);
      listener.close();
      for (const connection of connections) connection.close();
      await acceptTask;
    }
  });

  it("cleans the child and temporary root when setup fails after readiness", async () => {
    let failedRoot = "";
    let failedPort = 0;
    await assertRejects(
      () =>
        startIsolatedDoltFixture({
          repoRoot,
          prefix: "dyfj_fixture_failure_",
          afterReady: async ({ root, port }) => {
            failedRoot = root;
            failedPort = port;
            throw new Error("forced fixture setup failure");
          },
        }),
      Error,
      "forced fixture setup failure",
    );

    assertNotStrictEquals(failedRoot, "");
    await assertRejects(() => Deno.stat(failedRoot), Deno.errors.NotFound);
    assertStrictEquals(await portIsClosed(failedPort), true);
  });

  it("cleans the child and temporary root when setup is interrupted", async () => {
    const abortController = new AbortController();
    let interruptedRoot = "";
    let interruptedPort = 0;
    await assertRejects(
      () =>
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
      Error,
      "isolated Dolt fixture setup interrupted",
    );

    assertNotStrictEquals(interruptedRoot, "");
    await assertRejects(() => Deno.stat(interruptedRoot), Deno.errors.NotFound);
    assertStrictEquals(await portIsClosed(interruptedPort), true);
  });
});
