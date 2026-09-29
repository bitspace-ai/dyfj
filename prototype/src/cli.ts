/**
 * dyfj — the interactive line REPL (multi-turn, streaming) and the one-shot
 * `exec` turn, with the socket turn client and turn rendering they share.
 * The entrypoint is `cli/main.ts`, which parses the arguments and dispatches
 * here or to a subcommand in `cli/commands/`.
 *
 * A THIN client over the Workbench runtime's JSON-RPC/UDS seam — it never
 * imports the engine (no mysql2, no provider SDKs), so the compiled binary
 * stays small and the server can migrate to Rust under the same contract.
 */

import { takeCodePointPrefix } from "./kernel/mod.ts";
import {
  DomainError,
  formatHistoryOmissionSummary,
  isSupersedingRetryStarted,
  MAX_ERROR_SUMMARY_BYTES,
  SESSION_ID_SHAPE,
  summarizeError,
  type TurnReceipt,
  type TurnStreamFrame,
  type WorkbenchSessionEvent,
} from "./contract/mod.ts";
import {
  connectUnixClient,
  type ToolApprovalVerdict,
  type UnixClient,
  type UnixClientOptions,
} from "./transport/mod.ts";
import { createStreamingMarkdownRenderer } from "./streaming-markdown.ts";
import { type BusySpinner, createBusySpinner } from "./busy-spinner.ts";
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
import type { CliConfig } from "./cli/args.ts";
import type { ConnectFn, Io, TurnInterruptSource } from "./cli/io.ts";
import { socketError } from "./cli/render/errors.ts";
import { fetchModelSlugs, type ModelRow } from "./cli/commands/models.ts";
import {
  LIVENESS_PROBE_TIMEOUT_MS,
  type RuntimeStatusPayload,
} from "./cli/commands/status.ts";

// ── Seam contract (shared with the server) ──────────────────────────
// The receipt and stream frame shapes are defined once in contract/turn.ts and
// imported by both sides, so this thin client can never silently drift from
// what the server sends. Type imports are erased at compile, and the one value
// import (the superseding-retry guard) comes from that dependency-free
// contract module, keeping the binary engine-free.

/** The receipt a turn carries. Canonical definition: the shared seam contract. */
export type TurnResult = TurnReceipt;

export interface TurnRequest {
  prompt: string;
  turnId?: string;
  mode?: "turn" | "ask" | "next-work";
  routingOptions?: {
    modelId?: string;
    tier?: 0 | 1 | 2;
    hint?: "code" | "chat" | "reasoning";
    fast?: boolean;
  };
  sessionId?: string;
  /** Working directory to scope the server's read-only file tools to. */
  workspace?: string;
  /** Experimental external-agent profile selector. */
  runner?: "fixture" | "codex-chatgpt";
  /**
   * Per-turn opt-in to paid (hosted) inference. The engine honors it only on the
   * loopback transport AND only when set — a remote caller can never approve spend.
   */
  approvePaidInference?: boolean;
}

export function buildTurnBody(
  prompt: string,
  config: CliConfig,
  sessionId?: string,
): TurnRequest {
  const routingOptions: NonNullable<TurnRequest["routingOptions"]> = {};
  if (config.runner === undefined) {
    if (config.model !== undefined) routingOptions.modelId = config.model;
    if (config.tier !== undefined) routingOptions.tier = config.tier;
    if (config.hint !== undefined) routingOptions.hint = config.hint;
    if (config.fast !== undefined) routingOptions.fast = config.fast;
  }

  const body: TurnRequest = { prompt, mode: config.mode };
  if (Object.keys(routingOptions).length > 0) {
    body.routingOptions = routingOptions;
  }
  if (config.runner !== undefined) body.runner = config.runner;
  if (sessionId !== undefined) body.sessionId = sessionId;
  // Send the workspace only when establishing a NEW session (no sessionId): the
  // server persists it on the session row, and resumed turns read it back, so
  // the cwd is sent once on init rather than re-sent every turn. The UDS seam
  // is local, so the implicit cwd default is always eligible.
  if (config.workspace !== undefined && sessionId === undefined) {
    body.workspace = config.workspace;
  }
  // Per-turn paid opt-in; the engine ignores it on non-loopback transports.
  if (config.approvePaid) body.approvePaidInference = true;
  return body;
}

// ── Presentation ─────────────────────────────────────────────────────────────

function terminalColumns(): number {
  try {
    return Math.min(Deno.consoleSize()?.columns ?? 80, 100);
  } catch {
    return 80;
  }
}

