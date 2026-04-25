#!/usr/bin/env bun
/**
 * DYFJ Memory MCP Server
 *
 * Exposes Dolt-backed memory, session tracking, and reflection as MCP tools.
 * Any agent that speaks MCP (Claude Code, pi, Codex CLI, Gemini CLI, Cursor, etc.)
 * can attach to this server and get the full DYFJ memory substrate for free.
 *
 * Transport: stdio (standard for CLI coding agents)
 *
 * Tools exposed:
 *   read_memory(slug)                         — fetch full memory content
 *   write_memory(slug, name, type, desc, content) — upsert a memory
 *   list_memories(type?)                      — index of all memories
 *   start_session(task_description, slug?)    — create a session row, return session_id
 *   update_session(session_id, phase, progress_done, progress_total, content?) — write phase transition
 *   write_reflection(session_slug, ...)       — end-of-session synthesis
 *
 * Architecture:
 *   Coding agent (any) → MCP → this server → Dolt CLI → Dolt database
 *
 * The pi extension (src/index.ts) will eventually thin down to a shim that
 * calls this server instead of doing SQL directly.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ulid } from "ulid";
import mysql from "mysql2/promise";

// ── Dolt connection (TCP → sql-server) ────────────────────────────────────────
// Uses mysql2 over TCP to avoid file-lock conflicts with dolt sql-server.

let _pool: mysql.Pool | null = null;

function getPool(): mysql.Pool {
  if (!_pool) {
    _pool = mysql.createPool({
      host: "127.0.0.1",
      port: 3306,
      user: "root",
      password: "dolt",
      database: "dolt",
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return _pool;
}

/** Run a SELECT and return rows as plain objects */
async function doltQuery(sql: string): Promise<Record<string, string>[]> {
  const [rows] = await getPool().execute(sql);
  return (rows as mysql.RowDataPacket[]).map((r) => {
    const out: Record<string, string> = {};
    for (const k of Object.keys(r)) out[k] = r[k] == null ? "" : String(r[k]);
    return out;
  });
}

/** Run an INSERT/UPDATE/DELETE */
async function doltExec(sql: string): Promise<void> {
  await getPool().execute(sql);
}

/** Escape a string value for safe SQL interpolation */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "''");
}


// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "dyfj-memory",
  version: "1.0.0",
});

// ── Tool: read_memory ─────────────────────────────────────────────────────────

server.tool(
  "read_memory",
  "Load the full content of a project or reference memory from the DYFJ knowledge base. " +
    "Call this before starting work to pull relevant context. " +
    "Available slugs are listed by calling list_memories().",
  { slug: z.string().describe("Memory slug, e.g. 'project_dyfj' or 'reference_1password_cli'") },
  async ({ slug }) => {
    const rows = await doltQuery(
      `SELECT memory_id, slug, type, name, description, content ` +
        `FROM memories WHERE slug = '${esc(slug)}' LIMIT 1;`
    );
    if (rows.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Memory not found: '${slug}'. Use list_memories() to see valid slugs.`,
          },
        ],
        isError: true,
      };
    }
    const m = rows[0]!;
    return {
      content: [
        {
          type: "text",
          text: `# ${m.name}\n\n${(m.content ?? "").trim()}`,
        },
      ],
    };
  }
);

// ── Tool: list_memories ───────────────────────────────────────────────────────

