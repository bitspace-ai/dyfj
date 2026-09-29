/**
 * dyfj — the interactive line REPL (multi-turn, streaming), with its slash
 * commands and session posture line. The entrypoint is `cli/main.ts`; the
 * turn client, approval prompt, rendering and subcommands it shares with
 * `exec` live under `cli/`.
 *
 * A THIN client over the Workbench runtime's JSON-RPC/UDS seam — it never
 * imports the engine (no mysql2, no provider SDKs), so the compiled binary
 * stays small and the server can migrate to Rust under the same contract.
 */

import {
  SESSION_ID_SHAPE,
  summarizeError,
  type WorkbenchSessionEvent,
} from "./contract/mod.ts";
import { connectUnixClient, type UnixClient } from "./transport/mod.ts";
import {
  draftWorkPacketFromContext,
  formatWorkPacketMarkdown,
  IdeaPacketRegistry,
  markWorkbenchIdea,
  stripOuterQuotes,
  type WorkbenchIdea,
  type WorkbenchWorkPacket,
} from "./extensions/ideas/client.ts";
import {
  type FrictionPostResult,
  normalizeFrictionContext,
} from "./extensions/friction/client.ts";
import { promptMidTurnApproval } from "./cli/approval.ts";
import type { CliConfig } from "./cli/args.ts";
import type { ConnectFn, Io, TurnInterruptSource } from "./cli/io.ts";
import { socketError } from "./cli/render/errors.ts";
import { formatReceipt } from "./cli/render/receipt.ts";
import { createTurnOutputHandlers } from "./cli/render/turn-output.ts";
import {
  createTurnSpinner,
  spinnerGuardedTurnHandlers,
} from "./cli/render/turn-spinner.ts";
import {
  buildTurnBody,
  socketTurn,
  TurnCancellationUncertainError,
  type TurnResult,
} from "./cli/turn-client.ts";
import { fetchModelSlugs, type ModelRow } from "./cli/commands/models.ts";
import {
  LIVENESS_PROBE_TIMEOUT_MS,
  type RuntimeStatusPayload,
} from "./cli/commands/status.ts";

/**
 * The REPL entry prompt. On a color terminal the gutter is bold green — a hue
 * the output renderer never uses (its palette: bright-cyan headers, cyan code,
 * dim receipts/markers) — so in scrollback the operator's lines are exactly
 * the ones carrying the green `dyfj ❯` gutter. Plain mode stays byte-identical
 * to the historical `dyfj> ` prompt, so NO_COLOR/non-TTY behavior is unchanged.
 */
export function replPrompt(color: boolean): string {
  return color ? "\n\x1b[1m\x1b[32mdyfj ❯\x1b[0m " : "\ndyfj> ";
}

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
  return `posture: ${posture.slug} · ${tier} · ${locality}${speed} · ${paid} · ` +
    `permission ${posture.permissionLevel ?? "unknown"} · ` +
    `workspace instructions: ${workspace}`;
}

