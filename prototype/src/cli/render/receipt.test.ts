import { assertFalse, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
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
    assertStringIncludes(
      formatted,
      "fixture · acp v1 · local_stdio · local_sidecar · $0",
    );
    assertStringIncludes(formatted, "· 12ms · explicit_external_agent");
    assertFalse(formatted.includes("tok"));
    assertStringIncludes(
      formatted,
      "continuity reconstructed 4msg/1tool · native session replaced · ACP tools 0/0 recorded",
    );
    assertStringIncludes(formatted, "Tool evidence withheld: 1 record");
    assertStringIncludes(
      formatted,
      "number of lost calls unknown (possibly zero)",
    );
    assertStringIncludes(formatted, "history delivery projected-transcript");
    assertStringIncludes(formatted, "notice composed for this request");
    assertFalse(formatted.includes("notice included yes"));
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
    assertStringIncludes(formatted, "Tool evidence withheld: 2 records");
    assertStringIncludes(formatted, "2 malformed tool records");
    assertStringIncludes(formatted, "selected window 1");
    assertStringIncludes(formatted, "valid projected pairs 4");
    assertStringIncludes(formatted, "notice composed for this request");
    assertFalse(formatted.includes("notice included yes"));
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
    assertStringIncludes(formatted, "subscription quota (USD not reported)");
    assertStringIncludes(formatted, "1,000→200 tok (+50 reasoning)");
    assertStringIncludes(formatted, "ctx 1,250/8,192");
  });

  it("formatReceipt names the model and token counts", () => {
    const s = formatReceipt(result(), false);
    assertStringIncludes(s, "Qwen3 Coder 30B");
    assertStringIncludes(s, "12→5 tok");
    assertStringIncludes(s, "tools 0/32");
  });
  it("formatReceipt names a reached tool-step limit", () => {
    assertStringIncludes(
      formatReceipt(
        result({
          agent: { toolStepsUsed: 2, maxToolSteps: 2, limitReached: true },
        }),
        false,
      ),
      "tools 2/2 (limit reached)",
    );
  });
  it("formatReceipt appends the running session total when given", () => {
    const paid = result({
      cost: { estimatedUsd: 0, totalUsd: 0.0123, paidInferenceUsed: true },
    });
    assertStringIncludes(
      formatReceipt(paid, false, 0.0456),
      "$0.0123 · session $0.0456",
    );
    // A free session shows an explicit $0 total, and one-shot receipts
    // (no session figure passed) stay unchanged.
    assertStringIncludes(formatReceipt(result(), false, 0), "session $0");
    assertFalse((formatReceipt(result(), false)).includes("session"));
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
    assertStringIncludes(
      formatReceipt(withReasoning, false),
      "12→5 tok (+256 reasoning)",
    );
    assertFalse((formatReceipt(result(), false)).includes("reasoning"));
  });
});
