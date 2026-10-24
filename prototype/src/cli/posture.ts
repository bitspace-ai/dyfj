/**
 * The REPL's session posture: the line naming the model, spend and permission
 * posture a session runs under, read from the runtime over the UDS seam, and
 * the warning that follows it when the runtime is behind this checkout's code.
 * `openReplSession` prints them at session start and holds the session's
 * presence on the runtime. The Rust REPL prints the same warning
 * (`core/dyfj-repl/src/posture.rs`).
 */

import {
  compareFreshness,
  prototypeSourceDir,
  sourceTreeHash,
} from "../config/mod.ts";
import { connectUnixClient } from "../transport/mod.ts";
import type { CliConfig } from "./args.ts";
import type { ConnectFn, Io } from "./io.ts";
import { socketError } from "./render/errors.ts";
import type { ModelRow } from "./commands/models.ts";
import {
  LIVENESS_PROBE_TIMEOUT_MS,
  type RuntimeStatusPayload,
} from "./commands/status.ts";

/** Inputs for the operator posture line (session start and /model switches). */
export interface SessionPosture {
  /** Active model slug, or the server-resolved bare-turn default. */
  slug: string;
  tier?: number;
  /** true = on-machine local provider; false = hosted; undefined = unknown. */
  local?: boolean;
  /** This session opted into paid inference (--approve-paid / /model --approve-paid). */
  approvePaidSession: boolean;
  /** Standing paid posture from engine config (approve_paid_default). */
  approvePaidDefault?: boolean;
  permissionLevel?: string;
  /** Standing workspace-instruction trust from engine config (trust_workspace_instructions). */
  trustWorkspaceInstructions?: boolean;
  fast?: boolean;
  /** The code the runtime loaded; absent from an older runtime. */
  runtimeFingerprint?: unknown;
  /** Whether `dyfj` autostarted the runtime; absent from an older runtime. */
  autostarted?: boolean;
  /** The session's tool-step limit: its own, else the runtime's configured one. */
  maxToolSteps?: number;
  /** The highest limit a session may set; absent from an older runtime. */
  maxToolStepsCeiling?: number;
}

/**
 * The line after the posture line when the runtime is behind this checkout's
 * code, saying how it will catch up; null when it is current, or when either
 * side's hash is unknown (no comparison). The Rust REPL prints the same text
 * (`core/dyfj-repl/src/posture.rs`).
 */
export function formatFreshnessWarning(
  posture: Pick<SessionPosture, "runtimeFingerprint" | "autostarted">,
  localHash: string,
): string | null {
  if (compareFreshness(posture.runtimeFingerprint, localHash) !== "behind") {
    return null;
  }
  return posture.autostarted === true
    ? "warning: runtime is behind the working tree; dyfj started it, so it " +
      "stops 10 s after its last client disconnects and the next dyfj loads " +
      "the current code"
    : "warning: runtime is behind the working tree; it was started with " +
      "`dyfj start`, so restart it to load the current code: `dyfj stop`, " +
      "then `dyfj start`";
}

/**
 * One plain stderr line stating the routing/spend/permission posture: model,
 * tier, local vs hosted, paid posture, permission level, and whether workspace
 * instructions are trusted. Printed at REPL start and after every /model switch;
 * deliberately uncolored so NO_COLOR and non-TTY output carry the identical bytes.
 */
export function formatPostureLine(posture: SessionPosture): string {
  const tier = posture.tier !== undefined ? `tier ${posture.tier}` : "tier ?";
  const locality = posture.local === undefined
    ? "locality unknown"
    : posture.local
    ? "local"
    : "hosted";
  const speed = posture.fast === true ? " · ⚡ fast" : "";
  const paid = posture.approvePaidSession
    ? "paid approved (session)"
    : posture.approvePaidDefault === true
    ? "paid approved (standing config)"
    : "paid off (hosted turns fail closed)";
  // Three states, mirroring the locality/permission convention above: an absent
  // field is missing evidence, not a confirmed-off stance — say "unknown" rather
  // than overclaiming a reassuring "off" the runtime never reported.
  // Strict classification: the wire value is unvalidated JSON, so "trusted"
  // and "off" require the literal booleans — every other shape (absent, null,
  // a stringly "false", 0) is missing evidence and renders "unknown".
  const workspace = posture.trustWorkspaceInstructions === true
    ? "trusted"
    : posture.trustWorkspaceInstructions === false
    ? "off"
    : "unknown";
  const steps = posture.maxToolSteps === undefined
    ? ""
    : ` · ${formatToolSteps(posture.maxToolSteps, posture.maxToolStepsCeiling)}`;
  return `posture: ${posture.slug} · ${tier} · ${locality}${speed} · ${paid} · ` +
    `permission ${posture.permissionLevel ?? "unknown"} · ` +
    `workspace instructions: ${workspace}${steps}`;
}

