import { describe, expect, test } from "vitest";

import {
  assertBoundedLocalJsonSchemaRefs,
  classifyMcpRetry,
  extractMcpTraceContext,
  injectMcpTraceContext,
  mcpTraceEventFields,
  resolveMcpListFreshness,
  sortMcpList,
} from "./mcp-conformance.ts";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

describe("MCP W3C trace context", () => {
  test("injects canonical trace identifiers and validated trace state", () => {
    expect(injectMcpTraceContext({ retained: true, baggage: "drop=me" }, {
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: 1,
      traceState: "vendor=value",
    })).toEqual({
      retained: true,
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
      tracestate: "vendor=value",
    });
  });

  test("extracts a validated remote parent without retaining raw envelopes", () => {
    expect(extractMcpTraceContext({
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
      tracestate: "vendor=value",
      baggage: "private=value",
    })).toEqual({
      traceId: TRACE_ID,
      parentSpanId: SPAN_ID,
      traceFlags: 1,
      traceState: "vendor=value",
      parentIsRemote: true,
    });
  });

  test.each([
    undefined,
    "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
    "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
  ])("rejects invalid traceparent %s", (traceparent) => {
    expect(extractMcpTraceContext({ traceparent })).toBeUndefined();
  });

  test.each([
    "duplicate=one,duplicate=two",
    "Upper=value",
    "vendor=value=invalid",
    "vendor=comma,inside",
    `vendor=${"x".repeat(506)}`,
  ])("drops invalid tracestate %s", (traceState) => {
    const extracted = extractMcpTraceContext({
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-00`,
      tracestate: traceState,
    });
    expect(extracted).toEqual({
      traceId: TRACE_ID,
      parentSpanId: SPAN_ID,
      traceFlags: 0,
      parentIsRemote: true,
    });
  });

  test("projects bounded durable fields without raw propagation envelopes", () => {
    const fields = mcpTraceEventFields({
      traceFlags: 1,
      traceState: "vendor=value",
      parentIsRemote: true,
    }, "server");
    expect(fields).toEqual({
      trace_flags: 1,
      trace_state: "vendor=value",
      span_kind: "server",
      parent_is_remote: true,
    });
    expect(fields).not.toHaveProperty("traceparent");
    expect(fields).not.toHaveProperty("baggage");
  });
});

describe("MCP deterministic list and retry fixtures", () => {
  test("sorts lists independently of producer order", () => {
    expect(sortMcpList([
      { name: "zeta" },
      { name: "alpha" },
      { name: "middle" },
    ], (entry) => entry.name)).toEqual([
      { name: "alpha" },
      { name: "middle" },
      { name: "zeta" },
    ]);
  });

  test("partitions private freshness by principal and clearance", () => {
    expect(resolveMcpListFreshness({
      ttlMs: 1_000,
      cacheScope: "private",
      principalId: "operator-a",
      clearance: "private+public",
    })).toEqual({
      ttlMs: 1_000,
      cacheScope: "private",
      partition: '["private","operator-a","private+public"]',
    });
  });

  test("shares public freshness only within the same clearance", () => {
    const first = resolveMcpListFreshness({
      cacheScope: "public",
      principalId: "operator-a",
      clearance: "client_safe:public",
    });
    const second = resolveMcpListFreshness({
      cacheScope: "public",
      principalId: "operator-b",
      clearance: "client_safe:public",
    });
    expect(first.partition).toBe('["public","client_safe:public"]');
    expect(second.partition).toBe(first.partition);
  });

  test("encodes private partition tuples without separator or control collisions", () => {
    const partition = (principalId: string, clearance: string) =>
      resolveMcpListFreshness({
        principalId,
        clearance,
      }).partition;
    const controlPartition = partition("line\nbreak", "public\0private");
    expect(new Set([
      partition("a:b", "c"),
      partition("a", "b:c"),
      controlPartition,
      partition(String.raw`line\nbreak`, "public"),
      partition("operator\0admin", "public"),
      partition("operator", "\0admin:public"),
    ])).toHaveLength(6);
    expect(controlPartition).not.toContain("\n");
    expect(controlPartition).not.toContain("\0");
  });

  test("bounds server-controlled cache identity inputs", () => {
    const maximumEscapedPartition = resolveMcpListFreshness({
      principalId: "\0".repeat(128),
      clearance: "\0".repeat(128),
    }).partition;
    expect(maximumEscapedPartition).toHaveLength(1_553);
    expect(maximumEscapedPartition).not.toContain("\0");
    expect(() => resolveMcpListFreshness({
      principalId: "p".repeat(129),
      clearance: "public",
    })).toThrow("principalId exceeds 128 UTF-16 code units");
    expect(() => resolveMcpListFreshness({
      principalId: "operator",
      clearance: "c".repeat(129),
    })).toThrow("clearance exceeds 128 UTF-16 code units");
  });

  test("defaults untrusted freshness to immediately stale and private", () => {
    expect(resolveMcpListFreshness({
      ttlMs: -1,
      cacheScope: "unexpected",
      principalId: "operator-a",
      clearance: "public",
    })).toEqual({
      ttlMs: 0,
      cacheScope: "private",
      partition: '["private","operator-a","public"]',
    });
  });

  test.each([
    [{ terminal: "complete", readOnly: true, requestStarted: true }, "complete"],
    [{ terminal: "input_required", readOnly: true, requestStarted: true }, "input_required"],
    [{ terminal: "cancelled", readOnly: true, requestStarted: true }, "cancelled"],
    [{ streamFailed: true, readOnly: true, requestStarted: true }, "retry_new_request"],
    [{ streamFailed: true, readOnly: false, requestStarted: false }, "retry_new_request"],
    [{ streamFailed: true, readOnly: false, requestStarted: true }, "fail"],
  ] as const)("classifies %j as %s", (input, expected) => {
    expect(classifyMcpRetry(input)).toBe(expected);
  });
});

describe("bounded JSON Schema 2020-12 refs", () => {
  test("accepts bounded local refs", () => {
    expect(() => assertBoundedLocalJsonSchemaRefs({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        query: { type: "string", minLength: 1 },
      },
      type: "object",
      properties: { query: { $ref: "#/$defs/query" } },
    })).not.toThrow();
  });

  test("rejects remote, cyclic, unresolved, and over-budget refs", () => {
    expect(() => assertBoundedLocalJsonSchemaRefs({
      $ref: "https://example.invalid/schema",
    })).toThrow("only local");
    expect(() => assertBoundedLocalJsonSchemaRefs({
      $defs: { loop: { $ref: "#/$defs/loop" } },
      $ref: "#/$defs/loop",
    })).toThrow("cyclic");
    expect(() => assertBoundedLocalJsonSchemaRefs({
      $ref: "#/$defs/missing",
    })).toThrow("unresolved");
    expect(() => assertBoundedLocalJsonSchemaRefs({
      $defs: { value: { type: "string" } },
      allOf: [
        { $ref: "#/$defs/value" },
        { $ref: "#/$defs/value" },
      ],
    }, { maxDepth: 4, maxRefs: 1 })).toThrow("count exceeded");
  });
});
