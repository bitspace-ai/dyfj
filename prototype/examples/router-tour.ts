/**
 * DYFJ Workbench — Multi-turn router integration test
 *
 * Live test covering all three tiers, heuristic routing, and error handling.
 * Run with: bun run poc/multi_turn_test.ts
 *
 * Prerequisites:
 *   - Ollama running (http://localhost:11434)
 *   - gemma4 pulled:       ollama pull gemma4
 *   - qwen3:32b pulled:    ollama pull qwen3:32b   (Turn 2 skipped if absent)
 *   - qwen3:30b-a3b pulled: ollama pull qwen3:30b-a3b (Turn 2b skipped if absent)
 *   - ANTHROPIC_API_KEY in .env (Turns 4–7 skipped if absent)
 *
 * Turn plan:
 *   1  Local default     → gemma4 (no hint)
 *   2  Local code hint   → qwen3:32b (hint:code)
 *   2b Local chat hint   → qwen3:30b-a3b (hint:chat)
 *   3  Long-context hint → gemma4 (contextLength > 100K)
 *   4  Tier 1 explicit   → claude-haiku-4-5 (prompts once, sticky)
 *   5  Tier 1 sticky     → claude-haiku-4-5 (no prompt — session grant)
 *   6  Tier 2 explicit   → claude-opus-4-5 (per-call prompt with cost estimate)
 *   7  Consent declined  → no model call, ConsentDeclinedError thrown
 *
 * After all turns: queries events table to verify the full session ledger.
 */

import type { Context } from "@mariozechner/pi-ai";
import {
  generateULID,
  generateTraceId,
  generateSpanId,
  extractText,
  doltQuery,
  writeEvent,
} from "./utils";
import {
  routedStream,
  clearRegistryCache,
  resetSessionConsent,
  ConsentDeclinedError,
  loadModelRegistry,
} from "./router";
import { BudgetTracker } from "./budget";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SESSION_ID    = generateULID();
const TRACE_ID      = generateTraceId();
const budgetTracker = new BudgetTracker(SESSION_ID, TRACE_ID);

let passed = 0;
let skipped = 0;
let failed  = 0;

function pass(label: string, detail = "") {
  console.log(`  ✓  ${label}${detail ? "  " + detail : ""}`);
  passed++;
}

function skip(label: string, reason: string) {
  console.log(`  ⊘  ${label}  (skipped: ${reason})`);
  skipped++;
}

function fail(label: string, err: unknown) {
  console.error(`  ✗  ${label}  ${err}`);
  failed++;
}

function makeContext(prompt: string, systemPrompt = "Answer in one sentence."): Context {
  return {
    systemPrompt,
    messages: [
      { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
    ],
  };
}

async function drainStream(
  stream: AsyncIterable<import("@mariozechner/pi-ai").AssistantMessageEvent>,
  tier: 0 | 1 | 2 = 0,
): Promise<{ text: string | null; model: string; cost: number }> {
  let text = "";
  let model = "";
  let cost  = 0;

  for await (const event of stream) {
    if (event.type === "text_delta") text += event.delta;
    if (event.type === "done") {
      model = event.message.model;
      cost  = event.message.usage.cost.total;
      budgetTracker.record(event.message.usage, tier);
      await writeEvent({
        event_id:           generateULID(),
        session_id:         SESSION_ID,
        event_type:         "model_response",
        trace_id:           TRACE_ID,
        span_id:            generateSpanId(),
        principal_id:       (process.env.DYFJ_PRINCIPAL_ID ?? process.env.USER ?? "user"),
        principal_type:     "agent",
        action:             "invoke",
        resource:           event.message.model,
        authz_basis:        "user_consent",
        model_id:           event.message.model,
        provider:           event.message.provider,
        api:                event.message.api,
        tokens_input:       event.message.usage.input,
        tokens_output:      event.message.usage.output,
        cost_total:         event.message.usage.cost.total,
        content:            extractText(event.message.content),
        stop_reason:        event.message.stopReason,
      });
    }
    if (event.type === "error") {
      throw new Error(`Model error: ${event.error.errorMessage ?? "unknown"}`);
    }
  }

  return { text: text.length > 0 ? text : null, model, cost };
}

// ── Check prerequisites ───────────────────────────────────────────────────────

const registry = await loadModelRegistry();
const ollamaAvailable = await (async () => {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    return res.ok;
  } catch { return false; }
})();

