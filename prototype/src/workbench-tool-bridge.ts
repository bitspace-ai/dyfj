/**
 * The Workbench tool bridge: an MCP server, hosted by the runtime, that gives
 * a Codex ChatGPT session a selected set of Workbench commands.
 *
 * - Codex starts `scripts/workbench-tool-bridge-shim.ts` as a stdio MCP server. The
 *   shim connects to this bridge's Unix socket, sends its session token as
 *   the first line, and then copies bytes in both directions.
 * - The runtime mints one token per Workbench session (`bind`) and keeps the
 *   token-to-session map in memory. A connection serves the session its token
 *   maps to. No tool argument names a session.
 * - A `tools/call` is admitted only while that session has an active turn
 *   (`activate`). It goes through `invokeCommandWithEvent` with that turn's
 *   approver, session grants, permission level and journal, as a native tool
 *   call does. A command whose policy is `ask`, and that no session grant
 *   covers, asks the turn's approver (on
 *   an interactive turn, the Workbench prompt on the turn's connection) and
 *   is denied when the turn has none. An approval that arrives after the
 *   turn ended, or after Codex cancelled the call, counts as a denial. Each
 *   admitted call attempts to record one `tool_call` event; a failed journal
 *   write is logged and does not fail the call.
 *
 * The token is a session capability, not a credential for any outside
 * service. It is in the Codex process's configuration, so commands Codex
 * runs can read it. Those commands run in Codex's sandbox, which refuses
 * Unix-socket connects with network access off (`codex-seatbelt-socket.test.ts`
 * checks this for the runtime socket). A call made with a token that does
 * reach the bridge is admitted only for that token's session, only during
 * that session's turn, and under the same Workbench policy. A command that
 * is already running when the turn ends is not stopped.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type JSONRPCMessage,
  ReadBuffer,
  serializeMessage,
  Server,
  type Transport,
} from "@modelcontextprotocol/server";
import type { PermissionLevel } from "./config/mod.ts";
import { generateSpanId } from "./kernel/mod.ts";
import type { EventInsert } from "./store/mod.ts";
import {
  type CommandDefinition,
  type CommandPolicyContext,
  type ConfirmToolApproval,
  createCommandRegistry,
  invokeCommandWithEvent,
  type JsonSchemaObject,
  type SessionGrants,
} from "./tools/mod.ts";
import {
  type ByteConnection,
  type ConnectionListener,
  maxSocketPathBytes,
  nodeSocketHost,
  type SocketHost,
} from "./transport/mod.ts";

/** The MCP server name Codex sees, and its key in the Codex config. */
export const WORKBENCH_BRIDGE_SERVER_NAME = "workbench";

/** The env var the shim reads its session token from. */
export const WORKBENCH_BRIDGE_TOKEN_ENV = "DYFJ_WORKBENCH_BRIDGE_TOKEN";

/**
 * The shim Codex starts as the bridge's stdio MCP server. It runs as its own
 * process, so it lives with the other standalone programs under `scripts/`.
 */
export const WORKBENCH_BRIDGE_SHIM_PATH = fileURLToPath(
  new URL("../scripts/workbench-tool-bridge-shim.ts", import.meta.url),
);

/** The socket's file name, inside the bridge's own private directory. */
const SOCKET_FILE = "tools.sock";

/** A token line longer than this closes the connection unread. */
const MAX_TOKEN_LINE_BYTES = 128;

/** A connection that sends no token line within this time is closed. */
const HANDSHAKE_TIMEOUT_MS = 5_000;

/** The most connections the bridge holds open at once. */
const MAX_CONNECTIONS = 32;

/** The most tool calls one connection may have in progress at once. */
const MAX_CALLS_IN_FLIGHT = 8;

/** The largest unterminated JSON-RPC frame a connection may buffer. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Whether the bridge offers `command` to Codex: the operator's configured
 * MCP servers' commands (`mcp.<server>.<tool>`). Codex has its own shell,
 * file and patch tools, so Workbench's builtins stay off.
 */
export function isBridgedCommand(command: CommandDefinition): boolean {
  return command.id.startsWith("mcp.");
}

/**
 * The tool name Codex sees for a command id. OpenAI function names allow
 * `[A-Za-z0-9_-]` only, so every other character becomes `_`.
 */
export function bridgedToolName(commandId: string): string {
  return commandId.replace(/[^A-Za-z0-9_-]/g, "_");
}

