/**
 * dyfj — the CLI/TUI daily-driver client (Slice 1: line REPL + exec).
 *
 * A THIN client over the Workbench runtime's REST + SSE surface — it never
 * imports the engine (no mysql2, no provider SDKs), so the compiled binary
 * stays small and the server can migrate to Rust under the same contract.
 *
 *   dyfj exec "<prompt>"   one-shot; streams text to stdout, receipt to stderr
 *   dyfj exec --json ...    one-shot; full result JSON to stdout (buffered)
 *   dyfj                    interactive line REPL (multi-turn, streaming)
 *
 * Assumes the runtime server is running; use `dyfj status` to check it and
 * `dyfj start` to foreground the local UDS runtime.
 */

import { createInterface } from "node:readline/promises";
import process from "node:process";
import {
  DomainError,
  isSupersedingRetryStarted,
  MAX_ERROR_SUMMARY_BYTES,
  sanitizeBoundaryText,
  summarizeError,
  type TurnReceipt,
  type TurnStreamFrame,
} from "./turn-contract";
import {
  connectUnixClient,
  type ToolApprovalVerdict,
  type UnixClient,
  type UnixClientOptions,
} from "./uds-client";
import { RpcError, RpcErrorCode } from "./jsonrpc";
import { resolveSocketPath } from "./uds-path";
import { assertSecureMemoryUrl } from "./memory-search";
import {
  loadMcpServersConfig,
  loadSecretsConfig,
  type McpHttpServerConfig,
  type SecretsConfig,
} from "./config";
import { mcpServerNetGrants } from "./mcp-net-grants";
import { secretsRunGrant } from "./secrets";
import { createStreamingMarkdownRenderer } from "./streaming-markdown";
import { type BusySpinner, createBusySpinner } from "./busy-spinner";
import { hasDotPathComponent } from "./lexical-path";
import {
  defaultIdeaPacketRegistry,
  draftWorkPacketFromContext,
  formatWorkPacketMarkdown,
  getWorkbenchIdea,
  getWorkbenchPacket,
  listWorkbenchIdeas,
  listWorkbenchPackets,
  markWorkbenchIdea,
  type WorkbenchIdea,
  type WorkbenchWorkPacket,
} from "./idea-packet";

// ── Seam contract (shared with the server) ──────────────────────────
// The receipt and SSE frame shapes are defined once in turn-contract.ts and
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

export interface CliConfig {
  serverUrl: string;
  key?: string;
  /**
   * Context mode: native "turn" = companion + memory; native
   * "ask"/"next-work" = repo context. External runners receive the literal
   * prompt and selected workspace.
   */
  mode: "turn" | "ask" | "next-work";
  model?: string;
  tier?: 0 | 1 | 2;
  hint?: "code" | "chat" | "reasoning";
  runner?: "fixture" | "codex-chatgpt";
  sessionId?: string;
  /** Working directory sent to the server to scope read-only file tools. */
  workspace?: string;
  /** True when workspace came from --workspace/DYFJ_WORKSPACE, not the cwd default. */
  workspaceExplicit?: boolean;
  /** Unix socket path for the JSON-RPC seam (models/sessions, and turns with `unix`). */
  socket: string;
  /** Route turns over the UDS/JSON-RPC seam instead of HTTP/SSE (--unix). */
  unix?: boolean;
  /**
   * Opt into paid (hosted) inference for this turn/session (--approve-paid).
   * Persists across a REPL session; the engine gates it loopback-only.
   */
  approvePaid?: boolean;
  color: boolean;
}

export interface Io {
  /** Write to stdout with no implicit newline (used for streaming deltas). */
  out(text: string): void;
  /** Write a line to stderr (status, receipts, errors). */
  err(line: string): void;
  /** Write to stderr with no implicit newline (spinner frames). Optional. */
  errRaw?(text: string): void;
  /** True when stderr is an interactive terminal (spinner may animate). */
  errIsTerminal?: boolean;
  /** Prompt and read one line; null on EOF. */
  readLine(prompt: string, signal?: AbortSignal): Promise<string | null>;
  /** Interactive readline owns terminal Ctrl-C while its interface is open. */
  turnInterrupts?: TurnInterruptSource;
  close(): void;
}

const DEFAULT_SERVER = "http://127.0.0.1:8787";

// ── HTTP / SSE client ────────────────────────────────────────────────────────

function buildHeaders(
  config: CliConfig,
  stream: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (stream) headers["accept"] = "text/event-stream";
  if (config.key) headers["authorization"] = `Bearer ${config.key}`;
  return headers;
}

/** True when the server URL points at the local loopback interface. */
export function isLoopbackServerUrl(serverUrl: string): boolean {
  let host: string;
  try {
    host = new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL() strips the brackets from IPv6 hosts, so compare the bare form too.
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
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
  }

  const body: TurnRequest = { prompt, mode: config.mode };
  if (Object.keys(routingOptions).length > 0) {
    body.routingOptions = routingOptions;
  }
  if (config.runner !== undefined) body.runner = config.runner;
  if (sessionId !== undefined) body.sessionId = sessionId;
  // Send the workspace only when establishing a NEW session (no sessionId): the
  // server persists it on the session row, and resumed turns read it back, so
  // the cwd is sent once on init rather than re-sent every turn. The IMPLICIT
  // cwd default is sent only to a loopback server — never auto-disclose the
  // operator's local absolute path to a remote endpoint. An explicitly supplied
  // --workspace / DYFJ_WORKSPACE is honored regardless (the operator chose it).
  const maySendWorkspace = config.workspaceExplicit ||
    isLoopbackServerUrl(config.serverUrl);
  if (
    config.workspace !== undefined && sessionId === undefined &&
    maySendWorkspace
  ) {
    body.workspace = config.workspace;
  }
  // Per-turn paid opt-in; the engine ignores it on non-loopback transports.
  if (config.approvePaid) body.approvePaidInference = true;
  return body;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data = await response.json() as { error?: string };
    if (data?.error) return data.error;
  } catch {
    // non-JSON body
  }
  return `HTTP ${response.status}`;
}

/** POST a turn and stream the SSE frames; resolves with the final result. */
export async function streamTurn(
  config: CliConfig,
  body: TurnRequest,
  handlers: {
    onDelta: (text: string) => void;
    onEvent?: (event: Record<string, unknown>) => void;
  },
  fetchFn: typeof fetch = fetch,
): Promise<TurnResult> {
  const response = await fetchFn(`${config.serverUrl}/api/turn`, {
    method: "POST",
    headers: buildHeaders(config, true),
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    // A well-behaved server already ran this through summarizeError (or it's
    // a plain "HTTP <status>" fallback) before it hit the wire — DomainError,
    // not a fresh unbounded local Error, so friendlyError doesn't re-collapse
    // an already-safe message down to class + byte count a second time. But
    // config.serverUrl is operator-configurable, so the wire itself is not a
    // trust boundary: sanitizeBoundaryText caps and control-char-strips
    // whatever arrived before it's stamped as trusted — a no-op for honest
    // content, a bound on a hostile or misbehaving peer's.
    throw new DomainError(
      sanitizeBoundaryText(
        await readErrorMessage(response),
        MAX_ERROR_SUMMARY_BYTES,
      ),
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: TurnResult | undefined;
  let streamError: string | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep).trim();
      buffer = buffer.slice(sep + 2);
      if (!block.startsWith("data:")) continue;
      const frame = JSON.parse(
        block.slice("data:".length).trim(),
      ) as TurnStreamFrame;
      if (frame.t === "delta") handlers.onDelta(frame.text);
      else if (frame.t === "event") handlers.onEvent?.(frame.event);
      else if (frame.t === "done") result = frame.result;
      else if (frame.t === "error") streamError = frame.message;
    }
  }

  // Same reasoning as above: the wire is not a trust boundary even though
  // http.ts's SSE error frame already crossed its own sanitizing step.
  if (streamError !== undefined) {
    throw new DomainError(
      sanitizeBoundaryText(streamError, MAX_ERROR_SUMMARY_BYTES),
    );
  }
  if (result === undefined) {
    throw new DomainError("stream ended without a result");
  }
  return result;
}