export async function runRepl(
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
  interactive = true,
  interrupts: TurnInterruptSource | undefined = io.turnInterrupts,
): Promise<number> {
  io.err(
    `dyfj — ${config.socket} · Ctrl-D or /exit to quit`,
  );
  // Session-start posture line. An unreachable runtime prints nothing here:
  // the first turn already reports reachability loudly, and the REPL must
  // still open. Interactive sessions only: with piped stdin, readline closes
  // on EOF during any await that precedes the first readLine, so this probe
  // would silently swallow the piped input; scripted sessions keep main-line
  // behavior byte-identical.
  if (interactive) {
    const posture = await fetchSessionPosture(config, connect);
    if (!("error" in posture)) io.err(formatPostureLine(posture));
  }
  const sessionState: ReplSessionState = {
    sessionId: config.sessionId,
    turnCount: 0,
    sessionSpendUsd: 0,
    workspace: config.sessionId === undefined ? config.workspace : undefined,
    eventCounter: 0,
  };
  let exitCode = 0;
  try {
    for (;;) {
      const line = await io.readLine(replPrompt(config.color));
      if (line === null) break;
      if (line.length > 32768) {
        io.err("command line exceeds maximum length of 32768 characters");
        continue;
      }
      const prompt = line.trim();
      if (prompt.length === 0) continue;
      if (prompt === "/exit" || prompt === "/quit") break;
      if (
        await handleReplSessionCommand(
          prompt,
          config,
          io,
          sessionState,
          connect,
        )
      ) {
        sessionState.lastReplCommand = prompt;
        continue;
      }
      if (
        await handleReplIdeaCommand(prompt, config, io, sessionState, connect)
      ) {
        sessionState.lastReplCommand = prompt;
        continue;
      }
      if (
        await handleReplPacketCommand(
          prompt,
          config,
          io,
          sessionState,
          connect,
        )
      ) {
        sessionState.lastReplCommand = prompt;
        continue;
      }
      if (
        await handleReplFrictionCommand(
          prompt,
          config,
          io,
          sessionState,
          connect,
          interactive,
        )
      ) continue;
      if (await handleReplModelCommand(prompt, config, io, connect)) {
        sessionState.lastReplCommand = prompt;
        continue;
      }
      if (await handleReplFastCommand(prompt, config, io, connect)) {
        sessionState.lastReplCommand = prompt;
        continue;
      }
      try {
        const body = buildTurnBody(prompt, config, sessionState.sessionId);
        const spinner = createTurnSpinner(config, io);
        const output = createTurnOutputHandlers(config, io, {
          beforeWrite: () => spinner.pause(),
          afterWrite: () => {
            spinner.updateLabel("working…");
            spinner.start();
          },
        });
        const abortController = new AbortController();
        const onApproval = (request: unknown) =>
          promptMidTurnApproval(
            io,
            request,
            interactive,
            abortController?.signal,
          );
        const handlers = spinnerGuardedTurnHandlers(
          spinner,
          output,
          io,
          onApproval,
        );
        const terminalHandlers = {
          ...handlers,
          onEvent: (event: Record<string, unknown>) => {
            if (event.type === "turnAborted") return;
            handlers.onEvent(event);
          },
        };
        let interruptRequested = false;
        const interrupt = () => {
          if (interruptRequested) return;
          interruptRequested = true;
          abortController?.abort();
          try {
            spinner.stop();
          } catch {
            // A failed terminal erase must not escape before cancellation runs.
          }
          try {
            io.err("[interrupt requested]");
          } catch {
            // A terminal write failure must not prevent the cancellation.
          }
        };
        let interruptInstalled = false;
        let turnFailed = false;
        let result: TurnResult;
        try {
          spinner.start();
          result = await socketTurn(
            config,
            body,
            {
              ...terminalHandlers,
              abortSignal: abortController.signal,
              onConnected: () => {
                if (interrupts !== undefined) {
                  interrupts.add(interrupt);
                  interruptInstalled = true;
                }
              },
            },
            connect,
          );
          sessionState.sessionId = result.sessionId;
        } catch (error) {
          turnFailed = true;
          throw error;
        } finally {
          abortController?.abort();
          let cleanupFailed = false;
          let cleanupError: unknown;
          try {
            if (interruptInstalled) interrupts?.remove(interrupt);
          } catch (error) {
            cleanupFailed = true;
            cleanupError = error;
          }
          try {
            spinner.stop();
          } catch (error) {
            if (!cleanupFailed) cleanupError = error;
            cleanupFailed = true;
          }
          if (!turnFailed && cleanupFailed) throw cleanupError;
        }
        if (!output.streamed() && result.text.length > 0) {
          output.emitBufferedText(result.text);
        } else {
          output.finish();
        }
        if (result.stopReason === "aborted") {
          handlers.onEvent({ type: "turnAborted" });
        }
        sessionState.sessionId = result.sessionId;
        sessionState.lastModelSlug = "model" in result
          ? result.model.slug
          : undefined;
        sessionState.turnCount++;
        sessionState.eventCounter = (sessionState.eventCounter ?? 0) + 1;
        const eventNum = sessionState.eventCounter;
        if ("cost" in result) {
          sessionState.sessionSpendUsd += result.cost.totalUsd;
        }
        if (!sessionState.events) sessionState.events = [];
        sessionState.events.push(createCliSessionEvent({
          eventId: `evt_u_${eventNum}`,
          sessionId: result.sessionId,
          eventType: "session_start",
          content: prompt,
          createdAt: new Date().toISOString(),
        }));
        if (result.text) {
          sessionState.events.push(createCliSessionEvent({
            eventId: `evt_a_${eventNum}`,
            sessionId: result.sessionId,
            eventType: "model_response",
            content: result.text,
            createdAt: new Date().toISOString(),
          }));
        }
        if (sessionState.events.length > 50) {
          sessionState.events = sessionState.events.slice(-50);
        }
        io.err(
          formatReceipt(
            result,
            config.color,
            "cost" in result ? sessionState.sessionSpendUsd : undefined,
          ),
        );
      } catch (error) {
        io.err(socketError(error, config));
        if (error instanceof TurnCancellationUncertainError) {
          exitCode = 1;
          break;
        }
      }
      sessionState.lastReplCommand = undefined;
    }
  } finally {
    io.close();
  }
  return exitCode;
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
      };
    } finally {
      client.close();
    }
  } catch (error) {
    return { error: socketError(error, config) };
  }
}

function createCliSessionEvent(input: {
  sessionId?: string;
  eventId: string;
  eventType: string;
  content: string;
  createdAt: string;
}): WorkbenchSessionEvent {
  const boundedContent = input.content.length > 4000
    ? input.content.slice(0, 3950) + "\n...[truncated]"
    : input.content;
  return {
    sessionId: input.sessionId,
    eventId: input.eventId,
    eventType: input.eventType,
    traceId: "cli_trace",
    spanId: "cli_span",
    parentSpanId: null,
    traceFlags: null,
    traceState: null,
    spanKind: null,
    parentIsRemote: null,
    principalId: "operator",
    modelId: null,
    provider: null,
    api: null,
    content: boundedContent,
    stopReason: null,
    tokensInput: null,
    tokensOutput: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    costTotal: null,
    durationMs: null,
    providerCallOrder: null,
    providerCallPurpose: null,
    providerErrorClass: null,
    unparsedToolCallCount: null,
    unparsedToolCallCountIsLowerBound: null,
    runnerKind: null,
    runnerProfile: null,
    runnerProtocol: null,
    runnerProtocolVersion: null,
    runnerStopReason: null,
    runnerExternalSessionId: null,
    runnerAgentName: null,
    runnerAgentVersion: null,
    runnerTransport: null,
    runnerAccessRoute: null,
    runnerCostBasis: null,
    runnerWorkspace: null,
    runnerCapabilities: null,
    runnerEvidenceScope: null,
    runnerRouteSource: null,
    runnerAuthType: null,
    permissionVerdict: null,
    toolName: null,
    toolCallId: null,
    toolArguments: null,
    toolResult: null,
    toolIsError: null,
    createdAt: input.createdAt,
  };
}

export interface ReplSessionState {
  sessionId?: string;
  turnCount: number;
  sessionSpendUsd: number;
  workspace?: string;
  events?: WorkbenchSessionEvent[];
  eventCounter?: number;
  lastModelSlug?: string;
  lastReplCommand?: string;
  lastFriction?: FrictionPostResult;
  /** The in-process idea/packet registry of the `unix: false` path. */
  ideaRegistry?: IdeaPacketRegistry;
}

// The `unix: false` path keeps ideas and packets in a registry this REPL
// session owns, created on first use.
function localIdeaRegistry(state: ReplSessionState): IdeaPacketRegistry {
  return state.ideaRegistry ??= new IdeaPacketRegistry();
}