interface BridgedTool {
  name: string;
  commandId: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

/**
 * The tools offered for `commands`: those `isBridgedCommand` admits, by
 * mapped name. Two commands that map to one name are both left out, so a
 * name never stands for a command the operator did not mean.
 */
export function bridgedTools(
  commands: readonly CommandDefinition[],
): BridgedTool[] {
  // null marks a name two commands map to.
  const byName = new Map<string, CommandDefinition | null>();
  for (const command of commands) {
    if (!isBridgedCommand(command)) continue;
    const name = bridgedToolName(command.id);
    byName.set(name, byName.has(name) ? null : command);
  }
  const tools: BridgedTool[] = [];
  for (const [name, command] of byName) {
    if (command === null) continue;
    tools.push({
      name,
      commandId: command.id,
      description: command.description,
      inputSchema: command.inputSchema,
    });
  }
  return tools;
}

/** What one turn gives the bridge: the commands and the turn's own ports. */
export interface BridgeTurn {
  /** The commands the turn may run; the bridge offers the subset it admits. */
  commands: readonly CommandDefinition[];
  /** The turn's tool approver. Absent, an `ask` command is denied. */
  confirmApproval?: ConfirmToolApproval;
  /** The turn's permission level, transport and session grants. */
  policy: CommandPolicyContext;
  traceId: string;
  /** The span the `tool_call` events are recorded under. */
  parentSpanId: string;
  /** Commits one `tool_call` event to the session's journal. */
  writeEvent: (event: EventInsert) => Promise<void> | void;
}

interface ActiveTurn {
  turn: BridgeTurn;
  tools: BridgedTool[];
  /** Aborted when the turn is released. */
  ended: AbortController;
}

const LATE_APPROVAL = {
  decision: "deny",
  reason: "the call was cancelled or its turn ended before the approval arrived",
} as const;

/**
 * A promise that resolves when `signal` aborts (at once if it already has),
 * and a `dispose` that removes its listener.
 */
function untilAborted(
  signal: AbortSignal,
): { aborted: Promise<void>; dispose: () => void } {
  let dispose = () => {};
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const listener = () => resolve();
    signal.addEventListener("abort", listener, { once: true });
    dispose = () => signal.removeEventListener("abort", listener);
  });
  return { aborted, dispose };
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function textResult(text: string, isError: boolean) {
  return { content: [{ type: "text" as const, text }], isError };
}

/**
 * An MCP transport over one accepted bridge connection: newline-delimited
 * JSON-RPC, as MCP's stdio transport speaks it, which is what the shim relays.
 */
class ConnectionTransport implements Transport {
  readonly #connection: ByteConnection;
  readonly #buffer = new ReadBuffer({ maxBufferSize: MAX_FRAME_BYTES });
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(connection: ByteConnection, rest: Uint8Array) {
    this.#connection = connection;
    if (rest.length > 0) this.#buffer.append(Buffer.from(rest));
  }

  start(): Promise<void> {
    void this.#pump();
    return Promise.resolve();
  }

  async #pump(): Promise<void> {
    try {
      this.#drain();
      for (let chunk; (chunk = await this.#connection.read()) !== null;) {
        this.#buffer.append(Buffer.from(chunk));
        this.#drain();
      }
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.#connection.close();
      this.onclose?.();
    }
  }

  #drain(): void {
    for (let message; (message = this.#buffer.readMessage()) !== null;) {
      this.onmessage?.(message);
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    return this.#connection.write(
      new TextEncoder().encode(serializeMessage(message)),
    );
  }

  close(): Promise<void> {
    this.#connection.close();
    return Promise.resolve();
  }
}

/**
 * Read the connection's first line, the token, within the handshake time.
 * Returns the token and the bytes after it, or undefined when the line is
 * too long, the time runs out or the connection ends first.
 */
