import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertBoundedLocalJsonSchemaRefs,
  classifyMcpRetry,
  extractMcpTraceContext,
  injectMcpTraceContext,
  mcpTraceEventFields,
  resolveMcpListFreshness,
  sortMcpList,
} from "./conformance.ts";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

describe("MCP W3C trace context", () => {
  it("injects canonical trace identifiers and validated trace state", () => {
    assert.deepStrictEqual(
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
    assert.deepStrictEqual(
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
      assert.strictEqual(extractMcpTraceContext({ traceparent }), undefined);
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
      assert.deepStrictEqual(extracted, {
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
    assert.deepStrictEqual(fields, {
      trace_flags: 1,
      trace_state: "vendor=value",
      span_kind: "server",
      parent_is_remote: true,
    });
    assert.ok(!("traceparent" in fields));
    assert.ok(!("baggage" in fields));
  });
});

describe("MCP deterministic list and retry fixtures", () => {
  it("sorts lists independently of producer order", () => {
    assert.deepStrictEqual(
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
    assert.deepStrictEqual(
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
    assert.strictEqual(first.partition, '["public","client_safe:public"]');
    assert.strictEqual(second.partition, first.partition);
  });

  it("encodes private partition tuples without separator or control collisions", () => {
    const partition = (principalId: string, clearance: string) =>
      resolveMcpListFreshness({
        principalId,
        clearance,
      }).partition;
    const controlPartition = partition("line\nbreak", "public\0private");
    assert.deepStrictEqual(
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
    assert.ok(!controlPartition.includes("\n"));
    assert.ok(!controlPartition.includes("\0"));
  });

  it("bounds server-controlled cache identity inputs", () => {
    const maximumEscapedPartition = resolveMcpListFreshness({
      principalId: "\0".repeat(128),
      clearance: "\0".repeat(128),
    }).partition;
    assert.deepStrictEqual(maximumEscapedPartition.length, 1_553);
    assert.ok(!maximumEscapedPartition.includes("\0"));
    assert.throws(
      () =>
        resolveMcpListFreshness({
          principalId: "p".repeat(129),
          clearance: "public",
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("principalId exceeds 128 UTF-16 code units"),
    );
    assert.throws(
      () =>
        resolveMcpListFreshness({
          principalId: "operator",
          clearance: "c".repeat(129),
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("clearance exceeds 128 UTF-16 code units"),
    );
  });

  it("defaults untrusted freshness to immediately stale and private", () => {
    assert.deepStrictEqual(
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
      assert.strictEqual(classifyMcpRetry(input), expected);
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
    assert.throws(
      () =>
        assertBoundedLocalJsonSchemaRefs({
          $ref: "https://example.invalid/schema",
        }),
      (error: unknown) =>
        error instanceof Error && error.message.includes("only local"),
    );
    assert.throws(
      () =>
        assertBoundedLocalJsonSchemaRefs({
          $defs: { loop: { $ref: "#/$defs/loop" } },
          $ref: "#/$defs/loop",
        }),
      (error: unknown) =>
        error instanceof Error && error.message.includes("cyclic"),
    );
    assert.throws(
      () =>
        assertBoundedLocalJsonSchemaRefs({
          $ref: "#/$defs/missing",
        }),
      (error: unknown) =>
        error instanceof Error && error.message.includes("unresolved"),
    );
    assert.throws(
      () =>
        assertBoundedLocalJsonSchemaRefs({
          $defs: { value: { type: "string" } },
          allOf: [
            { $ref: "#/$defs/value" },
            { $ref: "#/$defs/value" },
          ],
        }, { maxDepth: 4, maxRefs: 1 }),
      (error: unknown) =>
        error instanceof Error && error.message.includes("count exceeded"),
    );
  });
});
