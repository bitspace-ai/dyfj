#!/usr/bin/env -S deno run --allow-net=127.0.0.1:3306 --allow-env=HOME,DOLT_HOST,DOLT_PORT,DOLT_USER,DOLT_PASSWORD,DOLT_DATABASE
/**
 * DYFJ Memory MCP Server
 *
 * Exposes Dolt-backed memory and session tracking as MCP tools.
 * Any agent that speaks MCP (Claude Code, Codex CLI, Gemini CLI, Cursor, etc.)
 * can attach to this server and get a conservative client-safe and public
 * memory projection.
 *
 * Transport: stdio (standard for CLI coding agents)
 *
 * Tools exposed:
 *   read_memory(slug)                         — fetch full memory content
 *   write_memory(slug, name, type, desc, content) — upsert a memory
 *   list_memories(type?)                      — client-safe and public memory index
 *   start_session(task_description, slug?)    — create a session row, return session_id
 *   update_session(session_id, status, progress_done, progress_total, content?) — update session state
 *   list_sessions(limit?, status?)            — recent sessions
 *   get_session(session_id?, slug?)           — load a prior session
 *
 * Architecture:
 *   Coding agent (any) → MCP → this server → store (DoltStore) → Dolt sql-server
 *
 * Workbench and external agents use this server instead of embedding memory
 * SQL directly in each client.
 */

import { McpServer } from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { listMcpMemories, readMcpMemory } from "./memory-tools.ts";
import { generateULID } from "../src/kernel/mod.ts";
import { processEnv, resolveDoltConnection } from "../src/config/mod.ts";
import {
  createDoltPool,
  DoltStore,
  type MemoryType,
  type Store,
} from "../src/store/mod.ts";

type McpSessionStatus = "active" | "completed";

// ── MCP Server ────────────────────────────────────────────────────────────────

