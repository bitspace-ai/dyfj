/** `dyfj status`: probe the runtime and print its standing configuration. */

import {
  connectUnixClient,
  RpcError,
  RpcErrorCode,
  type UnixClient,
} from "../../transport/mod.ts";
import type { CliConfig } from "../args.ts";
import type { ConnectFn, Io } from "../io.ts";
import { socketError } from "../render/errors.ts";

export interface RuntimeStatusPayload {
  runtime?: {
    transport?: string;
    clearance?: string;
    defaultCompanionModel?: string | null;
    /** Server-resolved bare-turn route; absent on older servers, null when unroutable. */
    defaultTurnModel?: {
      slug?: string;
      displayName?: string;
      tier?: number;
      local?: boolean;
      reason?: string;
    } | null;
    permissionLevel?: string;
    approvePaidDefault?: boolean;
    trustWorkspaceInstructions?: boolean;
    defaultSessionBudgetUsd?: number;
    defaultPerCallBudgetUsd?: number;
    defaultDailyBudgetUsd?: number;
    maxToolSteps?: number;
    models?: { total?: number; local?: number; hosted?: number };
    methods?: string[];
    autostarted?: boolean;
    /** Secret pointers that failed to resolve when the runtime started. */
    unavailableSecrets?: UnavailableSecretEntry[];
  };
}

/** A failed pointer as `runtime/status` reports it: an env var or a name. */
export interface UnavailableSecretEntry {
  envVar?: string;
  name?: string;
  reason?: string;
}

/**
 * One line per secret pointer that failed at runtime start. Whatever reads one
 * (a provider, an MCP server) has no credential until the runtime restarts, so
 * the line says how to recover rather than leaving it to the first failure.
 */
export function formatUnavailableSecrets(
  secrets: readonly UnavailableSecretEntry[] | undefined,
): string[] {
  if (!Array.isArray(secrets) || secrets.length === 0) return [];
  return [
    ...secrets.map((secret) =>
      `secret unavailable since start: ${secretLabel(secret)} (${
        secret.reason ?? "unavailable"
      })`
    ),
    "  anything reading these has no credential until the runtime restarts; " +
    "unlock the vault, then restart it (`dyfj stop`, then start it again)",
  ];
}

function secretLabel(secret: UnavailableSecretEntry): string {
  if (secret.envVar) return secret.envVar;
  if (secret.name) return `[secrets.named] ${secret.name}`;
  return "(unnamed)";
}

export const LIVENESS_PROBE_TIMEOUT_MS = 5000;

/**
 * Probe runtime liveness over UDS with a client-owned deadline (default 5s).
 *
 * First attempts the lightweight `runtime/liveness` RPC (which does not load models,
 * query Dolt, or touch inference state). If the server is an older version that
 * does not implement `runtime/liveness` (RpcErrorCode.methodNotFound / -32601),
 * falls back once to `runtime/status` within the SAME remaining deadline.
 */
export async function probeRuntimeLiveness(
  client: UnixClient,
  signal: AbortSignal = AbortSignal.timeout(LIVENESS_PROBE_TIMEOUT_MS),
): Promise<{ live: true; statusPayload?: RuntimeStatusPayload }> {
  try {
    await client.request("runtime/liveness", undefined, signal);
    return { live: true };
  } catch (error) {
    // If the server returns methodNotFound (-32601), fall back once to runtime/status on the same signal
    if (
      error instanceof RpcError && error.code === RpcErrorCode.methodNotFound
    ) {
      const statusPayload = await client.request(
        "runtime/status",
        undefined,
        signal,
      ) as RuntimeStatusPayload;
      return { live: true, statusPayload };
    }
    throw error;
  }
}

export function formatRuntimeStatus(
  config: CliConfig,
  payload: RuntimeStatusPayload,
): string {
  const runtime = payload.runtime ?? {};
  const models = runtime.models ?? {};
  const methods = runtime.methods ?? [];
  const resolved = runtime.defaultTurnModel;
  return [
    `runtime: reachable`,
    `socket: ${config.socket}`,
    `transport: ${runtime.transport ?? "unknown"} / ${
      runtime.clearance ?? "unknown"
    }`,
    `default model: ${runtime.defaultCompanionModel ?? "(registry default)"}`,
    // The route a bare turn actually takes — under the local-by-default
    // posture this can differ from the configured default model above. An
    // explicit null (the server tried and bare-turn selection failed — no
    // routable local model, a misconfigured or unpriced default, …) renders
    // as an unavailable state rather than silently omitting the line; only an
    // older server that never sent the field omits it. The wording stays
    // cause-neutral because the null carries no failure reason.
    ...(resolved != null && typeof resolved.slug === "string"
      ? [
        `bare-turn route: ${resolved.slug} (tier ${resolved.tier ?? "?"}, ${
          resolved.local === undefined
            ? "locality unknown"
            : resolved.local
            ? "local"
            : "hosted"
        })`,
      ]
      : resolved === null
      ? [
        "bare-turn route: unavailable (selection failed — check the model " +
        "registry and default model)",
      ]
      : []),
    `models: ${models.total ?? 0} total · ${models.local ?? 0} local · ${
      models.hosted ?? 0
    } hosted`,
    `permission: ${runtime.permissionLevel ?? "unknown"}`,
    `approve paid default: ${
      runtime.approvePaidDefault === true ? "yes" : "no"
    }`,
    `workspace instructions: ${
      // Strict, matching formatPostureLine: literal booleans only; any other
      // wire shape is missing evidence, not a confirmed posture.
      runtime.trustWorkspaceInstructions === true
        ? "trusted"
        : runtime.trustWorkspaceInstructions === false
        ? "off"
        : "unknown"}`,
    `budget: $${(runtime.defaultSessionBudgetUsd ?? 0).toFixed(2)} session · $${
      (runtime.defaultDailyBudgetUsd ?? 0).toFixed(2)
    } day · $${(runtime.defaultPerCallBudgetUsd ?? 0).toFixed(2)} per call`,
    `tool-step limit: ${runtime.maxToolSteps ?? "unknown"}`,
    ...(runtime.autostarted !== undefined
      ? [
        `launch: ${
          runtime.autostarted ? "autostarted (background)" : "manual"
        }`,
      ]
      : []),
    ...formatUnavailableSecrets(runtime.unavailableSecrets),
    `methods: ${methods.length}`,
  ].join("\n");
}

export async function runStatus(
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
): Promise<number> {
  try {
    const signal = AbortSignal.timeout(LIVENESS_PROBE_TIMEOUT_MS);
    const client = await connect(config.socket, undefined, signal);
    try {
      const probeResult = await probeRuntimeLiveness(client, signal);
      const payload = probeResult.statusPayload ??
        (await client.request(
          "runtime/status",
          undefined,
          signal,
        ) as RuntimeStatusPayload);
      io.out(`${formatRuntimeStatus(config, payload)}\n`);
      return 0;
    } finally {
      client.close();
    }
  } catch (error) {
    io.out(`runtime: unreachable\n`);
    io.out(`socket: ${config.socket}\n`);
    io.err(socketError(error, config));
    return 1;
  }
}
