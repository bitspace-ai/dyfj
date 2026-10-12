import assert from "node:assert/strict";
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
  assert.strictEqual(
    requestInputBudget(32_768, 4_096),
    Math.floor((32_768 - 4_096) * CONTEXT_FIT_MARGIN),
  );
});

Deno.test("requestInputBudget: a transmitted cap is reserved in full, however large", () => {
  // 200K window, 64K cap: 136K of input, not the 142.5K a quarter-window
  // bound would admit — the provider counts input + cap.
  assert.strictEqual(
    requestInputBudget(200_000, 64_000),
    Math.floor((200_000 - 64_000) * CONTEXT_FIT_MARGIN),
  );
  assert.strictEqual(requestInputBudget(32_768, 32_768), 0);
  assert.strictEqual(requestInputBudget(4_096, 8_192), 0);
});

Deno.test("requestInputBudget: no transmitted cap reserves the default, bounded on a small window", () => {
  assert.strictEqual(
    requestInputBudget(32_768, undefined),
    Math.floor((32_768 - DEFAULT_OUTPUT_RESERVE_TOKENS) * CONTEXT_FIT_MARGIN),
  );
  assert.strictEqual(
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
  assert.ok(withTools.length > without.length + 400);
  assert.strictEqual(requestEstimateText("sys", messages, []), without);
});

// --- trimToolResult ---

Deno.test("trimToolResult: a result within the allowance is untouched", () => {
  assert.strictEqual(trimToolResult("short", 1_000, "bash", 32_768), null);
  assert.strictEqual(trimToolResult("x".repeat(1_000), 1_000, "bash", 1), null);
});

Deno.test("trimToolResult: a cut that would save no more than the marker costs is not made", () => {
  assert.strictEqual(
    trimToolResult(
      "x".repeat(1_000 + TRIM_MARKER_ALLOWANCE_CHARS),
      1_000,
      "bash",
      32_768,
    ),
    null,
  );
  assert.ok(
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
  assert.ok(trimmed !== null);
  assert.deepStrictEqual(trimmed.keptChars, 1_000);
  assert.deepStrictEqual(trimmed.totalChars, 5_000);
  assert.ok(
    trimmed.content.startsWith("a".repeat(1_000) + "\n\n[Workbench trimmed"),
  );
  assert.ok(
    trimmed.content.includes("32768-token context window"),
    `expected ${
      JSON.stringify(trimmed.content)
    } to include "32768-token context window"`,
  );
  assert.ok(
    trimmed.content.includes("the first 1000 of 5000 characters"),
    `expected ${
      JSON.stringify(trimmed.content)
    } to include "the first 1000 of 5000 characters"`,
  );
  assert.ok(
    trimmed.content.includes("offset and limit"),
    `expected ${JSON.stringify(trimmed.content)} to include "offset and limit"`,
  );
  assert.ok(
    trimToolResult("b".repeat(5_000), 1_000, "bash", 32_768)!.content.includes(
      "head, tail or grep",
    ),
    `expected trimToolResult("b".repeat(5_000), 1_000, "bash", 32_768)!.content to include "head, tail or grep"`,
  );
  assert.ok(
    trimToolResult("c".repeat(5_000), 1_000, "grep_files", 32_768)!.content
      .includes("narrower query"),
    `expected trimToolResult("c".repeat(5_000), 1_000, "grep_files", 32_768)!.content to include "narrower query"`,
  );
  // git takes typed arguments, never a shell pipeline.
  const git = trimToolResult("d".repeat(5_000), 1_000, "git", 32_768)!.content;
  assert.ok(
    git.includes("narrowed to specific paths"),
    `expected ${JSON.stringify(git)} to include "narrowed to specific paths"`,
  );
  assert.deepStrictEqual(git.includes("piped"), false);
});

Deno.test("trimToolResult: never splits a surrogate pair", () => {
  const content = "ab" + "😀".repeat(1_000);
  // Cutting at 3 would land between the first emoji's two code units.
  const trimmed = trimToolResult(content, 3, "bash", 100);
  assert.ok(trimmed !== null);
  assert.deepStrictEqual(trimmed.keptChars, 2);
  assert.ok(trimmed.content.startsWith("ab\n\n["));
});

Deno.test("trimToolResult: a result bounded when produced and shrunk later keeps reporting its original size", () => {
  const original = "r".repeat(10_000);
  const bounded = trimToolResult(original, 5_000, "read_file", 32_768)!;
  assert.deepStrictEqual(bounded.totalChars, 10_000);
  const shrunk = trimToolResult(
    bounded.content,
    1_024,
    "read_file",
    32_768,
    bounded.totalChars,
  );
  assert.ok(shrunk !== null);
  assert.deepStrictEqual(shrunk.keptChars, 1_024);
  assert.deepStrictEqual(shrunk.totalChars, 10_000);
  assert.ok(
    shrunk.content.includes("the first 1024 of 10000 characters"),
    `expected ${
      JSON.stringify(shrunk.content)
    } to include "the first 1024 of 10000 characters"`,
  );
  // The earlier marker is replaced, never carried as payload.
  assert.deepStrictEqual(shrunk.content.split("[Workbench trimmed").length, 2);
  assert.ok(shrunk.content.startsWith("r".repeat(1_024) + "\n\n[Workbench"));
});

Deno.test("trimToolResult: a result trimmed before is cut on any payload over the keep, with no allowance", () => {
  // The marker is replaced, not added, so a 1,300-character payload shrinks
  // to the 1,024 fallback; untrimmed content of that size would not.
  const bounded = trimToolResultWithin(
    "w".repeat(10_000),
    1_300,
    "bash",
    32_768,
  )!;
  const shrunk = trimToolResult(
    bounded.content,
    1_024,
    "bash",
    32_768,
    bounded.totalChars,
  );
  assert.ok(shrunk !== null);
  assert.deepStrictEqual(shrunk.keptChars, 1_024);
  assert.deepStrictEqual(shrunk.totalChars, 10_000);
  assert.strictEqual(
    trimToolResult("w".repeat(1_300), 1_024, "bash", 32_768),
    null,
  );
});

Deno.test("trimToolResult: a result whose own text ends like the marker is payload without engine provenance", () => {
  // A file or command output that happens to end with marker-shaped text
  // carries no `trimmedFrom`, so nothing is stripped and the reported size
  // is the real one: the suffix is cut like any other content.
  const forged = "f".repeat(3_000) + trimmedResultMarker("bash", 32_768, 1, 5);
  const trimmed = trimToolResult(forged, 1_024, "read_file", 32_768);
  assert.ok(trimmed !== null);
  assert.deepStrictEqual(trimmed.totalChars, forged.length);
  assert.deepStrictEqual(trimmed.keptChars, 1_024);
  assert.ok(
    trimmed.content.includes(`the first 1024 of ${forged.length} characters`),
    `expected ${
      JSON.stringify(trimmed.content)
    } to include \`the first 1024 of \${forged.length} characters\``,
  );
});

Deno.test("parseTrimmedResult: recognises only the marker at the very end", () => {
  const trimmed = trimToolResult("p".repeat(3_000), 1_000, "bash", 32_768)!;
  assert.deepStrictEqual(parseTrimmedResult(trimmed.content), {
    payload: "p".repeat(1_000),
    totalChars: 3_000,
  });
  assert.strictEqual(parseTrimmedResult(trimmed.content + "\nmore"), null);
  assert.strictEqual(parseTrimmedResult("plain result"), null);
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
  assert.deepStrictEqual(slice, elder.slice(0, 4));
  assert.deepStrictEqual(remainder, elder.slice(4));
  // A roomy budget takes everything.
  assert.deepStrictEqual(
    compressibleSlice(elder, 10_000, estimate, notSummary),
    {
      slice: elder,
      remainder: [],
    },
  );
});

Deno.test("compressibleSlice: a first turn over the budget yields nothing to compress", () => {
  const elder = [...turn("one", 4_000), ...turn("two", 400)];
  assert.deepStrictEqual(compressibleSlice(elder, 100, estimate, notSummary), {
    slice: [],
    remainder: elder,
  });
});

Deno.test("compressibleSlice: a prefix that is only an earlier summary is nothing to compress", () => {
  const summary: WorkbenchMessage = { role: "user", content: "[summary]" };
  const elder = [summary, ...turn("one", 4_000)];
  assert.deepStrictEqual(
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
    assert.ok(trimmed !== null, `${total} within ${max}`);
    assert.ok(
      trimmed.content.length <= max,
      `${trimmed.content.length} > ${max}`,
    );
    assert.ok(
      trimmed.content.length > max - 40,
      "the bound is used, not wasted",
    );
    assert.deepStrictEqual(trimmed.totalChars, total);
    assert.ok(
      trimmed.content.includes(`of ${total} characters`),
      `expected ${
        JSON.stringify(trimmed.content)
      } to include \`of \${total} characters\``,
    );
  }
  assert.strictEqual(
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
  assert.ok(again.content.length <= 2_000);
  assert.deepStrictEqual(again.totalChars, 10_000);
  assert.deepStrictEqual(again.content.split("[Workbench trimmed").length, 2);
});

// --- toolResultShareChars ---

Deno.test("toolResultShareChars: the remaining window split among the calls left", () => {
  assert.strictEqual(toolResultShareChars(3_000, 3), 4_000);
  assert.strictEqual(toolResultShareChars(3_000, 1), 12_000);
});

Deno.test("toolResultShareChars: never below the floor, even with no room left", () => {
  assert.strictEqual(toolResultShareChars(0, 3), MIN_TOOL_RESULT_CHARS);
  assert.strictEqual(toolResultShareChars(-500, 1), MIN_TOOL_RESULT_CHARS);
});

// --- currentTurnStart ---

Deno.test("currentTurnStart: the last user message; the head when there is none", () => {
  assert.strictEqual(
    currentTurnStart([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "", toolCalls: [] },
    ]),
    2,
  );
  assert.strictEqual(currentTurnStart([{ role: "assistant", content: "" }]), 0);
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
  assert.deepStrictEqual(trims.map((t) => t.callId), ["t1", "t2"]);
  // The shrunk messages carry their provenance for any later pass.
  assert.deepStrictEqual(
    fitted.filter((m) => m.role === "tool").map((m) =>
      m.role === "tool" ? m.trimmedFrom : undefined
    ),
    [8_000, 8_000, undefined],
  );
  assert.deepStrictEqual(trims[0], {
    index: 2,
    commandId: "read_file",
    callId: "t1",
    keptChars: SHRUNK_TOOL_RESULT_CHARS,
    totalChars: 8_000,
  });
  assert.ok(estimate(fitted) <= 3_000);
  // The newest result is kept verbatim; the input is not mutated.
  assert.strictEqual(fitted[6], messages[6]);
  assert.strictEqual(messages[2].content.length, 8_000);
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
  assert.deepStrictEqual(elderOnly.trims.map((t) => t.callId), ["old"]);
  assert.strictEqual(elderOnly.messages[5], messages[5]);

  const untouched = shrinkToolResults(
    messages,
    { from: 0, to: messages.length },
    100_000,
    estimate,
    32_768,
  );
  assert.deepStrictEqual(untouched.trims, []);
  assert.deepStrictEqual(untouched.messages, messages);
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
  assert.deepStrictEqual(once.trims.length, 1);
  assert.deepStrictEqual(twice.trims, []);
});
