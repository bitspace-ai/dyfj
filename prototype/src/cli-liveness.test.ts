import { afterEach, describe, expect, test } from "vitest";
import {
  type CliConfig,
  type Io,
  isTimeoutError,
  probeRuntimeLiveness,
  runStatus,
  socketError,
} from "./cli";
import { serveWorkbenchUnix, type WorkbenchUnixServer } from "./uds-server";
import { connectUnixClient, type UnixClient } from "./uds-client";
import { RpcError, RpcErrorCode } from "./jsonrpc";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function fakeIo(): { io: Io; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const raw: string[] = [];
  return {
    io: {
      out: (s) => stdout.push(s),
      err: (s) => stderr.push(s),
      errRaw: (s) => raw.push(s),
      readLine: () => Promise.resolve(null),
      close: () => {},
    },
    stdout,
    stderr,
  };
}

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    serverUrl: "http://localhost:8787",
    socket: "/tmp/fake-wb.sock",
    mode: "turn",
    color: false,
    ...overrides,
  };
}

// deno-lint-ignore no-explicit-any
const anyVal = (v: unknown): any => v;

describe("isTimeoutError and socketError", () => {
  test("identifies TimeoutError instances and rejects non-timeout aborts", () => {
    const timeoutErr = new Error("The operation timed out");
    timeoutErr.name = "TimeoutError";
    expect(isTimeoutError(timeoutErr)).toBe(true);

    const abortWithTimeoutCause = new Error("The operation was aborted");
    abortWithTimeoutCause.name = "AbortError";
    abortWithTimeoutCause.cause = timeoutErr;
    expect(isTimeoutError(abortWithTimeoutCause)).toBe(true);

    const plainAbortErr = new Error("The operation was aborted");
    plainAbortErr.name = "AbortError";
    expect(isTimeoutError(plainAbortErr)).toBe(false);

    const messageTimeout = new Error("connection timed out");
    expect(isTimeoutError(messageTimeout)).toBe(false);

    const regularErr = new Error("Something else failed");
    expect(isTimeoutError(regularErr)).toBe(false);
  });

  test("socketError produces clear message on timeout", () => {
    const timeoutErr = new Error("The operation timed out");
    timeoutErr.name = "TimeoutError";
    const msg = socketError(timeoutErr, cfg({ socket: "/tmp/dyfj.sock" }));
    expect(msg).toBe(
      "dyfj: runtime at /tmp/dyfj.sock is unresponsive (timed out)",
    );
  });

  test("socketError does not misclassify RpcError as unreachable socket", () => {
    const rpcErr = new RpcError(RpcErrorCode.methodNotFound, "Method not found");
    const msg = socketError(rpcErr, cfg({ socket: "/tmp/dyfj.sock" }));
    expect(msg).toBe("dyfj: Method not found");
    expect(msg).not.toContain("Start it with: dyfj start");
  });

  test("socketError produces start hint on connection refused or missing socket", () => {
    const enoentErr = new Error("No such file or directory (os error 2)");
    const msgEnoent = socketError(enoentErr, cfg({ socket: "/tmp/dyfj.sock" }));
    expect(msgEnoent).toContain("dyfj: runtime not reachable at /tmp/dyfj.sock.");
    expect(msgEnoent).toContain("Start it with: dyfj start");

    const econnrefusedErr = new Error("connect ECONNREFUSED /tmp/dyfj.sock");
    const msgRefused = socketError(econnrefusedErr, cfg({ socket: "/tmp/dyfj.sock" }));
    expect(msgRefused).toContain("dyfj: runtime not reachable at /tmp/dyfj.sock.");
    expect(msgRefused).toContain("Start it with: dyfj start");
  });
});

