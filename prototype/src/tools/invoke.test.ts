// Tests for command invocation and its tool_call event (`invoke.ts`).

import {
  assertEquals,
  assertFalse,
  assertGreater,
  assertLessOrEqual,
  assertObjectMatch,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import type { EventInsert } from "../store/mod.ts";
import type { CommandCall, CommandDefinition } from "./definition.ts";
import { createCommandRegistry } from "./registry.ts";
import {
  buildCommandToolCallEventPayload,
  EVENT_RESULT_MAX_BYTES,
  invokeCommand,
  invokeCommandWithEvent,
  truncateForEventColumn,
} from "./invoke.ts";
import { buildToolCatalog } from "./catalog.ts";
import { RootAnchors } from "./builtin/root-anchors.ts";

function readCommand(
  overrides: Partial<CommandDefinition<string>> = {},
): CommandDefinition<string> {
  return {
    id: "memory.read",
    title: "Read Memory",
    description: "Load one Dolt-backed memory by slug.",
    inputSchema: {
      type: "object",
      required: ["slug"],
      properties: {
        slug: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["read.memory", "emit.event"],
      defaultDecision: "allow",
      resources: ["memory:*"],
      network: "local",
      filesystem: "none",
      cost: "none",
    },
    executor: (call) => Promise.resolve(`read ${call.arguments.slug}`),
    ...overrides,
  };
}

function call(
  args: Record<string, unknown> = { slug: "project_dyfj" },
  overrides: Partial<CommandCall> = {},
): CommandCall {
  return {
    commandId: "memory.read",
    callId: "call-123",
    caller: { principalId: "operator", principalType: "human" },
    arguments: args,
    ...overrides,
  };
}

describe("invokeCommand approval (ask) flow", () => {
  function writeFileCommand(
    executor: CommandDefinition<string>["executor"] = (c) =>
      `wrote ${c.arguments.path}`,
  ): CommandDefinition<string> {
    return readCommand({
      id: "write_file",
      title: "Write File",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
        additionalProperties: false,
      },
      permission: {
        effects: ["write.filesystem", "emit.event"],
        defaultDecision: "allow",
        resources: ["file:write"],
        network: "none",
        filesystem: "write",
        cost: "none",
      },
      executor,
    });
  }

  it("with no approver, a mutating tool is denied — fail-closed", async () => {
    let ran = false;
    const registry = createCommandRegistry([
      writeFileCommand(() => {
        ran = true;
        return "ran";
      }),
    ]);
    const result = await invokeCommand(
      registry,
      call({ path: "x" }, { commandId: "write_file" }),
    );
    assertObjectMatch(result, {
      decision: "deny",
      authzBasis: "policy:deny:approval-denied",
      isError: true,
    });
    assertStrictEquals(ran, false);
  });

  it("an approve verdict runs the tool with the operator-approved basis", async () => {
    const registry = createCommandRegistry([writeFileCommand()]);
    const result = await invokeCommand(
      registry,
      call({ path: "x" }, { commandId: "write_file" }),
      () => Promise.resolve({ decision: "approve" }),
    );
    assertEquals(result, {
      decision: "allow",
      authzBasis: "policy:allow:operator-approved",
      isError: false,
      result: "wrote x",
    });
  });

  it("does not start the executor while approval is pending", async () => {
    let approve!: (verdict: { decision: "approve" }) => void;
    const approval = new Promise<{ decision: "approve" }>((resolve) => {
      approve = resolve;
    });
    let ran = false;
    const registry = createCommandRegistry([
      writeFileCommand(() => {
        ran = true;
        return "ran";
      }),
    ]);
    const pending = invokeCommand(
      registry,
      call({ path: "x" }, { commandId: "write_file" }),
      () => approval,
    );

    await Promise.resolve();
    assertStrictEquals(ran, false);

    approve({ decision: "approve" });
    assertObjectMatch(await pending, { decision: "allow" });
    assertStrictEquals(ran, true);
  });

  it("a deny verdict does not run the tool and carries the reason", async () => {
    let ran = false;
    const registry = createCommandRegistry([
      writeFileCommand(() => {
        ran = true;
        return "ran";
      }),
    ]);
    const result = await invokeCommand(
      registry,
      call({ path: "x" }, { commandId: "write_file" }),
      () => Promise.resolve({ decision: "deny", reason: "operator said no" }),
    );
    assertObjectMatch(result, {
      decision: "deny",
      authzBasis: "policy:deny:approval-denied",
      reason: "operator said no",
      isError: true,
    });
    assertStrictEquals(ran, false);
  });

  it("the approval request carries the tool identity and arguments", async () => {
    let seen: unknown;
    const registry = createCommandRegistry([writeFileCommand()]);
    await invokeCommand(
      registry,
      call({ path: "a.txt" }, { commandId: "write_file" }),
      (request) => {
        seen = request;
        return Promise.resolve({ decision: "approve" });
      },
    );
    assertEquals(seen, {
      commandId: "write_file",
      callId: "call-123",
      title: "Write File",
      arguments: { path: "a.txt" },
    });
  });

  it("a per-call approval title replaces the static title on the request", async () => {
    let seen: unknown;
    const registry = createCommandRegistry([{
      ...writeFileCommand(),
      approvalTitle: (c) => `Write File (${c.arguments.path})`,
    }]);
    await invokeCommand(
      registry,
      call({ path: "a.txt" }, { commandId: "write_file" }),
      (request) => {
        seen = request;
        return Promise.resolve({ decision: "approve" });
      },
    );
    assertObjectMatch(seen as Record<string, unknown>, {
      title: "Write File (a.txt)",
    });
  });

  it("an invalid-argument mutating call is denied before any approval", async () => {
    let asked = false;
    const registry = createCommandRegistry([writeFileCommand()]);
    const result = await invokeCommand(
      registry,
      call({ path: "x", extra: 1 }, { commandId: "write_file" }),
      () => {
        asked = true;
        return Promise.resolve({ decision: "approve" });
      },
    );
    assertObjectMatch(result, {
      decision: "deny",
      authzBasis: "policy:deny:invalid-arguments",
    });
    assertStrictEquals(asked, false);
  });
});

describe("invokeCommand", () => {
  it("executes an allowed command and returns its authz basis", async () => {
    const registry = createCommandRegistry([readCommand()]);

    assertEquals(await invokeCommand(registry, call()), {
      decision: "allow",
      authzBasis: "policy:allow:read-only-local",
      isError: false,
      result: "read project_dyfj",
    });
  });

  it("does not execute denied commands", async () => {
    let executed = false;
    const registry = createCommandRegistry([
      readCommand({
        executor: () => {
          executed = true;
          return Promise.resolve("should not happen");
        },
      }),
    ]);

    const result = await invokeCommand(registry, call({ slug: "../secret" }));

    assertObjectMatch(result, {
      decision: "deny",
      isError: true,
      authzBasis: "policy:deny:invalid-arguments",
    });
    assertStrictEquals(executed, false);
  });
});

describe("buildCommandToolCallEventPayload", () => {
  it("builds a successful tool_call event from a command result", () => {
    const payload = buildCommandToolCallEventPayload(
      call(),
      {
        decision: "allow",
        authzBasis: "policy:allow:read-only-local",
        isError: false,
        result: "# Project DYFJ",
      },
      {
        eventId: "01TESTEVENT0000000000000000",
        sessionId: "01TESTSESSION00000000000000",
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        parentSpanId: "fedcba9876543210",
        durationMs: 12,
      },
    );

    assertObjectMatch(payload, {
      event_id: "01TESTEVENT0000000000000000",
      session_id: "01TESTSESSION00000000000000",
      event_type: "tool_call",
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      parent_span_id: "fedcba9876543210",
      principal_id: "operator",
      principal_type: "human",
      action: "invoke",
      resource: "command:memory.read",
      authz_basis: "policy:allow:read-only-local",
      tool_name: "memory.read",
      tool_call_id: "call-123",
      tool_arguments: JSON.stringify({ slug: "project_dyfj" }),
      tool_result: "# Project DYFJ",
      tool_is_error: false,
      content: "memory.read allowed",
      duration_ms: 12,
    });
  });

  it("builds a denied tool_call event without command execution", () => {
    const payload = buildCommandToolCallEventPayload(
      call({ slug: "../secret" }),
      {
        decision: "deny",
        authzBasis: "policy:deny:invalid-arguments",
        isError: true,
        reason: "slug does not match required pattern",
      },
      {
        eventId: "01TESTEVENT0000000000000000",
        sessionId: "01TESTSESSION00000000000000",
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
      },
    );

    assertObjectMatch(payload, {
      action: "deny",
      authz_basis: "policy:deny:invalid-arguments",
      tool_is_error: true,
      tool_result: "slug does not match required pattern",
      content: "memory.read denied: slug does not match required pattern",
    });
  });
});

describe("invokeCommandWithEvent", () => {
  it("executes memory.read and writes one success event", async () => {
    const events: EventInsert[] = [];
    const registry = buildToolCatalog({
      readMemory: (slug) => Promise.resolve(`# ${slug}`),
    }, {});

    const result = await invokeCommandWithEvent(registry, call(), {
      sessionId: "01TESTSESSION00000000000000",
      traceId: "0123456789abcdef0123456789abcdef",
      eventId: "01TESTEVENT0000000000000000",
      spanId: "0123456789abcdef",
      writeEvent: (event) => {
        events.push(event);
      },
    });

    assertObjectMatch(result, {
      decision: "allow",
      isError: false,
      result: "# project_dyfj",
    });
    assertEquals(events.length, 1);
    assertObjectMatch(events[0], {
      event_type: "tool_call",
      action: "invoke",
      tool_name: "memory.read",
      tool_is_error: false,
    });
  });

  it("writes a denial event when memory.read arguments are invalid", async () => {
    let executed = false;
    const events: EventInsert[] = [];
    const registry = buildToolCatalog({
      readMemory: () => {
        executed = true;
        return Promise.resolve("should not happen");
      },
    }, {});

    const result = await invokeCommandWithEvent(
      registry,
      call({ slug: "../secret" }),
      {
        sessionId: "01TESTSESSION00000000000000",
        traceId: "0123456789abcdef0123456789abcdef",
        eventId: "01TESTEVENT0000000000000000",
        spanId: "0123456789abcdef",
        writeEvent: (event) => {
          events.push(event);
        },
      },
    );

    assertObjectMatch(result, {
      decision: "deny",
      isError: true,
    });
    assertStrictEquals(executed, false);
    assertObjectMatch(events[0], {
      event_type: "tool_call",
      action: "deny",
      tool_name: "memory.read",
      tool_is_error: true,
    });
  });
});

// ── Event-copy size cap (tool-result overflow containment) ─────────────────────────────────────────────
//
// events.tool_result is a Dolt/MySQL TEXT column: 65,535 bytes. A tool result
// can run right up to the model-facing 64KB cap (builtin/file-read.ts), which
// overflows the column once bytes (not chars) are counted. The event copy
// must be capped independently of, and well below, the model-facing value.
const DOLT_TEXT_COLUMN_MAX_BYTES = 65_535;

describe("truncateForEventColumn", () => {
  it("leaves a short string unchanged", () => {
    assertStrictEquals(truncateForEventColumn("hello", 100), "hello");
  });

  it("caps an over-limit string and appends a marker with the original byte size", () => {
    const original = "x".repeat(100_000);
    const truncated = truncateForEventColumn(original, 60_000);
    // The contract is output <= maxBytes INCLUDING the marker, not merely
    // under the (much larger) Dolt column limit — a marker appended after an
    // exact-maxBytes slice can itself push the total past maxBytes.
    assertLessOrEqual(new TextEncoder().encode(truncated).byteLength, 60_000);
    assertStringIncludes(truncated, "event-truncated");
    assertStringIncludes(truncated, "100000 bytes");
  });

  // Each "é" is 2 UTF-8 bytes; an odd byte cap forces the cut to land mid
  // character. Asserting only "< the 65,535 Dolt column limit" would pass
  // even for a regressed CHARACTER-based `text.slice(0, maxBytes)` — 12,345
  // "é" chars is 24,690 bytes, still comfortably under 65,535. Pin the actual
  // contract instead: output <= the maxBytes argument itself, and a clean
  // decode (no U+FFFD replacement chars), which only a byte-safe boundary cut
  // guarantees.
  it("cuts on a byte boundary without crashing on multibyte characters", () => {
    const original = "é".repeat(50_000);
    const maxBytes = 12_345;
    // Must not throw on a mid-character cut.
    truncateForEventColumn(original, maxBytes);
    const truncated = truncateForEventColumn(original, maxBytes);
    assertLessOrEqual(new TextEncoder().encode(truncated).byteLength, maxBytes);
    assertFalse(truncated.includes("�"));
  });

  it("a limit smaller than the marker still yields output within the limit", () => {
    // The <= maxBytes contract must hold for EVERY input, not just the
    // production column budget: when the marker alone exceeds maxBytes, the
    // function degrades to a byte-safe slice of the marker rather than
    // returning a marker larger than the promised cap.
    const truncated = truncateForEventColumn("x".repeat(1000), 10);
    assertLessOrEqual(new TextEncoder().encode(truncated).byteLength, 10);
    assertFalse(truncated.includes("�"));
  });

  it("reserves room for the marker itself, even when that leaves a mid-character excerpt boundary", () => {
    // maxBytes (100) comfortably exceeds the marker's own size (~50 bytes)
    // but not by much, so the excerpt budget after reserving the marker is
    // small enough that an odd remainder still forces a mid-character cut.
    const truncated = truncateForEventColumn("é".repeat(200), 100);
    assertLessOrEqual(new TextEncoder().encode(truncated).byteLength, 100);
    assertFalse(truncated.includes("�"));
    assertStringIncludes(truncated, "event-truncated");
  });
});

describe("buildCommandToolCallEventPayload — event copy size cap", () => {
  it("caps a maximally-truncated read_file-sized result below the TEXT column limit", () => {
    // Mirrors builtin/file-access.ts's DEFAULT_MAX_BYTES (64 * 1024 encoded bytes) plus its
    // own truncation suffix — the exact shape that overflowed the column in
    // the original tool-result overflow defect.
    const modelFacingResult = "a".repeat(64 * 1024) +
      "\n\n[truncated at 65536 bytes]";
    const payload = buildCommandToolCallEventPayload(
      call({ path: "workbench.ts" }, { commandId: "read_file" }),
      {
        decision: "allow",
        authzBasis: "policy:allow:read-only-local",
        isError: false,
        result: modelFacingResult,
      },
      {
        eventId: "01TESTEVENT0000000000000000",
        sessionId: "01TESTSESSION00000000000000",
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        durationMs: 5,
      },
    );

    const toolResult = payload.tool_result as string;
    assertLessOrEqual(
      new TextEncoder().encode(toolResult).byteLength,
      EVENT_RESULT_MAX_BYTES,
    );
    assertStringIncludes(toolResult, "event-truncated");
    // The marker records the true (uncapped) size in UTF-8 BYTES — assert in
    // the same unit, not string .length (UTF-16 code units), which only
    // coincides for an all-ASCII fixture and would let a unit regression
    // slip through unnoticed.
    assertStringIncludes(
      toolResult,
      `${new TextEncoder().encode(modelFacingResult).byteLength} bytes`,
    );
  });

  it("a result well under the cap is recorded verbatim (no marker, no data loss)", () => {
    const payload = buildCommandToolCallEventPayload(
      call({ path: "small.txt" }, { commandId: "read_file" }),
      {
        decision: "allow",
        authzBasis: "policy:allow:read-only-local",
        isError: false,
        result: "small file contents",
      },
      {
        eventId: "01TESTEVENT0000000000000000",
        sessionId: "01TESTSESSION00000000000000",
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
      },
    );
    assertStrictEquals(payload.tool_result, "small file contents");
  });
});

// ── read_file end-to-end containment (tool-result overflow acceptance test 1) ─────────────
//
// A real ≥64KB fixture through the real read_file executor and the real
// invokeCommandWithEvent: the call must resolve (not throw), the persisted
// event's tool_result must fit the Dolt TEXT column, and the model-facing
// result — what actually goes back on the transcript — must be untouched by
// this change (builtin/file-read.ts's own truncation behavior is a non-goal here).
describe("read_file → tool_call event containment", () => {
  let root: string;

  beforeAll(async () => {
    root = await Deno.makeTempDir();
    // One character over the model-facing 64KB cap so builtin/file-read.ts's own
    // truncation kicks in — the exact receipted trigger shape.
    await Deno.writeTextFile(`${root}/big.txt`, "a".repeat(64 * 1024 + 500));
  });

  afterAll(async () => {
    if (root) await Deno.remove(root, { recursive: true });
  });

  it("completes without throwing and records a capped event with a full-size marker", async () => {
    const registry = buildToolCatalog({ rootAnchors: new RootAnchors() }, {
      workspaceRoot: root,
    });
    const events: EventInsert[] = [];

    const result = await invokeCommandWithEvent(
      registry,
      call({ path: "big.txt" }, { commandId: "read_file" }),
      {
        sessionId: "01TESTSESSION00000000000000",
        traceId: "0123456789abcdef0123456789abcdef",
        eventId: "01TESTEVENT0000000000000000",
        spanId: "0123456789abcdef",
        writeEvent: (event) => {
          events.push(event);
        },
      },
    );

    // The model-facing result keeps builtin/file-read.ts's own 64KB byte cap —
    // unchanged by this fix (non-goal).
    assertStrictEquals(result.isError, false);
    if (!("result" in result)) throw new Error("expected an allowed result");
    assertStringIncludes(result.result as string, "[truncated at 65536 bytes]");
    const modelFacingBytes = new TextEncoder().encode(result.result as string)
      .byteLength;
    assertGreater(modelFacingBytes, DOLT_TEXT_COLUMN_MAX_BYTES);

    // The event copy is capped well below the column limit, independently of
    // the model-facing value, with a marker recording the true size.
    assertEquals(events.length, 1);
    const toolResult = events[0].tool_result as string;
    assertLessOrEqual(
      new TextEncoder().encode(toolResult).byteLength,
      EVENT_RESULT_MAX_BYTES,
    );
    assertStringIncludes(toolResult, "event-truncated");
  });
});