/** POST a turn and read the buffered JSON result (no streaming). */
export async function bufferedTurn(
  config: CliConfig,
  body: TurnRequest,
  fetchFn: typeof fetch = fetch,
): Promise<TurnResult> {
  const response = await fetchFn(`${config.serverUrl}/api/turn`, {
    method: "POST",
    headers: buildHeaders(config, false),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new DomainError(
      sanitizeBoundaryText(
        await readErrorMessage(response),
        MAX_ERROR_SUMMARY_BYTES,
      ),
    );
  }
  return await response.json() as TurnResult;
}

// ── Presentation ─────────────────────────────────────────────────────────────

function terminalColumns(): number {
  try {
    return Deno.consoleSize()?.columns ?? 80;
  } catch {
    return 80;
  }
}

/** Wrap streamed turn text with line-buffered markdown rendering. */
export function createTurnOutputHandlers(
  config: CliConfig,
  io: Io,
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

/**
 * The turn-in-flight indicator: animates on stderr from submit until the
 * turn's first output. Enabled only when the Io exposes a raw stderr writer
 * AND stderr is an interactive terminal — piped stderr gets no control bytes.
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
 * Wrap the streaming-turn handlers so the spinner is erased immediately before
 * the first output that reaches the terminal — a delta, a runtime-event status
 * line (but not an invisible event), or a mid-turn approval prompt. stop()
 * retires the spinner, so calls after the first are no-ops.
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
      spinner.stop();
      output.onDelta(text);
    },
    onEvent: (event) => {
      // Keep spinning through invisible events; the wait isn't over yet.
      if (runtimeEventIsVisible(event)) spinner.stop();
      handleTurnRuntimeEvent(event, output, io);
    },
    onApproval: (request) => {
      spinner.stop();
      return onApproval(request);
    },
  };
}

/**
 * Route one runtime event from a streaming turn: the superseding-retry signal
 * resets the renderer (the contract every streaming client must honor); other
 * events render as stderr status lines. Shared by the HTTP/SSE and UDS paths —
 * the frame shapes match, so honoring the contract once covers both.
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
    return dim(
      `— ${result.runner.profile} · ${result.runner.protocol}${
        result.runner.protocolVersion === undefined
          ? " (not negotiated)"
          : ` v${result.runner.protocolVersion}`
      } · ${result.runner.transport} · ${
        result.runner.accessRoute ?? "unverified"
      } · ${result.runner.costBasis} · ${result.runner.elapsedMs}ms · ${result.route.reason}`,
    );
  }
  const cost = formatUsdShort(result.cost.totalUsd);
  const session = sessionTotalUsd !== undefined
    ? ` · session ${formatUsdShort(sessionTotalUsd)}`
    : "";
  const reasoning = (result.tokens.reasoning ?? 0) > 0
    ? ` (+${result.tokens.reasoning} reasoning)`
    : "";
  const tokens =
    `${result.tokens.input}→${result.tokens.output} tok${reasoning}`;
  const toolSteps =
    `tools ${result.agent.toolStepsUsed}/${result.agent.maxToolSteps}` +
    (result.agent.limitReached ? " (limit reached)" : "");
  return dim(
    `— ${result.model.displayName} · ${cost}${session} · ${tokens} · ${toolSteps} · ${result.route.reason}`,
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
  return `posture: ${posture.slug} · ${tier} · ${locality} · ${paid} · ` +
    `permission ${posture.permissionLevel ?? "unknown"} · ` +
    `workspace instructions: ${workspace}`;
}

// A server-side error message can embed the full offending payload (e.g. a
// rejected event-log INSERT quoting the oversized value back in the driver
// error), and dispatchRequest (jsonrpc.ts) forwards err.message verbatim to
// the client. The server console already logs class-only for exactly this
// reason (workbench.ts's [turn-error] line, and every joint that forwards a
// turn error toward a client — see summarizeError in turn-contract.ts, the
// shared discipline this client and the server both apply); the client had no
// equivalent discipline, so an unbounded server message printed pages of raw
// payload to the operator's terminal. summarizeError caps what any client
// error printer renders: a sane excerpt plus the error class and full byte
// count, never a multi-KB dump.

export function friendlyError(error: unknown, config: CliConfig): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /connection refused|error sending request|tcp connect|econnrefused|failed to fetch|client error/i
      .test(message)
  ) {
    return `dyfj: runtime not reachable at ${config.serverUrl}. ` +
      `Start it with: deno task workbench-http`;
  }
  return `dyfj: ${summarizeError(error)}`;
}

// ── Commands ─────────────────────────────────────────────────────────────────

export async function runExec(
  prompt: string,
  config: CliConfig,
  io: Io,
  json: boolean,
  fetchFn: typeof fetch = fetch,
  connect: ConnectFn = connectUnixClient,
  interactive = true,
  interrupts: TurnInterruptSource | undefined = io.turnInterrupts,
): Promise<number> {
  const body = buildTurnBody(prompt, config, config.sessionId);
  const approvalController = config.unix ? new AbortController() : undefined;
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
      const result = config.unix
        ? await socketTurn(
          config,
          body,
          {
            onApproval,
            abortSignal: approvalController?.signal,
            onConnected: installInterrupt,
          },
          connect,
        )
        : await bufferedTurn(config, body, fetchFn);
      io.out(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const output = createTurnOutputHandlers(config, io);
      const spinner = createTurnSpinner(config, io);
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
        result = config.unix
          ? await socketTurn(
            config,
            body,
            {
              ...terminalHandlers,
              abortSignal: approvalController?.signal,
              onConnected: installInterrupt,
            },
            connect,
          )
          : await streamTurn(config, body, terminalHandlers, fetchFn);
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
    io.err(
      config.unix ? socketError(error, config) : friendlyError(error, config),
    );
    exitCode = 1;
  } finally {
    let cleanupError: unknown;
    try {
      approvalController?.abort();
    } catch (error) {
      cleanupError = error;
    }
    try {
      if (interruptInstalled) interrupts?.remove(interrupt);
    } catch (error) {
      cleanupError ??= error;
    }
    if (!turnFailed && cleanupError !== undefined) {
      io.err(
        config.unix
          ? socketError(cleanupError, config)
          : friendlyError(cleanupError, config),
      );
      exitCode = 1;
    }
  }
  return exitCode;
}

export async function runRepl(
  config: CliConfig,
  io: Io,
  fetchFn: typeof fetch = fetch,
  connect: ConnectFn = connectUnixClient,
  interactive = true,
  interrupts: TurnInterruptSource | undefined = io.turnInterrupts,
): Promise<number> {
  io.err(
    `dyfj — ${
      config.unix ? config.socket : config.serverUrl
    } · Ctrl-D or /exit to quit`,
  );
  // Session-start posture line (UDS seam only — HTTP sessions have no status
  // RPC). An unreachable runtime prints nothing here: the first turn already
  // reports reachability loudly, and the REPL must still open. Interactive
  // sessions only: with piped stdin, readline closes on EOF during any await
  // that precedes the first readLine, so this fetch would silently swallow the
  // piped input; scripted sessions keep main-line behavior byte-identical.
  if (config.unix && interactive) {
    const posture = await fetchSessionPosture(config, connect);
    if (!("error" in posture)) io.err(formatPostureLine(posture));
  }
  const sessionState: ReplSessionState = {
    sessionId: config.sessionId,
    turnCount: 0,
    sessionSpendUsd: 0,
  };
  let exitCode = 0;
  try {
    for (;;) {
      const line = await io.readLine(replPrompt(config.color));
      if (line === null) break;
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
      ) continue;
      if (
        await handleReplIdeaCommand(prompt, config, io, sessionState, connect)
      ) continue;
      if (
        await handleReplPacketCommand(
          prompt,
          config,
          io,
          sessionState,
          connect,
        )
      ) continue;
      if (await handleReplModelCommand(prompt, config, io, connect)) continue;
      try {
        const body = buildTurnBody(prompt, config, sessionState.sessionId);
        const output = createTurnOutputHandlers(config, io);
        const spinner = createTurnSpinner(config, io);
        const abortController = config.unix ? new AbortController() : undefined;
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
          result = config.unix
            ? await socketTurn(
              config,
              body,
              {
                ...terminalHandlers,
                abortSignal: abortController?.signal,
                onConnected: () => {
                  if (interrupts !== undefined) {
                    interrupts.add(interrupt);
                    interruptInstalled = true;
                  }
                },
              },
              connect,
            )
            : await streamTurn(config, body, terminalHandlers, fetchFn);
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
        sessionState.turnCount++;
        if ("cost" in result) sessionState.sessionSpendUsd += result.cost.totalUsd;
        io.err(
          formatReceipt(
            result,
            config.color,
            "cost" in result ? sessionState.sessionSpendUsd : undefined,
          ),
        );
      } catch (error) {
        io.err(
          config.unix
            ? socketError(error, config)
            : friendlyError(error, config),
        );
        if (error instanceof TurnCancellationUncertainError) {
          exitCode = 1;
          break;
        }
      }
    }
  } finally {
    io.close();
  }
  return exitCode;
}

// ── UDS read commands (models/sessions over the JSON-RPC seam) ───────────────

interface ModelRow {
  slug?: string;
  displayName?: string;
  provider?: string;
  tier?: number;
  /** Server-computed locality (on-machine loopback provider); absent on older servers. */
  local?: boolean;
}
interface SessionRow {
  slug?: string;
  sessionName?: string;
  updatedAt?: string;
}
interface ProjectGroup {
  project: string | null;
  sessions: SessionRow[];
}
interface RuntimeStatusPayload {
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
  };
}

export interface StartRuntimeOptions {
  command?: string;
  cwd?: string;
  autostarted?: boolean;
}