/** "N tool steps (ceiling M)", without the ceiling an older runtime omits. */
export function formatToolSteps(steps: number, ceiling?: number): string {
  return `${steps} tool steps` +
    (ceiling === undefined ? "" : ` (ceiling ${ceiling})`);
}

/**
 * Resolve the posture line's inputs over the UDS seam: the runtime's standing
 * config (permission level, paid default) plus the active model's tier and
 * locality — the explicit `config.model` when set, else the server-resolved
 * bare-turn default. One connection for the whole read.
 */
export async function fetchSessionPosture(
  config: CliConfig,
  connect: ConnectFn = connectUnixClient,
): Promise<SessionPosture | { error: string }> {
  try {
    const signal = AbortSignal.timeout(LIVENESS_PROBE_TIMEOUT_MS);
    const client = await connect(config.socket, undefined, signal);
    try {
      const { runtime } = await client.request(
        "runtime/status",
        undefined,
        signal,
      ) as RuntimeStatusPayload;
      let slug = config.model;
      let tier: number | undefined;
      let local: boolean | undefined;
      if (slug !== undefined) {
        const { models } = await client.request(
          "models/list",
          undefined,
          signal,
        ) as {
          models: ModelRow[];
        };
        const row = models.find((m) => m.slug === slug);
        tier = row?.tier;
        local = row?.local;
      } else if (config.tier !== undefined || config.hint !== undefined) {
        // Explicit tier/hint routing rides every turn, so the server's
        // bare-turn default does not describe this session; name the routing
        // rather than showing a default the session never uses.
        slug = config.tier !== undefined
          ? `(tier ${config.tier} route)`
          : `(hint ${config.hint} route)`;
        tier = config.tier;
      } else {
        const resolved = runtime?.defaultTurnModel;
        if (resolved != null && typeof resolved.slug === "string") {
          slug = resolved.slug;
          tier = resolved.tier;
          local = resolved.local;
        }
      }
      return {
        slug: slug ?? "(registry default)",
        tier,
        local,
        approvePaidSession: config.approvePaid === true,
        approvePaidDefault: runtime?.approvePaidDefault,
        permissionLevel: runtime?.permissionLevel,
        trustWorkspaceInstructions: runtime?.trustWorkspaceInstructions,
        ...(config.fast !== undefined ? { fast: config.fast } : {}),
        ...((config.toolSteps ?? runtime?.maxToolSteps) !== undefined
          ? { maxToolSteps: config.toolSteps ?? runtime?.maxToolSteps }
          : {}),
        ...(runtime?.maxToolStepsCeiling !== undefined
          ? { maxToolStepsCeiling: runtime.maxToolStepsCeiling }
          : {}),
        ...(runtime?.fingerprint !== undefined
          ? { runtimeFingerprint: runtime.fingerprint }
          : {}),
        ...(runtime?.autostarted !== undefined
          ? { autostarted: runtime.autostarted }
          : {}),
      };
    } finally {
      client.close();
    }
  } catch (error) {
    return { error: socketError(error, config) };
  }
}

/**
 * Start a REPL session: print the posture line (and the freshness warning)
 * and hold the session's presence on the runtime. Returns the call that
 * releases the presence when the session ends.
 *
 * Interactive sessions only. An unreachable runtime prints nothing here: the
 * first turn already reports reachability loudly, and the REPL must still
 * open. With piped stdin, readline closes on EOF during any await that
 * precedes the first readLine, so the posture probe would silently swallow
 * the piped input; scripted sessions keep main-line behavior byte-identical.
 *
 * The presence is one connection held open for the session. Each turn opens
 * its own connection, so between turns this is the REPL's only one, and it
 * keeps a runtime the launcher autostarted from stopping while the operator
 * sits at the prompt (such a runtime stops 10 s after its last client
 * leaves). Piped input runs its turns back to back, with no prompt to wait
 * at. When no runtime answers, there is no presence to keep.
 */
export async function openReplSession(
  config: CliConfig,
  io: Io,
  connect: ConnectFn,
  interactive: boolean,
): Promise<() => void> {
  if (!interactive) return () => {};
  const posture = await fetchSessionPosture(config, connect);
  if (!("error" in posture)) {
    io.err(formatPostureLine(posture));
    const warning = formatFreshnessWarning(
      posture,
      await sourceTreeHash(prototypeSourceDir()),
    );
    if (warning !== null) io.err(warning);
  }
  const presence = Promise.resolve()
    .then(() => connect(config.socket))
    .catch(() => undefined);
  // Closed once it settles, never awaited: a connect that has not answered
  // must not hold the REPL open.
  return () => void presence.then((client) => client?.close());
}