/** Wrap streamed turn text with line-buffered markdown rendering. */
export function createTurnOutputHandlers(
  config: CliConfig,
  io: Io,
  writeLifecycle: {
    beforeWrite?: () => void;
    afterWrite?: () => void;
  } = {},
): {
  onDelta: (text: string) => void;
  emitBufferedText: (text: string) => void;
  finish: () => void;
  streamed: () => boolean;
  supersede: () => void;
} {
  let sawDelta = false;
  const renderer = createStreamingMarkdownRenderer({
    out: (text) => io.out(text),
    color: config.color,
    columns: terminalColumns(),
    ...writeLifecycle,
  });
  return {
    onDelta: (text: string) => {
      sawDelta = true;
      renderer.push(text);
    },
    emitBufferedText: (text: string) => {
      renderer.push(text);
      renderer.flush();
    },
    finish: () => renderer.flush(),
    streamed: () => sawDelta,
    // The superseding-retry signal: text rendered so far is stale. Already-
    // printed lines may have scrolled beyond reach, so honest presentation is
    // a visible marker plus a clean renderer — never silently gluing the
    // replacement onto the stale text's parse state. sawDelta re-arms so a
    // retry that ends up buffered still gets its text emitted from the receipt.
    supersede: () => {
      renderer.reset();
      sawDelta = false;
      const marker = "⟲ retrying with recovered context — " +
        "the reply restarts below";
      io.out(`\n${config.color ? `\x1b[2m${marker}\x1b[0m` : marker}\n\n`);
    },
  };
}

/** Cheap scan budget before any label normalization. */
export const SPINNER_LABEL_SCAN_LIMIT = 256;
/** Visible code-point budget after control sequences are dropped. */
export const SPINNER_LABEL_DISPLAY_LIMIT = 40;

/**
 * Bound and neutralize a spinner label candidate.
 *
 * The first 256 code points are inspected; nothing past that budget is
 * normalized. Complete and incomplete ANSI / OSC / C0 / C1 sequences are
 * treated as control and dropped — the scan never slices a terminator off
 * a sequence and then keeps the payload.
 */
export function sanitizeSpinnerLabel(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const chars = takeCodePointPrefix(value, SPINNER_LABEL_SCAN_LIMIT);
  const limit = chars.length;
  const visible: string[] = [];
  let pendingSpace = false;
  let overflow = false;
  let index = 0;

  const emitVisible = (ch: string): void => {
    if (visible.length >= SPINNER_LABEL_DISPLAY_LIMIT) {
      overflow = true;
      return;
    }
    if (pendingSpace && visible.length > 0) {
      if (visible.length + 1 >= SPINNER_LABEL_DISPLAY_LIMIT) {
        overflow = true;
        return;
      }
      visible.push(" ");
    }
    pendingSpace = false;
    visible.push(ch);
  };

  while (index < limit && !overflow) {
    const code = chars[index].codePointAt(0) ?? 0;
    if (code === 0x1b) {
      index = skipEscSequence(chars, index, limit);
      continue;
    }
    if (code === 0x9b) {
      index = skipCsiBody(chars, index + 1, limit);
      continue;
    }
    if (code === 0x9d) {
      index = skipOscBody(chars, index + 1, limit);
      continue;
    }
    if (
      code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f
    ) {
      index = skipStringTerminator(chars, index + 1, limit);
      continue;
    }
    if (
      code === 0x20 ||
      code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)
    ) {
      if (visible.length > 0) pendingSpace = true;
      index += 1;
      continue;
    }
    emitVisible(chars[index]);
    index += 1;
  }

  if (visible.length === 0) return null;
  if (overflow) {
    return `${visible.slice(0, SPINNER_LABEL_DISPLAY_LIMIT - 1).join("")}…`;
  }
  return visible.join("");
}

function skipEscSequence(
  chars: string[],
  start: number,
  limit: number,
): number {
  const next = start + 1;
  if (next >= limit) return limit;
  const introducer = chars[next];
  if (introducer === "[") return skipCsiBody(chars, next + 1, limit);
  if (introducer === "]") return skipOscBody(chars, next + 1, limit);
  if (
    introducer === "P" || introducer === "X" || introducer === "^" ||
    introducer === "_"
  ) {
    return skipStringTerminator(chars, next + 1, limit);
  }
  return next + 1;
}

function skipCsiBody(chars: string[], start: number, limit: number): number {
  let index = start;
  while (index < limit) {
    const code = chars[index].codePointAt(0) ?? 0;
    if (code >= 0x40 && code <= 0x7e) return index + 1;
    if (code < 0x20 || code > 0x3f) return index + 1;
    index += 1;
  }
  return limit;
}

function skipOscBody(chars: string[], start: number, limit: number): number {
  let index = start;
  while (index < limit) {
    const code = chars[index].codePointAt(0) ?? 0;
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && index + 1 < limit && chars[index + 1] === "\\") {
      return index + 2;
    }
    index += 1;
  }
  return limit;
}

function skipStringTerminator(
  chars: string[],
  start: number,
  limit: number,
): number {
  let index = start;
  while (index < limit) {
    const code = chars[index].codePointAt(0) ?? 0;
    if (code === 0x9c) return index + 1;
    if (code === 0x1b && index + 1 < limit && chars[index + 1] === "\\") {
      return index + 2;
    }
    index += 1;
  }
  return limit;
}

