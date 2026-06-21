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
 * Assumes the runtime server is running (default http://127.0.0.1:8787).
 */

import { createInterface } from "node:readline/promises";
import process from "node:process";
import type { TurnReceipt, TurnStreamFrame } from "./turn-contract";
import { connectUnixClient } from "./uds-client";
import { resolveSocketPath } from "./uds-path";

// ── Seam contract (shared with the server; BIT-136) ──────────────────────────
// The receipt and SSE frame shapes are defined once in turn-contract.ts and
// imported by both sides, so this thin client can never silently drift from
// what the server sends. `import type` is erased at compile, keeping the binary
// engine-free.

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
  /** Unix socket path for the JSON-RPC read commands (models/sessions). */
  socket: string;
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

function buildHeaders(config: CliConfig, stream: boolean): Record<string, string> {
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
  if (Object.keys(routingOptions).length > 0) body.routingOptions = routingOptions;
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
    config.workspace !== undefined && sessionId === undefined && maySendWorkspace
  ) {
    body.workspace = config.workspace;
  }
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
): Promise<number> {
  const body = buildTurnBody(prompt, config, config.sessionId);
  try {
    if (json) {
      const result = await bufferedTurn(config, body, fetchFn);
      io.out(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      let streamed = false;
      const result = await streamTurn(
        config,
        body,
        { onDelta: (text) => { streamed = true; io.out(text); } },
        fetchFn,
      );
      // Some turns don't stream deltas (e.g. a first model call with tools);
      // the text still arrives on the done frame — render it so output is never empty.
      if (!streamed && result.text.length > 0) io.out(result.text);
      io.out("\n");
      io.err(formatReceipt(result, config.color));
    }
    return 0;
  } catch (error) {
    io.err(friendlyError(error, config));
    return 1;
  }
}

export async function runRepl(
  config: CliConfig,
  io: Io,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  io.err(`dyfj — ${config.serverUrl} · Ctrl-D or /exit to quit`);
  let sessionId = config.sessionId;
  try {
    for (;;) {
      const line = await io.readLine("\ndyfj> ");
      if (line === null) break;
      const prompt = line.trim();
      if (prompt.length === 0) continue;
      if (prompt === "/exit" || prompt === "/quit") break;
      try {
        let streamed = false;
        const result = await streamTurn(
          config,
          buildTurnBody(prompt, config, sessionId),
          { onDelta: (text) => { streamed = true; io.out(text); } },
          fetchFn,
        );
        if (!streamed && result.text.length > 0) io.out(result.text);
        io.out("\n");
        io.err(formatReceipt(result, config.color));
        sessionId = result.sessionId;
      } catch (error) {
        io.err(friendlyError(error, config));
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
}
interface ProjectGroup {
  project: string | null;
  sessions: SessionRow[];
}

export type ConnectFn = typeof connectUnixClient;

function socketError(error: unknown, config: CliConfig): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /no such file|not found|connection refused|enoent|os error 2|os error 61/i
      .test(message)
  ) {
    return `dyfj: runtime not reachable at ${config.socket}. ` +
      `Start it with: deno task serve-unix`;
  }
  return `dyfj: ${message}`;
}

export async function runModels(
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
): Promise<number> {
  try {
    const client = await connect(config.socket);
    try {
      const { models } = await client.request("models/list") as {
        models: ModelRow[];
      };
      for (const m of models) {
        io.out(
          `${(m.slug ?? "").padEnd(28)} t${m.tier ?? "?"}  ` +
            `${(m.provider ?? "").padEnd(10)} ${m.displayName ?? ""}\n`,
        );
      }
    } finally {
      client.close();
    }
    return 0;
  } catch (error) {
    io.err(socketError(error, config));
    return 1;
  }
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
          io.out(`  ${(s.slug ?? "").padEnd(40)} ${s.sessionName ?? ""}\n`);
        }
      }
    } finally {
      client.close();
    }
    return 0;
  } catch (error) {
    io.err(socketError(error, config));
    return 1;
  }
}

// ── Argument + config parsing ────────────────────────────────────────────────

interface ParsedArgs {
  command: "exec" | "repl" | "help" | "models" | "sessions";
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
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) return error(`missing value for ${arg}`);
      if (arg === "--server") overrides.serverUrl = value;
      else if (arg === "--socket") overrides.socket = value;
      else if (arg === "--key") overrides.key = value;
      else if (arg === "--model") overrides.model = value;
      else if (arg === "--session") overrides.sessionId = value;
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
  if (positional[0] === "exec") {
    const prompt = positional.slice(1).join(" ").trim();
    if (prompt.length === 0) {
      return { command: "exec", json, overrides, error: "exec requires a prompt" };
    }
    return { command: "exec", prompt, json, overrides };
  }
  // `dyfj ask "<prompt>"` — sugar for a one-shot repo-context (ask-mode) turn.
  if (positional[0] === "ask") {
    const prompt = positional.slice(1).join(" ").trim();
    if (prompt.length === 0) {
      return { command: "exec", json, overrides, error: "ask requires a prompt" };
    }
    return { command: "exec", prompt, json, overrides: { ...overrides, mode: "ask" } };
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
  const hint = hintEnv === "code" || hintEnv === "chat" || hintEnv === "reasoning"
    ? hintEnv
    : undefined;
  const explicitWorkspace = overrides.workspace ?? env.get("DYFJ_WORKSPACE");
  return {
    serverUrl: overrides.serverUrl ?? env.get("DYFJ_SERVER_URL") ?? DEFAULT_SERVER,
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
    color: !env.get("NO_COLOR") && isTty,
  };
}

const HELP = `dyfj — Workbench daily-driver client

Usage:
  dyfj                      interactive REPL (multi-turn, streaming)
  dyfj exec "<prompt>"      one-shot turn
  dyfj ask "<prompt>"       one-shot repo-context question (ask mode)
  dyfj -p "<prompt>"        one-shot turn (alias)
  dyfj models               list models over the runtime UDS socket
  dyfj sessions             list sessions over the runtime UDS socket

Options:
  --mode <m>       context mode: turn (companion+memory, default) | ask | next-work (repo)
  --server <url>   runtime server (default ${DEFAULT_SERVER}, env DYFJ_SERVER_URL)
  --socket <path>  runtime UDS socket for models/sessions (default per-user, env DYFJ_SOCKET)
  --key <key>      bearer key for remote servers (env DYFJ_WORKBENCH_API_KEY)
  --model <slug>   model id      --tier <0|1|2>   --hint <code|chat|reasoning>
  --session <id>   resume a session
  --workspace <d>  dir to scope file tools to (default: cwd, env DYFJ_WORKSPACE)
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
  if (parsed.command === "exec") {
    return await runExec(parsed.prompt!, config, io, parsed.json);
  }
  if (parsed.command === "models") {
    return await runModels(config, io);
  }
  if (parsed.command === "sessions") {
    return await runSessions(config, io);
  }
  await runRepl(config, io);
  return 0;
}

if (import.meta.main) {
  const io = realIo();
  const code = await main(Deno.args, io);
  io.close();
  Deno.exit(code);
}
