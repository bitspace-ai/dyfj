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
  isSupersedingRetryStarted,
  type TurnReceipt,
  type TurnStreamFrame,
} from "./turn-contract";
import {
  connectUnixClient,
  type ToolApprovalVerdict,
  type UnixClientOptions,
} from "./uds-client";
import { resolveSocketPath } from "./uds-path";
import { assertSecureMemoryUrl } from "./memory-search";
import { loadSecretsConfig } from "./config";
import { secretsRunGrant } from "./secrets";
import { createStreamingMarkdownRenderer } from "./streaming-markdown";

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
  mode?: "turn" | "ask" | "next-work";
  routingOptions?: {
    modelId?: string;
    tier?: 0 | 1 | 2;
    hint?: "code" | "chat" | "reasoning";
  };
  sessionId?: string;
  /** Working directory to scope the server's read-only file tools to. */
  workspace?: string;
  /**
   * Per-turn opt-in to paid (hosted) inference. The engine honors it only on the
   * loopback transport AND only when set — a remote caller can never approve spend.
   */
  approvePaidInference?: boolean;
}

export interface CliConfig {
  serverUrl: string;
  key?: string;
  /** Context mode: "turn" = companion + memory; "ask"/"next-work" = repo context. */
  mode: "turn" | "ask" | "next-work";
  model?: string;
  tier?: 0 | 1 | 2;
  hint?: "code" | "chat" | "reasoning";
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
  /** Prompt and read one line; null on EOF. */
  readLine(prompt: string): Promise<string | null>;
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
  if (config.model !== undefined) routingOptions.modelId = config.model;
  if (config.tier !== undefined) routingOptions.tier = config.tier;
  if (config.hint !== undefined) routingOptions.hint = config.hint;

  const body: TurnRequest = { prompt, mode: config.mode };
  if (Object.keys(routingOptions).length > 0) {
    body.routingOptions = routingOptions;
  }
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
    throw new Error(await readErrorMessage(response));
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

  if (streamError !== undefined) throw new Error(streamError);
  if (result === undefined) throw new Error("stream ended without a result");
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
  if (!response.ok) throw new Error(await readErrorMessage(response));
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
  const line = formatRuntimeEvent(event as Record<string, unknown>);
  if (line !== null) io.err(line);
}

export function formatReceipt(result: TurnResult, color: boolean): string {
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const cost = result.cost.totalUsd > 0
    ? `$${result.cost.totalUsd.toFixed(4)}`
    : "$0";
  const tokens = `${result.tokens.input}→${result.tokens.output} tok`;
  return dim(
    `— ${result.model.displayName} · ${cost} · ${tokens} · ${result.route.reason}`,
  );
}