function formatShellArg(arg: string): string {
  if (/^[a-zA-Z0-9_.-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export async function handleReplSessionCommand(
  line: string,
  config: CliConfig,
  io: Io,
  sessionState: ReplSessionState,
  connect: ConnectFn = connectUnixClient,
): Promise<boolean> {
  if (line.length > 32768) {
    io.err("command line exceeds maximum length of 32768 characters");
    return true;
  }
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("/session")) return false;
  const parts = trimmed.trimEnd().split(/\s+/);
  if (parts[0] !== "/session") return false;

  const sub = parts[1];
  if (!sub) {
    if (!sessionState.sessionId) {
      io.err("no session yet — send a prompt first");
    } else {
      const cleanSessionId = (sessionState.sessionId ?? "")
        .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
        .trim();
      io.err(`session: ${cleanSessionId}`);
      if (sessionState.turnCount === 0 && config.unix) {
        try {
          const client = await connect(config.socket);
          try {
            const inspect = await client.request("sessions/inspect", {
              sessionId: cleanSessionId,
            }) as { eventCount?: number; workspace?: string | null };
            if (inspect.eventCount !== undefined && inspect.eventCount > 0) {
              io.err(`events: ${inspect.eventCount}`);
            }
            if (inspect.workspace) {
              const cleanWorkspace = inspect.workspace
                .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
                .trim();
              io.err(`workspace: ${cleanWorkspace}`);
            }
          } finally {
            client.close();
          }
        } catch {
          // inspection optional
        }
      }
      io.err(`repl turns (this session): ${sessionState.turnCount}`);
      io.err(
        `repl spend (this session): $${
          sessionState.sessionSpendUsd.toFixed(4)
        }`,
      );
      io.err(
        `resume later with: dyfj --session ${formatShellArg(cleanSessionId)}`,
      );
    }
    return true;
  }

  if (sub === "list") {
    if (parts.length > 2) {
      io.err("usage: /session list");
      return true;
    }
    if (config.unix) {
      try {
        const client = await connect(config.socket);
        try {
          const res = await client.request("sessions/list", { limit: 15 }) as {
            projects?: Array<{
              sessions: Array<{
                sessionId: string;
                taskDescription: string;
                createdAt: string;
                updatedAt?: string;
              }>;
            }>;
          };
          const parseSessionSortKey = (s: {
            updatedAt?: string;
            createdAt?: string;
            sessionId?: string;
          }): string => {
            const ts = s.updatedAt || s.createdAt || "";
            if (ts) {
              if (/^\d{4}-\d{2}-\d{2}T/.test(ts)) return ts;
              const parsed = Date.parse(ts);
              if (!isNaN(parsed)) return new Date(parsed).toISOString();
              return ts;
            }
            return s.sessionId || "";
          };

          const formatSessionDate = (raw: string): string => {
            if (!raw) return "";
            if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
            const parsed = Date.parse(raw);
            if (!isNaN(parsed)) {
              return new Date(parsed).toISOString().slice(0, 10);
            }
            return raw.slice(0, 10);
          };

          const sessions: Array<{
            sessionId: string;
            taskDescription: string;
            createdAt: string;
            updatedAt?: string;
          }> = [];
          for (const p of res.projects ?? []) {
            if (Array.isArray(p.sessions)) {
              for (const s of p.sessions) {
                const sKey = parseSessionSortKey(s);
                if (sessions.length < 15) {
                  sessions.push(s);
                  sessions.sort((a, b) =>
                    parseSessionSortKey(b).localeCompare(parseSessionSortKey(a))
                  );
                } else if (
                  sKey.localeCompare(
                    parseSessionSortKey(sessions[sessions.length - 1]),
                  ) > 0
                ) {
                  sessions[sessions.length - 1] = s;
                  sessions.sort((a, b) =>
                    parseSessionSortKey(b).localeCompare(parseSessionSortKey(a))
                  );
                }
              }
            }
          }
          if (sessions.length === 0) {
            io.err("no sessions found");
          } else {
            io.err("Recent sessions:");
            for (const s of sessions) {
              const cleanId = (s.sessionId ?? "")
                .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
                .trim();
              const cleanCreated = formatSessionDate(s.createdAt ?? "");
              const cleanDesc = (s.taskDescription ?? "")
                .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, " ")
                .trim();
              io.err(
                `  ${cleanId}  ${cleanCreated}  ${cleanDesc}`,
              );
            }
            io.err(
              "resume with: /session switch <sessionId> or dyfj --session <sessionId>",
            );
          }
        } finally {
          client.close();
        }
      } catch (e) {
        io.err(`dyfj: failed to list sessions: ${summarizeError(e)}`);
      }
    } else {
      io.err("session listing over HTTP is not supported in REPL");
    }
    return true;
  }

  if (sub === "switch") {
    if (parts.length !== 3) {
      io.err("usage: /session switch <sessionId>");
      return true;
    }
    const rawTargetId = parts[2];
    if (rawTargetId.length === 0 || rawTargetId.length > 256) {
      io.err(
        "error: session identifier must be non-empty and <= 256 characters",
      );
      return true;
    }
    if (/[\s\x00-\x1F\x7F-\x9F\x1B]/.test(rawTargetId)) {
      io.err(
        "error: session identifier cannot contain control characters or whitespace",
      );
      return true;
    }
    const targetId = rawTargetId.trim();
    if (!SESSION_ID_SHAPE.test(targetId)) {
      io.err(
        "error: session identifier must be a valid 26-character Crockford Base32 identifier (e.g. from /session list)",
      );
      return true;
    }
    let targetWorkspace: string | undefined;
    if (config.unix) {
      try {
        const client = await connect(config.socket);
        try {
          const inspect = await client.request("sessions/inspect", {
            sessionId: targetId,
          }) as { exists?: boolean; workspace?: string | null };
          if (inspect.exists === false) {
            io.err(`warning: session "${targetId}" was not found on runtime`);
          }
          if (typeof inspect.workspace === "string") {
            targetWorkspace = inspect.workspace;
          }
        } finally {
          client.close();
        }
      } catch {
        // inspection optional
      }
    }
    sessionState.sessionId = targetId;
    config.sessionId = targetId;
    sessionState.turnCount = 0;
    sessionState.sessionSpendUsd = 0;
    sessionState.workspace = targetWorkspace;
    sessionState.events = [];
    sessionState.lastModelSlug = undefined;
    sessionState.lastReplCommand = undefined;
    io.err(`switched to session: ${targetId}`);
    return true;
  }

  io.err(
    "unknown /session subcommand. Usage: /session, /session list, /session switch <sessionId>",
  );
  return true;
}

function isOptionLike(token: string): boolean {
  return token.startsWith("-") && token.length > 1;
}

const FRICTION_SEVERITY_SET = new Set([
  "blocker",
  "major",
  "minor",
  "paper-cut",
]);

export async function handleReplFrictionCommand(
  line: string,
  config: CliConfig,
  io: Io,
  sessionState: ReplSessionState,
  connect: ConnectFn = connectUnixClient,
  interactive = true,
): Promise<boolean> {
  if (line.length > 32768) {
    io.err("command line exceeds maximum length of 32768 characters");
    return true;
  }
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("/friction")) return false;
  if (trimmed !== "/friction" && !/^\/friction\s/.test(trimmed)) return false;

  const rest = trimmed.slice("/friction".length).trim();
  if (rest === "" || rest === "help") {
    io.err("Friction capture commands:");
    io.err("  /friction <sev> [--escaped] <text...>   post one friction entry");
    io.err(
      "  /friction last                         show the last posted entry",
    );
    io.err("  sev: blocker | major | minor | paper-cut");
    io.err(
      "  posted Context: model slug, workspace basename, previous slash command (if any)",
    );
    io.err("  free-text prompts and absolute workspace paths are never posted");
    io.err("  DYFJ_FRICTION_ISSUE_ID must be set on the runtime");
    return true;
  }
  if (rest === "last") {
    if (sessionState.lastFriction === undefined) {
      io.err("no friction entry has been posted in this REPL");
    } else {
      io.err(sessionState.lastFriction.firstLine);
      io.err(`comment id: ${sessionState.lastFriction.commentId}`);
    }
    return true;
  }
  const severityMatch = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const severity = severityMatch?.[1] ?? "";
  if (!FRICTION_SEVERITY_SET.has(severity)) {
    io.err(
      "invalid friction severity; expected blocker, major, minor, or paper-cut",
    );
    return true;
  }
  let remainder = (severityMatch?.[2] ?? "").trim();
  let escaped = false;
  if (remainder === "--escaped" || remainder.startsWith("--escaped ")) {
    escaped = true;
    remainder = remainder.slice("--escaped".length).trim();
  } else if (remainder.startsWith("-")) {
    const option = remainder.split(/\s+/, 1)[0];
    io.err(`unknown /friction option: ${option}`);
    return true;
  }
  if (remainder === "") {
    io.err("usage: /friction <sev> [--escaped] <text...>");
    return true;
  }
  if (sessionState.sessionId === undefined) {
    io.err("no session yet — send a prompt first before posting friction");
    return true;
  }

  const context = normalizeFrictionContext({
    sessionId: sessionState.sessionId,
    ...(sessionState.lastModelSlug === undefined
      ? {}
      : { model: sessionState.lastModelSlug }),
    ...(sessionState.workspace === undefined
      ? {}
      : { workspace: sessionState.workspace }),
    ...(sessionState.lastReplCommand === undefined
      ? {}
      : { command: sessionState.lastReplCommand }),
  });
  let client: UnixClient | undefined;
  try {
    client = await connect(config.socket, {
      onApproval: (request) => promptMidTurnApproval(io, request, interactive),
    });
    const result = await client.request("friction/post", {
      severity,
      escaped,
      text: remainder,
      context,
    });
    if (
      typeof result !== "object" || result === null ||
      typeof (result as Record<string, unknown>).number !== "string" ||
      typeof (result as Record<string, unknown>).commentId !== "string" ||
      typeof (result as Record<string, unknown>).firstLine !== "string"
    ) {
      throw new Error("friction/post returned an invalid receipt");
    }
    const receipt = result as FrictionPostResult;
    sessionState.lastFriction = receipt;
    io.err(receipt.firstLine);
    io.err(`comment id: ${receipt.commentId}`);
  } catch (error) {
    io.err(`friction capture failed: ${summarizeError(error)}`);
  } finally {
    client?.close();
  }
  return true;
}

