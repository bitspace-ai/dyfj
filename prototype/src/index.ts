/**
 * DYFJ Workbench — Main entry point
 *
 * Session flow:
 *   1. Load core memories (user + feedback) and project/reference index from Dolt
 *   2. Build system prompt — full content for core, index table for project/reference
 *   3. Run agentic loop:
 *        a. routedStream() → model call with read_memory tool available
 *        b. If model calls read_memory(), execute → inject result → re-call
 *        c. Repeat until model produces a final response (no tool calls)
 *   4. Write session_end + budget_summary events to Dolt
 *
 * Usage:
 *   bun run src/index.ts                          # default routing (gemma4)
 *   bun run src/index.ts --hint code              # route to qwen3:32b
 *   bun run src/index.ts --model claude-haiku-4-5 # explicit model (prompts for consent)
 *   bun run src/index.ts --prompt "your question"
 */

import type { Context, AssistantMessage, ToolCall } from "@mariozechner/pi-ai";
import {
  generateULID,
  generateTraceId,
  generateSpanId,
  extractText,
  extractThinking,
  writeEvent,
  normaliseStopReason,
} from "./utils";
import { routedStream, type RoutingOptions } from "./router";
import { BudgetTracker } from "./budget";
import {
  loadMemoriesByType,
  loadMemoryIndex,
  buildSystemPrompt,
  buildReadMemoryTool,
  executeReadMemory,
  buildToolResult,
} from "./memory";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string) => {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
};

const cliModel  = getArg("--model");
const cliHint   = getArg("--hint") as "code" | "chat" | "reasoning" | undefined;
const cliPrompt = getArg("--prompt") ?? "What is a workbench? One sentence.";

const routingOptions: RoutingOptions = { modelId: cliModel, hint: cliHint };

// ── Session bootstrap ─────────────────────────────────────────────────────────

const sessionId    = generateULID();
const traceId      = generateTraceId();
const sessionStart = Date.now();
const budget       = new BudgetTracker(sessionId, traceId);
const principalId  = process.env.DYFJ_PRINCIPAL_ID ?? process.env.USER ?? "user";

console.log("🔧 DYFJ Workbench\n");

await writeEvent({
  event_id:       generateULID(),
  session_id:     sessionId,
  event_type:     "session_start",
  trace_id:       traceId,
  span_id:        generateSpanId(),
  principal_id:   principalId,
  principal_type: "human",
  action:         "start",
  resource:       "session",
  authz_basis:    "user_consent",
});

// ── Memory loading ────────────────────────────────────────────────────────────

console.log("  Loading memories...");
const coreMemories = await loadMemoriesByType(["user", "feedback"]);
const memoryIndex  = await loadMemoryIndex(["project", "reference"]);

console.log(
  `  Loaded ${coreMemories.length} core memories, ` +
  `${memoryIndex.length} index entries\n`
);

// ── Build initial context ─────────────────────────────────────────────────────

const systemPrompt    = buildSystemPrompt(coreMemories, memoryIndex);
const readMemoryTool  = buildReadMemoryTool();

const context: Context = {
  systemPrompt,
  messages: [
    {
      role:      "user",
      content:   [{ type: "text", text: cliPrompt }],
      timestamp: Date.now(),
    },
  ],
  tools: [readMemoryTool],
};

// ── Agentic loop ──────────────────────────────────────────────────────────────
//
// The model may call read_memory() one or more times before producing its
// final response. Each tool call round-trips to Dolt, injects the result,
// and re-invokes the model. Capped at MAX_TOOL_TURNS to prevent loops.

const MAX_TOOL_TURNS = 5;
let spanId: string | null = null;
let finalMessage: AssistantMessage | null = null;
let turn = 0;