export function friendlyError(error: unknown, config: CliConfig): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /connection refused|error sending request|tcp connect|econnrefused|failed to fetch|client error/i
      .test(message)
  ) {
    return `dyfj: runtime not reachable at ${config.serverUrl}. ` +
      `Start it with: deno task workbench-http`;
  }
  return `dyfj: ${message}`;
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
): Promise<number> {
  const body = buildTurnBody(prompt, config, config.sessionId);
  const onApproval = (request: unknown) =>
    promptMidTurnApproval(io, request, interactive);
  try {
    if (json) {
      const result = config.unix
        ? await socketTurn(config, body, { onApproval }, connect)
        : await bufferedTurn(config, body, fetchFn);
      io.out(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const output = createTurnOutputHandlers(config, io);
      const handlers = {
        onDelta: output.onDelta,
        onEvent: (event: Record<string, unknown>) =>
          handleTurnRuntimeEvent(event, output, io),
        onApproval,
      };
      const result = config.unix
        ? await socketTurn(config, body, handlers, connect)
        : await streamTurn(config, body, handlers, fetchFn);
      // Some turns don't stream deltas (e.g. a first model call with tools);
      // the text still arrives with the receipt — render it so output is never empty.
      if (!output.streamed() && result.text.length > 0) {
        output.emitBufferedText(result.text);
      } else {
        output.finish();
      }
      io.err(formatReceipt(result, config.color));
    }
    return 0;
  } catch (error) {
    io.err(
      config.unix ? socketError(error, config) : friendlyError(error, config),
    );
    return 1;
  }
}

export async function runRepl(
  config: CliConfig,
  io: Io,
  fetchFn: typeof fetch = fetch,
  connect: ConnectFn = connectUnixClient,
  interactive = true,
): Promise<void> {
  io.err(
    `dyfj — ${
      config.unix ? config.socket : config.serverUrl
    } · Ctrl-D or /exit to quit`,
  );
  let sessionId = config.sessionId;
  const onApproval = (request: unknown) =>
    promptMidTurnApproval(io, request, interactive);
  try {
    for (;;) {
      const line = await io.readLine("\ndyfj> ");
      if (line === null) break;
      const prompt = line.trim();
      if (prompt.length === 0) continue;
      if (prompt === "/exit" || prompt === "/quit") break;
      if (prompt === "/session") {
        if (sessionId === undefined) {
          io.err("no session yet — send a prompt first");
        } else {
          io.err(`session: ${sessionId}`);
          io.err(`resume later with: dyfj --session ${sessionId}`);
        }
        continue;
      }
      if (await handleReplModelCommand(prompt, config, io, connect)) continue;
      try {
        const output = createTurnOutputHandlers(config, io);
        const handlers = {
          onDelta: output.onDelta,
          onEvent: (event: Record<string, unknown>) =>
            handleTurnRuntimeEvent(event, output, io),
          onApproval,
        };
        const body = buildTurnBody(prompt, config, sessionId);
        const result = config.unix
          ? await socketTurn(config, body, handlers, connect)
          : await streamTurn(config, body, handlers, fetchFn);
        if (!output.streamed() && result.text.length > 0) {
          output.emitBufferedText(result.text);
        } else {
          output.finish();
        }
        io.err(formatReceipt(result, config.color));
        sessionId = result.sessionId;
      } catch (error) {
        io.err(
          config.unix
            ? socketError(error, config)
            : friendlyError(error, config),
        );
      }
    }
  } finally {
    io.close();
  }
}

// ── UDS read commands (models/sessions over the JSON-RPC seam) ───────────────

interface ModelRow {
  slug?: string;
  displayName?: string;
  provider?: string;
  tier?: number;
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
    permissionLevel?: string;
    approvePaidDefault?: boolean;
    defaultSessionBudgetUsd?: number;
    defaultPerCallBudgetUsd?: number;
    defaultDailyBudgetUsd?: number;
    models?: { total?: number; local?: number; hosted?: number };
    methods?: string[];
  };
}

export interface StartRuntimeOptions {
  command?: string;
  cwd?: string;
}

export type ConnectFn = typeof connectUnixClient;
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
  } = {},
  connect: ConnectFn = connectUnixClient,
): Promise<TurnResult> {
  const clientOptions: UnixClientOptions = {};
  if (handlers.onDelta !== undefined || handlers.onEvent !== undefined) {
    clientOptions.onStream = (params) => {
      const frame = params as TurnStreamFrame;
      if (frame.t === "delta") handlers.onDelta?.(frame.text);
      else if (frame.t === "event") handlers.onEvent?.(frame.event);
    };
  }
  if (handlers.onApproval) clientOptions.onApproval = handlers.onApproval;
  const client = await connect(config.socket, clientOptions);
  try {
    return await client.request("turn", body) as TurnResult;
  } finally {
    client.close();
  }
}

/**
 * Prompt the operator to approve a mid-turn request over the UDS seam: mutating
 * tools or a budget-ceiling overrun. Non-interactive (no TTY) denies without
 * prompting, fail-closed. The prompt goes to stderr so a `--json` turn's stdout
 * stays clean.
 */
