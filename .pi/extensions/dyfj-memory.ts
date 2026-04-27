/**
 * DYFJ Workbench — pi session extension (MCP-backed)
 *
 * All Dolt logic lives in the dyfj-memory MCP server.
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
import { DyfjMcpClient, type Phase, type EffortLevel } from "../../src/mcp-client";
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
      `FROM memories WHERE type IN ('user', 'feedback', 'environment') ORDER BY type, slug;`
    ),
    doltQuery(
      `SELECT slug, type, name, description ` +
      `FROM memories WHERE type IN ('project', 'reference') ORDER BY type, slug;`
    ),
  ]);

  const core: Memory[] = coreRows.map((r) => ({
    memoryId:    r.memory_id,
    slug:        r.slug,
    type:        r.type as Memory["type"],
    name:        r.name,
    description: r.description,
    content:     r.content,
  }));

  const index: MemoryIndexEntry[] = indexRows.map((r) => ({
    slug:        r.slug,
    type:        r.type as MemoryIndexEntry["type"],
    name:        r.name,
    description: r.description,
  }));

  return { core, index };
}

// ── Extension ─────────────────────────────────────────────────────────────────

// ── Dynamic environment discovery ───────────────────────────────────────────
//
// Probes the live environment at session_start and returns a markdown block
// appended to the system prompt. Complements the static 'environment' memories
// in Dolt — those carry authored facts (commands, paths, conventions); this
// carries live state (services up/down, loaded models).
//
// Implementation-specific: lives here, not in memory.ts. Discovery probes
// local tooling and has no place in the framework layer.

async function discoverLiveEnvironment(pi: ExtensionAPI): Promise<string> {
  const TIMEOUT = 3000;
  const exec = (cmd: string, args: string[]) =>
    pi.exec(cmd, args, { timeout: TIMEOUT }).catch(() => ({ code: 1, stdout: "", stderr: "", killed: false }));

  const [doltProc, ollamaProc, doltPath, ollamaPath, bunPath] = await Promise.all([
    exec("pgrep", ["-x", "dolt"]),
    exec("pgrep", ["-x", "ollama"]),
    exec("which", ["dolt"]),
    exec("which", ["ollama"]),
    exec("which", ["bun"]),
  ]);

  const doltRunning   = doltProc.code   === 0;
  const ollamaRunning = ollamaProc.code === 0;

  const lines: string[] = [
    "---",
    "",
    "## Current Environment Status",
    "",
    "**Services:**",
    `- Dolt sql-server: ${doltRunning   ? "✓ running" : "✗ not running"}`,
    `- Ollama:          ${ollamaRunning ? "✓ running" : "✗ not running"}`,
  ];

  if (ollamaRunning) {
    const list = await exec("ollama", ["list"]);
    if (list.code === 0) {
      const models = list.stdout.trim().split("\n").slice(1).filter(Boolean);
      if (models.length > 0) {
        lines.push("");
        lines.push("**Loaded Ollama models:**");
        for (const line of models) {
          const name = line.split(/\s+/)[0];
          if (name) lines.push(`- ${name}`);
        }
      }
    }
  }

  const paths: string[] = [];
  if (doltPath.code   === 0) paths.push(`- dolt:   ${doltPath.stdout.trim()}`);
  if (ollamaPath.code === 0) paths.push(`- ollama: ${ollamaPath.stdout.trim()}`);
  if (bunPath.code    === 0) paths.push(`- bun:    ${bunPath.stdout.trim()}`);
  if (paths.length > 0) {
    lines.push("");
    lines.push("**Tool paths (verified this session):**");
    lines.push(...paths);
  }

  return lines.join("\n");
}

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

    // Auto-create a Dolt session record via MCP
    if (mcpClient) {
      mcpClient.startSession("pi session", undefined, undefined)
        .then((s) => { doltSessionId = s.session_id; })
        .catch((err) => ctx.ui.notify(`DYFJ: start_session failed: ${err}`, "error"));
    }

    // Load memories and build system prompt
    ctx.ui.setStatus("dyfj", "Loading memories…");
    try {
      const [{ core, index }, envStatus] = await Promise.all([
        loadMemoriesViaMcp(),
        discoverLiveEnvironment(pi),
      ]);
      const prompt = buildSystemPrompt(core, index);

      // Append session context so model knows its session_id for update_session() calls
      const sessionHeader = doltSessionId
        ? `\n\n---\n\n**Active Session:** \`${doltSessionId}\` — use this ID with \`update_session()\` to track Algorithm progress.\n`
        : "";

      cachedPrompt = prompt + sessionHeader + "\n\n" + envStatus;
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

  // ── update_session tool ──────────────────────────────────────────────

  pi.registerTool({
    name: "update_session",
    label: "Update Session",
    description:
      "Write a phase transition or progress update to the active Dolt session. " +
      "Call at every Algorithm phase boundary and after each criterion passes. " +
      "Use the session_id from your system prompt.",
    promptSnippet: "Write Algorithm phase transition to Dolt session",
    parameters: Type.Object({
      session_id:     Type.String({ description: "Session ID from your system prompt" }),
      phase:          Type.Union(
        ["observe","think","plan","build","execute","verify","learn","complete"]
          .map(p => Type.Literal(p as Phase)),
        { description: "Current Algorithm phase" }
      ),
      progress_done:  Type.Number({ description: "Number of ISC criteria passing" }),
      progress_total: Type.Number({ description: "Total ISC criteria count" }),
      content:        Type.Optional(Type.String({ description: "ISC criteria, decisions, and verification notes as markdown" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!mcpClient) {
        return { content: [{ type: "text", text: "MCP client not connected" }], details: { ok: false } };
      }
      const result = await mcpClient.updateSession(
        params.session_id,
        params.phase as Phase,
        params.progress_done,
        params.progress_total,
        params.content,
      );
      return { content: [{ type: "text", text: result }], details: { ok: true } };
    },
  });

  // ── write_reflection tool ────────────────────────────────────────────

  pi.registerTool({
    name: "write_reflection",
    label: "Write Reflection",
    description:
      "Write end-of-session reflection to Dolt at the Algorithm LEARN phase. " +
      "Mandatory for Standard+ effort. Feeds aggregate analysis and Algorithm improvement.",
    promptSnippet: "Write Algorithm LEARN phase reflection to Dolt",
    parameters: Type.Object({
      session_slug:         Type.String({ description: "Session slug from the session record" }),
      effort_level:         Type.Union(
        ["standard","extended","advanced","deep","comprehensive"]
          .map(e => Type.Literal(e as EffortLevel)),
        { description: "Effort tier used for this session" }
      ),
      task_description:     Type.String({ description: "8-word task description" }),
      criteria_count:       Type.Number({ description: "Total ISC criteria" }),
      criteria_passed:      Type.Number({ description: "Criteria passing at VERIFY" }),
      criteria_failed:      Type.Number({ description: "Criteria failing at VERIFY" }),
      within_budget:        Type.Boolean({ description: "Did work finish within effort tier time budget?" }),
      implied_sentiment:    Type.Optional(Type.Number({ description: "Estimated user satisfaction 1-10 from conversation tone" })),
      reflection_execution: Type.String({ description: "What to do differently in execution" }),
      reflection_approach:  Type.String({ description: "What a smarter algorithm would have done" }),
      reflection_gaps:      Type.String({ description: "Missing capabilities or tools" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!mcpClient) {
        return { content: [{ type: "text", text: "MCP client not connected" }], details: { ok: false } };
      }
      const result = await mcpClient.writeReflection({
        session_slug:         params.session_slug,
        effort_level:         params.effort_level as EffortLevel,
        task_description:     params.task_description,
        criteria_count:       params.criteria_count,
        criteria_passed:      params.criteria_passed,
        criteria_failed:      params.criteria_failed,
        within_budget:        params.within_budget,
        implied_sentiment:    params.implied_sentiment,
        reflection_execution: params.reflection_execution,
        reflection_approach:  params.reflection_approach,
        reflection_gaps:      params.reflection_gaps,
      });
      return { content: [{ type: "text", text: result }], details: { ok: true } };
    },
  });
}