export async function handleReplIdeaCommand(
  line: string,
  config: CliConfig,
  io: Io,
  sessionState: ReplSessionState,
  connect: ConnectFn = connectUnixClient,
): Promise<boolean> {
  if (line.length > 32768) {
    io.err("command line exceeds maximum length of 32768 characters");
    return true;
  }
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("/idea")) return false;
  const parts = trimmed.trimEnd().split(/\s+/);
  if (parts[0] !== "/idea") return false;

  const sub = parts[1];
  if (!sub || sub === "help") {
    io.err("Idea capture commands:");
    io.err(
      "  /idea mark [--event <event-id>] [--] <label...>   mark an idea in this session",
    );
    io.err(
      "  /idea list                                   list marked ideas for this session",
    );
    io.err(
      "  /idea show <idea-id>                         show details of a marked idea",
    );
    return true;
  }

  if (!sessionState.sessionId) {
    io.err("no session yet — send a prompt first before marking ideas");
    return true;
  }

  if (sub === "mark") {
    if (parts.length < 3) {
      io.err("usage: /idea mark [--event <event-id>] <label...>");
      return true;
    }
    const tokens = parts.slice(2);
    let eventId: string | undefined;
    const labelParts: string[] = [];
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token === "--") {
        i++;
        while (i < tokens.length) {
          labelParts.push(tokens[i]);
          i++;
        }
        break;
      }
      if (token === "--event" || token === "-e") {
        if (eventId !== undefined) {
          io.err("error: --event specified multiple times");
          return true;
        }
        i++;
        if (i >= tokens.length || isOptionLike(tokens[i])) {
          io.err("usage: /idea mark --event <event-id> <label...>");
          return true;
        }
        eventId = tokens[i];
        i++;
      } else if (token.startsWith("--event=")) {
        if (eventId !== undefined) {
          io.err("error: --event specified multiple times");
          return true;
        }
        const val = token.slice("--event=".length);
        if (val.length === 0 || isOptionLike(val)) {
          io.err("usage: /idea mark --event <event-id> <label...>");
          return true;
        }
        eventId = val;
        i++;
      } else if (isOptionLike(token)) {
        const safeToken = token.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim();
        io.err(`error: unexpected argument "${safeToken}"`);
        return true;
      } else {
        labelParts.push(token);
        i++;
      }
    }
    const label = stripOuterQuotes(labelParts.join(" "));
    if (label.length === 0) {
      io.err("usage: /idea mark [--event <event-id>] <label...>");
      return true;
    }
    if (config.unix) {
      try {
        const client = await connect(config.socket);
        try {
          const res = await client.request("ideas/mark", {
            sessionId: sessionState.sessionId,
            label,
            eventId,
          }) as { idea: WorkbenchIdea };
          const cleanId = (res.idea.ideaId ?? "")
            .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
            .trim();
          const cleanLabel = (res.idea.label ?? "")
            .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, " ")
            .trim();
          io.err(`marked idea [${cleanId}]: "${cleanLabel}"`);
          io.err(`draft packet with: /packet draft ${cleanId}`);
        } finally {
          client.close();
        }
      } catch (e) {
        io.err(`dyfj: failed to mark idea: ${summarizeError(e)}`);
      }
    } else {
      if (eventId) {
        const found = sessionState.events?.some(
          (e) =>
            e.eventId === eventId && e.sessionId === sessionState.sessionId,
        );
        const cleanEvId = eventId.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
          .trim();
        if (!found) {
          io.err(
            `error: event "${cleanEvId}" not found in current local session context`,
          );
          return true;
        }
      }
      try {
        const idea = markWorkbenchIdea({
          sessionId: sessionState.sessionId,
          eventId,
          label,
          events: sessionState.events,
          registry: localIdeaRegistry(sessionState),
        });
        const cleanId = (idea.ideaId ?? "")
          .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
          .trim();
        const cleanLabel = (idea.label ?? "")
          .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, " ")
          .trim();
        io.err(`marked idea [${cleanId}]: "${cleanLabel}"`);
        io.err(`draft packet with: /packet draft ${cleanId}`);
      } catch (e) {
        io.err(`dyfj: failed to mark idea: ${summarizeError(e)}`);
      }
    }
    return true;
  }

  if (sub === "list") {
    if (parts.length > 2) {
      io.err("usage: /idea list");
      return true;
    }
    if (config.unix) {
      try {
        const client = await connect(config.socket);
        try {
          const res = await client.request("ideas/list", {
            sessionId: sessionState.sessionId,
          }) as { ideas: WorkbenchIdea[] };
          const cleanSessId = (sessionState.sessionId ?? "")
            .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
            .trim();
          if (res.ideas.length === 0) {
            io.err(`no ideas marked for session ${cleanSessId}`);
          } else {
            io.err(`Ideas for session ${cleanSessId}:`);
            for (const item of res.ideas) {
              const cleanId = (item.ideaId ?? "")
                .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
                .trim();
              const cleanLabel = (item.label ?? "")
                .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, " ")
                .trim();
              const cleanDate = (item.createdAt ?? "")
                .split("T")[0]
                .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
                .trim();
              io.err(`  [${cleanId}] ${cleanLabel} (${cleanDate})`);
            }
          }
        } finally {
          client.close();
        }
      } catch (e) {
        io.err(`dyfj: failed to list ideas: ${summarizeError(e)}`);
      }
    } else {
      const ideas = localIdeaRegistry(sessionState).listIdeas(
        sessionState.sessionId,
      );
      if (ideas.length === 0) {
        io.err(`no ideas marked for session ${sessionState.sessionId}`);
      } else {
        io.err(`Ideas for session ${sessionState.sessionId}:`);
        for (const item of ideas) {
          const cleanId = (item.ideaId ?? "")
            .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
            .trim();
          const cleanLabel = (item.label ?? "")
            .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, " ")
            .trim();
          const cleanDate = (item.createdAt ?? "")
            .split("T")[0]
            .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
            .trim();
          io.err(`  [${cleanId}] ${cleanLabel} (${cleanDate})`);
        }
      }
    }
    return true;
  }

  if (sub === "show") {
    if (parts.length !== 3) {
      io.err("usage: /idea show <idea-id>");
      return true;
    }
    const ideaId = parts[2];
    if (config.unix) {
      try {
        const client = await connect(config.socket);
        try {
          const res = await client.request("ideas/get", { ideaId }) as {
            idea: WorkbenchIdea | null;
          };
          if (!res.idea) {
            io.err(`idea not found: ${ideaId}`);
          } else {
            const id = res.idea;
            const cleanId = id.ideaId.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
              .trim();
            const cleanSession = id.sessionId.replace(
              /[\x00-\x1F\x7F-\x9F\x1B]/g,
              "",
            ).trim();
            const cleanEvent = id.eventId
              ? id.eventId.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim()
              : null;
            const cleanDate = (id.createdAt ?? "").replace(
              /[\x00-\x1F\x7F-\x9F\x1B]/g,
              "",
            ).trim();
            const cleanLabel = id.label
              .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, " ")
              .trim();
            const cleanDesc = id.description
              ? id.description.replace(
                /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F\x1B]/g,
                "",
              )
              : "";
            io.err(`Idea [${cleanId}]:`);
            io.err(`  Label: ${cleanLabel}`);
            io.err(`  Session: ${cleanSession}`);
            if (cleanEvent) io.err(`  Event: ${cleanEvent}`);
            io.err(`  Date: ${cleanDate}`);
            if (cleanDesc) io.err(`  Description: ${cleanDesc}`);
          }
        } finally {
          client.close();
        }
      } catch (e) {
        io.err(`dyfj: failed to get idea: ${summarizeError(e)}`);
      }
    } else {
      try {
        const idea = localIdeaRegistry(sessionState).getIdea(ideaId);
        if (!idea) {
          io.err(`idea not found: ${ideaId}`);
        } else {
          const cleanId = idea.ideaId.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
            .trim();
          const cleanSession = idea.sessionId.replace(
            /[\x00-\x1F\x7F-\x9F\x1B]/g,
            "",
          ).trim();
          const cleanEvent = idea.eventId
            ? idea.eventId.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim()
            : null;
          const cleanDate = (idea.createdAt ?? "").replace(
            /[\x00-\x1F\x7F-\x9F\x1B]/g,
            "",
          ).trim();
          const cleanLabel = idea.label
            .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, " ")
            .trim();
          const cleanDesc = idea.description
            ? idea.description.replace(
              /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F\x1B]/g,
              "",
            )
            : "";
          io.err(`Idea [${cleanId}]:`);
          io.err(`  Label: ${cleanLabel}`);
          io.err(`  Session: ${cleanSession}`);
          if (cleanEvent) io.err(`  Event: ${cleanEvent}`);
          io.err(`  Date: ${cleanDate}`);
          if (cleanDesc) io.err(`  Description: ${cleanDesc}`);
        }
      } catch (e) {
        io.err(`dyfj: failed to get idea: ${summarizeError(e)}`);
      }
    }
    return true;
  }

  io.err(
    "unknown /idea subcommand. Usage: /idea mark [--event <id>] <label...>, /idea list, /idea show <ideaId>",
  );
  return true;
}

