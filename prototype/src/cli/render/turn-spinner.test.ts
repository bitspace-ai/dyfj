import assert from "node:assert/strict";
import { describe, it } from "@std/testing/bdd";
import { supersedeEvent } from "../../../testing/builders/turn-client.ts";
import { fakeIo } from "../../../testing/fakes/fake-io.ts";
import type { CliConfig } from "../args.ts";
import type { Io } from "../io.ts";
import { createTurnOutputHandlers } from "./turn-output.ts";
import {
  createTurnSpinner,
  runtimeEventIsVisible,
  sanitizeSpinnerLabel,
  spinnerGuardedTurnHandlers,
} from "./turn-spinner.ts";

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    socket: "/tmp/dyfj-test.sock",
    mode: "turn",
    color: false,
    ...overrides,
  };
}

const ERASE_LINE = "\r\x1b[2K";

describe("createTurnSpinner", () => {
  it("animates only when the Io has a raw writer and a TTY stderr", () => {
    const { io, raw } = fakeIo([], { errIsTerminal: true });
    const spinner = createTurnSpinner(cfg(), io);
    spinner.start();
    spinner.stop();
    assert.deepStrictEqual(raw, [`${ERASE_LINE}⠋ working… 0s`, ERASE_LINE]);
  });

  it("is a no-op when stderr is not a terminal", () => {
    const { io, raw } = fakeIo();
    const spinner = createTurnSpinner(cfg(), io);
    spinner.start();
    spinner.stop();
    assert.deepStrictEqual(raw, []);
  });

  it("is a no-op when the Io exposes no raw stderr writer", () => {
    const stderr: string[] = [];
    const io: Io = {
      out: () => {},
      err: (line) => stderr.push(line),
      readLine: () => Promise.resolve(null),
      close: () => {},
    };
    const spinner = createTurnSpinner(cfg(), io);
    spinner.start();
    spinner.stop();
    assert.deepStrictEqual(stderr, []);
  });
});

describe("spinnerGuardedTurnHandlers", () => {
  function stubSpinner(calls: string[]) {
    return {
      start: () => calls.push("start"),
      pause: () => calls.push("pause"),
      stop: () => calls.push("stop"),
      updateLabel: (label: string) => calls.push(`label:${label}`),
    };
  }

  it("pauses only when a delta emits a line, then resumes", () => {
    const calls: string[] = [];
    const { io, stdout } = fakeIo();
    const spinner = stubSpinner(calls);
    const output = createTurnOutputHandlers(cfg(), {
      ...io,
      out: (text) => {
        calls.push("out");
        stdout.push(text);
      },
    }, {
      beforeWrite: spinner.pause,
      afterWrite: () => {
        spinner.updateLabel("working…");
        spinner.start();
      },
    });
    const handlers = spinnerGuardedTurnHandlers(
      spinner,
      output,
      io,
      () => ({ decision: "deny" as const, reason: "n/a" }),
    );
    handlers.onDelta("hello");
    // Typed, so the assertion does not narrow `calls` to an empty tuple.
    assert.deepStrictEqual<string[]>(calls, []);
    handlers.onDelta("\n");
    assert.strictEqual(calls[0], "pause");
    assert.deepStrictEqual(["out"].filter((item) => !calls.includes(item)), []);
    assert.deepStrictEqual(calls.slice(-2), ["label:working…", "start"]);
    assert.strictEqual(stdout.join(""), "hello\n");
  });

  it("pauses around a visible runtime-event status line and resumes", () => {
    const calls: string[] = [];
    const { io, stderr } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    const handlers = spinnerGuardedTurnHandlers(
      stubSpinner(calls),
      output,
      {
        ...io,
        err: (line) => {
          calls.push("err");
          stderr.push(line);
        },
      },
      () => ({ decision: "deny" as const, reason: "n/a" }),
    );
    handlers.onEvent({ type: "toolCallStarted", commandId: "read_file" });
    assert.strictEqual(calls[0], "pause");
    assert.deepStrictEqual(calls.slice(-2), ["label:working…", "start"]);
    assert.deepStrictEqual(stderr, ["tool: read_file started"]);
  });

  it("thought activity updates the spinner before text output", () => {
    const calls: string[] = [];
    const { io, stdout, stderr } = fakeIo();
    const spinner = stubSpinner(calls);
    const output = createTurnOutputHandlers(cfg(), {
      ...io,
      out: (text) => {
        calls.push("out");
        stdout.push(text);
      },
    }, {
      beforeWrite: spinner.pause,
      afterWrite: () => {
        spinner.updateLabel("working…");
        spinner.start();
      },
    });
    const handlers = spinnerGuardedTurnHandlers(
      spinner,
      output,
      io,
      () => ({ decision: "deny" as const, reason: "n/a" }),
    );
    handlers.onEvent({ type: "agentProgress", kind: "thought" });
    assert.deepStrictEqual(calls, ["label:thinking…", "start"]);
    assert.deepStrictEqual(stderr, []);
    handlers.onDelta("solution found\n");
    assert.deepStrictEqual(calls, [
      "label:thinking…",
      "start",
      "pause",
      "out",
      "label:working…",
      "start",
    ]);
    assert.strictEqual(stdout.join(""), "solution found\n");
  });

  it("progress does not stop the spinner or print a status line", () => {
    const calls: string[] = [];
    const { io, stderr } = fakeIo();
    const spinner = stubSpinner(calls);
    const output = createTurnOutputHandlers(cfg(), io, {
      beforeWrite: spinner.pause,
      afterWrite: () => {
        spinner.updateLabel("working…");
        spinner.start();
      },
    });
    const handlers = spinnerGuardedTurnHandlers(
      spinner,
      output,
      io,
      () => ({ decision: "deny" as const, reason: "n/a" }),
    );
    handlers.onEvent({
      type: "agentProgress",
      kind: "tool_call",
      title: "Inspecting codebase",
    });
    assert.deepStrictEqual(calls, ["label:Inspecting codebase", "start"]);
    assert.deepStrictEqual(stderr, []);
  });

  it("keeps spinning through an invisible event (modelSelected)", () => {
    const calls: string[] = [];
    const { io, stderr } = fakeIo();
    const spinner = stubSpinner(calls);
    const output = createTurnOutputHandlers(cfg(), io, {
      beforeWrite: spinner.pause,
      afterWrite: () => {
        spinner.updateLabel("working…");
        spinner.start();
      },
    });
    const handlers = spinnerGuardedTurnHandlers(
      spinner,
      output,
      io,
      () => ({ decision: "deny" as const, reason: "n/a" }),
    );
    // Emitted right before the provider wait; it renders nothing, so the
    // spinner must survive it — otherwise it vanishes before the wait it
    // exists to cover.
    handlers.onEvent({ type: "modelSelected", modelSlug: "x", tier: 0 });
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(stderr, []);
    // …and yields/restarts around the first delta that follows.
    handlers.onDelta("hi\n");
    assert.deepStrictEqual(calls, ["pause", "label:working…", "start"]);
  });

  it("stops the spinner before delegating a mid-turn approval", async () => {
    const calls: string[] = [];
    const { io } = fakeIo();
    const output = createTurnOutputHandlers(cfg(), io);
    const handlers = spinnerGuardedTurnHandlers(
      stubSpinner(calls),
      output,
      io,
      () => {
        calls.push("approval");
        return { decision: "approve" as const };
      },
    );
    const verdict = await handlers.onApproval({ kind: "tool" });
    assert.deepStrictEqual(calls, [
      "pause",
      "approval",
      "label:working…",
      "start",
    ]);
    assert.deepStrictEqual(verdict, { decision: "approve" });
  });
});

