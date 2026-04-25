/**
 * Tests for the dyfj-memory pi extension logic
 *
 * The extension itself is thin wiring — the substantive logic lives in
 * memory.ts (tested in memory.test.ts + memory.integration.test.ts),
 * budget.ts (tested in budget.test.ts), and utils.ts (tested in utils.test.ts).
 *
 * What we test here:
 *   - The tier inference heuristic (provider → 0|1|2)
 *   - The tool result text extraction pattern used in tool_result handler
 *   - The content extraction pattern for model_response events
 *   - That the session reset logic produces fresh IDs each time
 *   - The fire-and-forget error handling contract
 */

import { test, expect, describe } from "bun:test";
import { extractText, extractThinking, normaliseStopReason, generateULID, generateTraceId } from "./utils";
import { BudgetTracker } from "./budget";

// ── Tier inference (mirrors extension logic) ──────────────────────────────────

function inferTier(provider: string): 0 | 1 | 2 {
  return provider === "ollama" ? 0 : 1;
}

describe("tier inference from provider", () => {
  test("ollama → tier 0 (free)", () => {
    expect(inferTier("ollama")).toBe(0);
  });

  test("anthropic → tier 1 (API)", () => {
    expect(inferTier("anthropic")).toBe(1);
  });

  test("google → tier 1 (API)", () => {
    expect(inferTier("google")).toBe(1);
  });

  test("openai → tier 1 (API)", () => {
    expect(inferTier("openai")).toBe(1);
  });

  test("unknown provider → tier 1 (safe default)", () => {
    expect(inferTier("some-unknown-provider")).toBe(1);
  });
});

// ── Tool result content extraction (mirrors tool_result handler) ──────────────

function extractToolResultText(
  content: { type: string; text?: string }[],
  limit = 500,
): string | null {
  const text = content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map(c => c.text)
    .join("")
    .slice(0, limit);
  return text || null;
}

describe("tool result text extraction", () => {
  test("extracts text from a single text content item", () => {
    const content = [{ type: "text", text: "result output" }];
    expect(extractToolResultText(content)).toBe("result output");
  });

  test("concatenates multiple text items", () => {
    const content = [
      { type: "text", text: "part one " },
      { type: "text", text: "part two" },
    ];
    expect(extractToolResultText(content)).toBe("part one part two");
  });

  test("ignores non-text content items (images)", () => {
    const content = [
      { type: "image", data: "base64..." },
      { type: "text", text: "actual text" },
    ];
    expect(extractToolResultText(content)).toBe("actual text");
  });

  test("returns null for empty content array", () => {
    expect(extractToolResultText([])).toBeNull();
  });

  test("returns null for content with no text items", () => {
    expect(extractToolResultText([{ type: "image", data: "..." }])).toBeNull();
  });

  test("truncates at the specified limit", () => {
    const content = [{ type: "text", text: "a".repeat(1000) }];
    expect(extractToolResultText(content, 500)).toHaveLength(500);
  });

  test("default limit is 500 chars", () => {
    const content = [{ type: "text", text: "x".repeat(600) }];
    const result = extractToolResultText(content);
    expect(result).toHaveLength(500);
  });
});

// ── model_response content extraction (reuses utils functions) ───────────────

