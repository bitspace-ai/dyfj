import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  supersedeEvent,
  unparsedMarkupEvent,
} from "../../../testing/builders/turn-client.ts";
import { fakeIo } from "../../../testing/fakes/fake-io.ts";
import type { CliConfig } from "../args.ts";
import type { Io } from "../io.ts";
import {
  createTurnOutputHandlers,
  formatRuntimeEvent,
  handleTurnRuntimeEvent,
  wrapColumns,
} from "./turn-output.ts";

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    socket: "/tmp/dyfj-test.sock",
    mode: "turn",
    color: false,
    ...overrides,
  };
}

describe("wrapColumns", () => {
  it("falls back to 80 when the width is unknown", () => {
    assert.strictEqual(wrapColumns(undefined), 80);
  });

  it("falls back to 80 when a sizeless pty reports zero columns", () => {
    assert.strictEqual(wrapColumns(0), 80);
  });

  it("caps a wide terminal at 100", () => {
    assert.strictEqual(wrapColumns(140), 100);
  });
});

describe("formatRuntimeEvent", () => {
  it("ignores routine non-tool lifecycle events", () => {
    assert.strictEqual(formatRuntimeEvent({ type: "modelSelected" }), null);
  });

  it("marks an aborted turn", () => {
    assert.strictEqual(
      formatRuntimeEvent({ type: "turnAborted" }),
      "[interrupted]",
    );
  });

  it("marks the forced conclusion after the tool-step limit", () => {
    assert.strictEqual(
      formatRuntimeEvent({
        type: "toolStepLimitReached",
        maxSteps: 8,
      }),
      "tool: reached 8-step limit; concluding now",
    );
  });

  it("warns about unparsed markup without model-supplied text", () => {
    const warning = formatRuntimeEvent(unparsedMarkupEvent());
    assert.strictEqual(
      warning,
      "WARNING: unparsed tool-call markup was present (at least 64 unrun tool call(s)); " +
        "no tools were executed from it",
    );
    assert.doesNotMatch(warning, /edit_file|read_file|<tool_call>/);
  });

  it("words a single unrun tool-call block as a call, not an opening", () => {
    const warning = formatRuntimeEvent({
      ...unparsedMarkupEvent(),
      count: 1,
      countIsLowerBound: false,
    });
    assert.strictEqual(
      warning,
      "WARNING: unparsed tool-call markup was present (1 unrun tool call(s)); " +
        "no tools were executed from it",
    );
    assert.doesNotMatch(warning, /unmatched opening/);
  });

  it("renders negotiated memory-recall diagnostics from structured fields", () => {
    assert.strictEqual(
      formatRuntimeEvent({
        type: "memoryRecallNegotiated",
        era: "modern",
        revision: "2026-07-28",
        server: { name: "fixture-memory", version: "1.2.3" },
        extensions: ["fixture.extension"],
      }),
      "Memory recall MCP: era=modern revision=2026-07-28 " +
        "server=fixture-memory@1.2.3 extensions=fixture.extension",
    );
  });

  it("drops malformed recall evidence instead of rendering foreign text", () => {
    assert.strictEqual(
      formatRuntimeEvent({
        type: "memoryRecallNegotiated",
        era: "modern",
        revision: "2026-07-28\nprivate-text",
        extensions: [],
      }),
      null,
    );
  });

  it("drops an over-limit extension list instead of reporting none", () => {
    assert.strictEqual(
      formatRuntimeEvent({
        type: "memoryRecallNegotiated",
        era: "modern",
        revision: "2026-07-28",
        extensions: Array.from(
          { length: 9 },
          (_, index) => `extension.${index}`,
        ),
      }),
      null,
    );
  });
});