const ollamaModels: string[] = [];
if (ollamaAvailable) {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    const json = await res.json() as { models: { name: string }[] };
    // Keep full names (e.g. "qwen3:32b") AND base names (e.g. "qwen3")
    // so checks like registry.has("qwen3:32b") and ollamaModels.includes("qwen3:32b") both work
    for (const m of json.models) {
      ollamaModels.push(m.name);                  // "qwen3:32b"
      ollamaModels.push(m.name.split(":")[0]);    // "qwen3"  (for :latest shorthand)
    }
  } catch {}
}

const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY ||
  await (async () => {
    try {
      const text = await Bun.file(`${process.env.HOME}/.dyfj/.env`).text();
      const match = text.match(/^ANTHROPIC_API_KEY=(.+)$/m);
      if (match) { process.env.ANTHROPIC_API_KEY = match[1].trim(); return true; }
      return false;
    } catch { return false; }
  })();

console.log("DYFJ Multi-turn Router Integration Test");
console.log("─".repeat(50));
console.log(`  Ollama: ${ollamaAvailable ? "✓" : "✗ not reachable"}`);
console.log(`  Anthropic API key: ${hasAnthropicKey ? "✓" : "✗ not set (Tier 1/2 tests will skip)"}`);
console.log(`  Session: ${SESSION_ID}`);
console.log();

// ── Session start ─────────────────────────────────────────────────────────────

await writeEvent({
  event_id:       generateULID(),
  session_id:     SESSION_ID,
  event_type:     "session_start",
  trace_id:       TRACE_ID,
  span_id:        generateSpanId(),
  principal_id:   (process.env.DYFJ_PRINCIPAL_ID ?? process.env.USER ?? "user"),
  principal_type: "human",
  action:         "start",
  resource:       "session",
  authz_basis:    "user_consent",
  content:        "multi_turn_test",
});

// ── Turn 1: Local default → gemma4 ───────────────────────────────────────────

console.log("Turn 1 — Local default (gemma4)");
if (!ollamaAvailable) {
  skip("Turn 1", "Ollama not reachable");
} else {
  try {
    const { stream, selectedModel, selection } = await routedStream(
      makeContext("What is a workbench? One sentence."),
      {}, // no hint — default routing
      SESSION_ID, TRACE_ID, undefined, budgetTracker,
    );
    const { text, model } = await drainStream(stream, selectedModel.tier);

    if (selection.reason !== "default") fail("Turn 1: reason", `expected 'default', got '${selection.reason}'`);
    else if (selectedModel.slug !== "gemma4") fail("Turn 1: model", `expected 'gemma4', got '${selectedModel.slug}'`);
    else if (!text) fail("Turn 1: response", "empty response");
    else pass("Turn 1", `gemma4 → "${text.slice(0, 60)}..."`);
  } catch (e) { fail("Turn 1", e); }
}

// ── Turn 2: Local code hint → qwen3:32b ──────────────────────────────────────

console.log("\nTurn 2 — Code hint (qwen3:32b)");
const hasQwen32b = ollamaModels.includes("qwen3:32b");
if (!ollamaAvailable) {
  skip("Turn 2", "Ollama not reachable");
} else if (!hasQwen32b) {
  skip("Turn 2", "qwen3:32b not pulled — run: ollama pull qwen3:32b");
} else {
  try {
    const { stream, selectedModel, selection } = await routedStream(
      makeContext("Write a one-line TypeScript function that doubles a number."),
      { hint: "code" },
      SESSION_ID, TRACE_ID, undefined, budgetTracker,
    );
    const { text } = await drainStream(stream, selectedModel.tier);

    const expectedReason = hasQwen32b ? "hint_code" : "hint_code_fallback_gemma4";
    if (!["hint_code", "hint_code_fallback_gemma4"].includes(selection.reason))
      fail("Turn 2: reason", `unexpected reason: '${selection.reason}'`);
    else if (!text)
      fail("Turn 2: response", "empty response");
    else
      pass("Turn 2", `${selectedModel.slug} [${selection.reason}] → "${text.slice(0, 60)}..."`);
  } catch (e) { fail("Turn 2", e); }
}

