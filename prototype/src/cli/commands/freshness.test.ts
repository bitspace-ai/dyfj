// The launcher's freshness probe: is the runtime up, and is it running the
// code in this checkout? A stale runtime that `dyfj` autostarted is stopped
// for a restart, but only when this probe is its sole client; a runtime
// started with `dyfj start` is never stopped here.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeIo } from "../../../testing/fakes/fake-io.ts";
import type { CliConfig } from "../args.ts";
import type { ConnectFn } from "../io.ts";
import {
  FRESHNESS_PROBE_RESTART,
  FRESHNESS_PROBE_UNREACHABLE,
  runFreshnessProbe,
} from "./freshness.ts";

const LOCAL = `sha256:${"a".repeat(64)}`;
const OLD = `sha256:${"b".repeat(64)}`;

function cfg(): CliConfig {
  return { socket: "/tmp/dyfj-test.sock", mode: "turn", color: false };
}

interface Call {
  method: string;
  params: unknown;
}

/**
 * A fake runtime: answers each method from `responses`, records every call,
 * and, once a stop has answered `stopping`, refuses new connections, as a
 * stopped runtime's socket does.
 */
function fakeRuntime(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  let stopped = false;
  const connect: ConnectFn = () => {
    if (stopped) {
      return Promise.reject(new Error("connect ENOENT /tmp/dyfj-test.sock"));
    }
    return Promise.resolve({
      request: (method: string, params?: unknown) => {
        calls.push({ method, params });
        const response = responses[method];
        if (response instanceof Error) return Promise.reject(response);
        if (
          method === "runtime/stop" &&
          (response as { status?: string }).status === "stopping"
        ) {
          stopped = true;
        }
        return Promise.resolve(response);
      },
      close: () => {},
    } as unknown as Awaited<ReturnType<ConnectFn>>);
  };
  return { connect, calls };
}

function status(runtime: Record<string, unknown>) {
  return {
    "runtime/liveness": { status: "ok" },
    "runtime/status": { runtime },
  };
}

async function probe(responses: Record<string, unknown>, localHash = LOCAL) {
  const runtime = fakeRuntime(responses);
  const { io, stderr } = fakeIo();
  const code = await runFreshnessProbe(cfg(), io, {
    connect: runtime.connect,
    localHash: () => Promise.resolve(localHash),
  });
  return { code, stderr: stderr.join("\n"), calls: runtime.calls };
}

const methods = (calls: Call[]) => calls.map((call) => call.method);

describe("runFreshnessProbe", () => {
  it("reports an unreachable runtime the way the status probe does", async () => {
    const { io } = fakeIo();
    const code = await runFreshnessProbe(cfg(), io, {
      connect: () => Promise.reject(new Error("connect ENOENT")),
      localHash: () => Promise.resolve(LOCAL),
    });
    assert.equal(code, FRESHNESS_PROBE_UNREACHABLE);
  });

  it("passes a runtime that runs this checkout's code, saying nothing", async () => {
    const result = await probe(
      status({ autostarted: true, fingerprint: { head: "x", contentHash: LOCAL } }),
    );
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.ok(!methods(result.calls).includes("runtime/stop"));
  });

  it("stops a stale autostarted runtime for a restart, only if this is its sole client", async () => {
    const result = await probe({
      ...status({
        autostarted: true,
        clients: 1,
        inFlightTurns: 0,
        fingerprint: { head: "x", contentHash: OLD },
      }),
      "runtime/stop": { status: "stopping" },
    });
    assert.equal(result.code, FRESHNESS_PROBE_RESTART);
    assert.match(result.stderr, /runtime is behind the working tree/);
    assert.match(result.stderr, /restarting it/);
    const stop = result.calls.find((call) => call.method === "runtime/stop");
    assert.deepEqual(stop?.params, { ifSoleClient: true });
  });

  it("warns and keeps a stale autostarted runtime that another client still uses", async () => {
    const result = await probe({
      ...status({
        autostarted: true,
        clients: 2,
        fingerprint: { head: "x", contentHash: OLD },
      }),
      "runtime/stop": { status: "declined", reason: "another client is connected" },
    });
    assert.equal(result.code, 0);
    assert.match(result.stderr, /runtime is behind the working tree/);
    assert.match(result.stderr, /another client is connected/);
  });

  it("never stops a stale runtime started with dyfj start", async () => {
    const result = await probe(
      status({
        autostarted: false,
        clients: 1,
        fingerprint: { head: "x", contentHash: OLD },
      }),
    );
    assert.equal(result.code, 0);
    assert.ok(!methods(result.calls).includes("runtime/stop"));
  });

  it("never restarts an older runtime that reports no fingerprint", async () => {
    const result = await probe(status({ autostarted: true, clients: 1 }));
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.ok(!methods(result.calls).includes("runtime/stop"));
  });

  it("makes no comparison when either hash is unknown", async () => {
    const runtimeUnknown = await probe(
      status({ autostarted: true, fingerprint: { head: "unknown", contentHash: "unknown" } }),
    );
    assert.equal(runtimeUnknown.code, 0);
    assert.equal(runtimeUnknown.stderr, "");
    const localUnknown = await probe(
      status({ autostarted: true, fingerprint: { head: "x", contentHash: OLD } }),
      "unknown",
    );
    assert.equal(localUnknown.code, 0);
    assert.equal(localUnknown.stderr, "");
    assert.ok(!methods(localUnknown.calls).includes("runtime/stop"));
  });

  it("never warns about or stops a runtime whose reported hash is malformed", async () => {
    const result = await probe(
      status({
        autostarted: true,
        clients: 1,
        fingerprint: { head: "x", contentHash: "sha256:not-a-hash" },
      }),
    );
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.ok(!methods(result.calls).includes("runtime/stop"));
  });

  it("keeps the runtime and warns when the conditional stop fails", async () => {
    const result = await probe({
      ...status({
        autostarted: true,
        clients: 1,
        fingerprint: { head: "x", contentHash: OLD },
      }),
      "runtime/stop": new Error("runtime shutdown failed"),
    });
    assert.equal(result.code, 0);
    assert.match(result.stderr, /runtime is behind the working tree/);
  });
});
