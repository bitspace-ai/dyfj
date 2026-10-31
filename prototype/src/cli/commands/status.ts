/** `dyfj status`: probe the runtime and print its standing configuration. */

import {
  compareFreshness,
  prototypeSourceDir,
  sourceTreeHash,
} from "../../config/mod.ts";
import {
  connectUnixClient,
  RpcError,
  RpcErrorCode,
  type UnixClient,
} from "../../transport/mod.ts";
import type { CliConfig } from "../args.ts";
import { formatBudgetLine } from "../budget.ts";
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
    defaultTurnBudgetUsd?: number;
    defaultRunawayStallUsd?: number;
    maxToolSteps?: number;
    /** The highest limit a session may set; absent on older servers. */
    maxToolStepsCeiling?: number;
    models?: { total?: number; local?: number; hosted?: number };
    methods?: string[];
    autostarted?: boolean;
    /** Secret pointers that failed to resolve when the runtime started. */
    unavailableSecrets?: UnavailableSecretEntry[];
    /** The external MCP lines the runtime printed at boot; absent on older servers. */
    externalMcp?: unknown[];
    /** The code the runtime loaded at boot; absent on older servers. */
    fingerprint?: { head?: unknown; contentHash?: unknown };
    /** Open client connections, this one included; absent on older servers. */
    clients?: number;
    /** Turns not yet settled; absent on older servers. */
    inFlightTurns?: number;
    /** The tool sandbox (BIT-662); absent on older servers. */
    sandbox?: { state?: unknown; backend?: unknown; reason?: unknown };
    /** The Dolt store's state (BIT-832); absent on older servers. */
    store?: { state?: unknown; user?: unknown };
  };
}

/**
 * A field of server text as it may be printed: control characters replaced, a
 * non-string rendered as the caller's fallback.
 */
function sanitizeField(value: unknown, fallback: string): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "?")
    : fallback;
}

/**
 * The sandbox segment the posture lines and `dyfj status` show, or null when
 * the runtime reports none. The runtime's `describeSandbox` and the Rust
 * REPL's posture line print the same text.
 */
export function formatSandbox(
  sandbox: NonNullable<RuntimeStatusPayload["runtime"]>["sandbox"],
): string | null {
  if (sandbox === undefined || sandbox === null) return null;
  const text = sanitizeField;
  return sandbox.state === "on"
    ? `sandbox ${text(sandbox.backend, "unknown backend")}`
    : `sandbox OFF (${text(sandbox.reason, "no reason given")}): commands ask`;
}

/**
 * The Dolt store's line, or null when the runtime reports no store (an older
 * server). The refused line names the account and how to fix it; it carries
 * no password and no driver text, which is what the probe reports and all it
 * reports.
 */
export function formatStore(
  store: NonNullable<RuntimeStatusPayload["runtime"]>["store"],
): string | null {
  if (store === undefined || store === null) return null;
  if (store.state === "ok") return "dolt ok";
  if (store.state === "refused") {
    const user = typeof store.user === "string" && store.user.length > 0
      ? sanitizeField(store.user, "")
      : "";
    return user === ""
      ? `dolt REFUSED the login: check DOLT_USER and DOLT_PASSWORD`
      : `dolt REFUSED the login for user "${user}": check DOLT_USER and ` +
        "DOLT_PASSWORD";
  }
  return "dolt unreachable: is the Dolt server running?";
}

/** A fingerprint field for display: its first 12 characters (of the hex). */
function shortFingerprintField(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "unknown";
  if (value.startsWith("sha256:")) return value.slice(0, 19);
  return value.slice(0, 12).replace(/[^0-9a-z]/gi, "?");
}

/**
 * The runtime's code version, and, given this checkout's hash, whether it
 * matches; no line for an older runtime that reports no fingerprint.
 */
function formatCodeLine(
  fingerprint: { head?: unknown; contentHash?: unknown } | undefined,
  localHash: string | undefined,
): string[] {
  if (typeof fingerprint !== "object" || fingerprint === null) return [];
  const freshness = localHash === undefined
    ? "unknown"
    : compareFreshness(fingerprint, localHash);
  const verdict = freshness === "behind"
    ? " (runtime is behind the working tree)"
    : freshness === "current"
    ? " (matches the working tree)"
    : "";
  return [
    `code: ${shortFingerprintField(fingerprint.head)} · ${
      shortFingerprintField(fingerprint.contentHash)
    }${verdict}`,
  ];
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
    "fix what the reason names (unlock the vault, or correct the resolver " +
    "command or pointer), then restart it (`dyfj stop`, then start it again)",
  ];
}

function secretLabel(secret: UnavailableSecretEntry): string {
  if (secret.envVar) return secret.envVar;
  if (secret.name) return `[secrets.named] ${secret.name}`;
  return "(unnamed)";
}

/**
 * The runtime's external MCP boot lines, as it printed them: one per server
 * and one per configured tool that did not reach the model. Control
 * characters are stripped; a non-string entry is skipped.
 */
export function formatExternalMcpLines(lines: unknown): string[] {
  if (!Array.isArray(lines)) return [];
  return lines.filter((line): line is string => typeof line === "string")
    .map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""));
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
  localHash?: string,
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
    ...[formatSandbox(runtime.sandbox)].filter((line) => line !== null),
    ...[formatStore(runtime.store)].filter((line) => line !== null),
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
    formatBudgetLine({
      turn: runtime.defaultTurnBudgetUsd,
      session: runtime.defaultSessionBudgetUsd,
      day: runtime.defaultDailyBudgetUsd,
      perCall: runtime.defaultPerCallBudgetUsd,
      runaway: runtime.defaultRunawayStallUsd,
    }),
    `tool-step limit: ${runtime.maxToolSteps ?? "unknown"}` +
      (runtime.maxToolStepsCeiling === undefined
        ? ""
        : ` (ceiling ${runtime.maxToolStepsCeiling})`),
    ...(runtime.autostarted !== undefined
      ? [
        `launch: ${
          runtime.autostarted ? "autostarted (background)" : "manual"
        }`,
      ]
      : []),
    ...formatCodeLine(runtime.fingerprint, localHash),
    ...(typeof runtime.clients === "number" &&
        typeof runtime.inFlightTurns === "number"
      ? [
        `clients: ${runtime.clients} · turns in flight: ${runtime.inFlightTurns}`,
      ]
      : []),
    ...formatUnavailableSecrets(runtime.unavailableSecrets),
    ...formatExternalMcpLines(runtime.externalMcp),
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
      const localHash = await sourceTreeHash(prototypeSourceDir());
      io.out(`${formatRuntimeStatus(config, payload, localHash)}\n`);
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
