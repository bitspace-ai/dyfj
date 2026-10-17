/**
 * The launcher's freshness probe (`main --freshness-probe`): is a runtime
 * answering on the socket, and does it run the code in this checkout?
 *
 * The launcher runs it as its first probe before an invocation that needs a
 * runtime. A runtime `dyfj` autostarted is `dyfj`'s own, so when it is behind
 * the working tree the probe stops it and the launcher autostarts a current
 * one. The stop is conditional (`ifSoleClient`): the runtime refuses it while
 * another client is connected or a turn is in flight, deciding in the same
 * step as the stop, so a restart never cuts off another client. Then the probe
 * warns and leaves it running. A runtime started with `dyfj start` is the
 * operator's and is never stopped here; the posture line warns about it. An
 * older runtime that reports no fingerprint, or an unknown hash on either
 * side, is never compared.
 */

import {
  compareFreshness,
  FINGERPRINT_UNKNOWN,
} from "../../config/mod.ts";
import { connectUnixClient } from "../../transport/mod.ts";
import type { CliConfig } from "../args.ts";
import type { ConnectFn, Io } from "../io.ts";
import {
  LIVENESS_PROBE_TIMEOUT_MS,
  probeRuntimeLiveness,
  type RuntimeStatusPayload,
} from "./status.ts";
import { waitForSocketClosed } from "./stop.ts";

/** The runtime is up; the launcher uses it as it is. */
export const FRESHNESS_PROBE_READY = 0;
/** Nothing answered; the launcher autostarts, as after a failed status. */
export const FRESHNESS_PROBE_UNREACHABLE = 1;
/** A stale autostarted runtime was stopped; the launcher autostarts anew. */
export const FRESHNESS_PROBE_RESTART = 3;

export interface FreshnessProbeDeps {
  connect?: ConnectFn;
  /** This checkout's source hash, or `unknown`. */
  localHash: () => Promise<string>;
}

const BEHIND = "dyfj: the autostarted runtime is behind the working tree";

export async function runFreshnessProbe(
  config: CliConfig,
  io: Io,
  deps: FreshnessProbeDeps,
): Promise<number> {
  const connect = deps.connect ?? connectUnixClient;
  let payload: RuntimeStatusPayload;
  try {
    const signal = AbortSignal.timeout(LIVENESS_PROBE_TIMEOUT_MS);
    const client = await connect(config.socket, undefined, signal);
    try {
      const probed = await probeRuntimeLiveness(client, signal);
      payload = probed.statusPayload ??
        await client.request("runtime/status", undefined, signal) as
          RuntimeStatusPayload;
      const runtime = payload.runtime ?? {};
      if (runtime.autostarted !== true) return FRESHNESS_PROBE_READY;
      const localHash = await deps.localHash().catch(() => FINGERPRINT_UNKNOWN);
      if (compareFreshness(runtime.fingerprint, localHash) !== "behind") {
        return FRESHNESS_PROBE_READY;
      }
      let stop: { status?: unknown; reason?: unknown };
      try {
        stop = await client.request(
          "runtime/stop",
          { ifSoleClient: true },
          signal,
        ) as typeof stop;
      } catch {
        io.err(`${BEHIND}; it could not be stopped for a restart`);
        return FRESHNESS_PROBE_READY;
      }
      if (stop?.status !== "stopping") {
        const reason = typeof stop?.reason === "string"
          ? stop.reason
          : "it declined to stop";
        io.err(
          `${BEHIND}; not restarting it because ${reason}. It stops 10 s ` +
            "after its last client disconnects; the next dyfj after that " +
            "loads the current code",
        );
        return FRESHNESS_PROBE_READY;
      }
    } finally {
      client.close();
    }
  } catch {
    return FRESHNESS_PROBE_UNREACHABLE;
  }
  io.err(`${BEHIND}; restarting it`);
  // The launcher's autostart must not race the old runtime's socket.
  return (await waitForSocketClosed(config.socket, connect))
    ? FRESHNESS_PROBE_RESTART
    : FRESHNESS_PROBE_UNREACHABLE;
}