export type ConnectFn = typeof connectUnixClient;
export const TURN_CANCELLATION_TIMEOUT_MS = 5_000;
export const TURN_CANCELLATION_SETTLE_TIMEOUT_MS = 30_000;
const MAX_ACP_PERMISSION_OPTIONS = 16;
const MAX_ACP_PERMISSION_SELECTION_ATTEMPTS = 3;
const MAX_ACP_PERMISSION_SELECTION_CODE_UNITS = 64;

class TurnCancellationUncertainError extends DomainError {}

export interface TurnInterruptSource {
  add(handler: () => void): void;
  remove(handler: () => void): void;
}

const denoTurnInterruptSource: TurnInterruptSource = {
  add: (handler) => Deno.addSignalListener("SIGINT", handler),
  remove: (handler) => Deno.removeSignalListener("SIGINT", handler),
};

export type StartRuntimeFn = (
  config: CliConfig,
  options?: StartRuntimeOptions,
) => Promise<number>;

/**
 * Run a turn over the UDS/JSON-RPC seam: forward `stream` notifications to the
 * handlers and resolve with the receipt (the RPC result). Mirrors streamTurn's
 * shape so runExec/runRepl can pick a transport transparently. Over UDS there is
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

/** @deprecated Use promptMidTurnApproval — kept as an alias for existing tests. */
export const promptToolApproval = promptMidTurnApproval;

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
    return `tool: ${commandId} ${
      event.isError === true ? "failed" : "finished"
    }${duration}`;
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

export const LIVENESS_PROBE_TIMEOUT_MS = 5000;

export function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") {
      return true;
    }
    if (
      error.name === "AbortError" &&
      error.cause instanceof Error &&
      error.cause.name === "TimeoutError"
    ) {
      return true;
    }
  }
  return false;
}