export async function handleReplPacketCommand(
  line: string,
  config: CliConfig,
  io: Io,
  sessionState: ReplSessionState,
  connect: ConnectFn = connectUnixClient,
): Promise<boolean> {
  if (line.length > 32768) {
    io.err("command line exceeds maximum length of 32768 characters");
    return true;
  }
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("/packet")) return false;
  const parts = trimmed.trimEnd().split(/\s+/);
  if (parts[0] !== "/packet") return false;

  if (parts.length === 1 || parts[1] === "help") {
    io.out(
      "Workbench Work Packet Commands:\n" +
        "  /packet draft [<idea-id>] [--idea <id>] [--event <id>] [--issue <id>] [--title <title>] Draft a work packet\n" +
        "  /packet list                          List generated work packets in this session\n" +
        "  /packet show <packetId>               Show rendered markdown for a work packet\n",
    );
    return true;
  }

  const sub = parts[1];

  if (!sessionState.sessionId) {
    io.err("no session yet — send a prompt first before drafting packets");
    return true;
  }

  if (sub === "draft") {
    let ideaId: string | undefined;
    let eventId: string | undefined;
    let issueId: string | undefined;
    let title: string | undefined;
    let targetRef: string | undefined;

    const tokens = parts.slice(2);
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token === "--") {
        i++;
        while (i < tokens.length) {
          if (!targetRef) {
            targetRef = tokens[i];
          } else {
            const safeArg = tokens[i].replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
              .trim();
            io.err(`error: unexpected argument "${safeArg}"`);
            return true;
          }
          i++;
        }
        break;
      }
      if (token === "--issue") {
        if (issueId !== undefined) {
          io.err("error: --issue specified multiple times");
          return true;
        }
        i++;
        if (i >= tokens.length || isOptionLike(tokens[i])) {
          io.err("error: --issue requires an issue identifier");
          return true;
        }
        issueId = tokens[i];
        i++;
      } else if (token === "--event" || token === "-e") {
        if (eventId !== undefined) {
          io.err("error: --event specified multiple times");
          return true;
        }
        i++;
        if (i >= tokens.length || isOptionLike(tokens[i])) {
          io.err("error: --event requires an event identifier");
          return true;
        }
        eventId = tokens[i];
        i++;
      } else if (token === "--idea") {
        if (ideaId !== undefined) {
          io.err("error: --idea specified multiple times");
          return true;
        }
        i++;
        if (i >= tokens.length || isOptionLike(tokens[i])) {
          io.err("error: --idea requires an idea identifier");
          return true;
        }
        ideaId = tokens[i];
        i++;
      } else if (token === "--title" || token === "-t") {
        if (title !== undefined) {
          io.err("error: --title specified multiple times");
          return true;
        }
        i++;
        const knownOptionFlags = new Set([
          "--issue",
          "--event",
          "--idea",
          "--title",
          "-i",
          "-e",
          "-t",
        ]);
        const titleTokens: string[] = [];
        while (i < tokens.length) {
          if (tokens[i] === "--") {
            i++;
            while (i < tokens.length) {
              titleTokens.push(tokens[i]);
              i++;
            }
            break;
          }
          if (isOptionLike(tokens[i])) {
            if (!knownOptionFlags.has(tokens[i])) {
              const safeArg = tokens[i].replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
                .trim();
              io.err(`error: unexpected argument "${safeArg}"`);
              return true;
            }
            break;
          }
          titleTokens.push(tokens[i]);
          i++;
        }
        if (titleTokens.length === 0) {
          io.err("error: --title requires a title argument");
          return true;
        }
        title = stripOuterQuotes(titleTokens.join(" "));
      } else if (!targetRef && !isOptionLike(token)) {
        targetRef = token;
        i++;
      } else {
        const safeToken = token.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim();
        io.err(`error: unexpected argument "${safeToken}"`);
        return true;
      }
    }

    if (ideaId && eventId) {
      io.err("error: cannot specify both --idea and --event");
      return true;
    }

    if (targetRef && (ideaId || eventId)) {
      io.err(
        "error: cannot specify both positional target and explicit --idea/--event flag",
      );
      return true;
    }

    if (targetRef && !ideaId && !eventId) {
      if (targetRef.startsWith("evt-") || targetRef.startsWith("evt_")) {
        let ideaExists = false;
        if (config.unix) {
          try {
            const client = await connect(config.socket);
            try {
              const res = await client.request("ideas/get", {
                ideaId: targetRef,
              }) as { idea: WorkbenchIdea };
              if (res.idea && res.idea.sessionId === sessionState.sessionId) {
                ideaExists = true;
              }
            } catch {
              // ignore
            } finally {
              client.close();
            }
          } catch {
            // ignore
          }
        } else {
          try {
            const matchingIdea = localIdeaRegistry(sessionState).getIdea(
              targetRef,
            );
            if (
              matchingIdea && matchingIdea.sessionId === sessionState.sessionId
            ) {
              ideaExists = true;
            }
          } catch {
            // ignore validation error from non-idea target format
          }
        }
        if (ideaExists) {
          ideaId = targetRef;
        } else {
          eventId = targetRef;
        }
      } else {
        ideaId = targetRef;
      }
    }

    if (config.unix) {
      try {
        const client = await connect(config.socket);
        try {
          const res = await client.request("packets/draft", {
            sessionId: sessionState.sessionId,
            ideaId,
            eventId,
            issueId,
            title,
          }) as { packet: WorkbenchWorkPacket; markdown: string };
          const cleanPacketId = (res.packet.packetId ?? "")
            .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
            .trim();
          const safeMarkdown = (res.markdown ?? "").replace(
            /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F\x1B]/g,
            "",
          );
          io.out(safeMarkdown);
          io.err(`\ndraft work packet registered: [${cleanPacketId}]`);
        } finally {
          client.close();
        }
      } catch (e) {
        io.err(`dyfj: failed to draft packet: ${summarizeError(e)}`);
      }
    } else {
      if (eventId) {
        const found = sessionState.events?.some(
          (e) =>
            e.eventId === eventId && e.sessionId === sessionState.sessionId,
        );
        const cleanEvId = eventId.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
          .trim();
        if (!found) {
          io.err(
            `error: event "${cleanEvId}" not found in current local session context`,
          );
          return true;
        }
      }
      try {
        const packet = draftWorkPacketFromContext({
          sessionId: sessionState.sessionId,
          ideaId,
          eventId,
          issueId,
          title,
          events: sessionState.events,
          registry: localIdeaRegistry(sessionState),
        });
        const cleanPacketId = (packet.packetId ?? "")
          .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
          .trim();
        const markdown = formatWorkPacketMarkdown(packet);
        const safeMarkdown = markdown.replace(
          /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F\x1B]/g,
          "",
        );
        io.out(safeMarkdown);
        io.err(`\ndraft work packet registered: [${cleanPacketId}]`);
      } catch (e) {
        io.err(`dyfj: failed to draft packet: ${summarizeError(e)}`);
      }
    }
    return true;
  }

  if (sub === "list") {
    if (parts.length > 2) {
      io.err("usage: /packet list");
      return true;
    }
    if (config.unix) {
      try {
        const client = await connect(config.socket);
        try {
          const res = await client.request("packets/list", {
            sessionId: sessionState.sessionId,
          }) as { packets: WorkbenchWorkPacket[] };
          const cleanSessId = (sessionState.sessionId ?? "")
            .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
            .trim();
          if (res.packets.length === 0) {
            io.err(
              `no work packets drafted for session ${cleanSessId}`,
            );
          } else {
            io.err(`Work packets for session ${cleanSessId}:`);
            for (const p of res.packets) {
              const cleanPacketId = (p.packetId ?? "")
                .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
                .trim();
              const cleanTitle = (p.title ?? "")
                .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, " ")
                .trim();
              const cleanIssue = p.issueId
                ? p.issueId.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim()
                : "none";
              io.err(
                `  [${cleanPacketId}] ${cleanTitle} (Issue: ${cleanIssue})`,
              );
            }
          }
        } finally {
          client.close();
        }
      } catch (e) {
        io.err(`dyfj: failed to list packets: ${summarizeError(e)}`);
      }
    } else {
      try {
        const packets = localIdeaRegistry(sessionState).listPackets(
          sessionState.sessionId,
        );
        if (packets.length === 0) {
          io.err(
            `no work packets drafted for session ${sessionState.sessionId}`,
          );
        } else {
          io.err(`Work packets for session ${sessionState.sessionId}:`);
          for (const p of packets) {
            const cleanPacketId = (p.packetId ?? "")
              .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "")
              .trim();
            const cleanTitle = (p.title ?? "")
              .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, " ")
              .trim();
            const cleanIssue = p.issueId
              ? p.issueId.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim()
              : "none";
            io.err(`  [${cleanPacketId}] ${cleanTitle} (Issue: ${cleanIssue})`);
          }
        }
      } catch (e) {
        io.err(`dyfj: failed to list packets: ${summarizeError(e)}`);
      }
    }
    return true;
  }

  if (sub === "show") {
    if (parts.length !== 3) {
      io.err("usage: /packet show <packet-id>");
      return true;
    }
    const packetId = parts[2];
    if (config.unix) {
      try {
        const client = await connect(config.socket);
        try {
          const res = await client.request("packets/get", { packetId }) as {
            packet: WorkbenchWorkPacket | null;
            markdown: string | null;
          };
          if (!res.packet || !res.markdown) {
            io.err(`work packet not found: ${packetId}`);
          } else {
            const safeMarkdown = (res.markdown ?? "").replace(
              /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F\x1B]/g,
              "",
            );
            io.out(safeMarkdown);
          }
        } finally {
          client.close();
        }
      } catch (e) {
        io.err(`dyfj: failed to get packet: ${summarizeError(e)}`);
      }
    } else {
      try {
        const packet = localIdeaRegistry(sessionState).getPacket(packetId);
        if (!packet) {
          io.err(`work packet not found: ${packetId}`);
        } else {
          const markdown = formatWorkPacketMarkdown(packet);
          const safeMarkdown = markdown.replace(
            /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F\x1B]/g,
            "",
          );
          io.out(safeMarkdown);
        }
      } catch (e) {
        io.err(`dyfj: failed to get packet: ${summarizeError(e)}`);
      }
    }
    return true;
  }

  io.err(
    "unknown /packet subcommand. Usage: /packet draft, /packet list, /packet show <id>",
  );
  return true;
}

