import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { test } from "node:test";
import {
  CONVERSATION_SUMMARY_MARKER,
  countTurns,
  formatSummaryMessage,
  partitionForCompression,
  VERBATIM_TAIL_TURNS,
} from "./compression.ts";
import {
  assertRepresentableToolHistory,
  buildConversationMessages,
} from "./conversation.ts";
import type { HistoryOmissionProjection } from "../contract/mod.ts";
import {
  type EventReader,
  fetchWorkbenchSessionEvents,
  type TextRow,
} from "../store/mod.ts";

const event = (
  eventType: string,
  content: string | null,
  tool: {
    name?: string;
    callId?: string;
    arguments?: Record<string, unknown>;
    result?: string;
    isError?: boolean;
    valid?: boolean;
  } = {},
) => ({
  eventId: "01E",
  eventType,
  traceId: "t",
  spanId: "s",
  parentSpanId: null,
  traceFlags: null,
  traceState: null,
  spanKind: null,
  parentIsRemote: null,
  principalId: "chris",
  modelId: null,
  provider: null,
  api: null,
  content,
  stopReason: null,
  tokensInput: null,
  tokensOutput: null,
  tokensCacheRead: null,
  tokensCacheWrite: null,
  costTotal: null,
  durationMs: null,
  providerCallOrder: null,
  providerCallPurpose: null,
  providerErrorClass: null,
  unparsedToolCallCount: null,
  unparsedToolCallCountIsLowerBound: null,
  runnerKind: null,
  runnerProfile: null,
  runnerProtocol: null,
  runnerProtocolVersion: null,
  runnerStopReason: null,
  runnerExternalSessionId: null,
  runnerAgentName: null,
  runnerAgentVersion: null,
  runnerTransport: null,
  runnerAccessRoute: null,
  runnerCostBasis: null,
  runnerWorkspace: null,
  runnerCapabilities: null,
  runnerEvidenceScope: null,
  runnerRouteSource: null,
  runnerAuthType: null,
  permissionVerdict: null,
  toolName: tool.name ?? null,
  toolCallId: tool.callId ?? null,
  toolArguments: tool.arguments ?? null,
  toolResult: tool.result ?? null,
  toolIsError: eventType === "tool_call" ? tool.isError ?? false : null,
  toolHistoryValid: eventType === "tool_call" ? tool.valid ?? true : null,
  createdAt: "2026-06-12 10:00:00",
});

/** The omission witness a projection reported, asserted present. */
function reported(
  omission: HistoryOmissionProjection | undefined,
): HistoryOmissionProjection {
  assert.ok(omission !== undefined, "expected an omission witness");
  return omission;
}

/** An event reader that serves these rows (in this order) for any session. */
function eventsReturning(rows: Record<string, unknown>[]): EventReader {
  return {
    exists: () => Promise.resolve(false),
    countBySession: () => Promise.resolve(rows.length),
    latestRun: () => Promise.resolve(null),
    bySession: () =>
      Promise.resolve(rows.map((row) => ({ ...row })) as TextRow[]),
  };
}

// Reads rows through the store helper, then projects them: it proves the row
// normalizer and the projection agree on what a valid tool record is.
test("fetchWorkbenchSessionEvents: preserves persisted tool-history validity instead of normalizing corruption", async () => {
  const valid = {
    event_id: "tool-event",
    event_type: "tool_call",
    trace_id: "trace",
    principal_id: "workbench",
    tool_name: "read_file",
    tool_call_id: "call-1",
    tool_arguments: '{"path":"README.md"}',
    tool_result: "",
    tool_is_error: "0",
    created_at: "2026-06-12 10:00:00",
  };
  const [emptyResult] = await fetchWorkbenchSessionEvents({
    sessionId: "01ABCDEF0123456789ABCDEF01",
    events: eventsReturning([valid]),
  });
  assert.strictEqual(emptyResult.toolHistoryValid, true);
  const emptyMessages = buildConversationMessages([emptyResult]);
  assert.ok(
    emptyMessages.some((message) =>
      isDeepStrictEqual(message, {
        role: "tool",
        toolCallId: "call-1",
        name: "read_file",
        content: "",
      })
    ),
  );

  for (
    const corrupted of [
      { ...valid, tool_name: "" },
      { ...valid, tool_call_id: "" },
      { ...valid, tool_arguments: "[]" },
      { ...valid, tool_result: null },
      { ...valid, tool_is_error: "2" },
    ]
  ) {
    const [event] = await fetchWorkbenchSessionEvents({
      sessionId: "01ABCDEF0123456789ABCDEF01",
      events: eventsReturning([
        corrupted as unknown as Record<string, string>,
      ]),
    });
    assert.strictEqual(event.toolHistoryValid, false);
    assert.throws(
      () => buildConversationMessages([event]),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          "Session history is empty after withholding unavailable tool evidence",
        ),
    );
  }
});

