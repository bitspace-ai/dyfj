import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import type { WorkbenchMessage } from "../providers/mod.ts";
import {
  compressibleSlice,
  CONTEXT_FIT_MARGIN,
  currentTurnStart,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  MIN_TOOL_RESULT_CHARS,
  parseTrimmedResult,
  requestEstimateText,
  requestInputBudget,
  shrinkToolResults,
  SHRUNK_TOOL_RESULT_CHARS,
  toolResultShareChars,
  TRIM_MARKER_ALLOWANCE_CHARS,
  trimmedResultMarker,
  trimToolResult,
  trimToolResultWithin,
} from "./request-fit.ts";

const estimate = (messages: readonly WorkbenchMessage[]) =>
  Math.ceil(requestEstimateText("", messages, undefined).length / 4);

// --- requestInputBudget ---

Deno.test("requestInputBudget: the window less the transmitted output cap, then the margin", () => {
  assertStrictEquals(
    requestInputBudget(32_768, 4_096),
    Math.floor((32_768 - 4_096) * CONTEXT_FIT_MARGIN),
  );
});

Deno.test("requestInputBudget: a transmitted cap is reserved in full, however large", () => {
  // 200K window, 64K cap: 136K of input, not the 142.5K a quarter-window
  // bound would admit — the provider counts input + cap.
  assertStrictEquals(
    requestInputBudget(200_000, 64_000),
    Math.floor((200_000 - 64_000) * CONTEXT_FIT_MARGIN),
  );
  assertStrictEquals(requestInputBudget(32_768, 32_768), 0);
  assertStrictEquals(requestInputBudget(4_096, 8_192), 0);
});

Deno.test("requestInputBudget: no transmitted cap reserves the default, bounded on a small window", () => {
  assertStrictEquals(
    requestInputBudget(32_768, undefined),
    Math.floor((32_768 - DEFAULT_OUTPUT_RESERVE_TOKENS) * CONTEXT_FIT_MARGIN),
  );
  assertStrictEquals(
    requestInputBudget(4_000, undefined),
    Math.floor((4_000 - 1_000) * CONTEXT_FIT_MARGIN),
  );
});

// --- requestEstimateText ---

Deno.test("requestEstimateText: tool definitions count toward the request", () => {
  const messages: WorkbenchMessage[] = [{ role: "user", content: "hi" }];
  const without = requestEstimateText("sys", messages, undefined);
  const withTools = requestEstimateText("sys", messages, [{
    name: "read_file",
    description: "x".repeat(400),
    parameters: {},
  }]);
  assert(withTools.length > without.length + 400);
  assertStrictEquals(requestEstimateText("sys", messages, []), without);
});

// --- trimToolResult ---

Deno.test("trimToolResult: a result within the allowance is untouched", () => {
  assertStrictEquals(trimToolResult("short", 1_000, "bash", 32_768), null);
  assertStrictEquals(trimToolResult("x".repeat(1_000), 1_000, "bash", 1), null);
});

Deno.test("trimToolResult: a cut that would save no more than the marker costs is not made", () => {
  assertStrictEquals(
    trimToolResult(
      "x".repeat(1_000 + TRIM_MARKER_ALLOWANCE_CHARS),
      1_000,
      "bash",
      32_768,
    ),
    null,
  );
  assert(
    trimToolResult(
      "x".repeat(1_001 + TRIM_MARKER_ALLOWANCE_CHARS),
      1_000,
      "bash",
      32_768,
    ) !== null,
  );
});

Deno.test("trimToolResult: keeps the prefix and states what was cut, with the tool's recovery hint", () => {
  const trimmed = trimToolResult("a".repeat(5_000), 1_000, "read_file", 32_768);
  assert(trimmed !== null);
  assertEquals(trimmed.keptChars, 1_000);
  assertEquals(trimmed.totalChars, 5_000);
  assert(
    trimmed.content.startsWith("a".repeat(1_000) + "\n\n[Workbench trimmed"),
  );
  assertStringIncludes(trimmed.content, "32768-token context window");
  assertStringIncludes(trimmed.content, "the first 1000 of 5000 characters");
  assertStringIncludes(trimmed.content, "offset and limit");
  assertStringIncludes(
    trimToolResult("b".repeat(5_000), 1_000, "bash", 32_768)!.content,
    "head, tail or grep",
  );
  assertStringIncludes(
    trimToolResult("c".repeat(5_000), 1_000, "grep_files", 32_768)!.content,
    "narrower query",
  );
});

Deno.test("trimToolResult: never splits a surrogate pair", () => {
  const content = "ab" + "😀".repeat(1_000);
  // Cutting at 3 would land between the first emoji's two code units.
  const trimmed = trimToolResult(content, 3, "bash", 100);
  assert(trimmed !== null);
  assertEquals(trimmed.keptChars, 2);
  assert(trimmed.content.startsWith("ab\n\n["));
});