describe("handleTurnRuntimeEvent", () => {
  it("routes the supersede signal to the renderer, not stderr", () => {
    const { io, stdout, stderr } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    handleTurnRuntimeEvent(supersedeEvent(), output, io);
    assert.ok(
      stdout.join("").includes("retrying with recovered context"),
      `expected stdout.join("") to include "retrying with recovered context"`,
    );
    assert.deepStrictEqual(stderr.length, 0);
  });

  it("still renders tool progress lines to stderr", () => {
    const { io, stdout, stderr } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    handleTurnRuntimeEvent(
      { type: "toolCallStarted", commandId: "bash", callId: "c1" },
      output,
      io,
    );
    assert.deepStrictEqual(
      ["tool: bash started"].filter((item) => !stderr.includes(item)),
      [],
    );
    assert.deepStrictEqual(stdout.length, 0);
  });

  it("renders a refused call as a refusal, with no duration", () => {
    const { io, stderr } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    handleTurnRuntimeEvent(
      {
        type: "toolCallCompleted",
        commandId: "bash",
        callId: "c1",
        isError: true,
        durationMs: 163376,
        verdict: "approval_denied",
      },
      output,
      io,
    );
    assert.deepStrictEqual(stderr, ["  ⊘ bash not approved"]);
  });

  it("still renders a failed call as a failure, with its duration", () => {
    const { io, stderr } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    handleTurnRuntimeEvent(
      {
        type: "toolCallCompleted",
        commandId: "bash",
        callId: "c1",
        isError: true,
        durationMs: 40,
      },
      output,
      io,
    );
    assert.deepStrictEqual(stderr, ["tool: bash failed (40ms)"]);
  });

  it("flushes preserved partial text before the interrupted marker", () => {
    const writes: string[] = [];
    const io: Io = {
      out: (text) => writes.push(`out:${text}`),
      err: (line) => writes.push(`err:${line}`),
      readLine: () => Promise.resolve(null),
      close: () => {},
    };
    const output = createTurnOutputHandlers(cfg(), io);
    output.onDelta("unfinished partial line");

    handleTurnRuntimeEvent({ type: "turnAborted" }, output, io);

    assert.strictEqual(writes.some((write) => write.startsWith("out:")), true);
    assert.strictEqual(writes.at(-1), "err:[interrupted]");
  });

  it("renders a context-compression status line to stderr", () => {
    const { io, stderr } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    handleTurnRuntimeEvent(
      {
        type: "contextCompressed",
        sessionId: "s",
        compressorModelSlug: "qwen3:local",
        trigger: "proactive",
        turnsCompressed: 4,
        tokensBeforeEstimate: 900,
        tokensAfterEstimate: 120,
      },
      output,
      io,
    );
    assert.ok(
      stderr.join("\n").includes("context: compressed 4 elder turn(s)"),
      `expected stderr.join("\\n") to include "context: compressed 4 elder turn(s)"`,
    );
  });

  it("renders the window-fit status lines to stderr", () => {
    const { io, stderr } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    handleTurnRuntimeEvent(
      {
        type: "toolResultTrimmed",
        sessionId: "s",
        commandId: "read_file",
        callId: "c1",
        contextWindow: 32768,
        keptChars: 8192,
        totalChars: 65536,
      },
      output,
      io,
    );
    handleTurnRuntimeEvent(
      {
        type: "contextFitted",
        sessionId: "s",
        modelSlug: "qwen3:local",
        contextWindow: 32768,
        budgetTokens: 23347,
        estimatedTokensBefore: 47716,
        estimatedTokensAfter: 18200,
        trimmedToolResults: 2,
        compressed: true,
        trigger: "provider_rejected",
      },
      output,
      io,
    );
    assert.ok(
      stderr.join("\n").includes(
        "context: trimmed read_file result to fit the 32768-token window " +
          "(8192 of 65536 characters kept)",
      ),
      `expected stderr.join("\\n") to include "context: trimmed read_file result to fit the 32768-token window " +
        "(8192 of 65536 characters kept)"`,
    );
    assert.ok(
      stderr.join("\n").includes(
        "context: fitted to the 32768-token window after the provider " +
          "rejected the request (~47716 → ~18200 tokens, 2 tool result(s) " +
          "trimmed, elder turns compressed)",
      ),
      `expected stderr.join("\\n") to include "context: fitted to the 32768-token window after the provider " +
        "rejected the request (~47716 → ~18200 tokens, 2 tool result(s) " +
        "trimmed, elder turns compressed)"`,
    );
  });

  // Both clients decode the transport JSON but never schema-validate the frame,
  // so a malformed event payload must be dropped, not dereferenced.
  for (
    const [label, event] of [
      ["null", null],
      ["a number", 42],
      ["a string", "supersedingRetryStarted"],
      ["an array", []],
    ] as [string, unknown][]
  ) {
    it(`drops a malformed event frame (${label}) without throwing`, () => {
      const { io, stdout, stderr } = fakeIo();
      const output = createTurnOutputHandlers(cfg(), io);
      handleTurnRuntimeEvent(event, output, io);
      assert.deepStrictEqual(stdout.length, 0);
      assert.deepStrictEqual(stderr.length, 0);
    });
  }

  it("does not supersede on an event that only fakes the discriminator", () => {
    const { io, stdout } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    // type matches but the pinned payload fields are absent: not a valid signal.
    handleTurnRuntimeEvent({ type: "supersedingRetryStarted" }, output, io);
    assert.ok(!(stdout.join("")).includes("retrying with recovered context"));
  });

  // reason is an open union: a consumer that does not recognize a future reason
  // must still reset, or it renders the superseded attempt as the answer.
  it("supersedes on an unrecognized reason", () => {
    const { io, stdout } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    handleTurnRuntimeEvent(
      { ...supersedeEvent(), reason: "some_future_reason" },
      output,
      io,
    );
    assert.ok(
      stdout.join("").includes("retrying with recovered context"),
      `expected stdout.join("") to include "retrying with recovered context"`,
    );
  });

  it("does not supersede on an empty reason", () => {
    const { io, stdout } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    handleTurnRuntimeEvent({ ...supersedeEvent(), reason: "" }, output, io);
    assert.ok(!(stdout.join("")).includes("retrying with recovered context"));
  });
});
