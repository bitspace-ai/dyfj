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

import { Client } from "npm:@modelcontextprotocol/sdk@1.29.0/client";
import { StdioClientTransport } from "npm:@modelcontextprotocol/sdk@1.29.0/client/stdio";
import process from "node:process";

// ── Types (mirroring tool inputs/outputs) ─────────────────────────────────────

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type Phase = "observe" | "think" | "plan" | "build" | "execute" | "verify" | "learn" | "complete";

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
  phase: Phase;
  progress_done: number;
  progress_total: number;
  created_at: string;
}

// ── Client ────────────────────────────────────────────────────────────────────

const SERVER_BIN = process.env.DENO_BIN ?? "deno";
const DYFJ_ROOT   = process.env.DYFJ_ROOT ?? `${process.env.HOME}/.dyfj`;
const SERVER_SCRIPT = `${DYFJ_ROOT}/mcp/server.ts`;

export class DyfjMcpClient {
  private client: Client;
  private transport: StdioClientTransport | null = null;
  private connected = false;

  constructor() {
    this.client = new Client({ name: "dyfj-extension", version: "1.0.0" });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.transport = new StdioClientTransport({
      command: SERVER_BIN,
      args: [
        "run",
        "--allow-net=127.0.0.1:3306",
        "--allow-env=HOME,DOLT_HOST,DOLT_PORT,DOLT_USER,DOLT_PASSWORD,DOLT_DATABASE",
        SERVER_SCRIPT,
      ],
      env: { ...process.env, HOME: process.env.HOME ?? "" } as Record<string, string>,
    });
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }

  // ── Helper ──────────────────────────────────────────────────────────────────

  private async call(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    if (result.isError) throw new Error(`MCP tool '${name}' returned error: ${text}`);
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
    return this.call("write_memory", { slug, name, type, description, content });
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
    phase: Phase,
    progress_done: number,
    progress_total: number,
    content?: string,
  ): Promise<string> {
    return this.call("update_session", {
      session_id, phase, progress_done, progress_total,
      ...(content ? { content } : {}),
    });
  }

  async listSessions(limit?: number, phase?: Phase): Promise<string> {
    return this.call("list_sessions", {
      ...(limit ? { limit } : {}),
      ...(phase ? { phase } : {}),
    });
  }

  async getSession(session_id?: string, slug?: string): Promise<string> {
    return this.call("get_session", {
      ...(session_id ? { session_id } : {}),
      ...(slug ? { slug } : {}),
    });
  }
}
