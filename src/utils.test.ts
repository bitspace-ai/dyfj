import { test, expect, describe } from "bun:test";
import {
  generateULID, generateTraceId, generateSpanId,
  extractText, extractThinking,
  parseDoltCsv, parseCsvRow, parseCSVRows,
  normaliseStopReason,
} from "./utils";
import type { AssistantMessage } from "@mariozechner/pi-ai";

test("generateULID returns a valid ULID", () => {
  const id = generateULID();
  expect(typeof id).toBe("string");
  expect(id.length).toBe(26); // ULID length
  // Basic check for ULID structure (alphanumeric, base32)
  expect(id).toMatch(/^[0-9A-Z]{26}$/);

  const anotherId = generateULID();
  expect(id).not.toBe(anotherId);
});

test("generateTraceId returns a 32-char hex string", () => {
  const id = generateTraceId();
  expect(typeof id).toBe("string");
  expect(id.length).toBe(32);
  expect(id).toMatch(/^[0-9a-f]{32}$/); // Hexadecimal characters
});

test("generateSpanId returns a 16-char hex string", () => {
  const id = generateSpanId();
  expect(typeof id).toBe("string");
  expect(id.length).toBe(16);
  expect(id).toMatch(/^[0-9a-f]{16}$/); // Hexadecimal characters
});

test("extractText correctly extracts and concatenates text content", () => {
  const content: AssistantMessage['content'] = [
    { type: "text", text: "Hello" },
    { type: "thinking", thinking: "Thinking deep thoughts" },
    { type: "text", text: " World!" },
  ];
  expect(extractText(content)).toBe("Hello World!");
});

test("extractText returns null if no text content is present", () => {
  const content: AssistantMessage['content'] = [
    { type: "thinking", thinking: "Thinking deep thoughts" },
    { type: "toolCall", id: "tool_call_1", name: "consoleLog", arguments: {} },
  ];
  expect(extractText(content)).toBeNull();
});

test("extractText returns null for an empty content array", () => {
  const content: AssistantMessage['content'] = [];
  expect(extractText(content)).toBeNull();
});

test("extractThinking correctly extracts and concatenates thinking content", () => {
  const content: AssistantMessage['content'] = [
    { type: "text", text: "Hello" },
    { type: "thinking", thinking: "Thinking deep thoughts. " },
    { type: "thinking", thinking: "More thoughts." },
  ];
  expect(extractThinking(content)).toBe("Thinking deep thoughts. More thoughts.");
});

test("extractThinking returns null if no thinking content is present", () => {
  const content: AssistantMessage['content'] = [
    { type: "text", text: "Hello" },
    { type: "toolCall", id: "tool_call_2", name: "consoleLog", arguments: {} },
  ];
  expect(extractThinking(content)).toBeNull();
});

test("extractThinking returns null for an empty content array", () => {
  const content: AssistantMessage['content'] = [];
  expect(extractThinking(content)).toBeNull();
});

// ─── parseCsvRow ──────────────────────────────────────────────────────────

describe("parseCsvRow", () => {
  test("parses simple unquoted fields", () => {
    expect(parseCsvRow("a,b,c")).toEqual(["a", "b", "c"]);
  });

  test("parses a single field", () => {
    expect(parseCsvRow("hello")).toEqual(["hello"]);
  });

  test("handles empty fields", () => {
    expect(parseCsvRow("a,,c")).toEqual(["a", "", "c"]);
  });

  test("handles leading/trailing empty fields", () => {
    expect(parseCsvRow(",b,")).toEqual(["", "b", ""]);
  });

  test("parses quoted fields", () => {
    expect(parseCsvRow('"hello world",b')).toEqual(["hello world", "b"]);
  });

  test("parses quoted field containing a comma", () => {
    expect(parseCsvRow('"a,b",c')).toEqual(["a,b", "c"]);
  });

  test("handles escaped double-quote inside quoted field", () => {
    expect(parseCsvRow('"say \"\"hi\"\"",b')).toEqual(['say "hi"', "b"]);
  });

  test("handles JSON array value (RFC 4180 double-quote escaping, as Dolt outputs)", () => {
    // Dolt outputs JSON columns with RFC 4180 quoting: "[""code"",""reasoning""]"
    // Row: qwen3:32b,"[""code"",""reasoning""]",0
    const row = 'qwen3:32b,"[""code"",""reasoning""]",0';
    const fields = parseCsvRow(row);
    expect(fields[0]).toBe("qwen3:32b");
    // Outer quotes stripped, "" unescaped to " — valid JSON
    expect(fields[1]).toBe('["code","reasoning"]');
    expect(fields[2]).toBe("0");
  });
});