function progressSpinnerLabel(event: Record<string, unknown>): string | null {
  if (event.type !== "agentProgress") return null;
  const nested = typeof event.progress === "object" && event.progress !== null
    ? event.progress as Record<string, unknown>
    : null;
  const kind = nested?.kind ?? event.kind;
  if (kind === "thought") return "thinking…";
  return sanitizeSpinnerLabel(nested?.title ?? event.title) ??
    sanitizeSpinnerLabel(nested?.name ?? event.name) ??
    sanitizeSpinnerLabel(nested?.status ?? event.status);
}

/**
 * The turn-in-flight indicator: animates on stderr for the full turn, pausing
 * while output or an approval prompt owns the terminal. Enabled only when the
 * Io exposes a raw stderr writer AND stderr is an interactive terminal — piped
 * stderr gets no control bytes.
 */
export function createTurnSpinner(config: CliConfig, io: Io): BusySpinner {
  return createBusySpinner({
    write: (text) => io.errRaw?.(text),
    enabled: io.errRaw !== undefined && io.errIsTerminal === true,
    color: config.color,
  });
}

/**
 * True when routing this runtime event will actually put something on the
 * terminal — a superseding-retry marker (rendered to stdout) or a status line
 * (`formatRuntimeEvent` returns non-null). Invisible bookkeeping events (e.g.
 * `modelSelected`, emitted right before the long provider wait) render nothing,
 * so they must NOT retire the spinner — otherwise it vanishes before the wait
 * it exists to cover.
 */
export function runtimeEventIsVisible(event: unknown): boolean {
  if (isSupersedingRetryStarted(event)) return true;
  if (typeof event !== "object" || event === null) return false;
  return formatRuntimeEvent(event as Record<string, unknown>) !== null;
}

/**
 * Wrap streaming-turn handlers so the spinner yields the terminal around each
 * visible output, then resumes until the terminal turn result. Progress can
 * replace the generic label at any point. Invisible bookkeeping events leave
 * the current indicator alone.
 */
export function spinnerGuardedTurnHandlers(
  spinner: BusySpinner,
  output: ReturnType<typeof createTurnOutputHandlers>,
  io: Io,
  onApproval: (
    request: unknown,
  ) => Promise<ToolApprovalVerdict> | ToolApprovalVerdict,
): {
  onDelta: (text: string) => void;
  onEvent: (event: Record<string, unknown>) => void;
  onApproval: (
    request: unknown,
  ) => Promise<ToolApprovalVerdict> | ToolApprovalVerdict;
} {
  return {
    onDelta: (text) => {
      output.onDelta(text);
    },
    onEvent: (event) => {
      const progressLabel = progressSpinnerLabel(event);
      if (progressLabel !== null) {
        spinner.updateLabel(progressLabel);
        spinner.start();
        return;
      }
      // Keep spinning through invisible events; the wait isn't over yet.
      const visible = runtimeEventIsVisible(event);
      if (visible) spinner.pause();
      handleTurnRuntimeEvent(event, output, io);
      if (visible) {
        spinner.updateLabel("working…");
        spinner.start();
      }
    },
    onApproval: async (request) => {
      spinner.pause();
      try {
        return await onApproval(request);
      } finally {
        spinner.updateLabel("working…");
        spinner.start();
      }
    },
  };
}

/**
 * Route one runtime event from a streaming turn: the superseding-retry signal
 * resets the renderer (the contract every streaming client must honor); other
 * events render as stderr status lines. The UDS stream frames carry the same
 * shapes the contract defines, so honoring it here covers the seam.
 */
export function handleTurnRuntimeEvent(
  event: unknown,
  output: ReturnType<typeof createTurnOutputHandlers>,
  io: Io,
): void {
  if (isSupersedingRetryStarted(event)) {
    output.supersede();
    return;
  }
  // Both clients decode the transport JSON but never schema-validate the frame,
  // so a malformed `event: null` or primitive must be dropped, not dereferenced.
  if (typeof event !== "object" || event === null) return;
  const runtimeEvent = event as Record<string, unknown>;
  // The renderer may still hold an incomplete final line. Make the terminal
  // marker follow all preserved partial text, rather than bisecting it.
  if (
    runtimeEvent.type === "turnAborted" ||
    runtimeEvent.type === "unparsedToolCallMarkupDetected"
  ) output.finish();
  const line = formatRuntimeEvent(runtimeEvent);
  if (line !== null) io.err(line);
}

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

function formatUsdShort(usd: number): string {
  return usd > 0 ? `$${usd.toFixed(4)}` : "$0";
}

function formatTokenCount(count: number): string {
  return new Intl.NumberFormat("en-US").format(count);
}

/**
 * The per-turn receipt line. `sessionTotalUsd` (the REPL's running sum of
 * per-turn costs) adds a `session $…` figure so spend is visible as it
 * accumulates, not just per turn; one-shot exec passes none. Reasoning tokens
 * appear only when the provider reported some — most report none.
 */