server.tool(
  "list_memories",
  "List all memories in the DYFJ knowledge base. Returns slug, type, name, and description. " +
    "Optionally filter by type: user | feedback | project | reference.",
  {
    type: z
      .enum(["user", "feedback", "project", "reference"])
      .optional()
      .describe("Filter by memory type (omit for all)"),
  },
  async ({ type }) => {
    const where = type ? `WHERE type = '${esc(type)}'` : "";
    const rows = await doltQuery(
      `SELECT slug, type, name, description FROM memories ${where} ORDER BY type, slug;`
    );
    if (rows.length === 0) {
      return {
        content: [{ type: "text", text: "No memories found." }],
      };
    }

    const lines = [
      "| slug | type | name | description |",
      "|------|------|------|-------------|",
      ...rows.map((r) => {
        const desc = r.description?.replace(/\n/g, " ").replace(/\|/g, "\\|").slice(0, 100) ?? "";
        return `| ${r.slug} | ${r.type} | ${r.name} | ${desc} |`;
      }),
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
);

// ── Tool: write_memory ────────────────────────────────────────────────────────

server.tool(
  "write_memory",
  "Create or update a memory in the DYFJ knowledge base. " +
    "Uses INSERT ... ON DUPLICATE KEY UPDATE so it's safe to call on existing slugs.",
  {
    slug: z.string().describe("Stable identifier, e.g. 'project_dyfj'"),
    name: z.string().describe("Human-readable name"),
    type: z
      .enum(["user", "feedback", "project", "reference"])
      .describe("Memory category"),
    description: z.string().describe("One-line summary for the index"),
    content: z.string().describe("Full memory content (markdown)"),
  },
  async ({ slug, name, type, description, content }) => {
    const id = ulid();
    await doltExec(
      `INSERT INTO memories (memory_id, slug, type, name, description, content) ` +
        `VALUES ('${esc(id)}', '${esc(slug)}', '${esc(type)}', '${esc(name)}', '${esc(description)}', '${esc(content)}') ` +
        `ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), content = VALUES(content), updated_at = CURRENT_TIMESTAMP(6);`
    );
    return {
      content: [
        {
          type: "text",
          text: `Memory '${slug}' saved (type: ${type}).`,
        },
      ],
    };
  }
);

// ── Tool: start_session ───────────────────────────────────────────────────────

server.tool(
  "start_session",
  "Create a new work session in Dolt. Returns the session_id. " +
    "Call this at the start of any Algorithm run to establish a PRD-equivalent record.",
  {
    task_description: z
      .string()
      .max(256)
      .describe("One-line description of the task (maps to ISC task_description)"),
    slug: z
      .string()
      .optional()
      .describe(
        "Optional stable slug, e.g. '20260415-dyfj-mcp-server'. " +
          "Auto-generated from timestamp + task if omitted."
      ),
    session_name: z
      .string()
      .optional()
      .describe("Optional 4-word human-readable session name"),
  },
  async ({ task_description, slug, session_name }) => {
    const id = ulid();
    const now = new Date();
    const ts = now.toISOString().slice(0, 10).replace(/-/g, "");
    const hms = now.toISOString().slice(11, 23).replace(/[:.]/g, "");
    const derivedSlug =
      slug ??
      `${ts}T${hms}-${task_description
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40)
        .replace(/-$/, "")}`;

    const nameCol = session_name
      ? `session_name = '${esc(session_name)}',`
      : "";

    await doltExec(
      `INSERT INTO sessions (session_id, slug, ${session_name ? "session_name, " : ""}task_description, phase, progress_done, progress_total) ` +
        `VALUES ('${esc(id)}', '${esc(derivedSlug)}', ${session_name ? `'${esc(session_name)}', ` : ""}'${esc(task_description)}', 'observe', 0, 0);`
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ session_id: id, slug: derivedSlug }),
        },
      ],
    };
  }
);

// ── Tool: update_session ──────────────────────────────────────────────────────

server.tool(
  "update_session",
  "Update an existing session's phase, progress, and content. " +
    "Call this at each Algorithm phase transition and whenever criteria or decisions change.",
  {
    session_id: z.string().describe("session_id returned by start_session"),
    phase: z
      .enum([
        "observe",
        "think",
        "plan",
        "build",
        "execute",
        "verify",
        "learn",
        "complete",
      ])
      .describe("Current Algorithm phase"),
    progress_done: z
      .number()
      .int()
      .min(0)
      .describe("Number of ISC criteria completed"),
    progress_total: z
      .number()
      .int()
      .min(0)
      .describe("Total ISC criteria count"),
    content: z
      .string()
      .optional()
      .describe(
        "Freeform session content — ISC criteria, decisions, verification notes (markdown)"
      ),
  },
  async ({ session_id, phase, progress_done, progress_total, content }) => {
    const contentSql = content
      ? `, content = '${esc(content)}'`
      : "";
    await doltExec(
      `UPDATE sessions SET phase = '${esc(phase)}', ` +
        `progress_done = ${progress_done}, ` +
        `progress_total = ${progress_total}` +
        `${contentSql} ` +
        `WHERE session_id = '${esc(session_id)}';`
    );
    return {
      content: [
        {
          type: "text",
          text: `Session ${session_id} updated: phase=${phase} progress=${progress_done}/${progress_total}`,
        },
      ],
    };
  }
);