// ── Turn 2b: Local chat hint → qwen3:30b-a3b ─────────────────────────────────

console.log("\nTurn 2b — Chat hint (qwen3:30b-a3b)");
const hasQwenMoE = ollamaModels.includes("qwen3:30b-a3b");
if (!ollamaAvailable) {
  skip("Turn 2b", "Ollama not reachable");
} else if (!hasQwenMoE) {
  skip("Turn 2b", "qwen3:30b-a3b not pulled — run: ollama pull qwen3:30b-a3b");
} else {
  try {
    const { stream, selectedModel, selection } = await routedStream(
      makeContext("Say hello in one word."),
      { hint: "chat" },
      SESSION_ID, TRACE_ID, undefined, budgetTracker,
    );
    const { text } = await drainStream(stream, selectedModel.tier);

    if (!["hint_chat_speed", "hint_chat_fallback_gemma4"].includes(selection.reason))
      fail("Turn 2b: reason", `unexpected: '${selection.reason}'`);
    else if (!text)
      fail("Turn 2b: response", "empty response");
    else
      pass("Turn 2b", `${selectedModel.slug} [${selection.reason}] → "${text.trim()}"`);
  } catch (e) { fail("Turn 2b", e); }
}

// ── Turn 3: Long-context heuristic → gemma4 ──────────────────────────────────

console.log("\nTurn 3 — Long-context heuristic (contextLength > 100K → gemma4)");
if (!ollamaAvailable) {
  skip("Turn 3", "Ollama not reachable");
} else {
  try {
    const { stream, selectedModel, selection } = await routedStream(
      makeContext("Summarise this document in one sentence: " + "word ".repeat(200)),
      { contextLength: 101_000 },
      SESSION_ID, TRACE_ID, undefined, budgetTracker,
    );
    const { text } = await drainStream(stream, selectedModel.tier);

    if (selection.reason !== "context_length_gt_100k")
      fail("Turn 3: reason", `expected 'context_length_gt_100k', got '${selection.reason}'`);
    else if (selectedModel.slug !== "gemma4")
      fail("Turn 3: model", `expected 'gemma4', got '${selectedModel.slug}'`);
    else
      pass("Turn 3", `gemma4 [long-context] → "${(text ?? "").slice(0, 60)}..."`);
  } catch (e) { fail("Turn 3", e); }
}

// ── Turn 4: Tier 1 escalation (first time → prompts) ─────────────────────────

console.log("\nTurn 4 — Tier 1 escalation, first call (claude-haiku-4-5)");
if (!hasAnthropicKey) {
  skip("Turn 4", "ANTHROPIC_API_KEY not set");
} else {
  resetSessionConsent(); // ensure clean state for this test
  let prompted = false;
  try {
    const { stream, selectedModel } = await routedStream(
      makeContext("What is 2 + 2?"),
      { tier: 1 },
      SESSION_ID, TRACE_ID,
      async (msg) => { prompted = true; console.log(`    [consent] ${msg.trim()}`); return true; },
      budgetTracker,
    );
    const { cost } = await drainStream(stream, selectedModel.tier);

    if (!prompted) fail("Turn 4: consent", "expected prompt but none fired");
    else if (selectedModel.slug !== "claude-haiku-4-5") fail("Turn 4: model", selectedModel.slug);
    else if (cost <= 0) fail("Turn 4: cost", `expected cost > 0 for API model, got ${cost}`);
    else pass("Turn 4", `haiku-4-5, cost=$${cost.toFixed(6)}, session grant set`);
  } catch (e) {
    if (e instanceof ConsentDeclinedError) fail("Turn 4", "consent declined unexpectedly");
    else fail("Turn 4", e);
  }
}

// ── Turn 5: Tier 1 sticky (no prompt) ────────────────────────────────────────

console.log("\nTurn 5 — Tier 1 sticky (no prompt — session consent carried over)");
if (!hasAnthropicKey) {
  skip("Turn 5", "ANTHROPIC_API_KEY not set");
} else {
  let prompted = false;
  try {
    const { stream, selectedModel } = await routedStream(
      makeContext("What is 3 + 3?"),
      { tier: 1 },
      SESSION_ID, TRACE_ID,
      async (_msg) => { prompted = true; return true; },
      budgetTracker,
    );
    await drainStream(stream, selectedModel.tier);

    if (prompted) fail("Turn 5: sticky", "promptFn was called — session grant not sticky");
    else pass("Turn 5", `haiku-4-5, no consent prompt (session grant sticky)`);
  } catch (e) { fail("Turn 5", e); }
}