export function socketError(error: unknown, config: CliConfig): string {
  if (isTimeoutError(error)) {
    return `dyfj: runtime at ${config.socket} is unresponsive (timed out)`;
  }
  if (error instanceof RpcError) {
    return `dyfj: ${error.message}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    /no such file|file not found|socket not found|connection refused|econnrefused|enoent|\bos error 2\b|\bos error 61\b/i
      .test(message)
  ) {
    return `dyfj: runtime not reachable at ${config.socket}. ` +
      `Start it with: dyfj start`;
  }
  return `dyfj: ${summarizeError(error)}`;
}

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
    if (error instanceof RpcError && error.code === RpcErrorCode.methodNotFound) {
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

export async function fetchModelSlugs(
  config: CliConfig,
  connect: ConnectFn = connectUnixClient,
): Promise<{ slugs: string[]; models: ModelRow[] } | { error: string }> {
  try {
    const signal = AbortSignal.timeout(LIVENESS_PROBE_TIMEOUT_MS);
    const client = await connect(config.socket, undefined, signal);
    try {
      const { models } = await client.request(
        "models/list",
        undefined,
        signal,
      ) as {
        models: ModelRow[];
      };
      const slugs = models
        .map((m) => m.slug)
        .filter((slug): slug is string =>
          typeof slug === "string" && slug.length > 0
        );
      return { slugs, models };
    } finally {
      client.close();
    }
  } catch (error) {
    return { error: socketError(error, config) };
  }
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
      };
    } finally {
      client.close();
    }
  } catch (error) {
    return { error: socketError(error, config) };
  }
}

export interface ReplSessionState {
  sessionId?: string;
  turnCount: number;
  sessionSpendUsd: number;
  workspace?: string;
}

export async function handleReplSessionCommand(
  line: string,
  config: CliConfig,
  io: Io,
  sessionState: ReplSessionState,
  connect: ConnectFn = connectUnixClient,
): Promise<boolean> {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== "/session") return false;

  const sub = parts[1];
  if (!sub) {
    if (!sessionState.sessionId) {
      io.err("no session yet — send a prompt first");
    } else {
      io.err(`session: ${sessionState.sessionId}`);
      if (sessionState.turnCount === 0 && config.unix) {
        try {
          const client = await connect(config.socket);
          try {
            const inspect = await client.request("sessions/inspect", {
              sessionId: sessionState.sessionId,
            }) as { eventCount?: number; workspace?: string | null };
            if (inspect.eventCount !== undefined && inspect.eventCount > 0) {
              io.err(`events: ${inspect.eventCount}`);
            }
            if (inspect.workspace) {
              io.err(`workspace: ${inspect.workspace}`);
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
      io.err(`resume later with: dyfj --session ${sessionState.sessionId}`);
    }
    return true;
  }

  if (sub === "list") {
    if (config.unix) {
      try {
        const client = await connect(config.socket);
        try {
          const res = await client.request("sessions/list", {}) as {
            projects?: Array<{
              sessions: Array<{
                sessionId: string;
                taskDescription: string;
                createdAt: string;
              }>;
            }>;
          };
          const allSessions: Array<{
            sessionId: string;
            taskDescription: string;
            createdAt: string;
          }> = [];
          for (const p of res.projects ?? []) {
            if (Array.isArray(p.sessions)) {
              allSessions.push(...p.sessions);
            }
          }
          const sessions = allSessions
            .sort((a, b) =>
              (b.createdAt || "").localeCompare(a.createdAt || "")
            )
            .slice(0, 15);
          if (sessions.length === 0) {
            io.err("no sessions found");
          } else {
            io.err("Recent sessions:");
            for (const s of sessions) {
              io.err(
                `  ${s.sessionId}  ${s.createdAt?.split("T")[0] ?? ""}  ${s.taskDescription}`,
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
    const targetId = parts[2];
    if (!targetId) {
      io.err("usage: /session switch <sessionId>");
      return true;
    }
    if (config.unix) {
      try {
        const client = await connect(config.socket);
        try {
          const inspect = await client.request("sessions/inspect", {
            sessionId: targetId,
          }) as { exists?: boolean };
          if (inspect.exists === false) {
            io.err(`warning: session "${targetId}" was not found on runtime`);
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
    io.err(`switched to session: ${targetId}`);
    return true;
  }

  io.err(
    "unknown /session subcommand. Usage: /session, /session list, /session switch <sessionId>",
  );
  return true;
}

export async function handleReplIdeaCommand(
  line: string,
  config: CliConfig,
  io: Io,
  sessionState: ReplSessionState,
  connect: ConnectFn = connectUnixClient,
): Promise<boolean> {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== "/idea") return false;

  const sub = parts[1];
  if (!sub || sub === "help") {
    io.err("Idea capture commands:");
    io.err("  /idea mark [--event <event-id>] <label...>   mark an idea in this session");
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
    let eventId: string | undefined;
    let labelParts: string[];
    if (parts[2] === "--event") {
      if (parts.length < 5) {
        io.err("usage: /idea mark --event <event-id> <label...>");
        return true;
      }
      eventId = parts[3];
      labelParts = parts.slice(4);
    } else {
      labelParts = parts.slice(2);
    }
    const label = labelParts.join(" ").trim();
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
            eventId,
            label,
          }) as { idea: WorkbenchIdea };
          io.err(`marked idea [${res.idea.ideaId}]: "${res.idea.label}"`);
          io.err(`draft packet with: /packet draft ${res.idea.ideaId}`);
        } finally {
          client.close();
        }
      } catch (e) {
        io.err(`dyfj: failed to mark idea: ${summarizeError(e)}`);
      }
    } else {
      if (eventId) {
        io.err(
          "error: --event requires connecting to a local runtime over Unix domain socket",
        );
        return true;
      }
      const idea = markWorkbenchIdea({
        sessionId: sessionState.sessionId,
        eventId,
        label,
      });
      io.err(`marked idea [${idea.ideaId}]: "${idea.label}"`);
      io.err(`draft packet with: /packet draft ${idea.ideaId}`);
    }
    return true;
  }

  if (sub === "list") {
    if (config.unix) {
      try {
        const client = await connect(config.socket);
        try {
          const res = await client.request("ideas/list", {
            sessionId: sessionState.sessionId,
          }) as { ideas: WorkbenchIdea[] };
          if (res.ideas.length === 0) {
            io.err(`no ideas marked for session ${sessionState.sessionId}`);
          } else {
            io.err(`Ideas for session ${sessionState.sessionId}:`);
            for (const item of res.ideas) {
              io.err(
                `  [${item.ideaId}] ${item.label} (${
                  item.createdAt.split("T")[0]
                })`,
              );
            }
          }
        } finally {
          client.close();
        }
      } catch (e) {
        io.err(`dyfj: failed to list ideas: ${summarizeError(e)}`);
      }
    } else {
      const ideas = listWorkbenchIdeas({ sessionId: sessionState.sessionId });
      if (ideas.length === 0) {
        io.err(`no ideas marked for session ${sessionState.sessionId}`);
      } else {
        io.err(`Ideas for session ${sessionState.sessionId}:`);
        for (const item of ideas) {
          io.err(
            `  [${item.ideaId}] ${item.label} (${item.createdAt.split("T")[0]})`,
          );
        }
      }
    }
    return true;
  }

  if (sub === "show") {
    const ideaId = parts[2];
    if (!ideaId) {
      io.err("usage: /idea show <idea-id>");
      return true;
    }
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
            io.err(`Idea [${res.idea.ideaId}]:`);
            io.err(`  Label: ${res.idea.label}`);
            io.err(`  Session: ${res.idea.sessionId}`);
            if (res.idea.eventId) io.err(`  Event: ${res.idea.eventId}`);
            io.err(`  Date: ${res.idea.createdAt}`);
            io.err(`  Description: ${res.idea.description}`);
          }
        } finally {
          client.close();
        }
      } catch (e) {
        io.err(`dyfj: failed to get idea: ${summarizeError(e)}`);
      }
    } else {
      const idea = getWorkbenchIdea(ideaId);
      if (!idea) {
        io.err(`idea not found: ${ideaId}`);
      } else {
        io.err(`Idea [${idea.ideaId}]:`);
        io.err(`  Label: ${idea.label}`);
        io.err(`  Session: ${idea.sessionId}`);
        if (idea.eventId) io.err(`  Event: ${idea.eventId}`);
        io.err(`  Date: ${idea.createdAt}`);
        io.err(`  Description: ${idea.description}`);
      }
    }
    return true;
  }

  io.err(
    "unknown /idea subcommand. Usage: /idea mark, /idea list, /idea show <id>",
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
  const raw = line.trim();
  const parts = raw.split(/\s+/);
  if (parts[0] !== "/packet") return false;

  const sub = parts[1];
  if (!sub || sub === "help") {
    io.err("Work packet commands:");
    io.err(
      "  /packet draft <idea-id|event-id> [--issue <BIT-id>] [--title <title>]",
    );
    io.err("  /packet list");
    io.err("  /packet show <packet-id>");
    return true;
  }

  if (!sessionState.sessionId) {
    io.err("no session yet — send a prompt first before drafting packets");
    return true;
  }

  if (sub === "draft") {
    let targetRef: string | undefined;
    let issueId: string | undefined;
    let title: string | undefined;
    const knownOptions = new Set(["--issue", "--title"]);
    const tokens = parts.slice(2);
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token === "--issue") {
        i++;
        if (i >= tokens.length || knownOptions.has(tokens[i])) {
          io.err("error: --issue requires an issue identifier");
          return true;
        }
        issueId = tokens[i];
        i++;
      } else if (token === "--title") {
        i++;
        const titleTokens: string[] = [];
        while (i < tokens.length && !knownOptions.has(tokens[i])) {
          titleTokens.push(tokens[i]);
          i++;
        }
        if (titleTokens.length === 0) {
          io.err("error: --title requires a title argument");
          return true;
        }
        title = titleTokens.join(" ").trim();
      } else if (!targetRef && !token.startsWith("--")) {
        targetRef = token;
        i++;
      } else {
        io.err(`error: unexpected argument "${token}"`);
        return true;
      }
    }

    if (!targetRef) {
      io.err(
        "usage: /packet draft <idea-id|event-id> [--issue <BIT-id>] [--title <title>]",
      );
      return true;
    }

    const isEventRef = targetRef.startsWith("evt-");
    const ideaId = isEventRef ? undefined : targetRef;
    const eventId = isEventRef ? targetRef : undefined;

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
          io.out(res.markdown);
          io.err(`\ndraft work packet registered: [${res.packet.packetId}]`);
        } finally {
          client.close();
        }
      } catch (e) {
        io.err(`dyfj: failed to draft packet: ${summarizeError(e)}`);
      }
    } else {
      if (isEventRef) {
        io.err(
          "error: drafting packets from event references requires connecting to a local runtime over Unix domain socket",
        );
        return true;
      }
      const packet = draftWorkPacketFromContext({
        sessionId: sessionState.sessionId,
        ideaId,
        eventId,
        issueId,
        title,
      });
      const markdown = formatWorkPacketMarkdown(packet);
      io.out(markdown);
      io.err(`\ndraft work packet registered: [${packet.packetId}]`);
    }
    return true;
  }

  if (sub === "list") {
    if (config.unix) {
      try {
        const client = await connect(config.socket);
        try {
          const res = await client.request("packets/list", {
            sessionId: sessionState.sessionId,
          }) as { packets: WorkbenchWorkPacket[] };
          if (res.packets.length === 0) {
            io.err(
              `no work packets drafted for session ${sessionState.sessionId}`,
            );
          } else {
            io.err(`Work packets for session ${sessionState.sessionId}:`);
            for (const p of res.packets) {
              io.err(
                `  [${p.packetId}] ${p.title} (Issue: ${p.issueId ?? "none"})`,
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
      const packets = listWorkbenchPackets({
        sessionId: sessionState.sessionId,
      });
      if (packets.length === 0) {
        io.err(`no work packets drafted for session ${sessionState.sessionId}`);
      } else {
        io.err(`Work packets for session ${sessionState.sessionId}:`);
        for (const p of packets) {
          io.err(
            `  [${p.packetId}] ${p.title} (Issue: ${p.issueId ?? "none"})`,
          );
        }
      }
    }
    return true;
  }

  if (sub === "show") {
    const packetId = parts[2];
    if (!packetId) {
      io.err("usage: /packet show <packet-id>");
      return true;
    }
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
            io.out(res.markdown);
          }
        } finally {
          client.close();
        }
      } catch (e) {
        io.err(`dyfj: failed to get packet: ${summarizeError(e)}`);
      }
    } else {
      const packet = getWorkbenchPacket(packetId);
      if (!packet) {
        io.err(`work packet not found: ${packetId}`);
      } else {
        io.out(formatWorkPacketMarkdown(packet));
      }
    }
    return true;
  }

  io.err(
    "unknown /packet subcommand. Usage: /packet draft, /packet list, /packet show <id>",
  );
  return true;
}

export async function handleReplModelCommand(
  line: string,
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
): Promise<boolean> {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== "/model") return false;
  // `--approve-paid` mirrors the launch flag: it arms the SESSION's existing
  // per-turn paid opt-in (buildTurnBody sends it each turn), so escalating to a
  // hosted model mid-session doesn't require relaunching. Consent stays with
  // the engine: without it, hosted turns keep failing closed exactly as today.
  const approvePaid = parts.includes("--approve-paid");
  const args = parts.slice(1).filter((part) => part !== "--approve-paid");

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
    // Bare `/model --approve-paid` arms paid inference without switching.
    if (approvePaid) config.approvePaid = true;
    const active = config.model ?? "(registry default)";
    io.err(`active model: ${active}`);
    io.err(`available: ${listed.slugs.join(", ") || "(none)"}`);
    await emitPosture();
    return true;
  }

  const slug = args[0];
  if (!listed.slugs.includes(slug)) {
    // A failed switch must not arm paid inference as a side effect.
    io.err(
      `dyfj: unknown model "${slug}". Available: ${
        listed.slugs.join(", ") || "(none)"
      }`,
    );
    return true;
  }

  config.model = slug;
  config.runner = undefined;
  if (approvePaid) config.approvePaid = true;
  await emitPosture();
  return true;
}

export async function runModels(
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
): Promise<number> {
  const listed = await fetchModelSlugs(config, connect);
  if ("error" in listed) {
    io.err(listed.error);
    return 1;
  }
  const { models } = listed;
  const slugWidth = models.reduce(
    (w, m) => Math.max(w, (m.slug ?? "").length),
    0,
  );
  for (const m of models) {
    // Server-computed flag; only an explicit false marks a row (older servers
    // omit the field, and absence must not smear "unpriced" over the list).
    const unroutable = (m as { routable?: boolean }).routable === false
      ? "  [unpriced — not routable]"
      : "";
    io.out(
      `${(m.slug ?? "").padEnd(slugWidth)} t${m.tier ?? "?"}  ` +
        `${(m.provider ?? "").padEnd(10)} ${
          m.displayName ?? ""
        }${unroutable}\n`,
    );
  }
  return 0;
}

/**
 * Accept a session reference as either the bare 26-char session id or the
 * slug exactly as `dyfj sessions` lists it (workbench-<id>, lowercased).
 * Returns the canonical uppercase session id.
 */
export function normalizeSessionRef(value: string): string {
  const ULID = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
  const slugMatch = value.match(/^workbench-([0-9A-Za-z]{26})$/i);
  const candidate = slugMatch ? slugMatch[1] : value;
  if (!ULID.test(candidate)) {
    throw new Error(
      `--session expects a session id or a slug as listed by 'dyfj sessions', got: ${value}`,
    );
  }
  return candidate.toUpperCase();
}

export async function runSessions(
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
): Promise<number> {
  try {
    const client = await connect(config.socket);
    try {
      const { projects } = await client.request("sessions/list") as {
        projects: ProjectGroup[];
      };
      for (const group of projects) {
        io.out(`\n${group.project ?? "(unfiled)"}\n`);
        for (const s of group.sessions) {
          const when = (s.updatedAt ?? "").slice(0, 16);
          io.out(
            `  ${(s.slug ?? "").padEnd(40)} ${when.padEnd(18)} ${
              s.sessionName ?? ""
            }\n`,
          );
        }
      }
      io.err(`resume one with: dyfj --session <session> (the first column)`);
    } finally {
      client.close();
    }
    return 0;
  } catch (error) {
    io.err(socketError(error, config));
    return 1;
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

export async function runStop(
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
  signal: AbortSignal = AbortSignal.timeout(LIVENESS_PROBE_TIMEOUT_MS),
): Promise<number> {
  try {
    let client: UnixClient;
    try {
      client = await connect(config.socket, undefined, signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        /no such file|file not found|socket not found|connection refused|econnrefused|enoent|\bos error 2\b|\bos error 61\b/i
          .test(message)
      ) {
        io.out(`dyfj: runtime is not running at ${config.socket}\n`);
        return 0;
      }
      throw err;
    }
    try {
      await client.request("runtime/stop", undefined, signal);
    } finally {
      client.close();
    }

    // Poll with bounded connection attempts until the socket is verified closed or missing
    let closed = false;
    const stopDeadline = Date.now() + 3000;
    while (Date.now() < stopDeadline) {
      try {
        const pollSignal = AbortSignal.timeout(200);
        const checkClient = await connect(config.socket, undefined, pollSignal);
        checkClient.close();
        await new Promise((r) => setTimeout(r, 50));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          /no such file|file not found|socket not found|connection refused|econnrefused|enoent|\bos error 2\b|\bos error 61\b/i
            .test(message)
        ) {
          closed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    if (!closed) {
      io.err(`dyfj: runtime at ${config.socket} did not stop within deadline`);
      return 1;
    }

    io.out(`dyfj: runtime at ${config.socket} stopped\n`);
    return 0;
  } catch (error) {
    io.err(socketError(error, config));
    return 1;
  }
}

/**
 * The prototype root whose `deno.json` (net/run grants) and `.env` the spawned
 * runtime trusts — derived from a TRUSTED source, never the arbitrary cwd. A
 * hostile cwd could seed a `deno.json` that grants broad net/run to the child;
 * so `dyfj start` refuses to trust it. Precedence:
 *   1. DYFJ_PROTOTYPE_ROOT — the launcher always sets it (compiled + deno routes).
 *   2. The install root derived from this module's own file: URL (running
 *      cli.ts directly from a checkout without the launcher).
 *   3. Otherwise throw — better to fail closed than trust the current directory.
 */
function defaultPrototypeRoot(): string {
  const envRoot = Deno.env.get("DYFJ_PROTOTYPE_ROOT");
  if (envRoot && envRoot.length > 0) return envRoot;
  const installRoot = installRootFromModuleUrl(import.meta.url);
  if (installRoot !== null) return installRoot;
  throw new Error(
    "cannot determine the prototype root: set DYFJ_PROTOTYPE_ROOT or launch via " +
      "the dyfj launcher. Refusing to trust the current working directory for " +
      "the runtime's permission grants.",
  );
}

/**
 * Derive the prototype root from this module's URL: `.../prototype/src/cli.ts`
 * → `.../prototype`. Only a `file:` URL is trusted (the code's real on-disk
 * home); a remote (`https:`) module has no trustworthy local install root, so
 * this returns null and the caller fails closed.
 */
export function installRootFromModuleUrl(moduleUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(moduleUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;
  const path = decodeURIComponent(url.pathname);
  // .../prototype/src/cli.ts → strip the trailing `/src/<file>` to reach root.
  const match = path.match(/^(.*)\/src\/[^/]+$/);
  if (match === null) return null;
  return match[1];
}

/**
 * Build the `deno run` args for foregrounding the runtime. The serve-unix
 * permission profile cannot carry the machine-specific `unix:<socket>` net
 * grant (deno.json commits no host paths), and a spawned child cannot prompt
 * for it (the CLI holds stdin in raw mode). So `dyfj start` passes an explicit
 * --allow-net that reproduces the profile's net list plus the one resolved
 * socket path — and, when an external memory endpoint is configured, its
 * launch-resolved host grant (same reasoning: an operator-private hostname
 * never belongs in the committed profile); -P still supplies every other
 * permission category.
 */
export function buildServeUnixArgs(
  netGrants: string[],
  socketPath: string,
  memoryMcpGrant?: string | null,
  runGrants?: string[] | null,
  envGrants?: string[] | null,
  autostarted = false,
  externalMcpGrants: readonly string[] = [],
): string[] {
  if (runGrants?.some((grant) => grant.includes(","))) {
    throw new Error("Deno run grants cannot contain commas");
  }
  const socketGrant = `unix:${socketPath}`;
  if (
    [...netGrants, socketGrant, ...(memoryMcpGrant == null
      ? []
      : [memoryMcpGrant]), ...externalMcpGrants]
      .some((grant) => grant.includes(","))
  ) {
    throw new Error("Deno network grants cannot contain commas");
  }
  let net = netGrants.includes(socketGrant)
    ? netGrants
    : [...netGrants, socketGrant];
  if (memoryMcpGrant != null && !net.includes(memoryMcpGrant)) {
    net = [...net, memoryMcpGrant];
  }
  for (const grant of externalMcpGrants) {
    if (!net.includes(grant)) net = [...net, grant];
  }
  return [
    "run",
    // A server must never interactively prompt: ungranted access throws
    // NotCapable (fail-closed) instead of parking the runtime on a TTY
    // prompt nobody watches while clients hang on a silent turn.
    "--no-prompt",
    "-P=serve-unix",
    `--allow-net=${net.join(",")}`,
    // An explicit --allow-run REPLACES the profile's run list, so runGrants
    // must carry the profile grants plus the launch-resolved Node executable,
    // /bin/kill, and any configured resolver binary.
    ...(runGrants != null ? [`--allow-run=${runGrants.join(",")}`] : []),
    // An explicit --allow-env likewise REPLACES the profile's env list, so
    // envGrants must carry the profile's own env plus the [secrets].inherit_env
    // names the runtime must READ to forward them into the resolver. Omitted
    // (null) when inherit_env is empty. The forwarded VALUES never enter the
    // committed profile — only launch-resolved from the operator's config.
    ...(envGrants != null ? [`--allow-env=${envGrants.join(",")}`] : []),
    "--env-file=.env",
    "--sloppy-imports",
    "src/uds-serve.ts",
    ...(autostarted ? ["--autostarted"] : []),
  ];
}

/** Read the serve-unix profile's declared env grants from deno.json. */
export async function readServeUnixEnvGrants(cwd: string): Promise<string[]> {
  const raw = await Deno.readTextFile(`${cwd}/deno.json`);
  const parsed = JSON.parse(raw) as {
    permissions?: { "serve-unix"?: { env?: unknown } };
  };
  const env = parsed.permissions?.["serve-unix"]?.env;
  if (!Array.isArray(env) || !env.every((e) => typeof e === "string")) {
    throw new Error(
      `serve-unix permission profile in ${cwd}/deno.json has no env grant list`,
    );
  }
  return env;
}

/** Read the serve-unix profile's declared run grants from deno.json. */
export async function readServeUnixRunGrants(cwd: string): Promise<string[]> {
  const raw = await Deno.readTextFile(`${cwd}/deno.json`);
  const parsed = JSON.parse(raw) as {
    permissions?: { "serve-unix"?: { run?: unknown } };
  };
  const run = parsed.permissions?.["serve-unix"]?.run;
  if (!Array.isArray(run) || !run.every((r) => typeof r === "string")) {
    throw new Error(
      `serve-unix permission profile in ${cwd}/deno.json has no run grant list`,
    );
  }
  return run;
}

/** Validate the selected executable and carry that same path into exact grants. */
export async function nodeRunGrant(
  env: { get(name: string): string | undefined } = Deno.env,
): Promise<string | null> {
  const configured = env.get("DYFJ_NODE_PATH");
  if (configured === undefined || configured === "") return null;
  if (!configured.startsWith("/")) {
    throw new Error("DYFJ_NODE_PATH must name an absolute executable");
  }
  if (configured.includes(",") || configured.includes(":")) {
    throw new Error("DYFJ_NODE_PATH contains an unsupported delimiter");
  }
  let resolved: string;
  try {
    resolved = await Deno.realPath(configured);
    const info = await Deno.stat(resolved);
    if (
      !info.isFile ||
      (Deno.build.os !== "windows" && ((info.mode ?? 0) & 0o111) === 0)
    ) throw new Error("not executable");
  } catch {
    throw new Error("DYFJ_NODE_PATH executable is unavailable");
  }
  if (resolved.includes(",") || resolved.includes(":")) {
    throw new Error(
      "DYFJ_NODE_PATH canonical target contains an unsupported delimiter",
    );
  }
  return configured;
}

/** Validate the optional toolchain path using only the CLI's read authority. */
export async function toolchainReadGrant(
  env: { get(name: string): string | undefined } = Deno.env,
): Promise<string | null> {
  const configured = env.get("DYFJ_CODEX_TOOLCHAIN_PATH");
  if (configured === undefined || configured === "") return null;
  if (!configured.startsWith("/")) {
    throw new Error("Codex toolchain path must name an absolute directory");
  }
  if (configured.includes(",") || configured.includes(":")) {
    throw new Error("Codex toolchain path contains an unsupported delimiter");
  }
  if (hasDotPathComponent(configured)) {
    throw new Error("Codex toolchain path must not contain dot components");
  }
  if (/^\/+$/u.test(configured)) {
    throw new Error("Codex toolchain directory is unavailable");
  }
  try {
    const noFollowPath = configured === "/"
      ? configured
      : configured.replace(/\/+$/, "");
    const info = await Deno.lstat(noFollowPath);
    if (!info.isDirectory || info.isSymlink) {
      throw new Error("unavailable directory");
    }
    const resolved = await Deno.realPath(noFollowPath);
    if (resolved.includes(",") || resolved.includes(":")) {
      throw new Error("unsafe canonical path");
    }
  } catch {
    throw new Error("Codex toolchain directory is unavailable");
  }
  return configured;
}

/** Validate the optional Rustup home using only the CLI's read authority. */
export async function rustupHomeReadGrant(
  env: { get(name: string): string | undefined } = Deno.env,
): Promise<string | null> {
  const configured = env.get("DYFJ_CODEX_RUSTUP_HOME");
  if (configured === undefined || configured === "") return null;
  if (!configured.startsWith("/")) {
    throw new Error("Codex Rustup home must name an absolute directory");
  }
  if (configured.includes(",") || configured.includes(":")) {
    throw new Error("Codex Rustup home contains an unsupported delimiter");
  }
  if (hasDotPathComponent(configured)) {
    throw new Error("Codex Rustup home must not contain dot components");
  }
  if (/^\/+$/u.test(configured)) {
    throw new Error("Codex Rustup home directory is unavailable");
  }
  try {
    const noFollowPath = configured === "/"
      ? configured
      : configured.replace(/\/+$/, "");
    const info = await Deno.lstat(noFollowPath);
    if (!info.isDirectory || info.isSymlink) {
      throw new Error("unavailable directory");
    }
    const resolved = await Deno.realPath(noFollowPath);
    if (resolved.includes(",") || resolved.includes(":")) {
      throw new Error("unsafe canonical path");
    }
  } catch {
    throw new Error("Codex Rustup home directory is unavailable");
  }
  return configured;
}

/**
 * Derive the --allow-net grant for the external memory MCP endpoint from its
 * configured URL. The endpoint host is operator-private, so it must never be
 * committed to deno.json's net lists; like the `unix:<socket>` grant above, it
 * is resolved at launch and appended to the explicit --allow-net. Returns null
 * when no endpoint is configured (recall disabled — no grant to add); throws on
 * a malformed value so misconfiguration surfaces at `dyfj start`, not as a
 * NotCapable deep inside a recall turn.
 */
export function memoryMcpNetGrant(url: string | undefined): string | null {
  if (url === undefined || url === "") return null;
  // Same rule the runtime enforces at config resolution: https everywhere,
  // plain http only to loopback — never grant a destination that would carry
  // the token in cleartext.
  assertSecureMemoryUrl(url);
  const parsed = new URL(url);
  const port = parsed.port !== ""
    ? parsed.port
    : parsed.protocol === "http:"
    ? "80"
    : "443";
  return `${parsed.hostname}:${port}`;
}

/**
 * Read one variable from env-file text (KEY=VALUE lines; `export` prefix,
 * surrounding quotes, comments, and blank lines tolerated). Just enough of the
 * dotenv shape for the launcher to resolve the same value the spawned runtime
 * will read via --env-file=.env.
 */
export function envFileVar(text: string, name: string): string | undefined {
  for (const line of text.split("\n")) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/,
    );
    if (match === null || match[1] !== name) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

/**
 * Resolve the memory MCP net grant the way the spawned runtime will resolve
 * the URL itself: ambient environment first (--env-file does NOT override
 * already-set process env, and the child inherits ours), then `<cwd>/.env`.
 * Anything else lets the two diverge — recall configured without its grant, or
 * a grant for the wrong host. No value anywhere means no grant (recall stays
 * disabled).
 */
export async function readMemoryMcpNetGrant(
  cwd: string,
  readTextFile: (path: string) => Promise<string> = Deno.readTextFile,
  env: { get(name: string): string | undefined } = Deno.env,
): Promise<string | null> {
  // Any DEFINED ambient value is authoritative — including empty: --env-file
  // does not fill an explicitly empty inherited var, so the child sees "" and
  // disables recall; granting the .env host anyway would be an unnecessary
  // grant with no consumer.
  const ambient = env.get("DYFJ_MEMORY_MCP_URL");
  if (ambient !== undefined) {
    return memoryMcpNetGrant(ambient);
  }
  let raw: string;
  try {
    raw = await readTextFile(`${cwd}/.env`);
  } catch {
    return null;
  }
  return memoryMcpNetGrant(envFileVar(raw, "DYFJ_MEMORY_MCP_URL"));
}

/**
 * Load the `[secrets]` config the SAME way the spawned child will locate it, so
 * the launcher's `--allow-run` grant matches the resolver the runtime actually
 * invokes. The config file lives at `$DYFJ_ROOT/config.toml` (else
 * `$HOME/.dyfj/config.toml`). The child reads `--env-file=.env`, which only
 * supplies a var that is NOT already in the ambient environment — so `DYFJ_ROOT`
 * is taken from `.env` ONLY when it is ambiently UNSET. An ambient empty string
 * (`DYFJ_ROOT=""`) is left as-is and treated as absent by `configFilePath`,
 * exactly as the child sees it (its `--env-file` cannot override the empty
 * value). Reading `.env` on `""` too would make the launcher and child pick
 * different configs and mis-grant `--allow-run`.
 */
export async function readLauncherSecretsConfig(
  cwd: string,
  readTextFile: (path: string) => Promise<string> = Deno.readTextFile,
  env: { get(name: string): string | undefined } = Deno.env,
  parseToml?: (raw: string) =>
    | Record<string, unknown>
    | Promise<
      Record<string, unknown>
    >,
): Promise<Awaited<ReturnType<typeof loadSecretsConfig>>> {
  let root = env.get("DYFJ_ROOT");
  if (root === undefined) {
    try {
      root = envFileVar(await readTextFile(`${cwd}/.env`), "DYFJ_ROOT");
    } catch {
      root = undefined;
    }
  }
  const home = env.get("HOME");
  const configEnv = {
    get: (name: string): string | undefined =>
      name === "DYFJ_ROOT" ? root : name === "HOME" ? home : undefined,
  };
  return loadSecretsConfig({ env: configEnv, readTextFile, parseToml });
}

export async function readLauncherMcpServersConfig(
  cwd: string,
  secrets: SecretsConfig | null,
  readTextFile: (path: string) => Promise<string> = Deno.readTextFile,
  env: { get(name: string): string | undefined } = Deno.env,
  parseToml?: (raw: string) =>
    | Record<string, unknown>
    | Promise<Record<string, unknown>>,
): Promise<McpHttpServerConfig[]> {
  let root = env.get("DYFJ_ROOT");
  if (root === undefined) {
    try {
      root = envFileVar(await readTextFile(`${cwd}/.env`), "DYFJ_ROOT");
    } catch {
      root = undefined;
    }
  }
  const home = env.get("HOME");
  const configEnv = {
    get: (name: string): string | undefined =>
      name === "DYFJ_ROOT" ? root : name === "HOME" ? home : undefined,
  };
  return loadMcpServersConfig(
    { env: configEnv, readTextFile, parseToml },
    secrets,
  );
}

/** Read the serve-unix profile's declared net grants from deno.json. */
export async function readServeUnixNetGrants(cwd: string): Promise<string[]> {
  const raw = await Deno.readTextFile(`${cwd}/deno.json`);
  const parsed = JSON.parse(raw) as {
    permissions?: { "serve-unix"?: { net?: unknown } };
  };
  const net = parsed.permissions?.["serve-unix"]?.net;
  if (!Array.isArray(net) || !net.every((n) => typeof n === "string")) {
    throw new Error(
      `serve-unix permission profile in ${cwd}/deno.json has no net grant list`,
    );
  }
  return net;
}

export async function startLocalRuntime(
  config: CliConfig,
  options: StartRuntimeOptions = {},
): Promise<number> {
  const command = options.command ?? "deno";
  const cwd = options.cwd ?? defaultPrototypeRoot();
  const autostarted = options.autostarted === true;
  const netGrants = await readServeUnixNetGrants(cwd);
  const memoryMcpGrant = await readMemoryMcpNetGrant(cwd);
  // Node and any operator-private resolver binary are launch-resolved. The
  // fixed /bin/kill grant supports the ACP process-group contract.
  const secretsCfg = await readLauncherSecretsConfig(cwd);
  const externalMcpGrants = mcpServerNetGrants(
    await readLauncherMcpServersConfig(cwd, secretsCfg),
  );
  const resolverBin = secretsRunGrant(secretsCfg);
  const profileRun = await readServeUnixRunGrants(cwd);
  const nodeGrant = await nodeRunGrant();
  await toolchainReadGrant();
  await rustupHomeReadGrant();
  const dynamicRunGrants = [nodeGrant, "/bin/kill", resolverBin]
    .filter((grant): grant is string => grant !== null);
  const runGrants = [...profileRun];
  for (const grant of dynamicRunGrants) {
    if (!runGrants.includes(grant)) runGrants.push(grant);
  }
  // The resolver spawns with a cleared env and forwards only a minimal base plus
  // [secrets].inherit_env. The runtime must be able to READ those inherit_env
  // vars to forward them, so grant --allow-env for names not already in the
  // profile (launch-resolved: an operator-private var like a service-account
  // token never enters the committed profile). No inherit_env → null → -P's env.
  let envGrants: string[] | null = null;
  const inheritEnv = secretsCfg?.inheritEnv ?? [];
  if (inheritEnv.length > 0) {
    const profileEnv = await readServeUnixEnvGrants(cwd);
    const extra = inheritEnv.filter((name) => !profileEnv.includes(name));
    envGrants = extra.length > 0 ? [...profileEnv, ...extra] : null;
  }
  // Autostarted supervisor and server share the client's terminal process
  // group. Both must survive the SIGINT that the client converts into cancel.
  const ignoreSigint = () => {};
  if (autostarted) denoTurnInterruptSource.add(ignoreSigint);
  try {
    const child = new Deno.Command(command, {
      args: buildServeUnixArgs(
        netGrants,
        config.socket,
        memoryMcpGrant,
        runGrants,
        envGrants,
        autostarted,
        externalMcpGrants,
      ),
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const status = await child.status;
    return status.code;
  } finally {
    if (autostarted) denoTurnInterruptSource.remove(ignoreSigint);
  }
}

export async function runStart(
  config: CliConfig,
  io: Io,
  startRuntime: StartRuntimeFn = startLocalRuntime,
  autostarted = false,
): Promise<number> {
  io.err(`dyfj: starting local runtime at ${config.socket}`);
  io.err(
    autostarted
      ? `dyfj: autostarted process; after its signal handler is ready, client Ctrl-C leaves the runtime running`
      : `dyfj: foreground process; Ctrl-C signals runtime shutdown; the shell may return before cleanup settles`,
  );
  try {
    return await startRuntime(config, { autostarted });
  } catch (error) {
    io.err(`dyfj: could not start local runtime: ${summarizeError(error)}`);
    io.err(`dyfj: fallback command: cd prototype && deno task serve-unix`);
    return 1;
  }
}

// ── Argument + config parsing ────────────────────────────────────────────────

interface ParsedArgs {
  command:
    | "exec"
    | "repl"
    | "help"
    | "models"
    | "sessions"
    | "status"
    | "start"
    | "stop";
  prompt?: string;
  json: boolean;
  overrides: Partial<CliConfig>;
  launcherAutostarted?: true;
  error?: string;
}

const VALUE_FLAGS = new Set([
  "--server",
  "--socket",
  "--key",
  "--mode",
  "--model",
  "--tier",
  "--hint",
  "--session",
  "--workspace",
  "--runner",
  "-p",
  "--print",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const overrides: Partial<CliConfig> = {};
  const positional: string[] = [];
  let json = false;
  let printPrompt: string | undefined;
  let help = false;
  let launcherAutostarted = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--launcher-autostarted") {
      launcherAutostarted = true;
    } else if (arg === "--unix") {
      overrides.unix = true;
    } else if (arg === "--approve-paid") {
      overrides.approvePaid = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) return error(`missing value for ${arg}`);
      if (arg === "--server") overrides.serverUrl = value;
      else if (arg === "--socket") overrides.socket = value;
      else if (arg === "--key") overrides.key = value;
      else if (arg === "--model") overrides.model = value;
      else if (arg === "--runner") {
        if (value !== "fixture" && value !== "codex-chatgpt") {
          return error("--runner must be fixture or codex-chatgpt");
        }
        overrides.runner = value;
      } else if (arg === "--session") {
        // normalizeSessionRef throws on garbage; route it through the standard
        // usage-error path (exit 2) instead of an uncaught stack trace.
        try {
          overrides.sessionId = normalizeSessionRef(value);
        } catch (thrown) {
          return error(
            thrown instanceof Error ? thrown.message : String(thrown),
          );
        }
      } else if (arg === "--workspace") overrides.workspace = value;
      else if (arg === "-p" || arg === "--print") printPrompt = value;
      else if (arg === "--mode") {
        if (value !== "turn" && value !== "ask" && value !== "next-work") {
          return error("--mode must be turn, ask, or next-work");
        }
        overrides.mode = value;
      } else if (arg === "--tier") {
        const tier = Number(value);
        if (tier !== 0 && tier !== 1 && tier !== 2) {
          return error("--tier must be 0, 1, or 2");
        }
        overrides.tier = tier;
      } else if (arg === "--hint") {
        if (value !== "code" && value !== "chat" && value !== "reasoning") {
          return error("--hint must be code, chat, or reasoning");
        }
        overrides.hint = value;
      }
    } else if (arg.startsWith("-") && arg !== "-") {
      return error(`unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (
    launcherAutostarted &&
    !(
      !help && printPrompt === undefined && positional[0] === "start" &&
      positional.length === 1
    )
  ) {
    return error("--launcher-autostarted is valid only with start");
  }

  if (help) return { command: "help", json, overrides };
  if (
    overrides.runner !== undefined &&
    (overrides.model !== undefined || overrides.tier !== undefined ||
      overrides.hint !== undefined)
  ) {
    return error("--runner cannot be combined with --model, --tier, or --hint");
  }
  if (
    overrides.runner === "codex-chatgpt" &&
    overrides.sessionId !== undefined
  ) {
    return error("codex-chatgpt does not support --session");
  }

  if (printPrompt !== undefined) {
    return { command: "exec", prompt: printPrompt, json, overrides };
  }
  if (
    overrides.runner === "codex-chatgpt" &&
    positional[0] !== "exec" && positional[0] !== "ask"
  ) {
    return error("codex-chatgpt supports one-shot turns only");
  }
  if (positional[0] === "models" && positional.length === 1) {
    return { command: "models", json, overrides };
  }
  if (positional[0] === "sessions" && positional.length === 1) {
    return { command: "sessions", json, overrides };
  }
  if (positional[0] === "status" && positional.length === 1) {
    return { command: "status", json, overrides };
  }
  if (positional[0] === "start" && positional.length === 1) {
    return {
      command: "start",
      json,
      overrides,
      ...(launcherAutostarted ? { launcherAutostarted: true as const } : {}),
    };
  }
  if (positional[0] === "stop" && positional.length === 1) {
    return { command: "stop", json, overrides };
  }
  if (positional[0] === "exec") {
    const prompt = positional.slice(1).join(" ").trim();
    if (prompt.length === 0) {
      return {
        command: "exec",
        json,
        overrides,
        error: "exec requires a prompt",
      };
    }
    return { command: "exec", prompt, json, overrides };
  }
  // `dyfj ask "<prompt>"` — sugar for a one-shot repo-context (ask-mode) turn.
  if (positional[0] === "ask") {
    const prompt = positional.slice(1).join(" ").trim();
    if (prompt.length === 0) {
      return {
        command: "exec",
        json,
        overrides,
        error: "ask requires a prompt",
      };
    }
    return {
      command: "exec",
      prompt,
      json,
      overrides: { ...overrides, mode: "ask" },
    };
  }
  if (positional.length > 0) {
    return error(`unknown command: ${positional[0]}`);
  }
  return { command: "repl", json, overrides };

  function error(message: string): ParsedArgs {
    return { command: "help", json, overrides, error: message };
  }
}

export function resolveConfig(
  overrides: Partial<CliConfig>,
  env: { get(key: string): string | undefined },
  isTty = false,
  cwd = ".",
): CliConfig {
  const tierEnv = env.get("DYFJ_WORKBENCH_TIER");
  const tier = tierEnv === "0" || tierEnv === "1" || tierEnv === "2"
    ? (Number(tierEnv) as 0 | 1 | 2)
    : undefined;
  const hintEnv = env.get("DYFJ_WORKBENCH_HINT");
  const hint =
    hintEnv === "code" || hintEnv === "chat" || hintEnv === "reasoning"
      ? hintEnv
      : undefined;
  const explicitWorkspace = overrides.workspace ?? env.get("DYFJ_WORKSPACE");
  // Local-first default: talk to the UDS loopback seam (where serve-unix listens)
  // unless the operator explicitly points at an HTTP server. So `dyfj exec "…"`
  // just works against the local runtime; `--server <url>` opts into HTTP/remote.
  const explicitServer = overrides.serverUrl ?? env.get("DYFJ_SERVER_URL");
  return {
    serverUrl: explicitServer ?? DEFAULT_SERVER,
    key: overrides.key ?? env.get("DYFJ_WORKBENCH_API_KEY"),
    mode: overrides.mode ?? "turn",
    model: overrides.model ?? env.get("DYFJ_WORKBENCH_MODEL"),
    tier: overrides.tier ?? tier,
    hint: overrides.hint ?? hint,
    runner: overrides.runner,
    sessionId: overrides.sessionId,
    // Workspace follows the directory `dyfj` runs in; --workspace or
    // DYFJ_WORKSPACE override it. The implicit cwd is sent only to a loopback
    // server (buildTurnBody); an explicit value is honored anywhere.
    workspace: explicitWorkspace ?? cwd,
    workspaceExplicit: explicitWorkspace !== undefined,
    socket: overrides.socket ?? resolveSocketPath(env),
    // Default to the UDS seam locally; an explicit --server / DYFJ_SERVER_URL
    // routes over HTTP instead. --unix (or DYFJ_UNIX=1) always forces the seam.
    unix: overrides.unix ??
      (env.get("DYFJ_UNIX") === "1" || explicitServer === undefined),
    approvePaid: overrides.approvePaid ?? false,
    color: !env.get("NO_COLOR") && isTty,
  };
}

const HELP = `dyfj — Workbench daily-driver client

Talks to the local runtime over the UDS seam by default; a bare invocation
starts the runtime itself if none is answering (see Launcher lifecycle
below), and \`dyfj start\` still runs one in the foreground by hand. Permission posture (strict | operator) is engine config in
~/.dyfj/config.toml, not a flag here. Use --server <url> to reach a remote HTTP
runtime instead.

Usage:
  dyfj                      interactive REPL (multi-turn, streaming)
  dyfj exec "<prompt>"      one-shot turn
  dyfj ask "<prompt>"       one-shot repo-context question (ask mode)
  dyfj -p "<prompt>"        one-shot turn (alias)
  dyfj status               check the local runtime and socket
  dyfj start                foreground the local runtime (Ctrl-C to stop)
  dyfj stop                 stop the running local runtime at the socket
  dyfj models               list available model slugs
  dyfj sessions             list sessions

Launcher lifecycle (the dyfj wrapper script, local UDS seam only):
  a REPL or one-shot turn probes the socket first and, when no runtime
  answers, starts one detached (output to ~/.dyfj/log/) and waits for it.
  'start', 'status', 'stop', and help (when invoked without a prompt) never
  trigger autostart. Opt out per call with --no-autostart, or standing with
  DYFJ_AUTOSTART=0.

REPL commands:
  /model [<slug>]           show or switch the active model (validated slugs);
                            add --approve-paid to opt this session into paid
                            (hosted) inference when escalating
  /session                  show the current session id (for --session resume)
  /exit, /quit              exit the REPL

Options:
  --mode <m>       context mode: turn (companion+memory, default) | ask | next-work (repo)
  --server <url>   reach a remote HTTP runtime instead of the local UDS seam (env DYFJ_SERVER_URL)
  --socket <path>  local UDS socket path (env DYFJ_SOCKET)
  --unix           force the UDS seam (the local default; needed only to override --server)
  --key <key>      bearer key for remote servers (env DYFJ_WORKBENCH_API_KEY)
  --model <slug>   model id      --tier <0|1|2>   --hint <code|chat|reasoning>
  --runner <name>  local ACP runner: fixture | codex-chatgpt (experimental;
                   codex-chatgpt is one-shot and requires trusted workspace config)
  --session <ref>  resume a session (accepts the id or the slug from 'dyfj sessions')
  --workspace <d>  dir to scope file tools to (default: cwd, env DYFJ_WORKSPACE)
  --approve-paid   opt into paid (hosted) inference (loopback only; persists in REPL)
  --no-autostart   launcher only: do not auto-start a runtime for this call (env DYFJ_AUTOSTART=0)
  --parse-check    launcher-internal, first argument only: validate the rest and exit 0/2
  --json           one-shot only: print the full result as JSON
  -h, --help       show this help`;

// ── Entry point ──────────────────────────────────────────────────────────────

interface QuestionReadline {
  question(prompt: string, options?: { signal?: AbortSignal }): Promise<string>;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

interface SigintReadline {
  on(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
}

export function readlineTurnInterruptSource(
  rl: SigintReadline,
): TurnInterruptSource {
  return {
    add: (handler) => {
      rl.on("SIGINT", handler);
    },
    remove: (handler) => {
      rl.off("SIGINT", handler);
    },
  };
}

export function selectTurnInterruptSource(
  inputIsTerminal: boolean,
  outputIsTerminal: boolean,
  readlineSource: TurnInterruptSource,
  signalSource: TurnInterruptSource,
): TurnInterruptSource | undefined {
  if (!inputIsTerminal) return undefined;
  return outputIsTerminal ? readlineSource : signalSource;
}

/**
 * Read one line, resolving null on EOF. On Ctrl-D readline emits "close" but the
 * pending `question` promise never settles, so race it against "close" —
 * otherwise the REPL's await hangs and Deno reports a never-resolved top-level
 * await instead of exiting cleanly.
 */
export function readLineOrNull(
  rl: QuestionReadline,
  prompt: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const onClose = () => resolve(null);
    rl.once("close", onClose);
    rl.question(prompt, signal === undefined ? undefined : { signal }).then(
      (answer) => {
        rl.off("close", onClose);
        resolve(answer);
      },
      () => {
        rl.off("close", onClose);
        resolve(null);
      },
    );
  });
}

function realIo(): Io {
  const encoder = new TextEncoder();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const inputIsTerminal = Deno.stdin.isTerminal();
  const outputIsTerminal = Deno.stdout.isTerminal();
  return {
    out: (text) => {
      Deno.stdout.writeSync(encoder.encode(text));
    },
    err: (line) => console.error(line),
    errRaw: (text) => {
      Deno.stderr.writeSync(encoder.encode(text));
    },
    errIsTerminal: Deno.stderr.isTerminal(),
    readLine: (prompt, signal) => readLineOrNull(rl, prompt, signal),
    turnInterrupts: selectTurnInterruptSource(
      inputIsTerminal,
      outputIsTerminal,
      readlineTurnInterruptSource(rl),
      denoTurnInterruptSource,
    ),
    close: () => rl.close(),
  };
}

export async function main(argv: string[], io: Io): Promise<number> {
  // Launcher-internal: `--parse-check <args…>` validates the remaining
  // arguments against this client's own parser and exits 0 (valid) or 2
  // (rejected), silently, touching nothing else. It exists so the launcher's
  // autostart decision can share THIS parser as its single validity contract
  // instead of mirroring it in shell — an invocation this parser would reject
  // must not spawn a runtime on its way to the usage error.
  if (argv[0] === "--parse-check") {
    try {
      return parseArgs(argv.slice(1)).error ? 2 : 0;
    } catch {
      // parseArgs can throw on some invalid values (session refs) rather than
      // returning a parse error; parse-check's contract is 0/2 regardless of
      // which shape the rejection takes.
      return 2;
    }
  }
  const parsed = parseArgs(argv);
  if (parsed.error) io.err(`dyfj: ${parsed.error}`);
  if (parsed.command === "help") {
    io.err(HELP);
    return parsed.error ? 2 : 0;
  }
  const config = resolveConfig(
    parsed.overrides,
    Deno.env,
    Deno.stdout.isTerminal(),
    Deno.cwd(),
  );
  const interactive = Deno.stdin.isTerminal();
  if (parsed.command === "exec") {
    return await runExec(
      parsed.prompt!,
      config,
      io,
      parsed.json,
      fetch,
      connectUnixClient,
      interactive,
    );
  }
  if (parsed.command === "models") {
    return await runModels(config, io);
  }
  if (parsed.command === "sessions") {
    return await runSessions(config, io);
  }
  if (parsed.command === "status") {
    return await runStatus(config, io);
  }
  if (parsed.command === "stop") {
    return await runStop(config, io);
  }
  if (parsed.command === "start") {
    return await runStart(
      config,
      io,
      startLocalRuntime,
      parsed.launcherAutostarted === true,
    );
  }
  return await runRepl(config, io, fetch, connectUnixClient, interactive);
}

if (import.meta.main) {
  const io = realIo();
  const code = await main(Deno.args, io);
  io.close();
  Deno.exit(code);
}