describe("sanitizeSpinnerLabel", () => {
  it("complete ANSI, OSC, C0, and C1 inputs cannot alter terminal control flow", () => {
    assert.strictEqual(
      sanitizeSpinnerLabel("Malicious\x1b[31m title\nwith controls\r\n"),
      "Malicious title with controls",
    );
    assert.strictEqual(
      sanitizeSpinnerLabel("C1\u009b31m style\u0085 test"),
      "C1 style test",
    );
    assert.strictEqual(
      sanitizeSpinnerLabel("\x1b]8;;https://evil.example\x07link\x1b]8;;\x07"),
      "link",
    );
    const sanitized = sanitizeSpinnerLabel(
      "keep\x1b]8;;https://evil.example\x07text\x1b\\done",
    );
    assert.strictEqual(sanitized, "keeptextdone");
    assert.doesNotMatch(sanitized, /[\x00-\x1f\x7f-\x9f]/);
  });

  it("incomplete ANSI, OSC, C0, and C1 inputs cannot alter terminal control flow", () => {
    assert.strictEqual(
      sanitizeSpinnerLabel("\x1b]8;;https://evil.example/no-terminator"),
      null,
    );
    assert.strictEqual(sanitizeSpinnerLabel("\x1b[31"), null);
    assert.strictEqual(sanitizeSpinnerLabel("\x1b"), null);
    assert.strictEqual(sanitizeSpinnerLabel("\u009d8;;unterminated-osc"), null);
    const prefix = sanitizeSpinnerLabel("ok\x1b]8;;truncated");
    assert.strictEqual(prefix, "ok");
    assert.doesNotMatch(prefix, /[\x00-\x1f\x7f-\x9f]/);
    assert.ok(!prefix.includes("truncated"));
  });

  it("tool status is bounded before expensive normalization", () => {
    const leak = "LEAK-AFTER-SCAN-BUDGET";
    const hugeOsc = `\x1b]8;;${"A".repeat(1_000_000)}\x07${leak}`;
    assert.strictEqual(sanitizeSpinnerLabel(hugeOsc), null);
    const longVisible = `${"x".repeat(300)}${leak}`;
    const truncated = sanitizeSpinnerLabel(longVisible);
    assert.strictEqual(truncated, `${"x".repeat(39)}…`);
    assert.ok(!truncated.includes(leak));
  });
});

describe("runtimeEventIsVisible", () => {
  it("invisible bookkeeping events render nothing", () => {
    assert.strictEqual(
      runtimeEventIsVisible({ type: "modelSelected", modelSlug: "x" }),
      false,
    );
    assert.strictEqual(
      runtimeEventIsVisible({ type: "unknownFutureEvent" }),
      false,
    );
    assert.strictEqual(
      runtimeEventIsVisible({ type: "agentProgress", kind: "thought" }),
      false,
    );
    assert.strictEqual(runtimeEventIsVisible(null), false);
    assert.strictEqual(runtimeEventIsVisible("nope"), false);
  });

  it("status-line and supersede events are visible", () => {
    assert.strictEqual(
      runtimeEventIsVisible({ type: "toolCallStarted", commandId: "x" }),
      true,
    );
    assert.strictEqual(
      runtimeEventIsVisible({ type: "toolStepStarted", step: 1 }),
      true,
    );
    assert.strictEqual(runtimeEventIsVisible(supersedeEvent()), true);
  });
});