// ── Turn 6: Tier 2 per-call prompt ───────────────────────────────────────────

console.log("\nTurn 6 — Tier 2 per-call consent (claude-opus-4-5)");
if (!hasAnthropicKey) {
  skip("Turn 6", "ANTHROPIC_API_KEY not set");
} else {
  let prompted = false;
  try {
    const { stream, selectedModel } = await routedStream(
      makeContext("What is 4 + 4?"),
      { modelId: "claude-opus-4-5" },
      SESSION_ID, TRACE_ID,
      async (msg) => {
        prompted = true;
        console.log(`    [consent] ${msg.trim()}`);
        return true; // accept
      },
      budgetTracker,
    );
    const { cost } = await drainStream(stream, selectedModel.tier);

    if (!prompted) fail("Turn 6: consent", "Tier 2 should always prompt");
    else if (cost <= 0) fail("Turn 6: cost", `expected cost > 0 for Tier 2, got ${cost}`);
    else pass("Turn 6", `opus-4-5, cost=$${cost.toFixed(6)}, per-call prompt fired`);
  } catch (e) { fail("Turn 6", e); }
}

// ── Turn 7: Consent declined ──────────────────────────────────────────────────

console.log("\nTurn 7 — Consent declined (Tier 2)");
if (!hasAnthropicKey) {
  skip("Turn 7", "ANTHROPIC_API_KEY not set (consent gate still works without it)");
}
// This turn works regardless of API key — ConsentDeclinedError thrown before any API call
try {
  await routedStream(
    makeContext("What is 5 + 5?"),
    { modelId: "claude-opus-4-5" },
    SESSION_ID, TRACE_ID,
    async (_msg) => false // decline
  );
  fail("Turn 7", "should have thrown ConsentDeclinedError");
} catch (e) {
  if (e instanceof ConsentDeclinedError) {
    pass("Turn 7", `ConsentDeclinedError thrown for ${e.slug}, no model call made`);
  } else {
    fail("Turn 7", e);
  }
}

// ── Session end ───────────────────────────────────────────────────────────────

await writeEvent({
  event_id:       generateULID(),
  session_id:     SESSION_ID,
  event_type:     "session_end",
  trace_id:       TRACE_ID,
  span_id:        generateSpanId(),
  principal_id:   (process.env.DYFJ_PRINCIPAL_ID ?? process.env.USER ?? "user"),
  principal_type: "human",
  action:         "end",
  resource:       "session",
  authz_basis:    "user_consent",
});

await budgetTracker.writeSummaryEvent();

const finalSummary = budgetTracker.getSummary();
console.log(`\nBudget summary: $${finalSummary.totalCostUsd.toFixed(6)} total  (in: ${finalSummary.totalTokensInput} tok, out: ${finalSummary.totalTokensOutput} tok)`);
for (const [tier, spend] of Object.entries(finalSummary.byTier)) {
  console.log(`  Tier ${tier}: ${spend.calls} call(s), $${spend.costUsd.toFixed(6)}`);
}

// ── DB verification ───────────────────────────────────────────────────────────

console.log("\n─".repeat(50));
console.log("Events for this session:\n");

const rows = await doltQuery(
  `SELECT event_type, model_id, cost_total, SUBSTRING(content, 1, 60) AS content_preview ` +
  `FROM events WHERE session_id = '${SESSION_ID}' ORDER BY created_at;`
);
for (const row of rows) {
  const cost = row.cost_total ? `  $${parseFloat(row.cost_total).toFixed(6)}` : "";
  const model = row.model_id ? `  [${row.model_id}]` : "";
  console.log(`  ${row.event_type.padEnd(18)}${model}${cost}`);
  if (row.content_preview) console.log(`    ${row.content_preview}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("\n" + "─".repeat(50));
console.log(`  ${passed} passed  ${skipped} skipped  ${failed} failed`);

if (failed > 0) process.exit(1);
