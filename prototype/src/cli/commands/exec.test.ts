import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertFalse,
  assertNotMatch,
  assertObjectMatch,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { DomainError } from "../../contract/mod.ts";
import type { ToolApprovalVerdict } from "../../transport/mod.ts";
import {
  fakeApprovalConnect,
  fakeTurnConnect,
  sequentialTurnConnect,
  supersedeEvent,
  turnResult as result,
  unparsedMarkupEvent,
} from "../../../testing/builders/turn-client.ts";
import { fakeIo } from "../../../testing/fakes/fake-io.ts";
import type { CliConfig } from "../args.ts";
import type { ConnectFn, Io, TurnInterruptSource } from "../io.ts";
import { runExec } from "./exec.ts";

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    socket: "/tmp/dyfj-test.sock",
    mode: "turn",
    color: false,
    ...overrides,
  };
}

const ERASE_LINE = "\r\x1b[2K";

describe("runExec tool approval", () => {
  it("prompts and sends the operator's approval back to the server", async () => {
    const captured: { verdict?: ToolApprovalVerdict } = {};
    const { io, stderr } = fakeIo(["y"]);
    const code = await runExec(
      "edit notes",
      cfg({ unix: true }),
      io,
      false,
      fakeApprovalConnect(
        {
          commandId: "write_file",
          title: "Write File",
          arguments: { path: "notes.md", content: "hi" },
        },
        result(),
        captured,
      ),
      true, // interactive
    );
    assertStrictEquals(code, 0);
    assertEquals(captured.verdict, { decision: "approve" });
    assertStringIncludes(stderr.join("\n"), "Write File");
  });

  it("a non-interactive run denies without prompting", async () => {
    const captured: { verdict?: ToolApprovalVerdict } = {};
    const { io } = fakeIo();
    await runExec(
      "edit notes",
      cfg({ unix: true }),
      io,
      false,
      fakeApprovalConnect(
        { commandId: "write_file", title: "Write File", arguments: {} },
        result(),
        captured,
      ),
      false, // not interactive
    );
    assertStrictEquals(captured.verdict?.decision, "deny");
  });

  it("aborts pending operator input when the turn ends first", async () => {
    const approvalSettled = Promise.withResolvers<ToolApprovalVerdict>();
    const io: Io = {
      out: () => {},
      err: () => {},
      readLine: (_prompt, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(null), {
            once: true,
          });
        }),
      close: () => {},
    };
    const connect: ConnectFn = (_socketPath, options) =>
      Promise.resolve({
        request: async (method: string) => {
          if (method === "turn") {
            void Promise.resolve(
              options?.onApproval?.({
                commandId: "external_agent",
                title: "External agent action",
                arguments: {},
              }),
            ).then((verdict) => {
              if (verdict !== undefined) approvalSettled.resolve(verdict);
            });
            return result();
          }
          return undefined;
        },
        close: () => {},
      });

    await assertStrictEquals(
      await runExec(
        "finish before approval",
        cfg({ unix: true }),
        io,
        false,
        connect,
        true,
      ),
      0,
    );
    assertEquals(await approvalSettled.promise, {
      decision: "abort",
    });
  });
});