test("buildConversationMessages: maps prompts to user turns and responses to assistant turns", () => {
  const messages = buildConversationMessages([
    event("session_start", "What is DYFJ?"),
    event("model_response", "A local-first workbench."),
    event("session_end", null),
  ]);
  assert.deepStrictEqual(messages, [
    { role: "user", content: "What is DYFJ?" },
    { role: "assistant", content: "A local-first workbench." },
  ]);
});

test("buildConversationMessages: replays an external-agent response as an assistant turn", () => {
  const messages = buildConversationMessages([
    event("session_start", "delegate this"),
    event("agent_response", "external result"),
  ]);
  assert.deepStrictEqual(messages, [
    { role: "user", content: "delegate this" },
    { role: "assistant", content: "external result" },
  ]);
});

test("buildConversationMessages: [case 1] retains a valid tool pair whose result is empty", () => {
  let omission: HistoryOmissionProjection | undefined;
  const messages = buildConversationMessages([
    event("session_start", "inspect"),
    event("tool_call", null, {
      name: "read_file",
      callId: "empty-result",
      arguments: { path: "README.md" },
      result: "",
    }),
  ], { onOmission: (value) => omission = value });
  assert.deepStrictEqual(messages.at(-1), {
    role: "tool",
    toolCallId: "empty-result",
    name: "read_file",
    content: "",
  });
  assert.strictEqual(omission, undefined);
});

test("buildConversationMessages: [case 3] counts a gap marker without claiming a positive missing-call count", () => {
  let omission: HistoryOmissionProjection | undefined;
  buildConversationMessages([
    event("session_start", "run the check"),
    event("tool_call", null, {
      name: "acp.history_unavailable",
      callId: "gap-01",
      arguments: {},
      result: "",
      isError: true,
    }),
  ], { onOmission: (value) => omission = value });
  assert.deepStrictEqual(omission, {
    detectedInHistory: 1,
    malformedToolRecords: 0,
    gapMarkers: 1,
    callsUnknown: true,
    withheldFromProjection: 1,
    projectedPairs: 0,
  });
});

test("buildConversationMessages: [case 4] continues an incident-shaped prompt with a trailing ACP history gap", () => {
  // Not throwing is asserted by the call itself: a throw fails this test.
  const messages = buildConversationMessages([
    event("session_start", "run the check"),
    event("tool_call", null, {
      name: "acp.history_unavailable",
      callId: "gap-01",
      arguments: {},
      result: "",
      isError: true,
    }),
  ]);
  assert.deepStrictEqual(messages, [{
    role: "user",
    content: "run the check",
  }]);
});

test("buildConversationMessages: [case 23] metadata-only history remains an allowed empty projection", () => {
  assert.deepStrictEqual(
    buildConversationMessages([event("session_end", null)]),
    [],
  );
});