export async function promptMidTurnApproval(
  io: Io,
  request: unknown,
  interactive: boolean,
): Promise<ToolApprovalVerdict> {
  if (!interactive) {
    return {
      decision: "deny",
      reason: "approval needs an interactive terminal",
    };
  }
  const r = (typeof request === "object" && request !== null)
    ? request as Record<string, unknown>
    : {};
  if (r.kind === "budget_ceiling") {
    const message = typeof r.message === "string"
      ? r.message
      : "Projected spend crosses the configured budget ceiling.";
    io.err(`\n⚠  ${message}`);
    const answer = await io.readLine("   exceed budget ceiling? [y/N] ");
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
    );
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
  const answer = await io.readLine("   approve? [y/N] ");
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
  if (event.type === "toolStepStarted") {
    const step = typeof event.step === "number" ? event.step : "?";
    const count = typeof event.toolCallCount === "number"
      ? event.toolCallCount
      : "?";
    return `tool: step ${step} running ${count} call(s)`;
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

function socketError(error: unknown, config: CliConfig): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /no such file|not found|connection refused|enoent|os error 2|os error 61/i
      .test(message)
  ) {
    return `dyfj: runtime not reachable at ${config.socket}. ` +
      `Start it with: dyfj start`;
  }
  return `dyfj: ${message}`;
}