describe("runExec", () => {
  it("streams text to stdout and the receipt to stderr", async () => {
    const { io, stdout, stderr } = fakeIo();
    const code = await runExec(
      "hello",
      cfg(),
      io,
      false,
      fakeTurnConnect([{ t: "delta", text: "Hi" }], result()),
    );
    assertStrictEquals(code, 0);
    assertStrictEquals(stdout.join(""), "Hi\n");
    assertStringIncludes(stderr.join("\n"), "Qwen3 Coder 30B");
  });

  it("surfaces reconciliation guidance for failed Linear creation independently of model prose", async () => {
    const { io, stderr } = fakeIo();
    await runExec(
      "create",
      cfg(),
      io,
      false,
      fakeTurnConnect([
        {
          t: "event",
          event: {
            type: "toolCallCompleted",
            commandId: "mcp.linear.create_issue",
            isError: true,
            durationMs: 10,
          },
        },
        { t: "delta", text: "No issue was created." },
      ], result({ text: "No issue was created." })),
    );
    assertStringIncludes(stderr.join("\n"), "the issue may already exist");
    assertStringIncludes(
      stderr.join("\n"),
      "reconcile in Linear before retrying",
    );
  });

  it("surfaces tool progress events to stderr", async () => {
    const { io, stderr } = fakeIo();
    const code = await runExec(
      "inspect",
      cfg(),
      io,
      false,
      fakeTurnConnect(
        [
          {
            t: "event",
            event: {
              type: "toolStepStarted",
              step: 1,
              toolCallCount: 1,
            },
          },
          {
            t: "event",
            event: {
              type: "toolCallStarted",
              commandId: "bash",
              callId: "call-1",
            },
          },
          {
            t: "event",
            event: {
              type: "toolCallCompleted",
              commandId: "bash",
              callId: "call-1",
              isError: false,
              durationMs: 85,
            },
          },
        ],
        result(),
      ),
    );
    assertStrictEquals(code, 0);
    assertArrayIncludes(stderr, ["tool: step 1 running 1 call(s)"]);
    assertArrayIncludes(stderr, ["tool: bash started"]);
    assertArrayIncludes(stderr, ["tool: bash finished (85ms)"]);
  });

  it("renders the shared unparsed-markup warning before the receipt", async () => {
    const { io, stderr } = fakeIo();
    const code = await runExec(
      "make the change",
      cfg(),
      io,
      false,
      fakeTurnConnect(
        [
          { t: "delta", text: "provider text" },
          { t: "event", event: unparsedMarkupEvent() },
        ],
        result({ text: "provider text" }),
      ),
    );
    assertStrictEquals(code, 0);
    const warningIndex = stderr.findIndex((line) =>
      line.startsWith("WARNING:")
    );
    const receiptIndex = stderr.findIndex((line) =>
      line.startsWith("— Qwen3 Coder 30B")
    );
    const warning = stderr[warningIndex];
    assertStringIncludes(warning, "no tools were executed from it");
    assert(warningIndex >= 0);
    assert(receiptIndex >= 0);
    assert(warningIndex < receiptIndex);
  });

  it("renders streamed markdown without raw markers", async () => {
    const { io, stdout } = fakeIo();
    const code = await runExec(
      "list tools",
      cfg(),
      io,
      false,
      fakeTurnConnect(
        [{ t: "delta", text: "## Tools\n- **read_file**\n" }],
        result(),
      ),
    );
    assertStrictEquals(code, 0);
    const out = stdout.join("");
    assertNotMatch(out, /##|\*\*/);
    assertStringIncludes(out, "Tools");
    assertStringIncludes(out, "read_file");
  });

  it("falls back to result.text when a turn streams no deltas", async () => {
    const { io, stdout } = fakeIo();
    const code = await runExec(
      "x",
      cfg(),
      io,
      false,
      fakeTurnConnect([], result({ text: "buffered answer" })),
    );
    assertStrictEquals(code, 0);
    assertStrictEquals(stdout.join(""), "buffered answer\n");
  });

  it("the superseding-retry signal resets the renderer mid-stream", async () => {
    // The stale attempt opened a code fence that never closed; the signal
    // must reset that parse state or the replacement's markdown would render
    // verbatim as code-block lines.
    const { io, stdout } = fakeIo();
    const code = await runExec(
      "long question",
      cfg(),
      io,
      false,
      fakeTurnConnect(
        [
          { t: "delta", text: "```\nstale partial\n" },
          { t: "event", event: supersedeEvent() },
          { t: "delta", text: "**fresh** answer\n" },
        ],
        result({ text: "**fresh** answer" }),
      ),
    );
    assertStrictEquals(code, 0);
    const out = stdout.join("");
    const markerAt = out.indexOf("retrying with recovered context");
    assert(markerAt > out.indexOf("stale partial"));
    // Rendered fresh (bold markers consumed), exactly once, after the marker.
    assert(out.indexOf("fresh answer") > markerAt);
    assertFalse(out.includes("**fresh**"));
    assertStrictEquals(
      out.indexOf("fresh answer"),
      out.lastIndexOf("fresh answer"),
    );
  });

  it("a superseding retry that streams no deltas still delivers the receipt text", async () => {
    // The signal re-arms the buffered-text fallback: everything streamed
    // before it is stale, so if nothing streams after, the authoritative
    // receipt text must render rather than leaving only the stale partial.
    const { io, stdout } = fakeIo();
    const code = await runExec(
      "x",
      cfg(),
      io,
      false,
      fakeTurnConnect(
        [
          { t: "delta", text: "stale partial" },
          { t: "event", event: supersedeEvent() },
        ],
        result({ text: "authoritative answer" }),
      ),
    );
    assertStrictEquals(code, 0);
    assertStringIncludes(stdout.join(""), "authoritative answer");
  });

  it("--json prints the buffered result and no receipt", async () => {
    const { io, stdout, stderr } = fakeIo();
    const code = await runExec(
      "hello",
      cfg(),
      io,
      true,
      fakeTurnConnect([], result()),
    );
    assertStrictEquals(code, 0);
    assertObjectMatch(JSON.parse(stdout.join("")), { text: result().text });
    assertEquals(stderr.length, 0);
  });
});

describe("runExec over the socket", () => {
  it("streams text + receipt over the seam", async () => {
    const { io, stdout, stderr } = fakeIo();
    const code = await runExec(
      "hi",
      cfg({ unix: true }),
      io,
      false,
      fakeTurnConnect([{ t: "delta", text: "Hi" }], result()),
    );
    assertStrictEquals(code, 0);
    assertStrictEquals(stdout.join(""), "Hi\n");
    assertStringIncludes(stderr.join("\n"), "Qwen3 Coder 30B");
  });

  it("prints buffered aborted text before the interrupted marker", async () => {
    const writes: string[] = [];
    const io: Io = {
      out: (text) => writes.push(`out:${text}`),
      err: (line) => writes.push(`err:${line}`),
      readLine: () => Promise.resolve(null),
      close: () => {},
    };
    const code = await runExec(
      "hi",
      cfg({ unix: true }),
      io,
      false,
      fakeTurnConnect(
        [],
        result({ stopReason: "aborted", text: "buffered partial text" }),
      ),
    );

    assertStrictEquals(code, 0);
    const textIndex = writes.findIndex((write) =>
      write.includes("buffered partial text")
    );
    const markerIndex = writes.indexOf("err:[interrupted]");
    assert(textIndex >= 0);
    assert(markerIndex > textIndex);
  });

  it("Ctrl-C cancels a one-shot UDS turn exactly once", async () => {
    let activeInterrupt: (() => void) | undefined;
    let finishTurn!: (value: unknown) => void;
    let cancelCalls = 0;
    const interrupts: TurnInterruptSource = {
      add: (handler) => {
        activeInterrupt = handler;
      },
      remove: () => {
        activeInterrupt = undefined;
      },
    };
    const connect: ConnectFn = (_socketPath, options) =>
      Promise.resolve({
        request: (method) => {
          if (method === "turn") {
            options?.onStream?.({ t: "delta", text: "partial" });
            queueMicrotask(() => {
              activeInterrupt?.();
              activeInterrupt?.();
            });
            return new Promise((resolve) => {
              finishTurn = resolve;
            });
          }
          if (method === "turn/cancel") {
            cancelCalls++;
            finishTurn(result({ stopReason: "aborted", text: "partial" }));
            return Promise.resolve({ cancelled: true });
          }
          return Promise.resolve(undefined);
        },
        close: () => {},
      });
    const { io, stdout, stderr } = fakeIo();
    io.turnInterrupts = interrupts;

    const code = await runExec(
      "cancel me",
      cfg({ unix: true }),
      io,
      false,
      connect,
    );

    assertStrictEquals(code, 0);
    assertStrictEquals(cancelCalls, 1);
    assertStringIncludes(stdout.join(""), "partial");
    assertEquals(stderr.filter((line) => line === "[interrupt requested]"), [
      "[interrupt requested]",
    ]);
    assertArrayIncludes(stderr, ["[interrupted]"]);
    assertStrictEquals(activeInterrupt, undefined);
  });

  it("one-shot cleanup preserves the turn failure and still aborts approval input", async () => {
    const approvalSettled = Promise.withResolvers<ToolApprovalVerdict>();
    const interrupts: TurnInterruptSource = {
      add: () => {},
      remove: () => {
        throw new Error("interrupt cleanup failed");
      },
    };
    const connect: ConnectFn = (_socketPath, options) =>
      Promise.resolve({
        request: (method) => {
          if (method !== "turn") return Promise.resolve(undefined);
          void Promise.resolve(
            options?.onApproval?.({
              commandId: "external_agent",
              title: "External agent action",
              arguments: {},
            }),
          ).then((verdict) => {
            if (verdict !== undefined) approvalSettled.resolve(verdict);
          });
          return Promise.reject(new DomainError("turn failed"));
        },
        close: () => {},
      });
    const { io, stderr } = fakeIo();
    io.readLine = (_prompt, signal) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve(null), { once: true });
      });
    io.turnInterrupts = interrupts;

    const code = await runExec(
      "fail while approval is pending",
      cfg({ unix: true }),
      io,
      false,
      connect,
    );

    assertStrictEquals(code, 1);
    assertEquals(await approvalSettled.promise, {
      decision: "abort",
    });
    assertStringIncludes(stderr.join("\n"), "turn failed");
    assertFalse((stderr.join("\n")).includes("interrupt cleanup failed"));
  });

  it("one-shot cleanup failure changes an otherwise successful exit to failure", async () => {
    const interrupts: TurnInterruptSource = {
      add: () => {},
      remove: () => {
        throw new Error("interrupt cleanup failed");
      },
    };
    const { io, stderr } = fakeIo();
    io.turnInterrupts = interrupts;

    const code = await runExec(
      "successful turn",
      cfg({ unix: true }),
      io,
      false,
      fakeTurnConnect([], result()),
    );

    assertStrictEquals(code, 1);
    assertStrictEquals(stderr.at(-1), "dyfj: [Error, 24 bytes]");
  });

  it("honors the superseding-retry signal over the UDS seam too", async () => {
    // Stream frames over the UDS seam honor the same supersede contract.
    const { io, stdout } = fakeIo();
    const code = await runExec(
      "long question",
      cfg({ unix: true }),
      io,
      false,
      fakeTurnConnect(
        [
          { t: "delta", text: "stale partial\n" },
          { t: "event", event: supersedeEvent() },
          { t: "delta", text: "fresh answer\n" },
        ],
        result({ text: "fresh answer" }),
      ),
    );
    assertStrictEquals(code, 0);
    const out = stdout.join("");
    const markerAt = out.indexOf("retrying with recovered context");
    assert(markerAt > out.indexOf("stale partial"));
    assert(out.indexOf("fresh answer") > markerAt);
  });

  it("renders the shared unparsed-markup warning over the UDS seam", async () => {
    const { io, stderr } = fakeIo();
    const code = await runExec(
      "make the change",
      cfg({ unix: true }),
      io,
      false,
      fakeTurnConnect(
        [{ t: "event", event: unparsedMarkupEvent() }],
        result({ text: "provider text" }),
      ),
    );
    assertStrictEquals(code, 0);
    const warningIndex = stderr.findIndex((line) =>
      line.startsWith("WARNING:")
    );
    const receiptIndex = stderr.findIndex((line) =>
      line.startsWith("— Qwen3 Coder 30B")
    );
    const warning = stderr[warningIndex];
    assertStringIncludes(warning, "no tools were executed from it");
    assert(warningIndex >= 0);
    assert(receiptIndex >= 0);
    assert(warningIndex < receiptIndex);
  });

  it("an unreachable socket points the operator at dyfj start", async () => {
    const { io, stderr } = fakeIo();
    const code = await runExec(
      "hi",
      cfg({ unix: true, socket: "/run/missing.sock" }),
      io,
      false,
      () => {
        throw new Error("No such file or directory (os error 2)");
      },
    );
    assertStrictEquals(code, 1);
    assertStringIncludes(stderr.join("\n"), "dyfj start");
  });
});