export function formatReceipt(
  result: TurnResult,
  color: boolean,
  sessionTotalUsd?: number,
): string {
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  if ("runner" in result) {
    const usage = result.runner.usage === undefined
      ? ""
      : ` · ${formatTokenCount(result.runner.usage.input)}→${
        formatTokenCount(result.runner.usage.output)
      } tok` +
        ((result.runner.usage.reasoning ?? 0) > 0
          ? ` (+${formatTokenCount(result.runner.usage.reasoning!)} reasoning)`
          : "");
    const context = result.runner.contextWindow === undefined
      ? ""
      : ` · ctx ${formatTokenCount(result.runner.contextWindow.used)}/${
        formatTokenCount(result.runner.contextWindow.size)
      }`;
    const reportedCost = result.runner.sessionCost;
    const cost = reportedCost !== undefined
      ? `session cost ${
        reportedCost.currency === "USD"
          ? formatUsdShort(reportedCost.amount)
          : `${reportedCost.amount} ${reportedCost.currency}`
      }`
      : result.runner.costBasis === "local_free"
      ? "$0"
      : result.runner.costBasis === "subscription_quota"
      ? "subscription quota (USD not reported)"
      : result.runner.costBasis === "metered_usd"
      ? "USD not reported"
      : "cost unknown";
    const continuity = result.runner.continuity;
    const continuityEvidence = continuity === undefined
      ? "continuity unestablished"
      : `continuity ${continuity.state}${
        continuity.state === "reconstructed"
          ? ` ${continuity.priorMessagesProjected ?? 0}msg/${
            continuity.toolExchangesProjected ?? 0
          }tool`
          : ""
      }`;
    const nativeSession = continuity === undefined
      ? "native session unverified"
      : continuity.state === "new"
      ? "native session new"
      : continuity.state === "warm-reused" ||
          continuity.state === "durably-resumed"
      ? "native session reused"
      : "native session replaced";
    const toolEvidence = result.runner.toolEvidence;
    const tools = toolEvidence === undefined
      ? "ACP tools unreported"
      : toolEvidence.status === "unavailable"
      ? `ACP tools unavailable (${toolEvidence.observedCalls} observed)`
      : `ACP tools ${toolEvidence.recordedCalls}/${toolEvidence.observedCalls} recorded`;
    const history = result.historyOmission === undefined
      ? ""
      : ` · ${formatHistoryOmissionSummary(result.historyOmission)}`;
    return dim(
      `— ${result.runner.profile} · ${result.runner.protocol}${
        result.runner.protocolVersion === undefined
          ? " (not negotiated)"
          : ` v${result.runner.protocolVersion}`
      } · ${result.runner.transport} · ${
        result.runner.accessRoute ?? "unverified"
      } · ${cost}${usage}${context} · ${continuityEvidence} · ${nativeSession} · ${tools}${history} · ${result.runner.elapsedMs}ms · ${result.route.reason}`,
    );
  }
  const cost = formatUsdShort(result.cost.totalUsd);
  const session = sessionTotalUsd !== undefined
    ? ` · session ${formatUsdShort(sessionTotalUsd)}`
    : "";
  const reasoning = (result.tokens.reasoning ?? 0) > 0
    ? ` (+${result.tokens.reasoning} reasoning)`
    : "";
  const tokens = `${formatTokenCount(result.tokens.input)}→${
    formatTokenCount(result.tokens.output)
  } tok${reasoning}`;
  const toolSteps =
    `tools ${result.agent.toolStepsUsed}/${result.agent.maxToolSteps}` +
    (result.agent.limitReached ? " (limit reached)" : "");
  const history = result.historyOmission === undefined
    ? ""
    : ` · ${formatHistoryOmissionSummary(result.historyOmission)}`;
  return dim(
    `— ${result.model.displayName} · ${cost}${session} · ${tokens} · ${toolSteps}${history} · ${result.route.reason}`,
  );
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

// A server-side error message can embed the full offending payload (e.g. a
// rejected event-log INSERT quoting the oversized value back in the driver
// error), and dispatchRequest (jsonrpc.ts) forwards err.message verbatim to
// the client. The server console already logs class-only for exactly this
// reason (the native runner's [turn-error] line, and every joint that forwards a
// turn error toward a client — see summarizeError in contract/turn.ts, the
// shared discipline this client and the server both apply); the client had no
// equivalent discipline, so an unbounded server message printed pages of raw
// payload to the operator's terminal. summarizeError caps what any client
// error printer renders: a sane excerpt plus the error class and full byte
// count, never a multi-KB dump.

// ── Commands ─────────────────────────────────────────────────────────────────

export async function runExec(
  prompt: string,
  config: CliConfig,
  io: Io,
  json: boolean,
  connect: ConnectFn = connectUnixClient,
  interactive = true,
  interrupts: TurnInterruptSource | undefined = io.turnInterrupts,
): Promise<number> {
  const body = buildTurnBody(prompt, config, config.sessionId);
  const approvalController = new AbortController();
  let interruptInstalled = false;
  let interruptRequested = false;
  let stopTurnIndicator = () => {};
  const interrupt = () => {
    if (interruptRequested) return;
    interruptRequested = true;
    approvalController?.abort();
    try {
      stopTurnIndicator();
    } catch {
      // A failed terminal erase must not escape before cancellation runs.
    }
    try {
      io.err("[interrupt requested]");
    } catch {
      // A terminal write failure must not prevent the cancellation.
    }
  };
  const installInterrupt = () => {
    if (interrupts === undefined || interruptInstalled) return;
    interrupts.add(interrupt);
    interruptInstalled = true;
  };
  const onApproval = (request: unknown) =>
    promptMidTurnApproval(
      io,
      request,
      interactive,
      approvalController?.signal,
    );
  let turnFailed = false;
  let exitCode = 0;
  try {
    if (json) {
      const result = await socketTurn(
        config,
        body,
        {
          onApproval,
          abortSignal: approvalController.signal,
          onConnected: installInterrupt,
        },
        connect,
      );
      io.out(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const spinner = createTurnSpinner(config, io);
      const output = createTurnOutputHandlers(config, io, {
        beforeWrite: () => spinner.pause(),
        afterWrite: () => {
          spinner.updateLabel("working…");
          spinner.start();
        },
      });
      stopTurnIndicator = () => spinner.stop();
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
      spinner.start();
      let result: TurnResult;
      try {
        result = await socketTurn(
          config,
          body,
          {
            ...terminalHandlers,
            abortSignal: approvalController.signal,
            onConnected: installInterrupt,
          },
          connect,
        );
      } finally {
        // Covers every non-streaming exit — turn failure, declined approval,
        // buffered-only turns — so no orphaned spinner line survives the turn.
        spinner.stop();
      }
      // Some turns don't stream deltas (e.g. a first model call with tools);
      // the text still arrives with the receipt — render it so output is never empty.
      if (!output.streamed() && result.text.length > 0) {
        output.emitBufferedText(result.text);
      } else {
        output.finish();
      }
      if (result.stopReason === "aborted") {
        handlers.onEvent({ type: "turnAborted" });
      }
      io.err(formatReceipt(result, config.color));
    }
  } catch (error) {
    turnFailed = true;
    io.err(socketError(error, config));
    exitCode = 1;
  } finally {
    let cleanupError: unknown;
    try {
      approvalController.abort();
    } catch (error) {
      cleanupError = error;
    }
    try {
      if (interruptInstalled) interrupts?.remove(interrupt);
    } catch (error) {
      cleanupError ??= error;
    }
    if (!turnFailed && cleanupError !== undefined) {
      io.err(socketError(cleanupError, config));
      exitCode = 1;
    }
  }
  return exitCode;
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
        if ("cost" in result) sessionState.sessionSpendUsd += result.cost.totalUsd;
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

// ── UDS read commands (models/sessions over the JSON-RPC seam) ───────────────

export const TURN_CANCELLATION_TIMEOUT_MS = 5_000;
export const TURN_CANCELLATION_SETTLE_TIMEOUT_MS = 30_000;
const MAX_ACP_PERMISSION_OPTIONS = 16;
const MAX_ACP_PERMISSION_SELECTION_ATTEMPTS = 3;
const MAX_ACP_PERMISSION_SELECTION_CODE_UNITS = 64;

class TurnCancellationUncertainError extends DomainError {}

/**
 * Run a turn over the UDS/JSON-RPC seam: forward `stream` notifications to the
 * handlers and resolve with the receipt (the RPC result). Over UDS there is
 * no `done`/`error` frame — the receipt is the result, errors are RPC errors.
 */
export async function socketTurn(
  config: CliConfig,
  body: TurnRequest,
  handlers: {
    onDelta?: (text: string) => void;
    onEvent?: (event: Record<string, unknown>) => void;
    onApproval?: (
      request: unknown,
    ) => Promise<ToolApprovalVerdict> | ToolApprovalVerdict;
    abortSignal?: AbortSignal;
    onConnected?: () => void;
    cancellationTimeoutMs?: number;
    cancellationSettleTimeoutMs?: number;
  } = {},
  connect: ConnectFn = connectUnixClient,
): Promise<TurnResult> {
  const turnId = body.turnId ?? crypto.randomUUID();
  const clientOptions: UnixClientOptions = {};
  let turnAbortedEvent: Record<string, unknown> | undefined;
  if (handlers.onDelta !== undefined || handlers.onEvent !== undefined) {
    clientOptions.onStream = (params) => {
      if (typeof params !== "object" || params === null) return;
      const frame = params as {
        t?: unknown;
        text?: unknown;
        event?: unknown;
      };
      if (frame.t === "delta" && typeof frame.text === "string") {
        handlers.onDelta?.(frame.text);
      } else if (
        frame.t === "event" &&
        typeof frame.event === "object" &&
        frame.event !== null &&
        !Array.isArray(frame.event)
      ) {
        const event = frame.event as Record<string, unknown>;
        if (
          event.type === "turnAborted" &&
          (
            typeof event.sessionId !== "string" ||
            typeof event.traceId !== "string" ||
            event.turnId !== turnId
          )
        ) {
          return;
        }
        if (event.type === "turnAborted") {
          turnAbortedEvent = event;
          return;
        }
        handlers.onEvent?.(event);
      }
    };
  }
  if (handlers.onApproval) clientOptions.onApproval = handlers.onApproval;
  const client = await connect(config.socket, clientOptions);
  let rejectCancellation!: (error: DomainError) => void;
  const cancellationFailure = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  let cancel: Promise<unknown> | undefined;
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const cancellationError = () =>
    new TurnCancellationUncertainError(
      "turn cancellation was not acknowledged; restart the runtime before retrying",
    );
  const cancellationSettleError = () =>
    new TurnCancellationUncertainError(
      "turn did not finish after cancellation was acknowledged; remote work may still be running, so restart the runtime before retrying",
    );
  const cancellationDeclinedSettleError = () =>
    new TurnCancellationUncertainError(
      "turn did not finish after cancellation was declined; remote work may still be running, so restart the runtime before retrying",
    );
  const requestCancel = () => {
    if (cancel !== undefined) return;
    cancellationTimer = setTimeout(() => {
      rejectCancellation(cancellationError());
    }, handlers.cancellationTimeoutMs ?? TURN_CANCELLATION_TIMEOUT_MS);
    cancel = Promise.resolve()
      .then(() => client.request("turn/cancel", { turnId }))
      .then(
        (result) => {
          clearTimeout(cancellationTimer);
          if (typeof result !== "object" || result === null) {
            rejectCancellation(cancellationError());
          } else if (!settled) {
            const cancelled = (result as Record<string, unknown>).cancelled;
            if (cancelled !== true && cancelled !== false) {
              rejectCancellation(cancellationError());
              return result;
            }
            cancellationTimer = setTimeout(
              () => {
                rejectCancellation(
                  cancelled
                    ? cancellationSettleError()
                    : cancellationDeclinedSettleError(),
                );
              },
              handlers.cancellationSettleTimeoutMs ??
                TURN_CANCELLATION_SETTLE_TIMEOUT_MS,
            );
          }
          return result;
        },
        () => {
          clearTimeout(cancellationTimer);
          rejectCancellation(cancellationError());
        },
      );
  };
  try {
    if (handlers.abortSignal?.aborted) {
      throw new DomainError("turn interrupted before dispatch");
    }
    handlers.onConnected?.();
    const turn = client.request("turn", { ...body, turnId });
    handlers.abortSignal?.addEventListener("abort", requestCancel, {
      once: true,
    });
    if (handlers.abortSignal?.aborted) requestCancel();
    const result = await Promise.race([
      turn as Promise<TurnResult>,
      cancellationFailure,
    ]);
    if (result.stopReason === "aborted") {
      const matchingAbortEvent = turnAbortedEvent?.sessionId ===
            result.sessionId &&
          turnAbortedEvent.traceId === result.traceId
        ? turnAbortedEvent
        : undefined;
      handlers.onEvent?.(
        matchingAbortEvent ?? {
          type: "turnAborted",
          sessionId: result.sessionId,
          traceId: result.traceId,
          turnId,
        },
      );
    }
    return result;
  } finally {
    settled = true;
    clearTimeout(cancellationTimer);
    handlers.abortSignal?.removeEventListener("abort", requestCancel);
    client.close();
  }
}

/**
 * Prompt the operator for a mid-turn decision over the UDS seam: an exact ACP
 * permission option, mutating-tool approval, or a budget gate. Non-interactive
 * use fails closed. The prompt goes to stderr so a `--json` turn's stdout stays
 * clean.
 */
export async function promptMidTurnApproval(
  io: Io,
  request: unknown,
  interactive: boolean,
  abortSignal?: AbortSignal,
): Promise<ToolApprovalVerdict> {
  const r = (typeof request === "object" && request !== null)
    ? request as Record<string, unknown>
    : {};
  if (r.kind === "external_agent_permission") {
    const rawOptions = Array.isArray(r.options) && r.options.length > 0 &&
        r.options.length <= MAX_ACP_PERMISSION_OPTIONS
      ? r.options
      : null;
    const parsedOptions = (rawOptions ?? []).flatMap((value) => {
      if (typeof value !== "object" || value === null) return [];
      const option = value as Record<string, unknown>;
      if (
        typeof option.optionId !== "string" || option.optionId.length === 0 ||
        typeof option.name !== "string" ||
        (option.kind !== "allow_once" &&
          option.kind !== "allow_always" &&
          option.kind !== "reject_once" &&
          option.kind !== "reject_always")
      ) return [];
      return [{
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      }];
    });
    const optionIds = new Set(parsedOptions.map((option) => option.optionId));
    const optionsValid = rawOptions !== null &&
      parsedOptions.length === rawOptions.length &&
      optionIds.size === parsedOptions.length;
    const options = optionsValid ? parsedOptions : [];
    const rejection = options.find((option) => option.kind === "reject_once") ??
      options.find((option) => option.kind === "reject_always");
    const reject = (): ToolApprovalVerdict =>
      rejection === undefined
        ? { decision: "deny", reason: "ACP rejection option unavailable" }
        : { decision: "select", optionId: rejection.optionId };
    const policyReject = (): ToolApprovalVerdict => ({
      decision: "deny",
      reason: "ACP permission selection unavailable",
    });
    if (!optionsValid) {
      io.err("   ACP permission options were invalid; request rejected.");
      return reject();
    }
    if (!interactive) return policyReject();

    const title = typeof r.title === "string"
      ? r.title
      : "External agent action";
    io.err(`\n⚠  ${title}`);
    io.err(formatApprovalArgs(r.arguments));
    for (const [index, option] of options.entries()) {
      io.err(`   ${index + 1}. ${option.name}`);
    }

    for (
      let attempt = 0;
      attempt < MAX_ACP_PERMISSION_SELECTION_ATTEMPTS;
      attempt += 1
    ) {
      const answer = await io.readLine(
        `   select [1-${options.length}] (default reject): `,
        abortSignal,
      );
      if (abortSignal?.aborted) return { decision: "abort" };
      if (answer === null) return policyReject();
      if (answer.length > MAX_ACP_PERMISSION_SELECTION_CODE_UNITS) {
        io.err(`   Enter a number from 1 to ${options.length}.`);
        continue;
      }
      const selection = answer.trim();
      if (selection === "") return reject();
      const selected = /^\d+$/u.test(selection) ? Number(selection) : 0;
      if (selected >= 1 && selected <= options.length) {
        return {
          decision: "select",
          optionId: options[selected - 1].optionId,
        };
      }
      io.err(`   Enter a number from 1 to ${options.length}.`);
    }
    return policyReject();
  }
  if (!interactive) {
    return {
      decision: "deny",
      reason: "approval needs an interactive terminal",
    };
  }
  if (r.kind === "budget_ceiling") {
    const message = typeof r.message === "string"
      ? r.message
      : "Projected spend crosses the configured budget ceiling.";
    io.err(`\n⚠  ${message}`);
    const answer = await io.readLine(
      "   exceed budget ceiling? [y/N] ",
      abortSignal,
    );
    if (abortSignal?.aborted) return { decision: "abort" };
    if (answer !== null && /^y(es)?$/i.test(answer.trim())) {
      return { decision: "approve" };
    }
    return { decision: "deny", reason: "operator declined" };
  }
  if (r.kind === "runaway_anomaly") {
    const message = typeof r.message === "string"
      ? r.message
      : "Actual spend crossed a runaway-anomaly hard stop.";
    io.err(`\n🛑 ${message}`);
    const answer = await io.readLine(
      "   allow the next call anyway? [y/N] ",
      abortSignal,
    );
    if (abortSignal?.aborted) return { decision: "abort" };
    if (answer !== null && /^y(es)?$/i.test(answer.trim())) {
      return { decision: "approve" };
    }
    return { decision: "deny", reason: "operator declined" };
  }
  const title = typeof r.title === "string"
    ? r.title
    : String(r.commandId ?? "tool");
  io.err(`\n⚠  approve ${title}?`);
  io.err(formatApprovalArgs(r.arguments));
  const answer = await io.readLine("   approve? [y/N] ", abortSignal);
  if (abortSignal?.aborted) return { decision: "abort" };
  if (answer !== null && /^y(es)?$/i.test(answer.trim())) {
    return { decision: "approve" };
  }
  return { decision: "deny", reason: "operator declined" };
}

export function formatRuntimeEvent(
  event: Record<string, unknown>,
): string | null {
  if (event.type === "turnAborted") return "[interrupted]";
  if (event.type === "toolStepStarted") {
    const step = typeof event.step === "number" ? event.step : "?";
    const count = typeof event.toolCallCount === "number"
      ? event.toolCallCount
      : "?";
    return `tool: step ${step} running ${count} call(s)`;
  }
  if (event.type === "toolStepLimitReached") {
    const maxSteps = typeof event.maxSteps === "number" ? event.maxSteps : "?";
    return `tool: reached ${maxSteps}-step limit; concluding now`;
  }
  if (event.type === "unparsedToolCallMarkupDetected") {
    const count = typeof event.count === "number" &&
        Number.isSafeInteger(event.count) && event.count > 0
      ? event.count
      : null;
    const amount = count === null
      ? "an unknown number of unmatched openings"
      : `${
        event.countIsLowerBound === true ? "at least " : ""
      }${count} unmatched opening(s)`;
    return `WARNING: unparsed tool-call markup was present (${amount}); ` +
      "no tools were executed from it";
  }
  if (event.type === "toolCallStarted") {
    const commandId = typeof event.commandId === "string"
      ? event.commandId
      : "tool";
    return `tool: ${commandId} started`;
  }
  if (event.type === "toolCallCompleted") {
    const commandId = typeof event.commandId === "string"
      ? event.commandId
      : "tool";
    const duration = typeof event.durationMs === "number"
      ? ` (${event.durationMs}ms)`
      : "";
    const reconciliation = event.isError === true &&
        /^mcp\.[A-Za-z0-9_-]+\.create_issue$/.test(commandId)
      ? "\nCreation not confirmed. If you approved this call, reconcile in Linear before retrying; the issue may already exist."
      : "";
    return `tool: ${commandId} ${
      event.isError === true ? "failed" : "finished"
    }${duration}${reconciliation}`;
  }
  if (event.type === "memoryRecallNegotiated") {
    const era = event.era === "modern" || event.era === "legacy"
      ? event.era
      : null;
    const identifier = (value: unknown): string | null =>
      typeof value === "string" &&
        value.length > 0 && value.length <= 64 &&
        /^[A-Za-z0-9._:/@+-]+$/.test(value)
        ? value
        : null;
    const revision = identifier(event.revision);
    const rawServer = typeof event.server === "object" &&
        event.server !== null && !Array.isArray(event.server)
      ? event.server as Record<string, unknown>
      : null;
    const serverName = rawServer === null ? null : identifier(rawServer.name);
    const serverVersion = rawServer === null
      ? null
      : identifier(rawServer.version);
    if (!Array.isArray(event.extensions) || event.extensions.length > 8) {
      return null;
    }
    const extensions = event.extensions.map(identifier);
    if (
      era === null || revision === null ||
      extensions.some((extension) => extension === null)
    ) return null;
    const server = serverName === null || serverVersion === null
      ? ""
      : ` server=${serverName}@${serverVersion}`;
    const extensionText = extensions.length === 0
      ? ""
      : ` extensions=${extensions.join(",")}`;
    return `Memory recall MCP: era=${era} revision=${revision}${server}${extensionText}`;
  }
  if (event.type === "contextCompressed") {
    const turns = typeof event.turnsCompressed === "number"
      ? event.turnsCompressed
      : "?";
    const before = typeof event.tokensBeforeEstimate === "number"
      ? event.tokensBeforeEstimate
      : "?";
    const after = typeof event.tokensAfterEstimate === "number"
      ? event.tokensAfterEstimate
      : "?";
    return `context: compressed ${turns} elder turn(s) ` +
      `(~${before} → ~${after} tokens)`;
  }
  return null;
}

function formatApprovalArgs(args: unknown): string {
  if (typeof args !== "object" || args === null) return `   ${String(args)}`;
  const lines: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    const preview = raw.length > 200
      ? `${raw.slice(0, 200)}… (${raw.length} chars)`
      : raw;
    lines.push(`   ${key}: ${preview.replace(/\n/g, "\n     ")}`);
  }
  return lines.join("\n");
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
      io.err(`resume later with: dyfj --session ${formatShellArg(cleanSessionId)}`);
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
            if (!isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
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
    io.err("  /idea mark [--event <event-id>] [--] <label...>   mark an idea in this session");
    io.err("  /idea list                                   list marked ideas for this session");
    io.err("  /idea show <idea-id>                         show details of a marked idea");
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
          (e) => e.eventId === eventId && e.sessionId === sessionState.sessionId,
        );
        const cleanEvId = eventId.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim();
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
            const cleanId = id.ideaId.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim();
            const cleanSession = id.sessionId.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim();
            const cleanEvent = id.eventId ? id.eventId.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim() : null;
            const cleanDate = (id.createdAt ?? "").replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim();
            const cleanLabel = id.label
              .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, " ")
              .trim();
            const cleanDesc = id.description
              ? id.description.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F\x1B]/g, "")
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
          const cleanId = idea.ideaId.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim();
          const cleanSession = idea.sessionId.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim();
          const cleanEvent = idea.eventId ? idea.eventId.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim() : null;
          const cleanDate = (idea.createdAt ?? "").replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim();
          const cleanLabel = idea.label
            .replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, " ")
            .trim();
          const cleanDesc = idea.description
            ? idea.description.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F\x1B]/g, "")
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
    io.out("Workbench Work Packet Commands:\n" +
      "  /packet draft [<idea-id>] [--idea <id>] [--event <id>] [--issue <id>] [--title <title>] Draft a work packet\n" +
      "  /packet list                          List generated work packets in this session\n" +
      "  /packet show <packetId>               Show rendered markdown for a work packet\n");
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
            const safeArg = tokens[i].replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim();
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
              const safeArg = tokens[i].replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim();
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
            if (matchingIdea && matchingIdea.sessionId === sessionState.sessionId) {
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
          (e) => e.eventId === eventId && e.sessionId === sessionState.sessionId,
        );
        const cleanEvId = eventId.replace(/[\x00-\x1F\x7F-\x9F\x1B]/g, "").trim();
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
              io.err(`  [${cleanPacketId}] ${cleanTitle} (Issue: ${cleanIssue})`);
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
          io.err(`no work packets drafted for session ${sessionState.sessionId}`);
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
  return Array.isArray(model.capabilities) && model.capabilities.includes("fast-speed");
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
      ("slug" in initialPosture && initialPosture.slug ? initialPosture.slug : "(registry default)");
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