Deno.test("trimToolResult: a result bounded when produced and shrunk later keeps reporting its original size", () => {
  const original = "r".repeat(10_000);
  const bounded = trimToolResult(original, 5_000, "read_file", 32_768)!;
  assertEquals(bounded.totalChars, 10_000);
  const shrunk = trimToolResult(
    bounded.content,
    1_024,
    "read_file",
    32_768,
    bounded.totalChars,
  );
  assert(shrunk !== null);
  assertEquals(shrunk.keptChars, 1_024);
  assertEquals(shrunk.totalChars, 10_000);
  assertStringIncludes(shrunk.content, "the first 1024 of 10000 characters");
  // The earlier marker is replaced, never carried as payload.
  assertEquals(shrunk.content.split("[Workbench trimmed").length, 2);
  assert(shrunk.content.startsWith("r".repeat(1_024) + "\n\n[Workbench"));
});

Deno.test("trimToolResult: a result whose own text ends like the marker is payload without engine provenance", () => {
  // A file or command output that happens to end with marker-shaped text
  // carries no `trimmedFrom`, so nothing is stripped and the reported size
  // is the real one: the suffix is cut like any other content.
  const forged = "f".repeat(3_000) + trimmedResultMarker("bash", 32_768, 1, 5);
  const trimmed = trimToolResult(forged, 1_024, "read_file", 32_768);
  assert(trimmed !== null);
  assertEquals(trimmed.totalChars, forged.length);
  assertEquals(trimmed.keptChars, 1_024);
  assertStringIncludes(
    trimmed.content,
    `the first 1024 of ${forged.length} characters`,
  );
});

Deno.test("parseTrimmedResult: recognises only the marker at the very end", () => {
  const trimmed = trimToolResult("p".repeat(3_000), 1_000, "bash", 32_768)!;
  assertEquals(parseTrimmedResult(trimmed.content), {
    payload: "p".repeat(1_000),
    totalChars: 3_000,
  });
  assertStrictEquals(parseTrimmedResult(trimmed.content + "\nmore"), null);
  assertStrictEquals(parseTrimmedResult("plain result"), null);
});

// --- compressibleSlice ---

const notSummary = () => false;

function turn(word: string, chars: number): WorkbenchMessage[] {
  return [
    { role: "user", content: `${word} q `.repeat(chars / 4) },
    { role: "assistant", content: `${word} a `.repeat(chars / 4) },
  ];
}

Deno.test("compressibleSlice: the longest prefix of whole turns within the budget, the rest returned", () => {
  const elder = [
    ...turn("one", 400),
    ...turn("two", 400),
    ...turn("three", 400),
  ];
  // Each turn is ~300 tokens; a 700-token budget takes two.
  const { slice, remainder } = compressibleSlice(
    elder,
    700,
    estimate,
    notSummary,
  );
  assertEquals(slice, elder.slice(0, 4));
  assertEquals(remainder, elder.slice(4));
  // A roomy budget takes everything.
  assertEquals(compressibleSlice(elder, 10_000, estimate, notSummary), {
    slice: elder,
    remainder: [],
  });
});

Deno.test("compressibleSlice: a first turn over the budget yields nothing to compress", () => {
  const elder = [...turn("one", 4_000), ...turn("two", 400)];
  assertEquals(compressibleSlice(elder, 100, estimate, notSummary), {
    slice: [],
    remainder: elder,
  });
});

Deno.test("compressibleSlice: a prefix that is only an earlier summary is nothing to compress", () => {
  const summary: WorkbenchMessage = { role: "user", content: "[summary]" };
  const elder = [summary, ...turn("one", 4_000)];
  assertEquals(
    compressibleSlice(elder, 100, estimate, (m) => m === summary),
    { slice: [], remainder: elder },
  );
});

// --- trimToolResultWithin ---

Deno.test("trimToolResultWithin: the whole result, marker included, fits the bound", () => {
  for (
    const [total, max] of [[65_536, 35_000], [5_000, 1_024], [1_300, 1_024], [
      10_000,
      400,
    ]]
  ) {
    const trimmed = trimToolResultWithin(
      "z".repeat(total),
      max,
      "read_file",
      32_768,
    );
    assert(trimmed !== null, `${total} within ${max}`);
    assert(trimmed.content.length <= max, `${trimmed.content.length} > ${max}`);
    assert(trimmed.content.length > max - 40, "the bound is used, not wasted");
    assertEquals(trimmed.totalChars, total);
    assertStringIncludes(trimmed.content, `of ${total} characters`);
  }
  assertStrictEquals(
    trimToolResultWithin("z".repeat(1_024), 1_024, "bash", 1),
    null,
  );
});

