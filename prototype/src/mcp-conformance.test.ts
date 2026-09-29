import {
  assertEquals,
  assertFalse,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";

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
  it("injects canonical trace identifiers and validated trace state", () => {
    assertEquals(
      injectMcpTraceContext({ retained: true, baggage: "drop=me" }, {
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: 1,
        traceState: "vendor=value",
      }),
      {
        retained: true,
        traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
        tracestate: "vendor=value",
      },
    );
  });

  it("extracts a validated remote parent without retaining raw envelopes", () => {
    assertEquals(
      extractMcpTraceContext({
        traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
        tracestate: "vendor=value",
        baggage: "private=value",
      }),
      {
        traceId: TRACE_ID,
        parentSpanId: SPAN_ID,
        traceFlags: 1,
        traceState: "vendor=value",
        parentIsRemote: true,
      },
    );
  });

  for (
    const traceparent of [
      undefined,
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
    ]
  ) {
    it(`rejects invalid traceparent ${traceparent}`, () => {
      assertStrictEquals(extractMcpTraceContext({ traceparent }), undefined);
    });
  }

  for (
    const traceState of [
      "duplicate=one,duplicate=two",
      "Upper=value",
      "vendor=value=invalid",
      "vendor=comma,inside",
      `vendor=${"x".repeat(506)}`,
    ]
  ) {
    it(`drops invalid tracestate ${traceState}`, () => {
      const extracted = extractMcpTraceContext({
        traceparent: `00-${TRACE_ID}-${SPAN_ID}-00`,
        tracestate: traceState,
      });
      assertEquals(extracted, {
        traceId: TRACE_ID,
        parentSpanId: SPAN_ID,
        traceFlags: 0,
        parentIsRemote: true,
      });
    });
  }

  it("projects bounded durable fields without raw propagation envelopes", () => {
    const fields = mcpTraceEventFields({
      traceFlags: 1,
      traceState: "vendor=value",
      parentIsRemote: true,
    }, "server");
    assertEquals(fields, {
      trace_flags: 1,
      trace_state: "vendor=value",
      span_kind: "server",
      parent_is_remote: true,
    });
    assertFalse("traceparent" in fields);
    assertFalse("baggage" in fields);
  });
});

describe("MCP deterministic list and retry fixtures", () => {
  it("sorts lists independently of producer order", () => {
    assertEquals(
      sortMcpList([
        { name: "zeta" },
        { name: "alpha" },
        { name: "middle" },
      ], (entry) => entry.name),
      [
        { name: "alpha" },
        { name: "middle" },
        { name: "zeta" },
      ],
    );
  });

  it("partitions private freshness by principal and clearance", () => {
    assertEquals(
      resolveMcpListFreshness({
        ttlMs: 1_000,
        cacheScope: "private",
        principalId: "operator-a",
        clearance: "private+public",
      }),
      {
        ttlMs: 1_000,
        cacheScope: "private",
        partition: '["private","operator-a","private+public"]',
      },
    );
  });

  it("shares public freshness only within the same clearance", () => {
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
    assertStrictEquals(first.partition, '["public","client_safe:public"]');
    assertStrictEquals(second.partition, first.partition);
  });

  it("encodes private partition tuples without separator or control collisions", () => {
    const partition = (principalId: string, clearance: string) =>
      resolveMcpListFreshness({
        principalId,
        clearance,
      }).partition;
    const controlPartition = partition("line\nbreak", "public\0private");
    assertEquals(
      (new Set([
        partition("a:b", "c"),
        partition("a", "b:c"),
        controlPartition,
        partition(String.raw`line\nbreak`, "public"),
        partition("operator\0admin", "public"),
        partition("operator", "\0admin:public"),
      ])).size,
      6,
    );
    assertFalse(controlPartition.includes("\n"));
    assertFalse(controlPartition.includes("\0"));
  });

  it("bounds server-controlled cache identity inputs", () => {
    const maximumEscapedPartition = resolveMcpListFreshness({
      principalId: "\0".repeat(128),
      clearance: "\0".repeat(128),
    }).partition;
    assertEquals(maximumEscapedPartition.length, 1_553);
    assertFalse(maximumEscapedPartition.includes("\0"));
    assertThrows(
      () =>
        resolveMcpListFreshness({
          principalId: "p".repeat(129),
          clearance: "public",
        }),
      Error,
      "principalId exceeds 128 UTF-16 code units",
    );
    assertThrows(
      () =>
        resolveMcpListFreshness({
          principalId: "operator",
          clearance: "c".repeat(129),
        }),
      Error,
      "clearance exceeds 128 UTF-16 code units",
    );
  });

  it("defaults untrusted freshness to immediately stale and private", () => {
    assertEquals(
      resolveMcpListFreshness({
        ttlMs: -1,
        cacheScope: "unexpected",
        principalId: "operator-a",
        clearance: "public",
      }),
      {
        ttlMs: 0,
        cacheScope: "private",
        partition: '["private","operator-a","public"]',
      },
    );
  });

  for (
    const [input, expected] of [
      [
        { terminal: "complete", readOnly: true, requestStarted: true },
        "complete",
      ],
      [
        { terminal: "input_required", readOnly: true, requestStarted: true },
        "input_required",
      ],
      [
        { terminal: "cancelled", readOnly: true, requestStarted: true },
        "cancelled",
      ],
      [
        { streamFailed: true, readOnly: true, requestStarted: true },
        "retry_new_request",
      ],
      [
        { streamFailed: true, readOnly: false, requestStarted: false },
        "retry_new_request",
      ],
      [{ streamFailed: true, readOnly: false, requestStarted: true }, "fail"],
    ] as const
  ) {
    it(`classifies ${JSON.stringify(input)} as ${expected}`, () => {
      assertStrictEquals(classifyMcpRetry(input), expected);
    });
  }
});

describe("bounded JSON Schema 2020-12 refs", () => {
  it("accepts bounded local refs", () => {
    // Must not throw.
    assertBoundedLocalJsonSchemaRefs({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        query: { type: "string", minLength: 1 },
      },
      type: "object",
      properties: { query: { $ref: "#/$defs/query" } },
    });
  });

  it("rejects remote, cyclic, unresolved, and over-budget refs", () => {
    assertThrows(
      () =>
        assertBoundedLocalJsonSchemaRefs({
          $ref: "https://example.invalid/schema",
        }),
      Error,
      "only local",
    );
    assertThrows(
      () =>
        assertBoundedLocalJsonSchemaRefs({
          $defs: { loop: { $ref: "#/$defs/loop" } },
          $ref: "#/$defs/loop",
        }),
      Error,
      "cyclic",
    );
    assertThrows(
      () =>
        assertBoundedLocalJsonSchemaRefs({
          $ref: "#/$defs/missing",
        }),
      Error,
      "unresolved",
    );
    assertThrows(
      () =>
        assertBoundedLocalJsonSchemaRefs({
          $defs: { value: { type: "string" } },
          allOf: [
            { $ref: "#/$defs/value" },
            { $ref: "#/$defs/value" },
          ],
        }, { maxDepth: 4, maxRefs: 1 }),
      Error,
      "count exceeded",
    );
  });
});
