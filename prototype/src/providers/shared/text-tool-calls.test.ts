// Unit tests for recovering tool calls leaked into model text and detecting
// tool-call markup left unparsed.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DSML_MARKER,
  dsmlBlock,
  dsmlTag,
} from "../../../testing/providers/dsml-fixtures.ts";
import { DSML_MARKER_COUNTS } from "./dsml-tool-calls.ts";
import {
  countNewTextToolMarkupCandidates,
  detectUnparsedToolCallMarkup,
  extractTextToolCalls,
  MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS,
} from "./text-tool-calls.ts";

describe("extractTextToolCalls", () => {
  it("recovers a leaked Qwen3-Coder tool call and strips the markup", () => {
    const text =
      "I'll check.\n<function=list_files>\n<parameter=path>\n.\n</parameter>\n</function>\n</tool_call>";
    const { toolCalls, cleaned } = extractTextToolCalls(text);
    assert.deepStrictEqual(toolCalls, [
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
    assert.strictEqual(cleaned, "I'll check.");
  });

  it("recovers multiple calls and coerces parameter values", () => {
    const text =
      "<function=read_file><parameter=path>schema/current/001_structure.sql</parameter><parameter=max>120</parameter></function>" +
      "<function=list_files><parameter=path>.</parameter></function>";
    const { toolCalls } = extractTextToolCalls(text);
    assert.deepStrictEqual(toolCalls, [
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
    assert.deepStrictEqual(toolCalls, []);
    assert.strictEqual(cleaned, "just a normal answer");
  });

  it("recovers tool markup at the candidate limit", () => {
    const text = Array.from(
      { length: 64 },
      (_, index) =>
        `<function=list_files><parameter=path>${index}</parameter></function>`,
    ).join("");
    const { toolCalls, cleaned } = extractTextToolCalls(text);
    assert.strictEqual(toolCalls.length, 64);
    assert.strictEqual(cleaned, "");
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
    assert.deepStrictEqual(toolCalls, []);
    assert.strictEqual(cleaned, text);
  });

  it("leaves excessive incomplete function candidates as prose", () => {
    const text = "<function=list_files".repeat(10_000);
    const { toolCalls, cleaned } = extractTextToolCalls(text);
    assert.deepStrictEqual(toolCalls, []);
    assert.strictEqual(cleaned, text);
  });

  it("leaves excessive incomplete parameter candidates as prose", () => {
    const text = `<function=list_files>${
      "<parameter=path".repeat(10_000)
    }</function>`;
    const { toolCalls, cleaned } = extractTextToolCalls(text);
    assert.deepStrictEqual(toolCalls, []);
    assert.strictEqual(cleaned, text);
  });
});

describe("detectUnparsedToolCallMarkup", () => {
  it("requires at least two unmatched openings", () => {
    assert.strictEqual(
      detectUnparsedToolCallMarkup(
        "The literal marker is <tool_call> in this sentence.",
      ),
      undefined,
    );
    assert.strictEqual(
      detectUnparsedToolCallMarkup(
        "Examples: <tool_call></tool_call> and <tool_call></tool_call>.",
      ),
      undefined,
    );
    assert.strictEqual(
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
    assert.deepStrictEqual(detectUnparsedToolCallMarkup(block), {
      count: 1,
      countIsLowerBound: false,
    });
    assert.deepStrictEqual(
      detectUnparsedToolCallMarkup(`Let me check:\n\n${block}\nthen more`),
      { count: 1, countIsLowerBound: false },
    );
  });

  it("adds complete blocks to repeated unmatched openings", () => {
    assert.deepStrictEqual(
      detectUnparsedToolCallMarkup(
        "<tool_call>\nedit_file\n<tool_call>\nread_file\n",
      ),
      { count: 2, countIsLowerBound: false },
    );
    assert.deepStrictEqual(
      detectUnparsedToolCallMarkup(
        "<tool_call><function=bash><parameter=command>ls</parameter>" +
          "</function></tool_call> <tool_call>\nedit_file\n<tool_call>\n",
      ),
      { count: 3, countIsLowerBound: false },
    );
  });

  it("counts one function element once, however many wrappers enclose it", () => {
    const block = "<tool_call><function=x></function></tool_call>";
    assert.deepStrictEqual(
      detectUnparsedToolCallMarkup(`<tool_call>${block}</tool_call>`),
      {
        count: 1,
        countIsLowerBound: false,
      },
    );
    assert.deepStrictEqual(
      detectUnparsedToolCallMarkup(
        `<tool_call>${block}</function></tool_call>`,
      ),
      { count: 1, countIsLowerBound: false },
    );
    assert.deepStrictEqual(detectUnparsedToolCallMarkup(`${block} ${block}`), {
      count: 2,
      countIsLowerBound: false,
    });
    assert.deepStrictEqual(
      detectUnparsedToolCallMarkup(
        `<tool_call>${block}<function=y></function></tool_call>`,
      ),
      { count: 2, countIsLowerBound: false },
    );
  });

  it("counts each wrapper's own function elements, whatever their order", () => {
    const outerFirst = "<tool_call><function=a></function>" +
      "<tool_call><function=b></function></tool_call></tool_call>";
    const innerFirst = "<tool_call><tool_call><function=a></function>" +
      "</tool_call><function=b></function></tool_call>";
    assert.deepStrictEqual(detectUnparsedToolCallMarkup(outerFirst), {
      count: 2,
      countIsLowerBound: false,
    });
    assert.deepStrictEqual(detectUnparsedToolCallMarkup(innerFirst), {
      count: 2,
      countIsLowerBound: false,
    });
    assert.deepStrictEqual(
      detectUnparsedToolCallMarkup(
        "<tool_call><function=a></function><function=b></function></tool_call>",
      ),
      { count: 2, countIsLowerBound: false },
    );
  });

  it("does not count a function element that a wrapper close interrupts", () => {
    assert.strictEqual(
      detectUnparsedToolCallMarkup(
        "<tool_call><function=x></tool_call></function></tool_call>",
      ),
      undefined,
    );
    assert.strictEqual(
      detectUnparsedToolCallMarkup(
        "<tool_call><tool_call><function=x></tool_call></function></tool_call>",
      ),
      undefined,
    );
  });

  it("keeps a balanced wrapper without a function element as prose", () => {
    assert.strictEqual(
      detectUnparsedToolCallMarkup("<tool_call></tool_call>"),
      undefined,
    );
    assert.strictEqual(
      detectUnparsedToolCallMarkup(
        "The wrapper is <tool_call>name and args</tool_call> in this dialect.",
      ),
      undefined,
    );
    assert.strictEqual(
      detectUnparsedToolCallMarkup(
        "Unterminated: <tool_call><function=bash>ls</tool_call>",
      ),
      undefined,
    );
  });

  it("caps complete blocks with the reported count", () => {
    const block =
      "<tool_call><function=bash><parameter=command>ls</parameter></function></tool_call>";
    assert.deepStrictEqual(detectUnparsedToolCallMarkup(block.repeat(64)), {
      count: 64,
      countIsLowerBound: false,
    });
    assert.deepStrictEqual(detectUnparsedToolCallMarkup(block.repeat(65)), {
      count: 64,
      countIsLowerBound: true,
    });
  });

  it("does not classify a direct input beyond the accepted-response bound", () => {
    const opening = "<tool_call>";
    const closing = "</tool_call>";
    assert.strictEqual(
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

    assert.deepStrictEqual(detectUnparsedToolCallMarkup(atBound), {
      count: 2,
      countIsLowerBound: false,
    });
    assert.strictEqual(detectUnparsedToolCallMarkup(beyondBound), undefined);
    assert.strictEqual(
      detectUnparsedToolCallMarkup(wrapperStraddlingBound),
      undefined,
    );
  });

  it("counts unmatched openings before capping the reported count", () => {
    assert.deepStrictEqual(
      detectUnparsedToolCallMarkup(
        "</tool_call></tool_call><tool_call><tool_call>",
      ),
      { count: 2, countIsLowerBound: false },
    );
    assert.strictEqual(
      detectUnparsedToolCallMarkup(
        "<tool_call>".repeat(71) + "</tool_call>".repeat(70),
      ),
      undefined,
    );
    assert.deepStrictEqual(
      detectUnparsedToolCallMarkup(
        "<tool_call>".repeat(71) + "</tool_call>".repeat(1),
      ),
      { count: 64, countIsLowerBound: true },
    );
    assert.deepStrictEqual(
      detectUnparsedToolCallMarkup(
        "<tool_call>".repeat(72) + "</tool_call>".repeat(70),
      ),
      { count: 2, countIsLowerBound: false },
    );
    assert.strictEqual(
      detectUnparsedToolCallMarkup(
        "<tool_call>".repeat(71) + "</tool_call>".repeat(71),
      ),
      undefined,
    );
  });
});

// The marker bound is spent on markup, not on prose that names the dialect. A
// reply that merely discusses DSML must still have its real block recovered,
// and a reply that holds separator-wrapped markers past the bound is still
// refused rather than parsed.
describe("DSML marker bound counts separator-wrapped runs", () => {
  const mentions = (count: number) => `The ${"DSML"} marker. `.repeat(count);

  it("recovers a DSML block after hundreds of prose mentions of DSML", () => {
    const prose = mentions(513);
    const text = `${prose}\n${dsmlBlock("spaced", "bash", [
      ["command", ' string="true"', "ls"],
    ])}`;
    const { toolCalls, cleaned } = extractTextToolCalls(
      text,
      new Set(["bash"]),
    );
    assert.deepStrictEqual(toolCalls, [{
      id: "text-tool-1",
      name: "bash",
      arguments: { command: "ls" },
    }]);
    // Recovery trims the retained text when whitespace is not preserved.
    assert.strictEqual(cleaned, prose.trim());
  });

  it("refuses the text once separator-wrapped markers pass the bound", () => {
    const markers = `${DSML_MARKER} `.repeat(513);
    const text = `${markers}\n${dsmlBlock("spaced", "bash", [
      ["command", ' string="true"', "ls"],
    ])}`;
    const { toolCalls, cleaned } = extractTextToolCalls(
      text,
      new Set(["bash"]),
    );
    assert.deepStrictEqual(toolCalls, []);
    assert.strictEqual(cleaned, text);
  });

  it("caps the unparsed DSML count and says the count is a lower bound", () => {
    const block = dsmlBlock("spaced", "bash", [
      ["command", ' string="true"', "ls"],
    ]);
    assert.deepStrictEqual(
      detectUnparsedToolCallMarkup(block.repeat(65)),
      { count: 64, countIsLowerBound: true },
    );
    // The candidate bound can stop the scan with markup still unread while the
    // count itself stays small: the count is short of the truth either way.
    const stray = dsmlTag("spaced", "parameter", ' name="x"');
    const early = `${block}${stray.repeat(64)}${block}`;
    assert.deepStrictEqual(detectUnparsedToolCallMarkup(early), {
      count: 1,
      countIsLowerBound: true,
    });
  });
});

// The DSML dialect joined Qwen recovery in BIT-991. This property of the Qwen
// reading predates it and must survive: an offered call whose arguments cannot
// be typed fails the whole Qwen reading closed, while a DSML block read
// independently is still recovered.
// Adjacent runs share a separator, so `|DSML|DSML|` holds two markers. Both the
// whole-text scan and the streaming counter step one character past a match, so
// the same text is refused however it is chunked; stepping a whole marker
// counted half of an overlapping run and let a reply past the bound be parsed.
describe("overlapping separator-wrapped runs count once each", () => {
  const overlapping = `${"|DSML|"}${"DSML|".repeat(600)}`;
  const asciiBlock = dsmlBlock("ascii", "bash", [
    ["command", ' string="true"', "ls"],
  ]);

  it("refuses overlapping runs in one piece of text", () => {
    const text = `${overlapping}\n${asciiBlock}`;
    const { toolCalls, cleaned } = extractTextToolCalls(
      text,
      new Set(["bash"]),
    );
    assert.deepStrictEqual(toolCalls, []);
    assert.strictEqual(cleaned, text);
  });

  it("counts them the same when they arrive in small deltas", () => {
    const chunks: string[] = [];
    for (let i = 0; i < overlapping.length; i += 5) {
      chunks.push(overlapping.slice(i, i + 5));
    }
    let count = 0;
    let tail = "";
    for (const chunk of chunks) {
      const update = countNewTextToolMarkupCandidates(
        tail,
        chunk,
        DSML_MARKER_COUNTS,
        600,
      );
      tail = update.tail;
      count += update.count;
    }
    assert.strictEqual(count, 601);
  });
});

describe("Qwen recovery stays fail-closed beside DSML", () => {
  const offered = new Set(["bash", "list_files"]);

  it("runs no Qwen call when a second offered call's arguments are unrecoverable", () => {
    const valid = "<tool_call><function=list_files>" +
      "<parameter=path>.</parameter></function></tool_call>";
    // 65 nested arrays: past the canonical-JSON depth budget, so the value
    // cannot be typed and the call is unrecoverable rather than guessed at.
    const unrecoverable = "<tool_call><function=bash><parameter=command>" +
      `${"[".repeat(65)}</parameter></function></tool_call>`;
    const text = `${valid}\n${unrecoverable}`;
    const { toolCalls, cleaned } = extractTextToolCalls(text, offered);
    assert.deepStrictEqual(toolCalls, []);
    assert.strictEqual(cleaned, text);
  });

  it("still runs a DSML block recovery can read beside an unrecoverable Qwen call", () => {
    const unrecoverable = "<tool_call><function=bash><parameter=command>" +
      `${"[".repeat(65)}</parameter></function></tool_call>`;
    const block = dsmlBlock("spaced", "list_files", [
      ["path", ' string="true"', "."],
    ]);
    const text = `${unrecoverable}\n${block}`;
    const { toolCalls, cleaned } = extractTextToolCalls(text, offered);
    assert.deepStrictEqual(toolCalls, [{
      id: "text-tool-1",
      name: "list_files",
      arguments: { path: "." },
    }]);
    assert.strictEqual(cleaned, unrecoverable);
  });
});
