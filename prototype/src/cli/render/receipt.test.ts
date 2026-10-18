import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { turnResult as result } from "../../../testing/builders/turn-client.ts";
import type { TurnResult } from "../turn-client.ts";
import { formatReceipt } from "./receipt.ts";

describe("presentation", () => {
  it("[case 25 footer] formatReceipt reports ACP history omission provenance and counts", () => {
    const external: TurnResult = {
      sessionId: "01CLISESSION0000000000000000",
      traceId: "0123456789abcdef0123456789abcdef",
      stopReason: "stop",
      text: "fixture output",
      receipt: "External-agent turn receipt",
      runner: {
        kind: "external_agent",
        profile: "fixture",
        protocol: "acp",
        protocolVersion: 1,
        externalStopReason: "end_turn",
        externalSessionId: "fixture-1",
        capabilities: [],
        workspace: "/tmp/workspace",
        transport: "local_stdio",
        accessRoute: "local_sidecar",
        costBasis: "local_free",
        continuity: {
          state: "reconstructed",
          claimSource: "workbench_observed",
          durableResume: "unavailable-client-verification",
          priorMessagesProjected: 4,
          toolExchangesProjected: 1,
          priorExternalSessionId: "fixture-previous",
        },
        evidence: {
          source: "acp",
          innerState: "opaque",
          toolchainDirectoryCount: 0,
          routeSource: "profile_declared",
        },
        toolEvidence: {
          status: "complete",
          observedCalls: 0,
          recordedCalls: 0,
        },
        elapsedMs: 12,
      },
      route: { reason: "explicit_external_agent" },
      context: { sources: [] },
      historyOmission: {
        detectedInHistory: 1,
        malformedToolRecords: 0,
        gapMarkers: 1,
        callsUnknown: true,
        withheldFromProjection: 1,
        projectedPairs: 0,
        historyDelivery: "projected-transcript",
        noticeIncluded: true,
      },
    };
    const formatted = formatReceipt(external, false);
    assert.ok(
      formatted.includes("fixture · acp v1 · local_stdio · local_sidecar · $0"),
      `expected ${
        JSON.stringify(formatted)
      } to include "fixture · acp v1 · local_stdio · local_sidecar · $0"`,
    );
    assert.ok(
      formatted.includes("· 12ms · explicit_external_agent"),
      `expected ${
        JSON.stringify(formatted)
      } to include "· 12ms · explicit_external_agent"`,
    );
    assert.ok(!formatted.includes("tok"));
    assert.ok(
      formatted.includes(
        "continuity reconstructed 4msg/1tool · native session replaced · ACP tools 0/0 recorded",
      ),
      `expected ${
        JSON.stringify(formatted)
      } to include "continuity reconstructed 4msg/1tool · native session replaced · ACP tools 0/0 recorded"`,
    );
    assert.ok(
      formatted.includes("Tool evidence withheld: 1 record"),
      `expected ${
        JSON.stringify(formatted)
      } to include "Tool evidence withheld: 1 record"`,
    );
    assert.ok(
      formatted.includes("number of lost calls unknown (possibly zero)"),
      `expected ${
        JSON.stringify(formatted)
      } to include "number of lost calls unknown (possibly zero)"`,
    );
    assert.ok(
      formatted.includes("history delivery projected-transcript"),
      `expected ${
        JSON.stringify(formatted)
      } to include "history delivery projected-transcript"`,
    );
    assert.ok(
      formatted.includes("notice composed for this request"),
      `expected ${
        JSON.stringify(formatted)
      } to include "notice composed for this request"`,
    );
    assert.ok(!formatted.includes("notice included yes"));
  });

  it("[case 15 footer] formatReceipt exposes native omission facts", () => {
    const formatted = formatReceipt(
      result({
        historyOmission: {
          detectedInHistory: 2,
          malformedToolRecords: 2,
          gapMarkers: 0,
          callsUnknown: false,
          withheldFromProjection: 1,
          projectedPairs: 4,
          historyDelivery: "projected-transcript",
          noticeIncluded: true,
        },
      }),
      false,
    );
    assert.ok(
      formatted.includes("Tool evidence withheld: 2 records"),
      `expected ${
        JSON.stringify(formatted)
      } to include "Tool evidence withheld: 2 records"`,
    );
    assert.ok(
      formatted.includes("2 malformed tool records"),
      `expected ${
        JSON.stringify(formatted)
      } to include "2 malformed tool records"`,
    );
    assert.ok(
      formatted.includes("selected window 1"),
      `expected ${JSON.stringify(formatted)} to include "selected window 1"`,
    );
    assert.ok(
      formatted.includes("valid projected pairs 4"),
      `expected ${
        JSON.stringify(formatted)
      } to include "valid projected pairs 4"`,
    );
    assert.ok(
      formatted.includes("notice composed for this request"),
      `expected ${
        JSON.stringify(formatted)
      } to include "notice composed for this request"`,
    );
    assert.ok(!formatted.includes("notice included yes"));
  });

  it("formatReceipt shows ACP usage while preserving its cost semantics", () => {
    const external = {
      sessionId: "01CLISESSION0000000000000000",
      traceId: "0123456789abcdef0123456789abcdef",
      stopReason: "stop" as const,
      text: "fixture output",
      receipt: "External-agent turn receipt",
      runner: {
        kind: "external_agent" as const,
        profile: "codex-chatgpt",
        protocol: "acp" as const,
        protocolVersion: 1,
        capabilities: [],
        workspace: "/tmp/workspace",
        transport: "local_stdio" as const,
        accessRoute: "subscription_oauth" as const,
        costBasis: "subscription_quota" as const,
        evidence: {
          source: "acp" as const,
          innerState: "opaque" as const,
          toolchainDirectoryCount: 0 as const,
        },
        toolEvidence: {
          status: "complete" as const,
          observedCalls: 0,
          recordedCalls: 0,
        },
        usage: {
          source: "acp" as const,
          stability: "unstable" as const,
          total: 1_250,
          input: 1_000,
          output: 200,
          reasoning: 50,
        },
        contextWindow: { source: "acp" as const, used: 1_250, size: 8_192 },
        elapsedMs: 12,
      },
      route: { reason: "explicit_external_agent" },
      context: { sources: [] },
    } satisfies TurnResult;
    const formatted = formatReceipt(external, false);
    assert.ok(
      formatted.includes("subscription quota (USD not reported)"),
      `expected ${
        JSON.stringify(formatted)
      } to include "subscription quota (USD not reported)"`,
    );
    assert.ok(
      formatted.includes("1,000→200 tok (+50 reasoning)"),
      `expected ${
        JSON.stringify(formatted)
      } to include "1,000→200 tok (+50 reasoning)"`,
    );
    assert.ok(
      formatted.includes("ctx 1,250/8,192"),
      `expected ${JSON.stringify(formatted)} to include "ctx 1,250/8,192"`,
    );
  });

  it("formatReceipt names the model and token counts", () => {
    const s = formatReceipt(result(), false);
    assert.ok(
      s.includes("Qwen3 Coder 30B"),
      `expected ${JSON.stringify(s)} to include "Qwen3 Coder 30B"`,
    );
    assert.ok(
      s.includes("12→5 tok"),
      `expected ${JSON.stringify(s)} to include "12→5 tok"`,
    );
    assert.ok(
      s.includes("tools 0/32"),
      `expected ${JSON.stringify(s)} to include "tools 0/32"`,
    );
  });
  it("formatReceipt names a reached tool-step limit", () => {
    assert.ok(
      formatReceipt(
        result({
          agent: { toolStepsUsed: 2, maxToolSteps: 2, limitReached: true },
        }),
        false,
      ).includes("tools 2/2 (limit reached)"),
      `expected formatReceipt(
        result({
          agent: { toolStepsUsed: 2, maxToolSteps: 2, limitReached: true },
        }),
        false,
      ) to include "tools 2/2 (limit reached)"`,
    );
  });
  it("formatReceipt shows the runtime's session figure in a REPL", () => {
    // The runtime's figure is the one its spending envelope checks; it counts
    // turns this REPL never saw complete, so it wins over the running sum.
    const paid = result({
      cost: {
        estimatedUsd: 0,
        totalUsd: 0.0123,
        sessionUsd: 3.21,
        paidInferenceUsed: true,
      },
    });
    assert.ok(
      formatReceipt(paid, false, 1.0404).includes("$0.0123 · session $3.2100"),
      formatReceipt(paid, false, 1.0404),
    );
    // One-shot receipts (no REPL total passed) stay unchanged.
    assert.ok(!(formatReceipt(paid, false)).includes("session"));
  });
  it("formatReceipt labels the REPL's own sum when the runtime sends no session figure", () => {
    const paid = result({
      cost: { estimatedUsd: 0, totalUsd: 0.0123, paidInferenceUsed: true },
    });
    assert.ok(
      formatReceipt(paid, false, 0.0456).includes(
        "$0.0123 · repl total $0.0456",
      ),
      formatReceipt(paid, false, 0.0456),
    );
    assert.ok(formatReceipt(result(), false, 0).includes("repl total $0"));
  });
  it("formatReceipt shows reasoning tokens only when reported", () => {
    const withReasoning = result({
      tokens: {
        input: 12,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 256,
        totalCalls: 1,
      },
    });
    assert.ok(
      formatReceipt(withReasoning, false).includes("12→5 tok (+256 reasoning)"),
      `expected formatReceipt(withReasoning, false) to include "12→5 tok (+256 reasoning)"`,
    );
    assert.ok(!(formatReceipt(result(), false)).includes("reasoning"));
  });
  it("formatReceipt shows prompt-cache tokens only when reported", () => {
    const cached = result({
      tokens: {
        input: 12,
        output: 5,
        cacheRead: 9_000,
        cacheWrite: 100,
        totalCalls: 1,
      },
    });
    assert.ok(
      formatReceipt(cached, false).includes(
        "12→5 tok · cache 9,000 read, 100 write",
      ),
      `expected formatReceipt(cached, false) to include "12→5 tok · cache 9,000 read, 100 write"`,
    );
    const readOnly = result({
      tokens: {
        input: 12,
        output: 5,
        cacheRead: 40,
        cacheWrite: 0,
        totalCalls: 1,
      },
    });
    assert.ok(
      formatReceipt(readOnly, false).includes("12→5 tok · cache 40 read ·"),
      `expected formatReceipt(readOnly, false) to include "12→5 tok · cache 40 read ·"`,
    );
    assert.ok(!(formatReceipt(result(), false)).includes("cache"));
  });
});