try {
  while (turn < MAX_TOOL_TURNS) {
    turn++;

    const { stream, selectedModel, selection } = await routedStream(
      context,
      routingOptions,
      sessionId,
      traceId,
      undefined,
      budget,
    );

    if (turn === 1) {
      console.log(`  Model:  ${selectedModel.displayName} (tier ${selectedModel.tier})`);
      console.log(`  Reason: ${selection.reason}\n`);
    }

    spanId = generateSpanId();
    let assistantMessage: AssistantMessage | null = null;

    for await (const event of stream) {
      if (event.type === "text_delta") {
        process.stdout.write(event.delta);
      }

      if (event.type === "done") {
        if (turn === 1) process.stdout.write("\n");
        assistantMessage = event.message;
        budget.record(event.message.usage, selectedModel.tier);

        await writeEvent({
          event_id:           generateULID(),
          session_id:         sessionId,
          event_type:         "model_response",
          trace_id:           traceId,
          span_id:            spanId,
          principal_id:       principalId,
          principal_type:     "agent",
          action:             "invoke",
          resource:           event.message.model,
          authz_basis:        "user_consent",
          model_id:           event.message.model,
          provider:           event.message.provider,
          api:                event.message.api,
          tokens_input:       event.message.usage.input,
          tokens_output:      event.message.usage.output,
          tokens_cache_read:  event.message.usage.cacheRead,
          tokens_cache_write: event.message.usage.cacheWrite,
          cost_total:         event.message.usage.cost.total,
          content:            extractText(event.message.content),
          stop_reason:        normaliseStopReason(event.message.stopReason),
          thinking:           extractThinking(event.message.content),
          duration_ms:        Date.now() - sessionStart,
        });
      }

      if (event.type === "error") {
        console.error("\n✗ Model error:", event.error.errorMessage ?? "unknown");
        await writeEvent({
          event_id:       generateULID(),
          session_id:     sessionId,
          event_type:     "error",
          trace_id:       traceId,
          span_id:        spanId,
          principal_id:   principalId,
          principal_type: "agent",
          action:         "invoke",
          resource:       event.error.model ?? "unknown",
          authz_basis:    "user_consent",
          model_id:       event.error.model,
          provider:       event.error.provider,
          api:            event.error.api,
          content:        event.error.errorMessage,
          stop_reason:    event.error.stopReason,
          duration_ms:    Date.now() - sessionStart,
        });
        break;
      }
    }

    if (!assistantMessage) break;

    // Check for tool calls — if none, the model is done
    const toolCalls = assistantMessage.content.filter(
      (c): c is ToolCall => c.type === "toolCall"
    );
    if (toolCalls.length === 0) {
      finalMessage = assistantMessage;
      break;
    }

    // Execute each tool call and collect results
    const toolResults = [];
    for (const tc of toolCalls) {
      if (tc.name === "read_memory") {
        const slug   = tc.arguments.slug as string;
        const result = await executeReadMemory(slug);
        const found  = !result.startsWith("Memory not found");

        console.log(`  📖 read_memory("${slug}") — ${found ? "loaded" : "not found"}`);

        await writeEvent({
          event_id:       generateULID(),
          session_id:     sessionId,
          event_type:     "tool_call",
          trace_id:       traceId,
          span_id:        generateSpanId(),
          parent_span_id: spanId,
          principal_id:   principalId,
          principal_type: "agent",
          action:         "tool_call",
          resource:       `memory:${slug}`,
          authz_basis:    "implicit",
          tool_name:      tc.name,
          tool_call_id:   tc.id,
          tool_arguments: JSON.stringify(tc.arguments),
          tool_result:    result.slice(0, 500), // truncate for storage
          tool_is_error:  !found,
        });

        toolResults.push(buildToolResult(tc.id, tc.name, result, !found));
      }
    }

    if (toolResults.length === 0) break; // no handled tool calls

    // Update context: assistant message + tool results → next turn
    context.messages.push(assistantMessage, ...toolResults);
  }

} catch (err: unknown) {
  const name = (err as Error)?.name ?? "Error";
  if (name === "ConsentDeclinedError") {
    console.log("\nConsent declined — no model call made.");
  } else if (name === "BudgetExceededError") {
    console.log(`\n✗ Budget exceeded: ${(err as Error).message}`);
  } else {
    console.error("\n✗ Unexpected error:", err);
  }
}

// ── Session end + budget summary ──────────────────────────────────────────────

await writeEvent({
  event_id:       generateULID(),
  session_id:     sessionId,
  event_type:     "session_end",
  trace_id:       traceId,
  span_id:        generateSpanId(),
  principal_id:   principalId,
  principal_type: "human",
  action:         "end",
  resource:       "session",
  authz_basis:    "user_consent",
  duration_ms:    Date.now() - sessionStart,
});

await budget.writeSummaryEvent();

const summary = budget.getSummary();
console.log(`\n  Session: ${sessionId}`);
console.log(
  `  Cost:    $${summary.totalCostUsd.toFixed(6)}` +
  `  (in: ${summary.totalTokensInput} tok, out: ${summary.totalTokensOutput} tok)`
);