function createServer(store: Store): McpServer {
  const server = new McpServer({
    name: "dyfj-memory",
    version: "1.0.0",
  });

  // ── Tool: read_memory ─────────────────────────────────────────────────────────

  server.registerTool(
    "read_memory",
    {
      description:
        "Load the full content of a client-safe or public project or reference memory. " +
        "Call this before starting work to pull relevant context. " +
        "Available slugs are listed by calling list_memories().",
      inputSchema: z.object({
        slug: z.string().describe("Memory slug from list_memories"),
      }),
    },
    ({ slug }: { slug: string }) => readMcpMemory(store.memories, slug),
  );

  // ── Tool: list_memories ───────────────────────────────────────────────────────

  server.registerTool(
    "list_memories",
    {
      description:
        "List the client-safe and public memory projection. Returns slug, type, name, and description. " +
        "Optionally filter by type: user | feedback | project | reference.",
      inputSchema: z.object({
        type: z
          .enum(["user", "feedback", "project", "reference"])
          .optional()
          .describe("Filter by memory type (omit for all)"),
      }),
    },
    ({ type }: { type?: MemoryType }) => listMcpMemories(store.memories, type),
  );

  // ── Tool: write_memory ────────────────────────────────────────────────────────

  server.registerTool(
    "write_memory",
    {
      description: "Create or update a memory in the DYFJ knowledge base. " +
        "Uses INSERT ... ON DUPLICATE KEY UPDATE so it's safe to call on existing slugs.",
      inputSchema: z.object({
        slug: z.string().describe("Stable identifier, e.g. 'project_dyfj'"),
        name: z.string().describe("Human-readable name"),
        type: z
          .enum(["user", "feedback", "project", "reference"])
          .describe("Memory category"),
        description: z.string().describe("One-line summary for the index"),
        content: z.string().describe("Full memory content (markdown)"),
      }),
    },
    async (
      { slug, name, type, description, content }: {
        slug: string;
        name: string;
        type: MemoryType;
        description: string;
        content: string;
      },
    ) => {
      await store.journal.commit({
        events: [],
        mutations: [{
          kind: "memory_upsert",
          memoryId: generateULID(),
          slug,
          type,
          name,
          description,
          content,
        }],
      });
      return {
        content: [
          {
            type: "text",
            text: `Memory '${slug}' saved (type: ${type}).`,
          },
        ],
      };
    },
  );

  // ── Tool: start_session ───────────────────────────────────────────────────────

  server.registerTool(
    "start_session",
    {
      description:
        "Create a new work session in Dolt. Returns the session_id. " +
        "Call this when starting a durable Workbench session record.",
      inputSchema: z.object({
        task_description: z
          .string()
          .max(256)
          .describe("One-line description of the session"),
        slug: z
          .string()
          .optional()
          .describe(
            "Optional stable slug, e.g. '20260415-dyfj-mcp-server'. " +
              "Auto-generated from timestamp + task if omitted.",
          ),
        session_name: z
          .string()
          .optional()
          .describe("Optional 4-word human-readable session name"),
      }),
    },
    async (
      { task_description, slug, session_name }: {
        task_description: string;
        slug?: string;
        session_name?: string;
      },
    ) => {
      const id = generateULID();
      const now = new Date();
      const ts = now.toISOString().slice(0, 10).replace(/-/g, "");
      const hms = now.toISOString().slice(11, 23).replace(/[:.]/g, "");
      const derivedSlug = slug ??
        `${ts}T${hms}-${
          task_description
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 40)
            .replace(/-$/, "")
        }`;

      await store.journal.commit({
        events: [],
        mutations: [{
          kind: "session_insert",
          sessionId: id,
          slug: derivedSlug,
          sessionName: session_name ?? null,
          taskDescription: task_description,
          status: "active",
          mode: "interactive",
          workspace: null,
          content: null,
          progressDone: 0,
          progressTotal: 0,
        }],
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ session_id: id, slug: derivedSlug }),
          },
        ],
      };
    },
  );

  // ── Tool: update_session ──────────────────────────────────────────────────────

  server.registerTool(
    "update_session",
    {
      description:
        "Update an existing session's lifecycle status, progress, and content.",
      inputSchema: z.object({
        session_id: z.string().describe("session_id returned by start_session"),
        status: z
          .enum(["active", "completed"])
          .describe("Current session lifecycle status"),
        progress_done: z
          .number()
          .int()
          .min(0)
          .describe("Number of progress units completed"),
        progress_total: z
          .number()
          .int()
          .min(0)
          .describe("Total progress unit count"),
        content: z
          .string()
          .optional()
          .describe(
            "Freeform session content — context, decisions, verification notes (markdown)",
          ),
      }),
    },
    async (
      { session_id, status, progress_done, progress_total, content }: {
        session_id: string;
        status: McpSessionStatus;
        progress_done: number;
        progress_total: number;
        content?: string;
      },
    ) => {
      await store.journal.commit({
        events: [],
        mutations: [{
          kind: "session_update",
          sessionId: session_id,
          status,
          progressDone: progress_done,
          progressTotal: progress_total,
          content: content ?? null,
        }],
      });
      return {
        content: [
          {
            type: "text",
            text:
              `Session ${session_id} updated: status=${status} progress=${progress_done}/${progress_total}`,
          },
        ],
      };
    },
  );

  // ── Tool: list_sessions ──────────────────────────────────────────────────────────

  server.registerTool(
    "list_sessions",
    {
      description:
        "List recent work sessions from Dolt. Returns session_id, slug, task_description, status, and progress. " +
        "Use this to find a prior session to resume with get_session().",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max sessions to return (default 10)"),
        status: z
          .enum(["active", "completed"])
          .optional()
          .describe("Filter by status (omit for all)"),
      }),
    },
    async (
      { limit = 10, status }: { limit?: number; status?: McpSessionStatus },
    ) => {
      const rows = await store.sessions.recent({
        ...(status ? { status } : {}),
        limit,
      });
      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No sessions found." }] };
      }
      const lines = rows.map((r) => {
        const name = r.session_name ? ` (${r.session_name})` : "";
        const prog = r.progress_total !== "0"
          ? ` [${r.progress_done}/${r.progress_total}]`
          : "";
        return `${
          (r.created_at ?? "").slice(0, 16)
        } | ${r.status}${prog} | ${r.task_description}${name}\n  id: ${r.session_id}\n  slug: ${r.slug}`;
      });
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    },
  );

  // ── Tool: get_session ────────────────────────────────────────────────────────────

  server.registerTool(
    "get_session",
    {
      description:
        "Load the full content of a prior session by session_id or slug. " +
        "Use this to resume a session: load its context, decisions, and progress, " +
        "then continue from where it left off using update_session().",
      inputSchema: z.object({
        session_id: z.string().optional().describe(
          "session_id from list_sessions",
        ),
        slug: z.string().optional().describe(
          "session slug (alternative to session_id)",
        ),
      }),
    },
    async ({ session_id, slug }: { session_id?: string; slug?: string }) => {
      if (!session_id && !slug) {
        return {
          content: [{
            type: "text",
            text: "Provide either session_id or slug.",
          }],
          isError: true,
        };
      }
      const s = await store.sessions.detail(
        session_id ? { sessionId: session_id } : { slug: slug! },
      );
      if (s === null) {
        return {
          content: [{
            type: "text",
            text: `Session not found. Use list_sessions() to find valid IDs.`,
          }],
          isError: true,
        };
      }
      const header = [
        `# Session: ${s.task_description}`,
        `**ID:** ${s.session_id}`,
        `**Slug:** ${s.slug}`,
        s.session_name ? `**Name:** ${s.session_name}` : "",
        `**Status:** ${s.status}  **Progress:** ${s.progress_done}/${s.progress_total}`,
        s.effort_level ? `**Effort:** ${s.effort_level}` : "",
        `**Created:** ${s.created_at}  **Updated:** ${s.updated_at}`,
        "",
        s.content ? `## Session Content\n\n${s.content}` : "*(no content yet)*",
      ].filter(Boolean).join("\n");
      return { content: [{ type: "text", text: header }] };
    },
  );

  return server;
}

// ── Start ─────────────────────────────────────────────────────────────────────

// The server's one store over one Dolt pool, shared by every connection. This
// composition root owns it and closes it, once, when the stdio transport
// closes or the server fails to start.
const store = new DoltStore(createDoltPool(resolveDoltConnection(processEnv)));
let storeClosed: Promise<void> | undefined;
const closeStore = () => (storeClosed ??= store.close().catch(() => {}));

const transport = new StdioServerTransport();
try {
  serveStdio(() => createServer(store), { legacy: "serve", transport });
} catch (error) {
  await closeStore();
  throw error;
}
// serveStdio binds the transport's close to tearing the server down; chain
// the store's close after it.
const closeServer = transport.onclose;
transport.onclose = () => {
  closeServer?.();
  void closeStore();
};