// ─── parseDoltCsv ──────────────────────────────────────────────────────────

describe("parseDoltCsv", () => {
  test("returns empty array for empty string", () => {
    expect(parseDoltCsv("")).toEqual([]);
  });

  test("returns empty array for header-only CSV", () => {
    expect(parseDoltCsv("slug,tier,active")).toEqual([]);
  });

  test("parses a single data row into a keyed object", () => {
    const csv = "slug,tier,active\ngemma4,0,1";
    expect(parseDoltCsv(csv)).toEqual([{ slug: "gemma4", tier: "0", active: "1" }]);
  });

  test("parses multiple rows", () => {
    const csv = "slug,tier\ngemma4,0\nqwen3:32b,0\nclaude-haiku-4-5,1";
    const rows = parseDoltCsv(csv);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ slug: "gemma4", tier: "0" });
    expect(rows[2]).toEqual({ slug: "claude-haiku-4-5", tier: "1" });
  });

  test("handles quoted JSON field in a row (RFC 4180 double-quote escaping)", () => {
    // Dolt outputs: gemma4,"[""text"",""reasoning""]"
    const csv = 'slug,capabilities\ngemma4,"[""text"",""reasoning""]"';
    const rows = parseDoltCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe("gemma4");
    // Parser strips outer quotes and unescapes "" → "; result is valid JSON
    expect(JSON.parse(rows[0].capabilities)).toEqual(["text", "reasoning"]);
  });

  test("ignores trailing blank lines", () => {
    const csv = "a,b\n1,2\n\n\n";
    expect(parseDoltCsv(csv)).toHaveLength(1);
  });
});

// ─── parseCSVRows ──────────────────────────────────────────────────────────

describe("parseCSVRows", () => {
  test("parses simple single-line rows", () => {
    const rows = parseCSVRows("a,b,c\n1,2,3");
    expect(rows).toEqual([["a","b","c"],["1","2","3"]]);
  });

  test("handles multiline content inside a quoted field", () => {
    const csv = `slug,content\nuser_profile,"Line one\nLine two\nLine three"`;
    const rows = parseCSVRows(csv);
    expect(rows).toHaveLength(2); // header + 1 data row
    expect(rows[1][0]).toBe("user_profile");
    expect(rows[1][1]).toBe("Line one\nLine two\nLine three");
  });

  test("multiline field does not create extra rows in parseDoltCsv", () => {
    const csv = `slug,name,content\nuser_profile,Profile,"First line\nSecond line"`;
    const result = parseDoltCsv(csv);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe("user_profile");
    expect(result[0].content).toBe("First line\nSecond line");
  });

  test("multiple rows each with multiline content", () => {
    const csv = `slug,content\nrow1,"A\nB"\nrow2,"C\nD"`;
    const result = parseDoltCsv(csv);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("A\nB");
    expect(result[1].content).toBe("C\nD");
  });

  test("handles \\r\\n line endings within quoted field", () => {
    const csv = `slug,content\ntest,"line1\r\nline2"`;
    const rows = parseCSVRows(csv);
    // \r inside quoted field should be preserved as-is by our parser
    // (we only skip bare \r outside quotes)
    expect(rows[1][1]).toBe("line1\r\nline2");
  });

  test("returns empty array for empty string", () => {
    expect(parseCSVRows("")).toEqual([]);
  });
});

// ─── normaliseStopReason ──────────────────────────────────────────────────

describe("normaliseStopReason", () => {
  test("maps 'toolUse' (pi-ai) to 'tool_use' (Dolt ENUM)", () => {
    expect(normaliseStopReason("toolUse")).toBe("tool_use");
  });
  test("passes through 'stop' unchanged", () => {
    expect(normaliseStopReason("stop")).toBe("stop");
  });
  test("passes through 'length' unchanged", () => {
    expect(normaliseStopReason("length")).toBe("length");
  });
  test("passes through 'error' unchanged", () => {
    expect(normaliseStopReason("error")).toBe("error");
  });
  test("returns null for null input", () => {
    expect(normaliseStopReason(null)).toBeNull();
  });
  test("returns null for undefined input", () => {
    expect(normaliseStopReason(undefined)).toBeNull();
  });
});