export async function fetchModelSlugs(
  config: CliConfig,
  connect: ConnectFn = connectUnixClient,
): Promise<{ slugs: string[]; models: ModelRow[] } | { error: string }> {
  try {
    const client = await connect(config.socket);
    try {
      const { models } = await client.request("models/list") as {
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

export async function handleReplModelCommand(
  line: string,
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
): Promise<boolean> {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== "/model") return false;

  const listed = await fetchModelSlugs(config, connect);
  if ("error" in listed) {
    io.err(listed.error);
    return true;
  }

  if (parts.length === 1) {
    const active = config.model ?? "(registry default)";
    io.err(`active model: ${active}`);
    io.err(`available: ${listed.slugs.join(", ") || "(none)"}`);
    return true;
  }

  const slug = parts[1];
  if (!listed.slugs.includes(slug)) {
    io.err(
      `dyfj: unknown model "${slug}". Available: ${
        listed.slugs.join(", ") || "(none)"
      }`,
    );
    return true;
  }

  config.model = slug;
  io.err(`model: ${slug}`);
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
        `${(m.provider ?? "").padEnd(10)} ${m.displayName ?? ""}${unroutable}\n`,
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
      `dyfj: --session expects a session id or a slug as listed by 'dyfj sessions', got: ${value}`,
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
  return [
    `runtime: reachable`,
    `socket: ${config.socket}`,
    `transport: ${runtime.transport ?? "unknown"} / ${
      runtime.clearance ?? "unknown"
    }`,
    `default model: ${runtime.defaultCompanionModel ?? "(registry default)"}`,
    `models: ${models.total ?? 0} total · ${models.local ?? 0} local · ${
      models.hosted ?? 0
    } hosted`,
    `permission: ${runtime.permissionLevel ?? "unknown"}`,
    `approve paid default: ${
      runtime.approvePaidDefault === true ? "yes" : "no"
    }`,
    `budget: $${(runtime.defaultSessionBudgetUsd ?? 0).toFixed(2)} session · $${
      (runtime.defaultDailyBudgetUsd ?? 0).toFixed(2)
    } day · $${(runtime.defaultPerCallBudgetUsd ?? 0).toFixed(2)} per call`,
    `methods: ${methods.length}`,
  ].join("\n");
}

export async function runStatus(
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
): Promise<number> {
  try {
    const client = await connect(config.socket);
    try {
      const payload = await client.request(
        "runtime/status",
      ) as RuntimeStatusPayload;
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
): string[] {
  const socketGrant = `unix:${socketPath}`;
  let net = netGrants.includes(socketGrant)
    ? netGrants
    : [...netGrants, socketGrant];
  if (memoryMcpGrant != null && !net.includes(memoryMcpGrant)) {
    net = [...net, memoryMcpGrant];
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
    // must already carry the profile's own grants plus the resolver binary.
    // Omitted (null) when no [secrets] resolver is configured, so -P supplies
    // the profile's run grants unchanged — a plain local-only start is untouched.
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
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
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
  parseToml?: (raw: string) => Record<string, unknown> | Promise<
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
  const netGrants = await readServeUnixNetGrants(cwd);
  const memoryMcpGrant = await readMemoryMcpNetGrant(cwd);
  // When a [secrets] resolver is configured, the child runtime must be granted
  // --allow-run for the resolver binary (operator-private, so never committed
  // to the serve-unix profile — same launch-resolved posture as the socket and
  // memory-host net grants). No resolver → null → -P supplies the run grants.
  const secretsCfg = await readLauncherSecretsConfig(cwd);
  const resolverBin = secretsRunGrant(secretsCfg);
  let runGrants: string[] | null = null;
  if (resolverBin !== null) {
    const profileRun = await readServeUnixRunGrants(cwd);
    runGrants = profileRun.includes(resolverBin)
      ? profileRun
      : [...profileRun, resolverBin];
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
  const child = new Deno.Command(command, {
    args: buildServeUnixArgs(
      netGrants,
      config.socket,
      memoryMcpGrant,
      runGrants,
      envGrants,
    ),
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  return status.code;
}

export async function runStart(
  config: CliConfig,
  io: Io,
  startRuntime: StartRuntimeFn = startLocalRuntime,
): Promise<number> {
  io.err(`dyfj: starting local runtime at ${config.socket}`);
  io.err(`dyfj: foreground process; Ctrl-C stops the runtime`);
  try {
    return await startRuntime(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`dyfj: could not start local runtime: ${message}`);
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
    | "start";
  prompt?: string;
  json: boolean;
  overrides: Partial<CliConfig>;
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
  "-p",
  "--print",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const overrides: Partial<CliConfig> = {};
  const positional: string[] = [];
  let json = false;
  let printPrompt: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
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
      else if (arg === "--session") {
        overrides.sessionId = normalizeSessionRef(value);
      }
      else if (arg === "--workspace") overrides.workspace = value;
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

  if (help) return { command: "help", json, overrides };

  if (printPrompt !== undefined) {
    return { command: "exec", prompt: printPrompt, json, overrides };
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
    return { command: "start", json, overrides };
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

Talks to the local runtime (start it with: dyfj start) over the UDS
seam by default. Permission posture (strict | operator) is engine config in
~/.dyfj/config.toml, not a flag here. Use --server <url> to reach a remote HTTP
runtime instead.

Usage:
  dyfj                      interactive REPL (multi-turn, streaming)
  dyfj exec "<prompt>"      one-shot turn
  dyfj ask "<prompt>"       one-shot repo-context question (ask mode)
  dyfj -p "<prompt>"        one-shot turn (alias)
  dyfj status               check the local runtime and socket
  dyfj start                foreground the local runtime (Ctrl-C to stop)
  dyfj models               list available model slugs
  dyfj sessions             list sessions

REPL commands:
  /model [<slug>]           show or switch the active model (validated slugs)
  /session                  show the current session id (for --session resume)
  /exit, /quit              exit the REPL

Options:
  --mode <m>       context mode: turn (companion+memory, default) | ask | next-work (repo)
  --server <url>   reach a remote HTTP runtime instead of the local UDS seam (env DYFJ_SERVER_URL)
  --socket <path>  local UDS socket path (env DYFJ_SOCKET)
  --unix           force the UDS seam (the local default; needed only to override --server)
  --key <key>      bearer key for remote servers (env DYFJ_WORKBENCH_API_KEY)
  --model <slug>   model id      --tier <0|1|2>   --hint <code|chat|reasoning>
  --session <ref>  resume a session (accepts the id or the slug from 'dyfj sessions')
  --workspace <d>  dir to scope file tools to (default: cwd, env DYFJ_WORKSPACE)
  --approve-paid   opt into paid (hosted) inference (loopback only; persists in REPL)
  --json           one-shot only: print the full result as JSON
  -h, --help       show this help`;

// ── Entry point ──────────────────────────────────────────────────────────────

interface QuestionReadline {
  question(prompt: string): Promise<string>;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
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
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const onClose = () => resolve(null);
    rl.once("close", onClose);
    rl.question(prompt).then(
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
  return {
    out: (text) => {
      Deno.stdout.writeSync(encoder.encode(text));
    },
    err: (line) => console.error(line),
    readLine: (prompt) => readLineOrNull(rl, prompt),
    close: () => rl.close(),
  };
}

export async function main(argv: string[], io: Io): Promise<number> {
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
  if (parsed.command === "start") {
    return await runStart(config, io);
  }
  await runRepl(config, io, fetch, connectUnixClient, interactive);
  return 0;
}

if (import.meta.main) {
  const io = realIo();
  const code = await main(Deno.args, io);
  io.close();
  Deno.exit(code);
}