async function readTokenLine(
  connection: ByteConnection,
): Promise<{ token: string; rest: Uint8Array } | undefined> {
  let buffered = new Uint8Array(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), HANDSHAKE_TIMEOUT_MS);
  });
  try {
    for (;;) {
      const chunk = await Promise.race([connection.read(), timeout]);
      if (chunk === null) return undefined;
      // Only the bytes that can still belong to the token line are looked
      // at or copied.
      const room = MAX_TOKEN_LINE_BYTES + 1 - buffered.length;
      const head = chunk.subarray(0, room);
      const newline = head.indexOf(0x0a);
      const line = new Uint8Array(
        buffered.length + (newline === -1 ? head.length : newline),
      );
      line.set(buffered);
      line.set(newline === -1 ? head : head.subarray(0, newline), buffered.length);
      if (newline !== -1) {
        return {
          token: new TextDecoder().decode(line),
          rest: chunk.subarray(newline + 1),
        };
      }
      if (chunk.length >= room) return undefined;
      buffered = line;
    }
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export class WorkbenchToolBridge {
  readonly #directory: string;
  readonly #socketPath: string;
  readonly #listener: ConnectionListener;
  /** token digest → session id */
  readonly #sessions = new Map<string, string>();
  /** session id → token */
  readonly #tokens = new Map<string, string>();
  readonly #turns = new Map<string, ActiveTurn>();
  /** session id → calls in progress, across its connections */
  readonly #inFlight = new Map<string, number>();
  readonly #connections = new Set<ByteConnection>();
  #closed = false;

  private constructor(
    directory: string,
    socketPath: string,
    listener: ConnectionListener,
  ) {
    this.#directory = directory;
    this.#socketPath = socketPath;
    this.#listener = listener;
  }

  /**
   * Start a bridge whose socket is in a new owner-only directory under
   * `parent`, resolved to an absolute path, because the shim Codex starts
   * runs in another working directory. When that socket path would not fit
   * the platform's Unix-socket path limit, the directory goes under the
   * system temporary directory instead. `parent` must exist.
   */
  static async start(
    parent: string,
    host: SocketHost = nodeSocketHost,
  ): Promise<WorkbenchToolBridge> {
    const preferred = join(resolve(parent), "codex-bridge-");
    const fits = Buffer.byteLength(join(`${preferred}XXXXXX`, SOCKET_FILE)) <=
      maxSocketPathBytes();
    const fallback = join(resolve(tmpdir()), "codex-bridge-");
    if (
      !fits &&
      Buffer.byteLength(join(`${fallback}XXXXXX`, SOCKET_FILE)) >
        maxSocketPathBytes()
    ) {
      throw new Error(
        "the bridge socket path is too long both beside the runtime socket " +
          "and under the system temporary directory",
      );
    }
    const directory = await mkdtemp(fits ? preferred : fallback);
    const socketPath = join(directory, SOCKET_FILE);
    let listener: ConnectionListener;
    try {
      // mkdtemp asks for 0700, which the umask can narrow.
      await chmod(directory, 0o700);
      listener = await host.listen(socketPath);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    const bridge = new WorkbenchToolBridge(directory, socketPath, listener);
    // A bridge that stops accepting connections closes, so the runtime's
    // next Codex turn starts a new one instead of reusing it.
    void bridge.#acceptLoop().catch(() => {
      console.error("[tool-bridge] the bridge stopped accepting connections");
      void bridge.close();
    });
    return bridge;
  }

  /** True once the bridge has closed, by `close()` or a failed accept loop. */
  get closed(): boolean {
    return this.#closed;
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  /**
   * The session's token, minted on first use and kept for the runtime's
   * life: about a hundred bytes per session the runtime has served on the
   * Codex route.
   */
  bind(sessionId: string): string {
    const existing = this.#tokens.get(sessionId);
    if (existing !== undefined) return existing;
    const token = randomBytes(32).toString("hex");
    this.#tokens.set(sessionId, token);
    this.#sessions.set(digest(token), sessionId);
    return token;
  }

  /**
   * Make `turn` the session's active turn until the returned function is
   * called. A session has at most one active turn.
   */
  activate(sessionId: string, turn: BridgeTurn): () => void {
    if (this.#turns.has(sessionId)) {
      throw new Error("the Workbench tool bridge already has a turn for this session");
    }
    const active: ActiveTurn = {
      turn,
      tools: bridgedTools(turn.commands),
      ended: new AbortController(),
    };
    this.#turns.set(sessionId, active);
    return () => {
      if (this.#turns.get(sessionId) === active) this.#turns.delete(sessionId);
      active.ended.abort();
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#listener.close();
    for (const connection of this.#connections) connection.close();
    await rm(this.#directory, { recursive: true, force: true });
  }

  async #acceptLoop(): Promise<void> {
    for (let connection; (connection = await this.#listener.accept()) !== null;) {
      if (this.#closed || this.#connections.size >= MAX_CONNECTIONS) {
        connection.close();
        continue;
      }
      void this.#serve(connection).catch(() => connection.close());
    }
  }

  async #serve(connection: ByteConnection): Promise<void> {
    this.#connections.add(connection);
    const handshake = await readTokenLine(connection);
    const sessionId = handshake === undefined
      ? undefined
      : this.#sessions.get(digest(handshake.token));
    if (handshake === undefined || sessionId === undefined || this.#closed) {
      connection.close();
      this.#connections.delete(connection);
      return;
    }
    const server = new Server(
      { name: "dyfj-workbench", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler("tools/list", () => ({
      tools: (this.#turns.get(sessionId)?.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));
    server.setRequestHandler("tools/call", async (request, context) => {
      const inFlight = this.#inFlight.get(sessionId) ?? 0;
      if (inFlight >= MAX_CALLS_IN_FLIGHT) {
        return textResult(
          `Too many Workbench tool calls in progress (at most ${MAX_CALLS_IN_FLIGHT}); the tool did not run.`,
          true,
        );
      }
      this.#inFlight.set(sessionId, inFlight + 1);
      // The session's slot is held until the call returns and each approval
      // request it made has settled or its turn has ended, so calls Codex
      // cancels do not pile up prompts within a turn, whatever connection
      // they come from.
      const approvals: Promise<unknown>[] = [];
      try {
        return await this.#call(
          sessionId,
          request.params,
          context.mcpReq.signal,
          approvals,
        );
      } finally {
        void Promise.allSettled(approvals).then(() =>
          this.#inFlight.set(sessionId, (this.#inFlight.get(sessionId) ?? 1) - 1)
        );
      }
    });
    try {
      // The constructor buffers the bytes after the token, and refuses an
      // oversized frame by throwing.
      const transport = new ConnectionTransport(connection, handshake.rest);
      const closed = new Promise<void>((resolve) => {
        transport.onclose = () => resolve();
      });
      await server.connect(transport);
      await closed;
    } catch {
      connection.close();
    } finally {
      this.#connections.delete(connection);
    }
  }

  async #call(
    sessionId: string,
    params: { name: string; arguments?: Record<string, unknown> },
    signal: AbortSignal,
    approvals: Promise<unknown>[],
  ) {
    const active = this.#turns.get(sessionId);
    if (active === undefined) {
      return textResult(
        "No Workbench turn is active for this session, so the tool did not run.",
        true,
      );
    }
    const tool = active.tools.find((each) => each.name === params.name);
    if (tool === undefined) {
      return textResult(`Unknown Workbench tool: ${params.name}`, true);
    }
    const { turn } = active;
    const confirm = turn.confirmApproval;
    // A verdict counts only while the call is still wanted. When Codex
    // cancels the call or the turn ends before the answer, the call is
    // denied then; an answer the operator gives later changes nothing.
    const stop = AbortSignal.any([signal, active.ended.signal]);
    const confirmApproval: ConfirmToolApproval | undefined = confirm === undefined
      ? undefined
      : async (request) => {
        // Both listeners are in place before `confirm` runs, so an abort
        // during `confirm` itself still denies the call at once. The slot is
        // released once the approval settles or the turn ends. Both listeners
        // are removed once their promise has settled.
        const stopped = untilAborted(stop);
        const ended = untilAborted(active.ended.signal);
        try {
          if (stop.aborted) return LATE_APPROVAL;
          const answer = confirm(request);
          approvals.push(Promise.race([answer, ended.aborted]));
          const verdict = await Promise.race([
            answer,
            stopped.aborted.then(() => LATE_APPROVAL),
          ]);
          return stop.aborted ? LATE_APPROVAL : verdict;
        } finally {
          stopped.dispose();
          void Promise.allSettled(approvals).then(() => ended.dispose());
        }
      };
    // A call cancelled, or whose turn ended, before it reached the command
    // does not run, whatever its policy.
    if (stop.aborted) {
      return textResult(
        "The call was cancelled or its turn ended before it ran.",
        true,
      );
    }
    const result = await invokeCommandWithEvent(
      createCommandRegistry(
        turn.commands.filter((command) => command.id === tool.commandId),
      ),
      {
        commandId: tool.commandId,
        callId: `bridge-${generateSpanId()}`,
        caller: { principalId: "workbench", principalType: "agent" },
        arguments: params.arguments ?? {},
      },
      {
        sessionId,
        traceId: turn.traceId,
        parentSpanId: turn.parentSpanId,
        writeEvent: turn.writeEvent,
      },
      confirmApproval,
      turn.policy,
    );
    if (result.isError) {
      return textResult(result.reason ?? "command failed", true);
    }
    return textResult(
      typeof result.result === "string"
        ? result.result
        : JSON.stringify(result.result),
      false,
    );
  }
}

/** What a turn uses of the runtime's `WorkbenchToolBridge`. */
export type ToolBridgePort = Pick<
  WorkbenchToolBridge,
  "socketPath" | "bind" | "activate"
>;

/** The runtime's tool bridge, as the external-agent runner receives it. */
export interface ExternalAgentToolBridge {
  /** The runtime's bridge, started on first use. */
  bridge: () => Promise<ToolBridgePort>;
  /** Codex's per-call timeout for the bridge's tools. */
  toolTimeoutSeconds: number;
  /** The session's "allow for the rest of the session" grants. */
  sessionGrants?: (sessionId: string) => SessionGrants;
}

export interface CodexWorkbenchToolsOptions {
  socketPath: string;
  /** The session's bridge token (`WorkbenchToolBridge.bind`). */
  token: string;
  /** Codex's per-call timeout for the bridge's tools. */
  toolTimeoutSeconds: number;
}

/**
 * The Codex `mcp_servers` entry for the Workbench tool bridge. Codex starts
 * the shim with `nodePath`; the token goes in the server's own environment.
 * `default_tools_approval_mode = "approve"` stops Codex from raising its own
 * prompt for these tools: the bridge runs each admitted call to an offered
 * tool through Workbench's policy. An `ask` command that no session grant
 * covers raises the Workbench prompt when the turn has an approver, and is
 * denied when it has none.
 */
export function codexWorkbenchToolsServer(
  nodePath: string,
  options: CodexWorkbenchToolsOptions,
): Record<string, unknown> {
  return {
    command: nodePath,
    args: [WORKBENCH_BRIDGE_SHIM_PATH, options.socketPath],
    env: { [WORKBENCH_BRIDGE_TOKEN_ENV]: options.token },
    tool_timeout_sec: options.toolTimeoutSeconds,
    default_tools_approval_mode: "approve",
  };
}

/**
 * The Codex config keys for the bridge, merged into the route's per-process
 * Codex config: `mcp_servers.workbench`, or nothing without `options`. Not
 * ACP `session/new`: codex-acp 2.5.0 maps a `session/new` server to command,
 * args and env only, so it cannot carry `tool_timeout_sec`.
 */
export function codexWorkbenchToolsConfig(
  nodePath: string,
  options: CodexWorkbenchToolsOptions | undefined,
): Record<string, unknown> {
  if (options === undefined) return {};
  return {
    mcp_servers: {
      [WORKBENCH_BRIDGE_SERVER_NAME]: codexWorkbenchToolsServer(nodePath, options),
    },
  };
}

/** What `bindCodexTurn` reads from an external-agent turn. */
export interface CodexTurnTools {
  runner: { profile: string };
  /** Boot-discovered external MCP commands, offered through the bridge. */
  externalMcpCommands?: readonly CommandDefinition[];
  /** The turn's tool approver; an `ask` command is denied when it is absent. */
  approver?: { confirmToolApproval?: ConfirmToolApproval };
  /** The operator's permission posture ("strict" when absent). */
  permissionLevel?: PermissionLevel;
}

/** A Codex turn's binding to the bridge (`bindCodexTurn`). */
export interface BoundCodexTurn {
  /** What the Codex profile carries for this session. */
  workbenchTools: CodexWorkbenchToolsOptions;
  /**
   * Make this turn the session's active turn until the returned function is
   * called. `writeEvent` commits to the session's journal; a failed write is
   * logged and does not fail the call, as on the native route.
   */
  activate(
    traceId: string,
    parentSpanId: string,
    writeEvent: (event: EventInsert) => Promise<void>,
  ): () => void;
}

/**
 * Bind a Codex ChatGPT turn's session to the runtime's bridge, starting the
 * bridge on first use. Undefined when there is no bridge, the turn is not on
 * the Codex route, or no configured MCP command would be offered. The
 * external route serves loopback callers only, so every configured MCP
 * command passes the turn's clearance.
 */
export async function bindCodexTurn(
  dependency: ExternalAgentToolBridge | undefined,
  sessionId: string,
  input: CodexTurnTools,
): Promise<BoundCodexTurn | undefined> {
  const commands = input.externalMcpCommands ?? [];
  if (
    dependency === undefined || input.runner.profile !== "codex-chatgpt" ||
    bridgedTools(commands).length === 0
  ) {
    return undefined;
  }
  const bridge = await dependency.bridge();
  return {
    workbenchTools: {
      socketPath: bridge.socketPath,
      token: bridge.bind(sessionId),
      toolTimeoutSeconds: dependency.toolTimeoutSeconds,
    },
    activate: (traceId, parentSpanId, writeEvent) =>
      bridge.activate(sessionId, {
        commands,
        confirmApproval: input.approver?.confirmToolApproval,
        policy: {
          permissionLevel: input.permissionLevel ?? "strict",
          loopback: true,
          ...(dependency.sessionGrants === undefined
            ? {}
            : { sessionGrants: dependency.sessionGrants(sessionId) }),
        },
        traceId,
        parentSpanId,
        writeEvent: async (event) => {
          try {
            await writeEvent(event);
          } catch {
            console.error("[tool-bridge] a tool_call event was not recorded");
          }
        },
      }),
  };
}
