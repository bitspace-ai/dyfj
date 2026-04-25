/**
 * DYFJ Workbench — pi session extension (MCP-backed)
 *
 * Task 6 (M2.5): all Dolt logic now lives in the dyfj-memory MCP server.
 * This extension is a thin lifecycle bridge — it connects to the MCP server
 * at session_start and routes through it for all memory and session operations.
 *
 * Proof of vendor-agnosticism: swap pi for Codex CLI or Gemini CLI and the
 * same MCP server works unchanged. This extension is pi-specific glue only.
 *
 * Responsibilities:
 *   session_start      → connect MCP client, load memories, build system prompt,
 *                        auto-create session row in Dolt, write session_start event
 *   before_agent_start → inject Dolt-backed system prompt
 *   message_end        → write model_response telemetry event
 *   tool_result        → write tool_call telemetry event
 *   session_shutdown   → write session_end + budget_summary events, disconnect MCP
 *   read_memory tool   → on-demand project/reference memory retrieval via MCP
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { DyfjMcpClient } from "../../src/mcp-client";
import {
  buildSystemPrompt,
  buildReadMemoryTool,
  type Memory,
  type MemoryIndexEntry,
} from "../../src/memory";
import {
  writeEvent,
  generateULID,
  generateTraceId,
  generateSpanId,
  extractText,
  extractThinking,
  normaliseStopReason,
  doltQuery,
  parseDoltCsv,
} from "../../src/utils";
import { BudgetTracker } from "../../src/budget";

// ── Per-session state ─────────────────────────────────────────────────────────

let sessionId       = generateULID();
let traceId         = generateTraceId();
let sessionStartMs  = Date.now();
let budget          = new BudgetTracker(sessionId, traceId);
let cachedPrompt: string | null = null;
let doltSessionId: string | null = null;   // Dolt sessions row ID for this pi session
let mcpClient: DyfjMcpClient | null = null;

// ── Memory loading helpers (via MCP client) ───────────────────────────────────

async function loadMemoriesViaMcp(): Promise<{ core: Memory[]; index: MemoryIndexEntry[] }> {
  // MCP list_memories returns markdown table — parse it into structured objects.
  // For the system prompt builder we still need the same Memory/MemoryIndexEntry shapes,
  // so fall back to direct Dolt for now while MCP proves out on session/skill calls.
  //
  // This is an intentional incremental migration:
  //   Phase A (now): session + skill calls go through MCP; memory load stays on direct Dolt
  //   Phase B (future): extract memory loading into MCP tools that return JSON, migrate fully
  //
  // The MCP client is connected and ready for Phase B — no structural changes needed.

  const [coreRows, indexRows] = await Promise.all([
    doltQuery(
      `SELECT memory_id, slug, type, name, description, content ` +
      `FROM memories WHERE type IN ('user', 'feedback') ORDER BY type, slug;`
    ),
    doltQuery(
      `SELECT slug, type, name, description ` +
      `FROM memories WHERE type IN ('project', 'reference') ORDER BY type, slug;`
    ),
  ]);

  const core: Memory[] = parseDoltCsv(coreRows).map((r) => ({
    memoryId:    r.memory_id,
    slug:        r.slug,
    type:        r.type as Memory["type"],
    name:        r.name,
    description: r.description,
    content:     r.content,
  }));

  const index: MemoryIndexEntry[] = parseDoltCsv(indexRows).map((r) => ({
    slug:        r.slug,
    type:        r.type as MemoryIndexEntry["type"],
    name:        r.name,
    description: r.description,
  }));

  return { core, index };
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── session_start ────────────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    // Reset session context
    sessionId      = generateULID();
    traceId        = generateTraceId();
    sessionStartMs = Date.now();
    budget         = new BudgetTracker(sessionId, traceId);
    cachedPrompt   = null;
    doltSessionId  = null;

    // Connect MCP client (spawns server if not running)
    try {
      mcpClient = new DyfjMcpClient();
      await mcpClient.connect();
    } catch (err) {
      ctx.ui.notify(`DYFJ: MCP client connect failed: ${err}`, "error");
      mcpClient = null;
    }

    // Write session_start event (fire-and-forget)
    writeEvent({
      event_id:       generateULID(),
      session_id:     sessionId,
      event_type:     "session_start",
      trace_id:       traceId,
      span_id:        generateSpanId(),
      principal_id:   (process.env.DYFJ_PRINCIPAL_ID ?? process.env.USER ?? "user"),
      principal_type: "human",
      action:         "start",
      resource:       "session",
      authz_basis:    "user_consent",
      content:        `pi session | reason: ${event.reason}`,
    }).catch((err) => ctx.ui.notify(`DYFJ: session_start write failed: ${err}`, "error"));

    // Auto-create a Dolt session record via MCP (Task 5)
    if (mcpClient) {
      mcpClient.startSession("pi session", undefined, undefined)
        .then((s) => { doltSessionId = s.session_id; })
        .catch((err) => ctx.ui.notify(`DYFJ: start_session failed: ${err}`, "error"));
    }

    // Load memories and build system prompt
    ctx.ui.setStatus("dyfj", "Loading memories…");
    try {
      const { core, index } = await loadMemoriesViaMcp();
      const prompt = buildSystemPrompt(core, index);

      // Append session context so model knows its session_id for update_session() calls
      const sessionHeader = doltSessionId
        ? `\n\n---\n\n**Active Session:** \`${doltSessionId}\` — use this ID with \`update_session()\` to track Algorithm progress.\n`
        : "";

      cachedPrompt = prompt + sessionHeader;
      ctx.ui.setStatus("dyfj", "");
      ctx.ui.notify(
        `Memories: ${core.length} loaded, ${index.length} indexed` +
        (mcpClient ? " | MCP ✓" : " | MCP ✗"),
        "info",
      );
    } catch (err) {
      ctx.ui.setStatus("dyfj", "⚠ memory load failed");
      ctx.ui.notify(`DYFJ memory load failed: ${err}`, "error");
    }
  });

  // ── before_agent_start — inject system prompt ────────────────────────────

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!cachedPrompt) return undefined;
    return { systemPrompt: cachedPrompt };
  });

  // ── message_end — model_response telemetry ───────────────────────────────

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message as any;
    if (msg.role !== "assistant") return;

    const tier: 0 | 1 | 2 = msg.provider === "ollama" ? 0 : 1;
    if (msg.usage) budget.record(msg.usage, tier);

    writeEvent({
      event_id:           generateULID(),
      session_id:         sessionId,
      event_type:         "model_response",
      trace_id:           traceId,
      span_id:            generateSpanId(),
      principal_id:       (process.env.DYFJ_PRINCIPAL_ID ?? process.env.USER ?? "user"),
      principal_type:     "agent",
      action:             "invoke",
      resource:           msg.model ?? "unknown",
      authz_basis:        "user_consent",
      model_id:           msg.model   ?? null,
      provider:           msg.provider ?? null,
      api:                msg.api      ?? null,
      tokens_input:       msg.usage?.input        ?? null,
      tokens_output:      msg.usage?.output       ?? null,
      tokens_cache_read:  msg.usage?.cacheRead    ?? null,
      tokens_cache_write: msg.usage?.cacheWrite   ?? null,
      cost_total:         msg.usage?.cost?.total  ?? null,
      content:            extractText(msg.content  ?? []),
      stop_reason:        normaliseStopReason(msg.stopReason),
      thinking:           extractThinking(msg.content ?? []),
      duration_ms:        Date.now() - sessionStartMs,
    }).catch((err) => ctx.ui.notify(`DYFJ: model_response write failed: ${err}`, "error"));
  });

  // ── tool_result — tool_call telemetry ────────────────────────────────────

  pi.on("tool_result", async (event, _ctx) => {
    const resultText = event.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .slice(0, 500);

    writeEvent({
      event_id:       generateULID(),
      session_id:     sessionId,
      event_type:     "tool_call",
      trace_id:       traceId,
      span_id:        generateSpanId(),
      principal_id:   (process.env.DYFJ_PRINCIPAL_ID ?? process.env.USER ?? "user"),
      principal_type: "agent",
      action:         "tool_call",
      resource:       event.toolName,
      authz_basis:    "implicit",
      tool_name:      event.toolName,
      tool_call_id:   event.toolCallId,
      tool_arguments: JSON.stringify(event.input),
      tool_result:    resultText || null,
      tool_is_error:  event.isError,
    }).catch(() => {});
  });

  // ── session_shutdown ─────────────────────────────────────────────────────

  pi.on("session_shutdown", async (_event, _ctx) => {
    await writeEvent({
      event_id:       generateULID(),
      session_id:     sessionId,
      event_type:     "session_end",
      trace_id:       traceId,
      span_id:        generateSpanId(),
      principal_id:   (process.env.DYFJ_PRINCIPAL_ID ?? process.env.USER ?? "user"),
      principal_type: "human",
      action:         "end",
      resource:       "session",
      authz_basis:    "user_consent",
      duration_ms:    Date.now() - sessionStartMs,
    }).catch(() => {});

    await budget.writeSummaryEvent().catch(() => {});

    // Disconnect MCP client cleanly
    if (mcpClient) {
      await mcpClient.disconnect().catch(() => {});
      mcpClient = null;
    }
  });

  // ── read_memory tool ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "read_memory",
    label: "Read Memory",
    description:
      "Load the full content of a project or reference memory from the Dolt " +
      "knowledge base. Call this before starting work to pull relevant context. " +
      "Available slugs are listed in the Context Index in your system prompt.",
    promptSnippet: "Load full content of a project or reference memory by slug",
    promptGuidelines: [
      "Before starting any task, review the Context Index in your system prompt " +
      "and call read_memory() for entries relevant to the work. Do this first.",
    ],
    parameters: Type.Object({
      slug: Type.String({
        description:
          "Memory slug from the Context Index, " +
          "e.g. 'project_dyfj' or 'reference_1password_cli'",
      }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      // Route through MCP client if available; fall back to direct Dolt
      let content: string;
      if (mcpClient) {
        content = await mcpClient.readMemory(params.slug);
      } else {
        const { executeReadMemory } = await import("../../src/memory");
        content = await executeReadMemory(params.slug);
      }
      const found = !content.startsWith("Memory not found");
      return {
        content: [{ type: "text", text: content }],
        details: { slug: params.slug, found },
      };
    },
  });
}
