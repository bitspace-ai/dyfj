// Unit tests for recovering tool calls leaked into model text and detecting
// tool-call markup left unparsed.

import { assertEquals, assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  detectUnparsedToolCallMarkup,
  extractTextToolCalls,
  MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS,
} from "./text-tool-calls.ts";

describe("extractTextToolCalls", () => {
  it("recovers a leaked Qwen3-Coder tool call and strips the markup", () => {
    const text =
      "I'll check.\n<function=list_files>\n<parameter=path>\n.\n</parameter>\n</function>\n</tool_call>";
    const { toolCalls, cleaned } = extractTextToolCalls(text);
    assertEquals(toolCalls, [
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
    assertStrictEquals(cleaned, "I'll check.");
  });

  it("recovers multiple calls and coerces parameter values", () => {
    const text =
      "<function=read_file><parameter=path>schema/current/001_structure.sql</parameter><parameter=max>120</parameter></function>" +
      "<function=list_files><parameter=path>.</parameter></function>";
    const { toolCalls } = extractTextToolCalls(text);
    assertEquals(toolCalls, [
      {
        id: "text-tool-1",
        name: "read_file",
        arguments: { path: "schema/current/001_structure.sql", max: 120 },
      },
      { id: "text-tool-2", name: "list_files", arguments: { path: "." } },
    ]);
  });

  it("leaves normal text untouched when there is no tool markup", () => {
    const { toolCalls, cleaned } = extractTextToolCalls("just a normal answer");
    assertEquals(toolCalls, []);
    assertStrictEquals(cleaned, "just a normal answer");
  });

  it("recovers tool markup at the candidate limit", () => {
    const text = Array.from(
      { length: 64 },
      (_, index) =>
        `<function=list_files><parameter=path>${index}</parameter></function>`,
    ).join("");
    const { toolCalls, cleaned } = extractTextToolCalls(text);
    assertStrictEquals(toolCalls.length, 64);
    assertStrictEquals(cleaned, "");
  });

  it("leaves a large batch of unwrapped offered-function examples as prose", () => {
    const text = Array.from(
      { length: 10_000 },
      (_, index) =>
        `<function=list_files><parameter=path>${index}</parameter></function>`,
    ).join("\n");
    const { toolCalls, cleaned } = extractTextToolCalls(
      text,
      new Set(["list_files"]),
    );
    assertEquals(toolCalls, []);
    assertStrictEquals(cleaned, text);
  });

  it("leaves excessive incomplete function candidates as prose", () => {
    const text = "<function=list_files".repeat(10_000);
    const { toolCalls, cleaned } = extractTextToolCalls(text);
    assertEquals(toolCalls, []);
    assertStrictEquals(cleaned, text);
  });

  it("leaves excessive incomplete parameter candidates as prose", () => {
    const text = `<function=list_files>${
      "<parameter=path".repeat(10_000)
    }</function>`;
    const { toolCalls, cleaned } = extractTextToolCalls(text);
    assertEquals(toolCalls, []);
    assertStrictEquals(cleaned, text);
  });
});

describe("detectUnparsedToolCallMarkup", () => {
  it("requires at least two unmatched openings", () => {
    assertStrictEquals(
      detectUnparsedToolCallMarkup(
        "The literal marker is <tool_call> in this sentence.",
      ),
      undefined,
    );
    assertStrictEquals(
      detectUnparsedToolCallMarkup(
        "Examples: <tool_call></tool_call> and <tool_call></tool_call>.",
      ),
      undefined,
    );
    assertStrictEquals(
      detectUnparsedToolCallMarkup(
        "One stray <tool_call> plus <tool_call></tool_call>.",
      ),
      undefined,
    );
  });

  it("flags a complete tool-call block left in the text after recovery", () => {
    // Stored model text from a local-model turn (BIT-564): a complete block
    // that recovery did not run.
    const block = "<tool_call>\n<function=read_file>\n" +
      "<parameter=path>\nCHANGELOG.md\n</parameter>\n" +
      "<parameter=limit>\n200\n</parameter>\n" +
      "<parameter=offset>\n401\n</parameter>\n</function>\n</tool_call>";
    assertEquals(detectUnparsedToolCallMarkup(block), {
      count: 1,
      countIsLowerBound: false,
    });
    assertEquals(
      detectUnparsedToolCallMarkup(`Let me check:\n\n${block}\nthen more`),
      { count: 1, countIsLowerBound: false },
    );
  });

  it("adds complete blocks to repeated unmatched openings", () => {
    assertEquals(
      detectUnparsedToolCallMarkup(
        "<tool_call>\nedit_file\n<tool_call>\nread_file\n",
      ),
      { count: 2, countIsLowerBound: false },
    );
    assertEquals(
      detectUnparsedToolCallMarkup(
        "<tool_call><function=bash><parameter=command>ls</parameter>" +
          "</function></tool_call> <tool_call>\nedit_file\n<tool_call>\n",
      ),
      { count: 3, countIsLowerBound: false },
    );
  });

  it("counts one function element once, however many wrappers enclose it", () => {
    const block = "<tool_call><function=x></function></tool_call>";
    assertEquals(
      detectUnparsedToolCallMarkup(`<tool_call>${block}</tool_call>`),
      {
        count: 1,
        countIsLowerBound: false,
      },
    );
    assertEquals(
      detectUnparsedToolCallMarkup(
        `<tool_call>${block}</function></tool_call>`,
      ),
      { count: 1, countIsLowerBound: false },
    );
    assertEquals(detectUnparsedToolCallMarkup(`${block} ${block}`), {
      count: 2,
      countIsLowerBound: false,
    });
    assertEquals(
      detectUnparsedToolCallMarkup(
        `<tool_call>${block}<function=y></function></tool_call>`,
      ),
      { count: 2, countIsLowerBound: false },
    );
  });

  it("keeps a balanced wrapper without a function element as prose", () => {
    assertStrictEquals(
      detectUnparsedToolCallMarkup("<tool_call></tool_call>"),
      undefined,
    );
    assertStrictEquals(
      detectUnparsedToolCallMarkup(
        "The wrapper is <tool_call>name and args</tool_call> in this dialect.",
      ),
      undefined,
    );
    assertStrictEquals(
      detectUnparsedToolCallMarkup(
        "Unterminated: <tool_call><function=bash>ls</tool_call>",
      ),
      undefined,
    );
  });

  it("caps complete blocks with the reported count", () => {
    const block =
      "<tool_call><function=bash><parameter=command>ls</parameter></function></tool_call>";
    assertEquals(detectUnparsedToolCallMarkup(block.repeat(64)), {
      count: 64,
      countIsLowerBound: false,
    });
    assertEquals(detectUnparsedToolCallMarkup(block.repeat(65)), {
      count: 64,
      countIsLowerBound: true,
    });
  });

  it("does not classify a direct input beyond the accepted-response bound", () => {
    const opening = "<tool_call>";
    const closing = "</tool_call>";
    assertStrictEquals(
      MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS,
      4 * 1_024 * 1_024,
    );
    const atBound = opening.repeat(2) + "x".repeat(
      MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS - (2 * opening.length),
    );
    const beyondBound = `${atBound}x`;
    const wrapperStraddlingBound = opening + "x".repeat(
      MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS - (2 * opening.length),
    ) + opening + closing;

    assertEquals(detectUnparsedToolCallMarkup(atBound), {
      count: 2,
      countIsLowerBound: false,
    });
    assertStrictEquals(detectUnparsedToolCallMarkup(beyondBound), undefined);
    assertStrictEquals(
      detectUnparsedToolCallMarkup(wrapperStraddlingBound),
      undefined,
    );
  });

  it("counts unmatched openings before capping the reported count", () => {
    assertEquals(
      detectUnparsedToolCallMarkup(
        "</tool_call></tool_call><tool_call><tool_call>",
      ),
      { count: 2, countIsLowerBound: false },
    );
    assertStrictEquals(
      detectUnparsedToolCallMarkup(
        "<tool_call>".repeat(71) + "</tool_call>".repeat(70),
      ),
      undefined,
    );
    assertEquals(
      detectUnparsedToolCallMarkup(
        "<tool_call>".repeat(71) + "</tool_call>".repeat(1),
      ),
      { count: 64, countIsLowerBound: true },
    );
    assertEquals(
      detectUnparsedToolCallMarkup(
        "<tool_call>".repeat(72) + "</tool_call>".repeat(70),
      ),
      { count: 2, countIsLowerBound: false },
    );
    assertStrictEquals(
      detectUnparsedToolCallMarkup(
        "<tool_call>".repeat(71) + "</tool_call>".repeat(71),
      ),
      undefined,
    );
  });
});