function isModelRowFastCapable(model?: ModelRow): boolean {
  if (!model) return false;
  return Array.isArray(model.capabilities) &&
    model.capabilities.includes("fast-speed");
}

export async function handleReplFastCommand(
  line: string,
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
): Promise<boolean> {
  if (line.length > 32768) {
    io.err("command line exceeds maximum length of 32768 characters");
    return true;
  }
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("/fast")) return false;
  const parts = trimmed.trimEnd().split(/\s+/);
  if (parts[0] !== "/fast") return false;

  if (config.runner !== undefined) {
    io.err(
      "dyfj: fast speed tier cannot be toggled when an explicit runner is active",
    );
    return true;
  }

  const listed = await fetchModelSlugs(config, connect);
  if ("error" in listed) {
    io.err(listed.error);
    return true;
  }

  const posture = await fetchSessionPosture(config, connect);
  const activeSlug = config.model ??
    ("slug" in posture && posture.slug ? posture.slug : "(registry default)");
  const activeModel = listed.models.find((m) => m.slug === activeSlug);

  const sub = parts[1]?.toLowerCase();
  let targetFastState: boolean;
  if (sub === "on") {
    targetFastState = true;
  } else if (sub === "off") {
    targetFastState = false;
  } else if (!sub) {
    targetFastState = !config.fast;
  } else {
    io.err("usage: /fast [on|off]");
    return true;
  }

  if (targetFastState) {
    if (!isModelRowFastCapable(activeModel)) {
      io.err(
        `dyfj: fast speed tier is not supported by "${activeSlug}" (supported on models advertising the fast-speed capability)`,
      );
      return true;
    }
  }

  config.fast = targetFastState;
  const updatedPosture = await fetchSessionPosture(config, connect);
  io.err(
    "error" in updatedPosture
      ? updatedPosture.error
      : formatPostureLine(updatedPosture),
  );
  return true;
}

