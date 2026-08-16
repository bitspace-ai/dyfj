/**
 * DYFJ MCP Client — thin wrapper over the dyfj-memory MCP server.
 *
 * Spawns the MCP server as a child process and communicates via stdio.
 * Exposes typed methods for every tool the server provides so callers
 * never touch raw JSON-RPC.
 *
 * Usage:
 *   const client = new DyfjMcpClient();
 *   await client.connect();
 *   const memories = await client.listMemories();
 *   const mem = await client.readMemory("project_dyfj");
 *   await client.disconnect();
 *
 * Why this exists:
 *   Early prototype clients called Dolt SQL directly. With this client,
 *   ALL Dolt logic lives in the MCP server. The extension becomes a thin
 *   lifecycle bridge — swap one harness for Codex CLI or Gemini CLI and the same
 *   server works unchanged. This is the vendor-agnosticism proof.
 */

import {
  Client,
  type ProtocolEra,
} from "npm:@modelcontextprotocol/client@2.0.0";
import { StdioClientTransport } from "npm:@modelcontextprotocol/client@2.0.0/stdio";
import process from "node:process";
import {
  buildDoltAllowNetGrant,
  validateDoltPort,
} from "./mcp-net-grants.ts";

export { buildDoltAllowNetGrant, validateDoltPort };

// ── Types (mirroring tool inputs/outputs) ─────────────────────────────────────

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type SessionStatus = "active" | "completed";

export interface MemoryIndexEntry {
  slug: string;
  type: MemoryType;
  name: string;
  description: string;
}

export interface SessionSummary {
  session_id: string;
  slug: string;
  session_name?: string;
  task_description: string;
  status: SessionStatus;
  progress_done: number;
  progress_total: number;
  created_at: string;
}

// ── Client ────────────────────────────────────────────────────────────────────

const SERVER_BIN = process.env.DENO_BIN ?? "deno";
const DYFJ_ROOT = process.env.DYFJ_ROOT ?? `${process.env.HOME}/.dyfj`;
const SERVER_SCRIPT = `${DYFJ_ROOT}/mcp/server.ts`;
const CHILD_ENV_KEYS = [
  "HOME",
  "DOLT_HOST",
  "DOLT_PORT",
  "DOLT_USER",
  "DOLT_PASSWORD",
  "DOLT_DATABASE",
] as const;

export interface DyfjMcpClientOptions {
  serverExecutable?: string;
  serverScript?: string;
  childEnv?: Record<string, string>;
  versionNegotiation?: "auto" | "legacy";
}

export class DyfjMcpClient {
  private client: Client;
  private transport: StdioClientTransport | null = null;
  private connected = false;
  private readonly methodEvidence: string[] = [];
  private readonly options: DyfjMcpClientOptions;

  constructor(options: DyfjMcpClientOptions = {}) {
    this.options = options;
    this.client = new Client(
      { name: "dyfj-extension", version: "1.0.0" },
      {
        versionNegotiation: {
          mode: options.versionNegotiation ?? "auto",
          probe: { timeoutMs: 5_000, maxRetries: 0 },
        },
      },
    );
  }

  get protocolVersion(): string | undefined {
    return this.client.getNegotiatedProtocolVersion();
  }

  get protocolEra(): ProtocolEra | undefined {
    return this.client.getProtocolEra();
  }

  get sessionMethodEvidence(): readonly string[] {
    return this.methodEvidence;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const childEnv = this.options.childEnv === undefined
      ? Object.fromEntries(
        CHILD_ENV_KEYS.flatMap((name) => {
          const value = process.env[name];
          return value === undefined ? [] : [[name, value]];
        }),
      )
      : { ...this.options.childEnv };
    childEnv.HOME ??= process.env.HOME ?? "";
    const netGrant = buildDoltAllowNetGrant(childEnv.DOLT_PORT);
    this.transport = new StdioClientTransport({
      command: this.options.serverExecutable ?? SERVER_BIN,
      args: [
        "run",
        "--sloppy-imports",
        netGrant,
        "--allow-env=HOME,DOLT_HOST,DOLT_PORT,DOLT_USER,DOLT_PASSWORD,DOLT_DATABASE",
        this.options.serverScript ?? SERVER_SCRIPT,
      ],
      env: childEnv,
    });
    const send = this.transport.send.bind(this.transport);
    this.transport.send = async (message) => {
      if (
        "method" in message &&
        typeof message.method === "string" &&
        this.methodEvidence.length < 32
      ) {
        this.methodEvidence.push(message.method);
      }
      await send(message);
    };
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected && !this.transport) return;
    try {
      await this.client.close();
    } finally {
      this.connected = false;
      this.transport = null;
    }
  }

  // ── Helper ──────────────────────────────────────────────────────────────────

  private async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.filter((c) => c.type === "text").map((c) =>
      c.text ?? ""
    ).join("");
    if (result.isError) {
      throw new Error(`MCP tool '${name}' returned error: ${text}`);
    }
    return text;
  }

  // ── Memory tools ────────────────────────────────────────────────────────────

  async readMemory(slug: string): Promise<string> {
    return this.call("read_memory", { slug });
  }

  async listMemories(type?: MemoryType): Promise<string> {
    return this.call("list_memories", type ? { type } : {});
  }

  async writeMemory(
    slug: string,
    name: string,
    type: MemoryType,
    description: string,
    content: string,
  ): Promise<string> {
    return this.call("write_memory", {
      slug,
      name,
      type,
      description,
      content,
    });
  }

  // ── Session tools ───────────────────────────────────────────────────────────

  async startSession(
    task_description: string,
    slug?: string,
    session_name?: string,
  ): Promise<{ session_id: string; slug: string }> {
    const text = await this.call("start_session", {
      task_description,
      ...(slug ? { slug } : {}),
      ...(session_name ? { session_name } : {}),
    });
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`start_session returned non-JSON: ${text.slice(0, 120)}`);
    }
  }

  async updateSession(
    session_id: string,
    status: SessionStatus,
    progress_done: number,
    progress_total: number,
    content?: string,
  ): Promise<string> {
    return this.call("update_session", {
      session_id,
      status,
      progress_done,
      progress_total,
      ...(content ? { content } : {}),
    });
  }

  async listSessions(limit?: number, status?: SessionStatus): Promise<string> {
    return this.call("list_sessions", {
      ...(limit ? { limit } : {}),
      ...(status ? { status } : {}),
    });
  }

  async getSession(session_id?: string, slug?: string): Promise<string> {
    return this.call("get_session", {
      ...(session_id ? { session_id } : {}),
      ...(slug ? { slug } : {}),
    });
  }
}