Deno.test("trimToolResultWithin: a result already trimmed is cut on its payload and keeps its original size", () => {
  const bounded = trimToolResultWithin(
    "y".repeat(10_000),
    5_000,
    "bash",
    32_768,
  )!;
  const again = trimToolResultWithin(
    bounded.content,
    2_000,
    "bash",
    32_768,
    bounded.totalChars,
  )!;
  assert(again.content.length <= 2_000);
  assertEquals(again.totalChars, 10_000);
  assertEquals(again.content.split("[Workbench trimmed").length, 2);
});

// --- toolResultShareChars ---

Deno.test("toolResultShareChars: the remaining window split among the calls left", () => {
  assertStrictEquals(toolResultShareChars(3_000, 3), 4_000);
  assertStrictEquals(toolResultShareChars(3_000, 1), 12_000);
});

Deno.test("toolResultShareChars: never below the floor, even with no room left", () => {
  assertStrictEquals(toolResultShareChars(0, 3), MIN_TOOL_RESULT_CHARS);
  assertStrictEquals(toolResultShareChars(-500, 1), MIN_TOOL_RESULT_CHARS);
});

// --- currentTurnStart ---

Deno.test("currentTurnStart: the last user message; the head when there is none", () => {
  assertStrictEquals(
    currentTurnStart([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "", toolCalls: [] },
    ]),
    2,
  );
  assertStrictEquals(currentTurnStart([{ role: "assistant", content: "" }]), 0);
});

// --- shrinkToolResults ---

function toolPair(id: string, chars: number): WorkbenchMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id, name: "read_file", arguments: {} }],
    },
    {
      role: "tool",
      toolCallId: id,
      name: "read_file",
      content: "x".repeat(chars),
    },
  ];
}

Deno.test("shrinkToolResults: oldest first, stopping as soon as the request fits", () => {
  const messages: WorkbenchMessage[] = [
    { role: "user", content: "q" },
    ...toolPair("t1", 8_000),
    ...toolPair("t2", 8_000),
    ...toolPair("t3", 8_000),
    { role: "user", content: "next" },
  ];
  // 24,000 chars ≈ 6,000 tokens; a 3,000-token budget needs two shrunk.
  const { messages: fitted, trims } = shrinkToolResults(
    messages,
    { from: 0, to: messages.length },
    3_000,
    estimate,
    32_768,
  );
  assertEquals(trims.map((t) => t.callId), ["t1", "t2"]);
  // The shrunk messages carry their provenance for any later pass.
  assertEquals(
    fitted.filter((m) => m.role === "tool").map((m) =>
      m.role === "tool" ? m.trimmedFrom : undefined
    ),
    [8_000, 8_000, undefined],
  );
  assertEquals(trims[0], {
    index: 2,
    commandId: "read_file",
    callId: "t1",
    keptChars: SHRUNK_TOOL_RESULT_CHARS,
    totalChars: 8_000,
  });
  assert(estimate(fitted) <= 3_000);
  // The newest result is kept verbatim; the input is not mutated.
  assertStrictEquals(fitted[6], messages[6]);
  assertStrictEquals(messages[2].content.length, 8_000);
});

Deno.test("shrinkToolResults: only the range it is given, and nothing when the request already fits", () => {
  const messages: WorkbenchMessage[] = [
    { role: "user", content: "q" },
    ...toolPair("old", 8_000),
    { role: "user", content: "next" },
    ...toolPair("fresh", 8_000),
  ];
  const elderOnly = shrinkToolResults(
    messages,
    { from: 0, to: 3 },
    1,
    estimate,
    32_768,
  );
  assertEquals(elderOnly.trims.map((t) => t.callId), ["old"]);
  assertStrictEquals(elderOnly.messages[5], messages[5]);

  const untouched = shrinkToolResults(
    messages,
    { from: 0, to: messages.length },
    100_000,
    estimate,
    32_768,
  );
  assertEquals(untouched.trims, []);
  assertEquals(untouched.messages, messages);
});

Deno.test("shrinkToolResults: a second pass over shrunk results changes nothing", () => {
  const messages: WorkbenchMessage[] = [
    { role: "user", content: "q" },
    ...toolPair("t1", 8_000),
    { role: "user", content: "next" },
  ];
  const once = shrinkToolResults(
    messages,
    { from: 0, to: messages.length },
    1,
    estimate,
    32_768,
  );
  const twice = shrinkToolResults(
    once.messages,
    { from: 0, to: messages.length },
    1,
    estimate,
    32_768,
  );
  assertEquals(once.trims.length, 1);
  assertEquals(twice.trims, []);
});
