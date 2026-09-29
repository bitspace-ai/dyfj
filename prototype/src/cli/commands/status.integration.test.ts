// `dyfj status` and its liveness probe against real sockets. Socket paths
// come from the integration lane's exact grants
// (testing/servers/uds-sockets.ts).
import {
  assert,
  assertNotStrictEquals,
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
import { connectUnixClient } from "../../transport/mod.ts";
import { fakeIo } from "../../../testing/fakes/fake-io.ts";
import { udsTestSocket } from "../../../testing/servers/uds-sockets.ts";
import type { CliConfig } from "../args.ts";
import { isTimeoutError, socketError } from "../render/errors.ts";
import { probeRuntimeLiveness, runStatus } from "./status.ts";

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

// deno-lint-ignore no-explicit-any
const anyVal = (v: unknown): any => v;

describe("runStatus and liveness over real Unix domain sockets", () => {
  it("runStatus succeeds against a live UDS server", async () => {
    const socketPath = udsTestSocket("cli-status-live");
    const server: WorkbenchUnixServer = await serveWorkbenchUnix(socketPath, {
      store: new MemoryStore(),
      loadModels: async () => [
        anyVal({ slug: "local-qwen", tier: 0, costInput: 0, costOutput: 0 }),
      ],
      listSessions: async () => [],
      fetchSessionEvents: async () => [],
    });
    cleanups.push(async () => {
      await server.close();
      try {
        await Deno.remove(socketPath);
      } catch {}
    });

    const { io, stdout } = fakeIo();
    const code = await runStatus(cfg({ socket: socketPath }), io);
    assertStrictEquals(code, 0);
    const out = stdout.join("");
    assertStringIncludes(out, "runtime: reachable");
    assertStringIncludes(out, socketPath);
  });

  it("probe times out with a bounded deadline and cleans up when connected to a mute socket", async () => {
    const socketPath = udsTestSocket("cli-status-mute");
    // Create a raw UDS listener that accepts connections but writes nothing back
    const listener = Deno.listen({ transport: "unix", path: socketPath });
    const acceptedConns: Deno.Conn[] = [];

    // Background accept loop
    (async () => {
      try {
        for await (const conn of listener) {
          acceptedConns.push(conn);
          // Mute: do not write or close, just hold open until cleaned up
        }
      } catch {}
    })();

    cleanups.push(async () => {
      try {
        listener.close();
      } catch {}
      for (const c of acceptedConns) {
        try {
          c.close();
        } catch {}
      }
      try {
        await Deno.remove(socketPath);
      } catch {}
    });

    const client = await connectUnixClient(socketPath);
    cleanups.push(() => client.close());

    // Use a short 100ms signal to test timeout bounding without waiting 5 full seconds
    const timeoutSignal = AbortSignal.timeout(100);
    const start = Date.now();
    let caughtError: unknown;
    try {
      await probeRuntimeLiveness(client, timeoutSignal);
    } catch (err) {
      caughtError = err;
    }
    const elapsed = Date.now() - start;

    assertNotStrictEquals(caughtError, undefined);
    assertStrictEquals(isTimeoutError(caughtError), true);
    assert(elapsed >= 80);
    assert(elapsed < 1500);

    const formatted = socketError(caughtError, cfg({ socket: socketPath }));
    assertStrictEquals(
      formatted,
      `dyfj: runtime at ${socketPath} is unresponsive (timed out)`,
    );
  });

  it("connectUnixClient rejects immediately when given an already-aborted signal", async () => {
    const socketPath = udsTestSocket("cli-connect-aborted");
    const preAborted = AbortSignal.abort(
      new DOMException("The operation was aborted", "AbortError"),
    );
    await assertRejects(() => connectUnixClient(socketPath, {}, preAborted));
  });

  it("connectUnixClient closes connection if abort occurs while connect is in flight", async () => {
    const socketPath = udsTestSocket("cli-connect-inflight");
    const listener = Deno.listen({ transport: "unix", path: socketPath });
    let serverConn: Deno.Conn | undefined;
    const acceptedPromise = (async () => {
      try {
        for await (const conn of listener) {
          serverConn = conn;
          break;
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

    const ac = new AbortController();
    const connectPromise = connectUnixClient(socketPath, {}, ac.signal);
    // Abort immediately after connectUnixClient is called while Deno.connect is in flight
    ac.abort(new DOMException("The operation was aborted", "AbortError"));
    await assertRejects(() => connectPromise);

    await acceptedPromise;
    if (serverConn) {
      const buf = new Uint8Array(10);
      const readResult = await serverConn.read(buf);
      assertStrictEquals(readResult, null);
    }
  });
});