describe("model_response content extraction from AgentMessage", () => {
  // AgentMessage.content has same shape as AssistantMessage.content —
  // confirmed from large-session.jsonl fixture: { type, text } | { type, toolCall }

  test("extractText gets text from assistant message content", () => {
    const content = [
      { type: "text" as const, text: "Here is my answer." },
    ];
    expect(extractText(content)).toBe("Here is my answer.");
  });

  test("extractText ignores toolCall content items", () => {
    const content = [
      { type: "toolCall" as const, id: "tc1", name: "bash", arguments: {} },
      { type: "text" as const, text: "Running the command." },
    ];
    expect(extractText(content)).toBe("Running the command.");
  });

  test("extractText returns null when only tool calls are present", () => {
    const content = [
      { type: "toolCall" as const, id: "tc1", name: "read", arguments: {} },
    ];
    expect(extractText(content)).toBeNull();
  });

  test("extractThinking captures thinking blocks", () => {
    const content = [
      { type: "thinking" as const, thinking: "Let me reason about this..." },
      { type: "text" as const, text: "Final answer." },
    ];
    expect(extractThinking(content)).toBe("Let me reason about this...");
  });

  test("extractThinking returns null when no thinking blocks", () => {
    const content = [{ type: "text" as const, text: "Direct answer." }];
    expect(extractThinking(content)).toBeNull();
  });

  test("normaliseStopReason maps toolUse → tool_use for Dolt ENUM", () => {
    expect(normaliseStopReason("toolUse")).toBe("tool_use");
    expect(normaliseStopReason("stop")).toBe("stop");
    expect(normaliseStopReason(null)).toBeNull();
  });
});

// ── Session reset (mirrors session_start handler) ─────────────────────────────

describe("session state reset on session_start", () => {
  test("each reset produces a new unique session ID", () => {
    const id1 = generateULID();
    const id2 = generateULID();
    expect(id1).not.toBe(id2);
    expect(id1).toHaveLength(26);
    expect(id2).toHaveLength(26);
  });

  test("each reset produces a new unique trace ID", () => {
    const t1 = generateTraceId();
    const t2 = generateTraceId();
    expect(t1).not.toBe(t2);
    expect(t1).toMatch(/^[0-9a-f]{32}$/);
  });

  test("new BudgetTracker starts at zero cost", () => {
    const tracker = new BudgetTracker("sess1", "trace1");
    expect(tracker.totalCost).toBe(0);
    expect(tracker.totalCalls).toBe(0);
  });

  test("resetting produces a tracker independent of the previous one", () => {
    const t1 = new BudgetTracker("sess1", "trace1");
    t1.record({ input: 100, output: 50, cost: { total: 0.01 } }, 1);

    const t2 = new BudgetTracker("sess2", "trace2");
    expect(t2.totalCost).toBe(0);   // fresh tracker, not accumulated
    expect(t1.totalCost).toBeCloseTo(0.01); // old tracker unchanged
  });
});

// ── Budget accumulation across a typical pi session ───────────────────────────

describe("budget accumulation for a pi session", () => {
  test("records multiple model responses and accumulates cost", () => {
    const tracker = new BudgetTracker("sess", "trace");
    // Simulate 3 assistant messages in a session
    tracker.record({ input: 500,  output: 300, cost: { total: 0.004 } }, 1);
    tracker.record({ input: 1000, output: 800, cost: { total: 0.009 } }, 1);
    tracker.record({ input: 200,  output: 100, cost: { total: 0.0015 } }, 1);

    expect(tracker.totalCalls).toBe(3);
    expect(tracker.totalCost).toBeCloseTo(0.0145);
    expect(tracker.totalTokensInput).toBe(1700);
    expect(tracker.totalTokensOutput).toBe(1200);
  });

  test("buildSummaryEventPayload carries all session totals", () => {
    const tracker = new BudgetTracker("sess-xyz", "trace-abc");
    tracker.record({ input: 300, output: 200, cost: { total: 0.003 } }, 1);

    const payload = tracker.buildSummaryEventPayload({
      eventId: "FIXED_ID",
      spanId:  "FIXED_SPAN",
    });

    expect(payload.event_type).toBe("budget_summary");
    expect(payload.session_id).toBe("sess-xyz");
    expect(payload.tokens_input).toBe(300);
    expect(payload.tokens_output).toBe(200);
    expect(payload.cost_total as number).toBeCloseTo(0.003);

    const content = JSON.parse(payload.content as string);
    expect(content.byTier["1"].calls).toBe(1);
    expect(content.byTier["1"].costUsd).toBeCloseTo(0.003);
  });
});