describe("runExec spinner integration", () => {
  it("paints at submit and erases before streamed output on a TTY", async () => {
    const { io, raw, stdout } = fakeIo([], { errIsTerminal: true });
    const code = await runExec(
      "x",
      cfg(),
      io,
      false,
      fakeTurnConnect([{ t: "delta", text: "hi\n" }], result()),
    );
    assertStrictEquals(code, 0);
    assertStrictEquals(raw[0], `${ERASE_LINE}⠋ working… 0s`);
    assertStrictEquals(raw[raw.length - 1], ERASE_LINE);
    assertStringIncludes(stdout.join(""), "hi");
  });

  it("an invisible modelSelected event does not erase the spinner early", async () => {
    // The real ordering: modelSelected arrives before the provider wait, then
    // the first delta. The spinner must survive the event, yield around the
    // delta, resume, and retire only at the terminal result.
    const { io, raw } = fakeIo([], { errIsTerminal: true });
    const code = await runExec(
      "x",
      cfg(),
      io,
      false,
      fakeTurnConnect(
        [
          { t: "event", event: { type: "modelSelected", modelSlug: "x" } },
          { t: "delta", text: "hi\n" },
        ],
        result(),
      ),
    );
    assertStrictEquals(code, 0);
    assertEquals((raw.filter((w) => w === ERASE_LINE)).length, 2);
    assertArrayIncludes(raw, [`${ERASE_LINE}⠙ working… 0s`]);
    assertStrictEquals(raw[raw.length - 1], ERASE_LINE);
  });

  it("erases the spinner when the turn fails (no orphaned line)", async () => {
    const { io, raw } = fakeIo([], { errIsTerminal: true });
    const code = await runExec(
      "x",
      cfg(),
      io,
      false,
      sequentialTurnConnect([{ error: new DomainError("boom") }]).connect,
    );
    assertStrictEquals(code, 1);
    assertStrictEquals(raw[raw.length - 1], ERASE_LINE);
  });

  it("--json turns never see spinner bytes", async () => {
    const { io, raw } = fakeIo([], { errIsTerminal: true });
    const code = await runExec(
      "x",
      cfg(),
      io,
      true,
      fakeTurnConnect([], result()),
    );
    assertStrictEquals(code, 0);
    assertEquals(raw, []);
  });

  it("piped stderr sees no spinner bytes", async () => {
    const { io, raw } = fakeIo();
    const code = await runExec(
      "x",
      cfg(),
      io,
      false,
      fakeTurnConnect([{ t: "delta", text: "hi" }], result()),
    );
    assertStrictEquals(code, 0);
    assertEquals(raw, []);
  });
});