test("buildConversationMessages: [case 2] withholds a malformed row while retaining prose on both sides", () => {
  let omission: HistoryOmissionProjection | undefined;
  const messages = buildConversationMessages([
    event("session_start", "before"),
    event("tool_call", null, {
      name: "read_file",
      callId: "broken",
      arguments: {},
      result: "missing",
      valid: false,
    }),
    event("model_response", "dependent prose after"),
  ], { onOmission: (value) => omission = value });
  assert.deepStrictEqual(messages, [
    { role: "user", content: "before" },
    { role: "assistant", content: "dependent prose after" },
  ]);
  assert.partialDeepStrictEqual({ ...reported(omission) }, {
    detectedInHistory: 1,
    malformedToolRecords: 1,
    gapMarkers: 0,
    callsUnknown: false,
    withheldFromProjection: 1,
  });
});

test("buildConversationMessages: [case 5] refuses when withholding leaves no projected transcript", () => {
  let omission: HistoryOmissionProjection | undefined;
  assert.throws(
    () =>
      buildConversationMessages([
        event("tool_call", null, {
          name: "read_file",
          callId: "broken",
          arguments: {},
          result: "missing",
          valid: false,
        }),
      ], { onOmission: (value) => omission = value }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(
        "Session history is empty after withholding unavailable tool evidence",
      ),
  );
  assert.partialDeepStrictEqual({ ...reported(omission) }, {
    detectedInHistory: 1,
  });
});

test("buildConversationMessages: [case 6] refuses a synthetic split tool pair through the live representability guard", () => {
  assert.throws(
    () =>
      assertRepresentableToolHistory([{
        role: "tool",
        toolCallId: "orphan",
        name: "read_file",
        content: "result",
      }]),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(
        "Session contains unrepresentable persisted tool history",
      ),
  );
  assert.throws(
    () =>
      assertRepresentableToolHistory([{
        role: "assistant",
        content: "",
        toolCalls: [{ id: "orphan", name: "read_file", arguments: {} }],
      }]),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(
        "Session contains unrepresentable persisted tool history",
      ),
  );
});

test("buildConversationMessages: [case 7] reports three projected pairs beside one trailing gap", () => {
  let omission: HistoryOmissionProjection | undefined;
  const events = [event("session_start", "inspect")];
  for (let index = 1; index <= 3; index++) {
    events.push(event("tool_call", null, {
      name: "read_file",
      callId: `call-${index}`,
      arguments: { index },
      result: `result-${index}`,
    }));
  }
  events.push(event("tool_call", null, {
    name: "acp.history_unavailable",
    callId: "gap",
    arguments: {},
    result: "",
    isError: true,
  }));
  const messages = buildConversationMessages(events, {
    onOmission: (value) => omission = value,
  });
  assert.deepStrictEqual(
    messages.filter((message) => message.role === "tool").length,
    3,
  );
  assert.partialDeepStrictEqual({ ...reported(omission) }, {
    detectedInHistory: 1,
    gapMarkers: 1,
    projectedPairs: 3,
  });
});

test("buildConversationMessages: [case 8] counts withheld records independently even when ids repeat", () => {
  let omission: HistoryOmissionProjection | undefined;
  buildConversationMessages([
    event("session_start", "inspect"),
    event("tool_call", null, {
      name: "read_file",
      callId: "same-id",
      arguments: {},
      result: "one",
      valid: false,
    }),
    event("tool_call", null, {
      name: "read_file",
      callId: "same-id",
      arguments: {},
      result: "two",
      valid: false,
    }),
  ], { onOmission: (value) => omission = value });
  assert.partialDeepStrictEqual({ ...reported(omission) }, {
    detectedInHistory: 2,
    malformedToolRecords: 2,
    withheldFromProjection: 2,
  });
});

test("buildConversationMessages: [case 9] keeps whole-history counts when an old omission falls outside maxTurns", () => {
  let omission: HistoryOmissionProjection | undefined;
  const messages = buildConversationMessages([
    event("session_start", "old prompt"),
    event("tool_call", null, {
      name: "acp.history_unavailable",
      callId: "old-gap",
      arguments: {},
      result: "",
      isError: true,
    }),
    event("model_response", "old answer"),
    event("session_start", "recent prompt"),
    event("model_response", "recent answer"),
  ], { maxTurns: 1, onOmission: (value) => omission = value });
  assert.deepStrictEqual(messages, [
    { role: "user", content: "recent prompt" },
    { role: "assistant", content: "recent answer" },
  ]);
  assert.partialDeepStrictEqual({ ...reported(omission) }, {
    detectedInHistory: 1,
    withheldFromProjection: 0,
  });
});

test("buildConversationMessages: [case 10] retains a compressed summary while counting an elder omission outside the selected window", () => {
  let omission: HistoryOmissionProjection | undefined;
  const messages = buildConversationMessages([
    event("session_start", "elder prompt"),
    event("tool_call", null, {
      name: "acp.history_unavailable",
      callId: "elder-gap",
      arguments: {},
      result: "",
      isError: true,
    }),
    event("model_response", "elder answer"),
    event("session_start", "retained prompt"),
    event("model_response", "retained answer"),
    event(
      "context_compressed",
      JSON.stringify({
        summary: "summary may depend on missing evidence",
        turnsRetained: 1,
      }),
    ),
  ], { onOmission: (value) => omission = value });
  assert.ok(
    messages[0].content.includes(CONVERSATION_SUMMARY_MARKER),
    `expected ${JSON.stringify(messages[0].content)} to include ${
      JSON.stringify(CONVERSATION_SUMMARY_MARKER)
    }`,
  );
  assert.deepStrictEqual(
    [{
      role: "user",
      content: "retained prompt",
    }].filter((item) =>
      !messages.some((candidate) => isDeepStrictEqual(candidate, item))
    ),
    [],
  );
  assert.ok(!JSON.stringify(messages).includes("elder prompt"));
  assert.partialDeepStrictEqual({ ...reported(omission) }, {
    detectedInHistory: 1,
    withheldFromProjection: 0,
  });
});

test("buildConversationMessages: [case 11] repeated compression recomputes stable whole-history omission counts", () => {
  const events = [
    event("session_start", "elder prompt"),
    event("tool_call", null, {
      name: "acp.history_unavailable",
      callId: "elder-gap",
      arguments: {},
      result: "",
      isError: true,
    }),
    event("model_response", "elder answer"),
    event(
      "context_compressed",
      JSON.stringify({ summary: "first summary", turnsRetained: 0 }),
    ),
    event("session_start", "later prompt"),
    event("model_response", "later answer"),
    event(
      "context_compressed",
      JSON.stringify({ summary: "second summary", turnsRetained: 1 }),
    ),
  ];
  const project = () => {
    let omission: HistoryOmissionProjection | undefined;
    const messages = buildConversationMessages(events, {
      onOmission: (value) => omission = value,
    });
    return { messages, omission };
  };
  const first = project();
  assert.deepStrictEqual(project(), first);
  assert.partialDeepStrictEqual({ ...reported(first.omission) }, {
    detectedInHistory: 1,
  });
  assert.ok(
    first.messages[0].content.includes("second summary"),
    `expected ${
      JSON.stringify(first.messages[0].content)
    } to include "second summary"`,
  );
});

test("buildConversationMessages: [case 12] derives the witness from events beside a legacy summary with no omission field", () => {
  let omission: HistoryOmissionProjection | undefined;
  const messages = buildConversationMessages([
    event("session_start", "old prompt"),
    event("tool_call", null, {
      name: "acp.history_unavailable",
      callId: "legacy-gap",
      arguments: {},
      result: "",
      isError: true,
    }),
    event(
      "context_compressed",
      JSON.stringify({
        summary: "legacy summary without omission metadata",
        turnsRetained: 1,
      }),
    ),
  ], { onOmission: (value) => omission = value });
  assert.ok(
    messages[0].content.includes("legacy summary"),
    `expected ${
      JSON.stringify(messages[0].content)
    } to include "legacy summary"`,
  );
  assert.partialDeepStrictEqual({ ...reported(omission) }, {
    detectedInHistory: 1,
    gapMarkers: 1,
  });
});

test("buildConversationMessages: [case 17] retains later dependent prose verbatim after withholding", () => {
  const dependent = "I used that unavailable result; do not repair this prose.";
  const messages = buildConversationMessages([
    event("session_start", "inspect"),
    event("tool_call", null, {
      name: "read_file",
      callId: "bad",
      arguments: {},
      result: "missing",
      valid: false,
    }),
    event("model_response", dependent),
  ]);
  assert.deepStrictEqual(
    [{ role: "assistant", content: dependent }].filter((item) =>
      !messages.some((candidate) => isDeepStrictEqual(candidate, item))
    ),
    [],
  );
});

test("buildConversationMessages: [case 18] identical immutable events yield identical projections and counts", () => {
  const events = [
    event("session_start", "inspect"),
    event("tool_call", null, {
      name: "acp.history_unavailable",
      callId: "gap",
      arguments: {},
      result: "",
      isError: true,
    }),
  ];
  const project = () => {
    let omission: HistoryOmissionProjection | undefined;
    const messages = buildConversationMessages(events, {
      onOmission: (value) => omission = value,
    });
    return { messages, omission };
  };
  assert.deepStrictEqual(project(), project());
});

test("buildConversationMessages: [case 19] native and ACP-labelled rows have identical projection decisions and counts", () => {
  const base = [
    event("session_start", "inspect"),
    event("tool_call", null, {
      name: "acp.history_unavailable",
      callId: "gap",
      arguments: {},
      result: "",
      isError: true,
    }),
  ];
  const project = (runnerProtocol: string | null) => {
    let omission: HistoryOmissionProjection | undefined;
    const messages = buildConversationMessages(
      base.map((item) => ({ ...item, runnerProtocol })),
      { onOmission: (value) => omission = value },
    );
    return { messages, omission };
  };
  assert.deepStrictEqual(project(null), project("acp"));
});

test("buildConversationMessages: a context_compressed event replaces the elder turns with the pinned summary", () => {
  const summary = "## Session intent\ncompressed intent";
  const messages = buildConversationMessages([
    event("session_start", "old question one"),
    event("model_response", "old answer one"),
    // One elder turn compressed, nothing retained behind it.
    event(
      "context_compressed",
      JSON.stringify({ summary, turnsRetained: 0 }),
    ),
    event("session_start", "fresh question"),
    event("model_response", "fresh answer"),
  ]);
  // Byte-consistent with what the live session injected: the shared formatter.
  assert.deepStrictEqual(messages[0], formatSummaryMessage(summary));
  assert.ok(
    messages[0].content.includes(CONVERSATION_SUMMARY_MARKER),
    `expected ${JSON.stringify(messages[0].content)} to include ${
      JSON.stringify(CONVERSATION_SUMMARY_MARKER)
    }`,
  );
  // Elder turns are gone; the recent turns after compression remain.
  assert.ok(!JSON.stringify(messages).includes("old question one"));
  assert.deepStrictEqual(
    [{
      role: "user",
      content: "fresh question",
    }].filter((item) =>
      !messages.some((candidate) => isDeepStrictEqual(candidate, item))
    ),
    [],
  );
  assert.deepStrictEqual(
    [{
      role: "assistant",
      content: "fresh answer",
    }].filter((item) =>
      !messages.some((candidate) => isDeepStrictEqual(candidate, item))
    ),
    [],
  );
});

test("buildConversationMessages: resume keeps the verbatim tail and current prompt, dropping only elder", () => {
  // Two elder turns, a K=2 verbatim tail, then the current turn: the live path
  // used [summary, tail, current-prompt]; resume must reconstruct the same,
  // not collapse to [summary, answer].
  const summary = "## Session intent\nsummary of the elder turns";
  const messages = buildConversationMessages([
    event("session_start", "elder q1"),
    event("model_response", "elder a1"),
    event("session_start", "elder q2"),
    event("model_response", "elder a2"),
    event("session_start", "tail q1"),
    event("model_response", "tail a1"),
    event("session_start", "tail q2"),
    event("model_response", "tail a2"),
    event("session_start", "the current question"),
    // Two elder turns compressed; the K=2 tail plus the current prompt — three
    // turns — are what the live path kept.
    event(
      "context_compressed",
      JSON.stringify({ summary, turnsRetained: 3 }),
    ),
    event("model_response", "the current answer"),
  ]);
  assert.ok(
    messages[0].content.includes(CONVERSATION_SUMMARY_MARKER),
    `expected ${JSON.stringify(messages[0].content)} to include ${
      JSON.stringify(CONVERSATION_SUMMARY_MARKER)
    }`,
  );
  const s = JSON.stringify(messages);
  assert.ok(!s.includes("elder q1"));
  assert.ok(!s.includes("elder q2"));
  assert.deepStrictEqual(
    [{ role: "user", content: "tail q1" }].filter((item) =>
      !messages.some((candidate) => isDeepStrictEqual(candidate, item))
    ),
    [],
  );
  assert.deepStrictEqual(
    [{ role: "user", content: "tail q2" }].filter((item) =>
      !messages.some((candidate) => isDeepStrictEqual(candidate, item))
    ),
    [],
  );
  assert.deepStrictEqual(
    [{
      role: "user",
      content: "the current question",
    }].filter((item) =>
      !messages.some((candidate) => isDeepStrictEqual(candidate, item))
    ),
    [],
  );
  assert.deepStrictEqual(
    [{
      role: "assistant",
      content: "the current answer",
    }].filter((item) =>
      !messages.some((candidate) => isDeepStrictEqual(candidate, item))
    ),
    [],
  );
});

test("buildConversationMessages: the summary marker survives resume past the recent-turns cap", () => {
  const events = [
    event(
      "context_compressed",
      JSON.stringify({ summary: "pinned summary", turnsRetained: 0 }),
    ),
  ];
  // Far more post-compression turns than maxTurns.
  for (let i = 0; i < 20; i++) {
    events.push(
      event("session_start", `q${i}`),
      event("model_response", `a${i}`),
    );
  }
  const messages = buildConversationMessages(events, { maxTurns: 3 });
  // The pinned summary is still at the head despite 20 following turns...
  assert.ok(
    messages[0].content.includes(CONVERSATION_SUMMARY_MARKER),
    `expected ${JSON.stringify(messages[0].content)} to include ${
      JSON.stringify(CONVERSATION_SUMMARY_MARKER)
    }`,
  );
  // ...and only the most recent 3 turns follow it (summary user + 3 users).
  assert.deepStrictEqual(
    messages.filter((m) => m.role === "user").length,
    1 + 3,
  );
  assert.ok(!JSON.stringify(messages).includes("q0"));
});

test("buildConversationMessages: keeps prior turns when a context_compressed payload is unparseable", () => {
  const messages = buildConversationMessages([
    event("session_start", "keep me"),
    event("context_compressed", "not json"),
  ]);
  assert.deepStrictEqual(messages, [{ role: "user", content: "keep me" }]);
});

test("buildConversationMessages: resumes uncompressed on a payload with no retained count", () => {
  // An event written before the retained count existed carries only the
  // compressed (leading) count, which is meaningless here — replay rebuilds
  // the full history while that count was taken against a capped seed.
  // Applying it would silently drop the wrong turns, so it must fall through
  // the invalid-payload path and resume uncompressed rather than half-apply.
  const messages = buildConversationMessages([
    event("session_start", "elder q"),
    event("model_response", "elder a"),
    event("session_start", "recent q"),
    event(
      "context_compressed",
      JSON.stringify({
        summary: "## Session intent\nold shape",
        turnsCompressed: 1,
      }),
    ),
    event("model_response", "recent a"),
  ]);
  assert.ok(!JSON.stringify(messages).includes(CONVERSATION_SUMMARY_MARKER));
  assert.deepStrictEqual(messages, [
    { role: "user", content: "elder q" },
    { role: "assistant", content: "elder a" },
    { role: "user", content: "recent q" },
    { role: "assistant", content: "recent a" },
  ]);
});

test("buildConversationMessages: resume is byte-identical to the live transcript when history exceeds maxTurns", () => {
  // THE seam regression. The live path seeds from a transcript already capped
  // to the most recent `maxTurns` turns, then compresses within that window;
  // replay rebuilds the FULL history. A leading (compressed) count would mean
  // different things to each side — dropping the oldest turns replay knows
  // about while leaving the summarized ones standing. The retained count is
  // anchored to the tail, which is a suffix of both. This asserts the two
  // paths agree exactly, on a history far longer than the cap.
  const maxTurns = 10;
  const priorEvents = [];
  for (let i = 1; i <= 30; i++) {
    priorEvents.push(
      event("session_start", `question ${i}`),
      event("model_response", `answer ${i}`),
    );
  }

  // ── Live path, exactly as the runtime does it ──
  // buildResume caps the seed to the most recent maxTurns turns (21..30)...
  const seed = buildConversationMessages(priorEvents, { maxTurns });
  assert.strictEqual(countTurns(seed), maxTurns);
  // ...and the compressor partitions THAT capped seed.
  const { elder, tail } = partitionForCompression(seed, VERBATIM_TAIL_TURNS);
  assert.strictEqual(countTurns(elder), 8);
  assert.strictEqual(countTurns(tail), 2);
  const summary = "## Session intent\nsummary of questions 21-28";
  const liveTranscript = [formatSummaryMessage(summary), ...tail];

  // ── Resume path ──
  const resumed = buildConversationMessages([
    ...priorEvents,
    event(
      "context_compressed",
      JSON.stringify({ summary, turnsRetained: countTurns(tail) }),
    ),
  ], { maxTurns });

  assert.deepStrictEqual(resumed, liveTranscript);
  // The summarized turns must not ALSO survive verbatim — the exact corruption
  // a leading count produced (turns 21-28 both summarized and replayed).
  const resumedJson = JSON.stringify(resumed);
  for (const i of [21, 22, 23, 24, 25, 26, 27, 28]) {
    assert.ok(!resumedJson.includes(`question ${i}`));
  }
  assert.deepStrictEqual(
    [{ role: "user", content: "question 29" }].filter((item) =>
      !resumed.some((candidate) => isDeepStrictEqual(candidate, item))
    ),
    [],
  );
  assert.deepStrictEqual(
    [{ role: "user", content: "question 30" }].filter((item) =>
      !resumed.some((candidate) => isDeepStrictEqual(candidate, item))
    ),
    [],
  );
});

test("buildConversationMessages: a failed turn (error event, no model_response) rebuilds without a half-turn", () => {
  // e.g. a context-window overflow: the turn fails structured, so the event
  // trail carries the prompt and the error but no model_response. Resume
  // must see the prompt as a plain user turn — no fabricated assistant
  // content — and stay valid for the next turn.
  const messages = buildConversationMessages([
    event("session_start", "What is DYFJ?"),
    event("model_response", "A local-first workbench."),
    event("session_end", null),
    event("session_start", "one more question"),
    event("error", "Context window overflow: ..."),
    event("session_end", null),
  ]);
  assert.deepStrictEqual(messages, [
    { role: "user", content: "What is DYFJ?" },
    { role: "assistant", content: "A local-first workbench." },
    { role: "user", content: "one more question" },
  ]);
});

test("buildConversationMessages: keeps only the most recent maxTurns exchanges, whole turns intact", () => {
  const events = Array.from({ length: 50 }, (_, i) => [
    event("session_start", `prompt ${i}`),
    event("model_response", `response ${i}`),
  ]).flat();
  const messages = buildConversationMessages(events, { maxTurns: 3 });
  // 3 turns => 6 messages, and they are the most recent ones (no truncation).
  assert.deepStrictEqual(messages.length, 6);
  assert.deepStrictEqual(messages[0], { role: "user", content: "prompt 47" });
  assert.deepStrictEqual(messages.at(-1), {
    role: "assistant",
    content: "response 49",
  });
  assert.strictEqual(messages.some((m) => m.content === "prompt 0"), false);
});

test("buildConversationMessages: replays a tool_call event as a paired assistant+tool turn", () => {
  const messages = buildConversationMessages([
    event("session_start", "list the files"),
    event("tool_call", "list_files allowed", {
      name: "list_files",
      callId: "call_1",
      arguments: { path: "." },
      result: "README.md\nsrc/",
    }),
    event("model_response", "There are two entries."),
  ]);
  assert.deepStrictEqual(messages, [
    { role: "user", content: "list the files" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call_1", name: "list_files", arguments: { path: "." } },
      ],
    },
    {
      role: "tool",
      toolCallId: "call_1",
      name: "list_files",
      content: "README.md\nsrc/",
    },
    { role: "assistant", content: "There are two entries." },
  ]);
  // The tool message is immediately preceded by an assistant carrying the
  // same id — the wire-format pairing invariant.
  const toolIdx = messages.findIndex((m) => m.role === "tool");
  const prior = messages[toolIdx - 1];
  assert.strictEqual(prior.role, "assistant");
  assert.strictEqual(
    prior.role === "assistant" && prior.toolCalls?.[0]?.id,
    "call_1",
  );
});

