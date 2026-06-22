import { describe, expect, test } from "vitest";
import {
  buildDoltPoolOptions,
  buildModelSelectedEventPayload,
  extractText,
  extractThinking,
  generateSpanId,
  generateTraceId,
  generateULID,
  normaliseStopReason,
  parseCsvRow,
  parseCSVRows,
} from "./utils";
import type { MessageContent } from "./utils";

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
  const content: MessageContent[] = [
    { type: "text", text: "Hello" },
    { type: "thinking", thinking: "Thinking deep thoughts" },
    { type: "text", text: " World!" },
  ];
  expect(extractText(content)).toBe("Hello World!");
});

test("extractText returns null if no text content is present", () => {
  const content: MessageContent[] = [
    { type: "thinking", thinking: "Thinking deep thoughts" },
    { type: "toolCall", id: "tool_call_1", name: "consoleLog", arguments: {} },
  ];
  expect(extractText(content)).toBeNull();
});

test("extractText returns null for an empty content array", () => {
  const content: MessageContent[] = [];
  expect(extractText(content)).toBeNull();
});

test("extractThinking correctly extracts and concatenates thinking content", () => {
  const content: MessageContent[] = [
    { type: "text", text: "Hello" },
    { type: "thinking", thinking: "Thinking deep thoughts. " },
    { type: "thinking", thinking: "More thoughts." },
  ];
  expect(extractThinking(content)).toBe(
    "Thinking deep thoughts. More thoughts.",
  );
});

test("extractThinking returns null if no thinking content is present", () => {
  const content: MessageContent[] = [
    { type: "text", text: "Hello" },
    { type: "toolCall", id: "tool_call_2", name: "consoleLog", arguments: {} },
  ];
  expect(extractThinking(content)).toBeNull();
});

test("extractThinking returns null for an empty content array", () => {
  const content: MessageContent[] = [];
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
    expect(parseCsvRow('"say ""hi""",b')).toEqual(['say "hi"', "b"]);
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

// ─── parseCSVRows ──────────────────────────────────────────────────────────

describe("parseCSVRows", () => {
  test("parses simple single-line rows", () => {
    const rows = parseCSVRows("a,b,c\n1,2,3");
    expect(rows).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  test("handles multiline content inside a quoted field", () => {
    const csv = `slug,content\nuser_profile,"Line one\nLine two\nLine three"`;
    const rows = parseCSVRows(csv);
    expect(rows).toHaveLength(2); // header + 1 data row
    expect(rows[1][0]).toBe("user_profile");
    expect(rows[1][1]).toBe("Line one\nLine two\nLine three");
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
  test("maps 'toolUse' to 'tool_use' (Dolt ENUM)", () => {
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

describe("buildModelSelectedEventPayload", () => {
  test("builds a model_selected event with routing metadata", () => {
    const payload = buildModelSelectedEventPayload({
      selected: "gemma4",
      considered: ["gemma4", "qwen3:32b"],
      reason: "default",
      sessionId: "01TESTSESSION00000000000000",
      traceId: "0123456789abcdef0123456789abcdef",
      provider: "ollama",
      api: "openai-completions",
      eventId: "01TESTEVENT0000000000000000",
      spanId: "0123456789abcdef",
      principalId: "test-principal",
      durationMs: 12,
    });

    expect(payload).toMatchObject({
      event_id: "01TESTEVENT0000000000000000",
      session_id: "01TESTSESSION00000000000000",
      event_type: "model_selected",
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      principal_id: "test-principal",
      principal_type: "human",
      action: "select",
      resource: "gemma4",
      authz_basis: "routing_heuristic",
      model_id: "gemma4",
      provider: "ollama",
      api: "openai-completions",
      duration_ms: 12,
    });
    expect(JSON.parse(payload.content as string)).toEqual({
      selected: "gemma4",
      considered: ["gemma4", "qwen3:32b"],
      reason: "default",
    });
  });
});

describe("buildDoltPoolOptions", () => {
  test("reads Dolt connection settings from environment", () => {
    const options = buildDoltPoolOptions({
      DOLT_HOST: "localhost",
      DOLT_PORT: "3316",
      DOLT_USER: "dyfj",
      DOLT_PASSWORD: "secret",
      DOLT_DATABASE: "dyfjdb",
    });

    expect(options).toMatchObject({
      host: "localhost",
      port: 3316,
      user: "dyfj",
      password: "secret",
      database: "dyfjdb",
    });
  });

  test("does not hardcode the local Dolt password", () => {
    const options = buildDoltPoolOptions({});

    expect(options).toMatchObject({
      host: "127.0.0.1",
      port: 3306,
      user: "root",
      password: "",
      database: "dolt",
    });
  });
});
