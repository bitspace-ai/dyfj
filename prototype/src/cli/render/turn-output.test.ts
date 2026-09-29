import {
  assertArrayIncludes,
  assertEquals,
  assertFalse,
  assertNotMatch,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
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
} from "./turn-output.ts";

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    socket: "/tmp/dyfj-test.sock",
    mode: "turn",
    color: false,
    ...overrides,
  };
}

describe("formatRuntimeEvent", () => {
  it("ignores routine non-tool lifecycle events", () => {
    assertStrictEquals(formatRuntimeEvent({ type: "modelSelected" }), null);
  });

  it("marks an aborted turn", () => {
    assertStrictEquals(
      formatRuntimeEvent({ type: "turnAborted" }),
      "[interrupted]",
    );
  });

  it("marks the forced conclusion after the tool-step limit", () => {
    assertStrictEquals(
      formatRuntimeEvent({
        type: "toolStepLimitReached",
        maxSteps: 8,
      }),
      "tool: reached 8-step limit; concluding now",
    );
  });

  it("warns about unparsed markup without model-supplied text", () => {
    const warning = formatRuntimeEvent(unparsedMarkupEvent());
    assertStrictEquals(
      warning,
      "WARNING: unparsed tool-call markup was present (at least 64 unmatched opening(s)); " +
        "no tools were executed from it",
    );
    assertNotMatch(warning, /edit_file|read_file|<tool_call>/);
  });

  it("renders negotiated memory-recall diagnostics from structured fields", () => {
    assertStrictEquals(
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
    assertStrictEquals(
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
    assertStrictEquals(
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
    assertStringIncludes(stdout.join(""), "retrying with recovered context");
    assertEquals(stderr.length, 0);
  });

  it("still renders tool progress lines to stderr", () => {
    const { io, stdout, stderr } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    handleTurnRuntimeEvent(
      { type: "toolCallStarted", commandId: "bash", callId: "c1" },
      output,
      io,
    );
    assertArrayIncludes(stderr, ["tool: bash started"]);
    assertEquals(stdout.length, 0);
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

    assertStrictEquals(writes.some((write) => write.startsWith("out:")), true);
    assertStrictEquals(writes.at(-1), "err:[interrupted]");
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
    assertStringIncludes(
      stderr.join("\n"),
      "context: compressed 4 elder turn(s)",
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
      assertEquals(stdout.length, 0);
      assertEquals(stderr.length, 0);
    });
  }

  it("does not supersede on an event that only fakes the discriminator", () => {
    const { io, stdout } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    // type matches but the pinned payload fields are absent: not a valid signal.
    handleTurnRuntimeEvent({ type: "supersedingRetryStarted" }, output, io);
    assertFalse((stdout.join("")).includes("retrying with recovered context"));
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
    assertStringIncludes(stdout.join(""), "retrying with recovered context");
  });

  it("does not supersede on an empty reason", () => {
    const { io, stdout } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    handleTurnRuntimeEvent({ ...supersedeEvent(), reason: "" }, output, io);
    assertFalse((stdout.join("")).includes("retrying with recovered context"));
  });
});