test("buildConversationMessages: replays a failed tool_call with its error mark intact", () => {
  // A resumed transcript must serialize a failed result as an error
  // (Anthropic is_error) exactly like the live turn did — otherwise resume
  // silently reclassifies corrective feedback as ordinary tool output.
  const messages = buildConversationMessages([
    event("session_start", "read the friction log"),
    event("tool_call", "read_file denied: invalid arguments", {
      name: "read_file",
      callId: "call_bad",
      arguments: {},
      result:
        "invalid arguments for read_file: missing required argument: path",
      isError: true,
    }),
    event("model_response", "Retrying with a path."),
  ]);
  assert.deepStrictEqual(
    [{
      role: "tool",
      toolCallId: "call_bad",
      name: "read_file",
      content:
        "invalid arguments for read_file: missing required argument: path",
      isError: true,
    }].filter((item) =>
      !messages.some((candidate) => isDeepStrictEqual(candidate, item))
    ),
    [],
  );
  // A successful replayed result stays unmarked (absent, not false).
  const ok = buildConversationMessages([
    event("session_start", "list"),
    event("tool_call", "list_files allowed", {
      name: "list_files",
      callId: "call_ok",
      arguments: {},
      result: "README.md",
    }),
  ]);
  const okTool = ok.find((m) => m.role === "tool");
  assert.strictEqual(okTool && "isError" in okTool, false);
});

test("buildConversationMessages: truncation never orphans a tool result from its call", () => {
  // Two turns, each: user -> tool call+result -> assistant. maxTurns=1 must
  // keep the whole most-recent turn (user + assistant-with-toolcall + tool +
  // assistant), never start the window on the dangling tool message.
  const turn = (i: number) => [
    event("session_start", `prompt ${i}`),
    event("tool_call", "list_files allowed", {
      name: "list_files",
      callId: `call_${i}`,
      arguments: {},
      result: `result ${i}`,
    }),
    event("model_response", `response ${i}`),
  ];
  const messages = buildConversationMessages([...turn(0), ...turn(1)], {
    maxTurns: 1,
  });
  assert.deepStrictEqual(messages[0], { role: "user", content: "prompt 1" });
  assert.strictEqual(messages.some((m) => m.content === "prompt 0"), false);
  // First message is a user turn; no leading orphaned tool message.
  assert.strictEqual(messages[0].role, "user");
  const toolMsg = messages.find((m) => m.role === "tool");
  assert.strictEqual(
    toolMsg && "toolCallId" in toolMsg && toolMsg.toolCallId,
    "call_1",
  );
});