// ── Tool: write_reflection ────────────────────────────────────────────────────

server.tool(
  "write_reflection",
  "Write an end-of-session reflection to Dolt. " +
    "Captures what went well, what to do differently, and capability gaps identified.",
  {
    session_slug: z
      .string()
      .describe("Slug of the completed session (from start_session)"),
    effort_level: z
      .enum(["standard", "extended", "advanced", "deep", "comprehensive"])
      .describe("Effort tier used for this session"),
    task_description: z
      .string()
      .max(256)
      .describe("One-line task description (may duplicate session record)"),
    criteria_count: z.number().int().min(0).describe("Total ISC criteria"),
    criteria_passed: z.number().int().min(0).describe("Criteria that passed"),
    criteria_failed: z.number().int().min(0).describe("Criteria that failed"),
    within_budget: z
      .boolean()
      .describe("Did this session complete within the effort tier's time budget?"),
    implied_sentiment: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("1-10 estimate of user satisfaction from conversation tone"),
    reflection_execution: z
      .string()
      .describe("What should I have done differently in execution?"),
    reflection_approach: z
      .string()
      .describe("What would a smarter algorithm have done?"),
    reflection_gaps: z
      .string()
      .describe("What capabilities were missing from this session?"),
  },
  async ({
    session_slug,
    effort_level,
    task_description,
    criteria_count,
    criteria_passed,
    criteria_failed,
    within_budget,
    implied_sentiment,
    reflection_execution,
    reflection_approach,
    reflection_gaps,
  }) => {
    const id = ulid();
    const sentimentSql =
      implied_sentiment != null ? `${implied_sentiment}` : "NULL";
    await doltExec(
      `INSERT INTO reflections ` +
        `(reflection_id, session_slug, effort_level, task_description, ` +
        `criteria_count, criteria_passed, criteria_failed, within_budget, ` +
        `implied_sentiment, reflection_execution, reflection_approach, reflection_gaps) ` +
        `VALUES (` +
        `'${esc(id)}', '${esc(session_slug)}', '${esc(effort_level)}', '${esc(task_description)}', ` +
        `${criteria_count}, ${criteria_passed}, ${criteria_failed}, ${within_budget ? 1 : 0}, ` +
        `${sentimentSql}, '${esc(reflection_execution)}', '${esc(reflection_approach)}', '${esc(reflection_gaps)}');`
    );
    return {
      content: [
        {
          type: "text",
          text: `Reflection written for session '${session_slug}'. Pass rate: ${criteria_passed}/${criteria_count}.`,
        },
      ],
    };
  }
);

// ── Tool: list_sessions ──────────────────────────────────────────────────────────

server.tool(
  "list_sessions",
  "List recent work sessions from Dolt. Returns session_id, slug, task_description, phase, and progress. " +
    "Use this to find a prior session to resume with get_session().",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Max sessions to return (default 10)"),
    phase: z
      .enum(["observe","think","plan","build","execute","verify","learn","complete"])
      .optional()
      .describe("Filter by phase (omit for all)"),
  },
  async ({ limit = 10, phase }) => {
    const where = phase ? `WHERE phase = '${esc(phase)}'` : "";
    const rows = await doltQuery(
      `SELECT session_id, slug, session_name, task_description, phase, ` +
        `progress_done, progress_total, created_at ` +
        `FROM sessions ${where} ORDER BY created_at DESC LIMIT ${limit};`
    );
    if (rows.length === 0) {
      return { content: [{ type: "text", text: "No sessions found." }] };
    }
    const lines = rows.map((r) => {
      const name = r.session_name ? ` (${r.session_name})` : "";
      const prog = r.progress_total !== "0"
        ? ` [${r.progress_done}/${r.progress_total}]`
        : "";
      return `${(r.created_at ?? "").slice(0, 16)} | ${r.phase}${prog} | ${r.task_description}${name}\n  id: ${r.session_id}\n  slug: ${r.slug}`;
    });
    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }
);

