// `dyfj stop` against real sockets: a live runtime, a missing socket, a dead
// listener and a mute one. Socket paths come from the integration lane's
// exact grants (testing/servers/uds-sockets.ts).
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { afterEach, describe, it } from "@std/testing/bdd";
import { MemoryStore } from "../../store/mod.ts";
import {
  serveWorkbenchUnix,
  type WorkbenchUnixServer,
} from "../../server/main.ts";
import { fakeIo } from "../../../testing/fakes/fake-io.ts";
import { udsTestSocket } from "../../../testing/servers/uds-sockets.ts";
import type { CliConfig } from "../args.ts";
import { runStop } from "./stop.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    socket: "/tmp/dyfj-test.sock",
    mode: "turn",
    color: false,
    ...overrides,
  };
}

describe("runStop behavior over real sockets", () => {
  it("stops a running runtime, unlinks the socket, and returns exit code 0", async () => {
    const socketPath = udsTestSocket("cli-stop-live");

    let serverInstance: WorkbenchUnixServer | undefined;
    let shutdownInvoked = false;

    serverInstance = await serveWorkbenchUnix(socketPath, {
      store: new MemoryStore(),
      onShutdown: async () => {
        shutdownInvoked = true;
        if (serverInstance) {
          await serverInstance.close({ disconnectPeers: false });
        }
      },
    });

    cleanups.push(async () => {
      if (serverInstance) {
        try {
          await serverInstance.close();
        } catch {}
      }
      try {
        await Deno.remove(socketPath);
      } catch {}
    });

    const { io, stdout } = fakeIo();
    const exitCode = await runStop(cfg({ socket: socketPath }), io);

    assertStrictEquals(exitCode, 0);
    assertStrictEquals(shutdownInvoked, true);
    assertStringIncludes(
      stdout.join(""),
      `dyfj: runtime at ${socketPath} stopped`,
    );

    // Verify the socket is no longer present
    await assertRejects(() => Deno.stat(socketPath), Deno.errors.NotFound);
  });

  it("reports failure via io.err and returns 1 when runtime shutdown fails", async () => {
    const socketPath = udsTestSocket("cli-stop-fails");

    let serverInstance: WorkbenchUnixServer | undefined;

    serverInstance = await serveWorkbenchUnix(socketPath, {
      store: new MemoryStore(),
      onShutdown: () => Promise.reject(new Error("ACP close failed")),
    });

    cleanups.push(async () => {
      if (serverInstance) {
        try {
          await serverInstance.close();
        } catch {}
      }
      try {
        await Deno.remove(socketPath);
      } catch {}
    });

    const { io, stdout, stderr } = fakeIo();
    const exitCode = await runStop(cfg({ socket: socketPath }), io);

    assertStrictEquals(exitCode, 1);
    assertEquals(stdout, []);
    assertStringIncludes(stderr.join(""), "runtime shutdown failed");
  });

  it("is idempotent when socket does not exist", async () => {
    const socketPath = udsTestSocket("cli-stop-missing");

    const { io, stdout, stderr } = fakeIo();
    const exitCode = await runStop(cfg({ socket: socketPath }), io);

    assertStrictEquals(exitCode, 0);
    assertEquals(stderr, []);
    assertStringIncludes(
      stdout.join(""),
      `dyfj: runtime is not running at ${socketPath}`,
    );
  });

  it("reports not running when connection is refused by a dead listener", async () => {
    const socketPath = udsTestSocket("cli-stop-dead");

    // Create a listener and immediately close it without unlinking
    const listener = Deno.listen({ transport: "unix", path: socketPath });
    listener.close();

    cleanups.push(async () => {
      try {
        await Deno.remove(socketPath);
      } catch {}
    });

    const { io, stdout, stderr } = fakeIo();
    const exitCode = await runStop(cfg({ socket: socketPath }), io);

    assertStrictEquals(exitCode, 0);
    assertEquals(stderr, []);
    assertStringIncludes(
      stdout.join(""),
      `dyfj: runtime is not running at ${socketPath}`,
    );
  });

  it("reports failure via io.err and returns 1 when connected to a mute socket exceeding deadline", async () => {
    const socketPath = udsTestSocket("cli-stop-mute");
    const listener = Deno.listen({ transport: "unix", path: socketPath });
    let serverConn: Deno.Conn | undefined;
    (async () => {
      try {
        for await (const conn of listener) {
          serverConn = conn;
          // Hold connection open without reading or writing
        }
      } catch {}
    })();

    cleanups.push(async () => {
      try {
        listener.close();
      } catch {}
      if (serverConn) {
        try {
          serverConn.close();
        } catch {}
      }
      try {
        await Deno.remove(socketPath);
      } catch {}
    });

    const { io, stdout, stderr } = fakeIo();
    const exitCode = await runStop(
      cfg({ socket: socketPath }),
      io,
      undefined,
      AbortSignal.timeout(100),
    );

    assertStrictEquals(exitCode, 1);
    assertEquals(stdout, []);
    assertStringIncludes(stderr.join(""), "is unresponsive (timed out)");
  });

  it(
    "reports failure via io.err and returns 1 when runtime does not close within deadline",
    async () => {
      const socketPath = udsTestSocket("cli-stop-slow");

      let serverInstance: WorkbenchUnixServer | undefined;

      serverInstance = await serveWorkbenchUnix(socketPath, {
        store: new MemoryStore(),
        onShutdown: () => {
          // Stubborn server acknowledges stop but does not close
        },
      });

      cleanups.push(async () => {
        if (serverInstance) {
          try {
            await serverInstance.close();
          } catch {}
        }
        try {
          await Deno.remove(socketPath);
        } catch {}
      });

      const { io, stdout, stderr } = fakeIo();
      const exitCode = await runStop(cfg({ socket: socketPath }), io);

      assertStrictEquals(exitCode, 1);
      assertEquals(stdout, []);
      assertStringIncludes(stderr.join(""), "did not stop within deadline");
    },
  );
});