export async function handleReplModelCommand(
  line: string,
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
): Promise<boolean> {
  if (line.length > 32768) {
    io.err("command line exceeds maximum length of 32768 characters");
    return true;
  }
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("/model")) return false;
  const parts = trimmed.trimEnd().split(/\s+/);
  if (parts[0] !== "/model") return false;
  // `--approve-paid` mirrors the launch flag: it arms the SESSION's existing
  // per-turn paid opt-in (buildTurnBody sends it each turn), so escalating to a
  // hosted model mid-session doesn't require relaunching. Consent stays with
  // the engine: without it, hosted turns keep failing closed exactly as today.
  const approvePaid = parts.includes("--approve-paid");
  const hasFastFlag = parts.includes("--fast");
  const hasNoFastFlag = parts.includes("--no-fast");
  const args = parts.slice(1).filter((part) =>
    part !== "--approve-paid" && part !== "--fast" && part !== "--no-fast"
  );

  if (hasFastFlag && hasNoFastFlag) {
    io.err("dyfj: cannot specify both --fast and --no-fast");
    return true;
  }

  if (config.runner !== undefined && (hasFastFlag || hasNoFastFlag)) {
    io.err(
      "dyfj: fast speed tier cannot be configured when an explicit runner is active",
    );
    return true;
  }

  const listed = await fetchModelSlugs(config, connect);
  if ("error" in listed) {
    io.err(listed.error);
    return true;
  }

  const emitPosture = async () => {
    const posture = await fetchSessionPosture(config, connect);
    io.err("error" in posture ? posture.error : formatPostureLine(posture));
  };

  if (args.length === 0) {
    const initialPosture = await fetchSessionPosture(config, connect);
    const active = config.model ??
      ("slug" in initialPosture && initialPosture.slug
        ? initialPosture.slug
        : "(registry default)");
    const activeModel = listed.models.find((m) => m.slug === active);

    if (hasFastFlag) {
      if (!isModelRowFastCapable(activeModel)) {
        io.err(
          `dyfj: fast speed tier is not supported by "${active}" (supported on models advertising the fast-speed capability)`,
        );
        return true;
      }
      config.fast = true;
    } else if (hasNoFastFlag) {
      config.fast = false;
    }

    if (approvePaid) config.approvePaid = true;

    const posture = (hasFastFlag || hasNoFastFlag || approvePaid)
      ? await fetchSessionPosture(config, connect)
      : initialPosture;

    io.err(`active model: ${active}`);
    io.err(`available: ${listed.slugs.join(", ") || "(none)"}`);
    io.err("error" in posture ? posture.error : formatPostureLine(posture));
    return true;
  }

  const slug = args[0];
  if (!listed.slugs.includes(slug)) {
    io.err(
      `unknown model "${slug}". available: ${
        listed.slugs.join(", ") || "(none)"
      }`,
    );
    return true;
  }

  const targetModel = listed.models.find((m) => m.slug === slug);
  if (hasFastFlag) {
    if (!isModelRowFastCapable(targetModel)) {
      io.err(
        `dyfj: fast speed tier is not supported by "${slug}" (supported on models advertising the fast-speed capability)`,
      );
      return true;
    }
    config.fast = true;
  } else if (hasNoFastFlag) {
    config.fast = false;
  } else if (config.fast === true && !isModelRowFastCapable(targetModel)) {
    config.fast = false;
    io.err(`dyfj: fast speed tier disabled for "${slug}" (unsupported)`);
  }

  config.model = slug;
  config.runner = undefined;
  if (approvePaid) config.approvePaid = true;
  await emitPosture();
  return true;
}

// ── Argument + config parsing ────────────────────────────────────────────────

// ── Entry point ──────────────────────────────────────────────────────────────