// ── Tool: get_session ────────────────────────────────────────────────────────────

server.tool(
  "get_session",
  "Load the full content of a prior session by session_id or slug. " +
    "Use this to resume a session: load its ISC criteria, decisions, and progress, " +
    "then continue from where it left off using update_session().",
  {
    session_id: z.string().optional().describe("session_id from list_sessions"),
    slug: z.string().optional().describe("session slug (alternative to session_id)"),
  },
  async ({ session_id, slug }) => {
    if (!session_id && !slug) {
      return {
        content: [{ type: "text", text: "Provide either session_id or slug." }],
        isError: true,
      };
    }
    const where = session_id
      ? `WHERE session_id = '${esc(session_id)}'`
      : `WHERE slug = '${esc(slug!)}'`;
    const rows = await doltQuery(
      `SELECT session_id, slug, session_name, task_description, effort_level, ` +
        `phase, progress_done, progress_total, mode, content, created_at, updated_at ` +
        `FROM sessions ${where} LIMIT 1;`
    );
    if (rows.length === 0) {
      return {
        content: [{ type: "text", text: `Session not found. Use list_sessions() to find valid IDs.` }],
        isError: true,
      };
    }
    const s = rows[0]!;
    const header = [
      `# Session: ${s.task_description}`,
      `**ID:** ${s.session_id}`,
      `**Slug:** ${s.slug}`,
      s.session_name ? `**Name:** ${s.session_name}` : "",
      `**Phase:** ${s.phase}  **Progress:** ${s.progress_done}/${s.progress_total}`,
      s.effort_level ? `**Effort:** ${s.effort_level}` : "",
      `**Created:** ${s.created_at}  **Updated:** ${s.updated_at}`,
      "",
      s.content ? `## Session Content\n\n${s.content}` : "*(no content yet)*",
    ].filter(Boolean).join("\n");
    return { content: [{ type: "text", text: header }] };
  }
);

// ── Tool: invoke_skill ──────────────────────────────────────────────────────────

server.tool(
  "invoke_skill",
  "Load and return a skill's prompt template from the DYFJ skills table. " +
    "The returned template describes how to execute the skill — follow it. " +
    "Call list_skills() first if you need to discover available slugs.",
  {
    slug: z
      .string()
      .describe("Skill slug, e.g. 'first_principles', 'research', 'council'"),
  },
  async ({ slug }) => {
    const rows = await doltQuery(
      `SELECT slug, name, description, prompt_template ` +
        `FROM skills WHERE slug = '${esc(slug)}' LIMIT 1;`
    );
    if (rows.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Skill not found: '${slug}'. Call list_skills() to see available skills.`,
          },
        ],
        isError: true,
      };
    }
    const s = rows[0]!;
    return {
      content: [
        {
          type: "text",
          text: `# Invoking skill: ${s.name}\n\n${(s.prompt_template ?? "").trim()}`,
        },
      ],
    };
  }
);

// ── Tool: list_skills ─────────────────────────────────────────────────────────

server.tool(
  "list_skills",
  "List all available skills in the DYFJ skills table. Returns slug, name, and description.",
  {},
  async () => {
    const rows = await doltQuery(
      `SELECT slug, name, description FROM skills ORDER BY slug;`
    );
    if (rows.length === 0) {
      return {
        content: [{ type: "text", text: "No skills found." }],
      };
    }
    const lines = [
      "| slug | name | description |",
      "|------|------|-------------|",
      ...rows.map((r) => {
        const desc = r.description?.replace(/\n/g, " ").replace(/\|/g, "\\|").slice(0, 100) ?? "";
        return `| ${r.slug} | ${r.name} | ${desc} |`;
      }),
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