describe("probeRuntimeLiveness fallback logic", () => {
  test("succeeds directly when server implements runtime/liveness", async () => {
    const calls: string[] = [];
    const client: UnixClient = {
      request: (method) => {
        calls.push(method);
        if (method === "runtime/liveness") {
          return Promise.resolve({
            status: "ok",
            transport: "uds",
            clearance: "loopback",
          });
        }
        return Promise.reject(new Error(`Unexpected method ${method}`));
      },
      close: () => {},
    };

    const res = await probeRuntimeLiveness(client);
    expect(res.live).toBe(true);
    expect(res.statusPayload).toBeUndefined();
    expect(calls).toEqual(["runtime/liveness"]);
  });

  test("falls back once to runtime/status when server returns MethodNotFound (-32601)", async () => {
    const calls: string[] = [];
    const statusPayload = {
      runtime: {
        transport: "uds",
        clearance: "loopback",
        models: { total: 1, local: 1, hosted: 0 },
        methods: ["runtime/status"],
      },
    };

    const client: UnixClient = {
      request: (method) => {
        calls.push(method);
        if (method === "runtime/liveness") {
          return Promise.reject(
            new RpcError(RpcErrorCode.methodNotFound, "Method not found"),
          );
        }
        if (method === "runtime/status") {
          return Promise.resolve(statusPayload);
        }
        return Promise.reject(new Error(`Unexpected method ${method}`));
      },
      close: () => {},
    };

    const res = await probeRuntimeLiveness(client);
    expect(res.live).toBe(true);
    expect(res.statusPayload).toEqual(statusPayload);
    expect(calls).toEqual(["runtime/liveness", "runtime/status"]);
  });

  test("re-throws unexpected RPC errors without falling back", async () => {
    const calls: string[] = [];
    const client: UnixClient = {
      request: (method) => {
        calls.push(method);
        return Promise.reject(
          new RpcError(RpcErrorCode.internalError, "Internal error"),
        );
      },
      close: () => {},
    };

    await expect(probeRuntimeLiveness(client)).rejects.toThrow("Internal error");
    expect(calls).toEqual(["runtime/liveness"]);
  });
});

describe("runStatus and liveness over real Unix domain sockets", () => {
  test("runStatus succeeds against a live UDS server", async () => {
    const socketPath = `/tmp/dyfj-uds-${crypto.randomUUID()}.sock`;
    const server: WorkbenchUnixServer = await serveWorkbenchUnix(socketPath, {
      loadModels: async () => [anyVal({ slug: "local-qwen", tier: 0, costInput: 0, costOutput: 0 })],
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
    expect(code).toBe(0);
    const out = stdout.join("");
    expect(out).toContain("runtime: reachable");
    expect(out).toContain(socketPath);
  });

  test("probe times out with a bounded deadline and cleans up when connected to a mute socket", async () => {
    const socketPath = `/tmp/dyfj-uds-${crypto.randomUUID()}.sock`;
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

    expect(caughtError).toBeDefined();
    expect(isTimeoutError(caughtError)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(1500);

    const formatted = socketError(caughtError, cfg({ socket: socketPath }));
    expect(formatted).toBe(
      `dyfj: runtime at ${socketPath} is unresponsive (timed out)`,
    );
  });

  test("connectUnixClient rejects immediately when given an already-aborted signal", async () => {
    const socketPath = `/tmp/dyfj-uds-${crypto.randomUUID()}.sock`;
    const preAborted = AbortSignal.abort(
      new DOMException("The operation was aborted", "AbortError"),
    );
    await expect(connectUnixClient(socketPath, {}, preAborted)).rejects.toThrow();
  });

  test("connectUnixClient closes connection if abort occurs while connect is in flight", async () => {
    const socketPath = `/tmp/dyfj-uds-${crypto.randomUUID()}.sock`;
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
    await expect(connectPromise).rejects.toThrow();

    await acceptedPromise;
    if (serverConn) {
      const buf = new Uint8Array(10);
      const readResult = await serverConn.read(buf);
      expect(readResult).toBeNull();
    }
  });
});
