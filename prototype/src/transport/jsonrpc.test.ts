import {
  assert,
  assertEquals,
  assertMatch,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  classify,
  dispatchRequest,
  encodeFrame,
  failure,
  FrameDecoder,
  type JsonRpcRequest,
  notification,
  request,
  RpcError,
  RpcErrorCode,
  success,
} from "./jsonrpc.ts";

const dec = new TextDecoder();

// --- framing ---

Deno.test("encodeFrame is newline-terminated JSON", () => {
  assertEquals(
    dec.decode(encodeFrame(success(1, { ok: true }))),
    '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n',
  );
});

Deno.test("FrameDecoder yields one message per line and buffers partials", () => {
  const d = new FrameDecoder();
  assertEquals(
    d.push('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0"'),
    [{ ok: true, message: { jsonrpc: "2.0", id: 1, method: "a" } }],
  );
  // the buffered partial completes on the next chunk
  assertEquals(d.push(',"id":2,"method":"b"}\n'), [
    { ok: true, message: { jsonrpc: "2.0", id: 2, method: "b" } },
  ]);
});

Deno.test("FrameDecoder reports a parse error for a malformed line without throwing", () => {
  const frames = new FrameDecoder().push("not json\n");
  assertEquals(frames.length, 1);
  assertStrictEquals(frames[0].ok, false);
  assertEquals(typeof frames[0].error, "string");
});

Deno.test("FrameDecoder bounds the partial buffer when maxBytes is set", () => {
  const frames = new FrameDecoder(8).push("123456789"); // 9 chars, no newline
  assertEquals(frames.length, 1);
  assertStrictEquals(frames[0].ok, false);
  assertMatch(frames[0].error!, /exceeds/);
});

// --- envelope builders ---

// The request frame the duplex peer wrote before it used the codec builder,
// reproduced verbatim. The Rust REPL client in core/dyfj-repl parses these
// bytes, so the builder must not change a single one of them.
function literalRequest(
  id: string | number,
  method: string,
  params?: unknown,
): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
}

Deno.test("request() encodes byte-identically to the literal request frame", () => {
  const cases: Array<[string | number, string, unknown]> = [
    ["p1", "approval", undefined],
    ["p2", "approval", null],
    ["p3", "approval", { tool: "bash", command: "ls -la", n: 1.5 }],
    ["p4", "turn", { prompt: 'héllo   😀 "q" \\ \n' }],
    ["p5", "x", []],
    ["p6", "x", ["a", 1, true, null, { nested: { deep: [] } }]],
    ["p7", "x", ""],
    ["p8", "x", 0],
    ["p9", "x", false],
    [42, "numeric/id", { a: undefined, b: 1 }],
  ];
  for (const [id, method, params] of cases) {
    assertEquals(
      encodeFrame(request(id, method, params)),
      encodeFrame(literalRequest(id, method, params)),
      `${id} ${method}`,
    );
  }
});

Deno.test("request() pins the exact wire bytes", () => {
  assertEquals(
    dec.decode(encodeFrame(request("p1", "approval"))),
    '{"jsonrpc":"2.0","id":"p1","method":"approval"}\n',
  );
  assertEquals(
    dec.decode(encodeFrame(request("p2", "approval", { tool: "bash" }))),
    '{"jsonrpc":"2.0","id":"p2","method":"approval","params":{"tool":"bash"}}\n',
  );
  assertEquals(
    dec.decode(encodeFrame(request("p3", "approval", null))),
    '{"jsonrpc":"2.0","id":"p3","method":"approval","params":null}\n',
  );
});

Deno.test("notification() and failure() omit undefined params and data", () => {
  assertEquals(
    dec.decode(encodeFrame(notification("stream"))),
    '{"jsonrpc":"2.0","method":"stream"}\n',
  );
  assertEquals(
    dec.decode(encodeFrame(failure(null, RpcErrorCode.parseError, "bad"))),
    '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"bad"}}\n',
  );
});

// --- classification ---

Deno.test("classify distinguishes request / notification / response / invalid", () => {
  assertEquals(classify({ jsonrpc: "2.0", id: 1, method: "turn" }), "request");
  assertEquals(classify(request("p1", "turn")), "request");
  assertEquals(
    classify(notification("stream", { delta: "x" })),
    "notification",
  );
  assertEquals(classify(success(1, {})), "response");
  assertEquals(
    classify(failure("a", RpcErrorCode.paidNotApproved, "x")),
    "response",
  );
  assertEquals(classify({ jsonrpc: "1.0", id: 1, method: "x" }), "invalid");
  assertEquals(classify(null), "invalid");
});

// --- dispatch ---

const req = (method: string, params?: unknown): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});

Deno.test("dispatchRequest wraps a handler result in a success envelope", async () => {
  const res = await dispatchRequest(req("models/list"), {
    "models/list": () => ({ models: [] }),
  });
  assertEquals(res, success(1, { models: [] }));
});

Deno.test("dispatchRequest awaits async handlers", async () => {
  const res = await dispatchRequest(req("sessions/list"), {
    "sessions/list": () => Promise.resolve({ sessions: ["s1"] }),
  });
  assertEquals(res, success(1, { sessions: ["s1"] }));
});

Deno.test("dispatchRequest: unknown method -> methodNotFound", async () => {
  assertEquals(
    await dispatchRequest(req("nope"), {}),
    failure(1, RpcErrorCode.methodNotFound, "method not found: nope"),
  );
});

Deno.test("dispatchRequest maps a thrown RpcError to its code + data (fail-closed range)", async () => {
  const res = await dispatchRequest(req("turn"), {
    turn: () => {
      throw new RpcError(
        RpcErrorCode.paidNotApproved,
        "paid inference not approved",
        { turnId: "t1" },
      );
    },
  });
  assertEquals(
    res,
    failure(1, RpcErrorCode.paidNotApproved, "paid inference not approved", {
      turnId: "t1",
    }),
  );
});

Deno.test("dispatchRequest maps a generic throw to internalError, rendered as class + byte count — never the raw message", async () => {
  // This is the original crash's exact path — a rejected
  // event-log INSERT's driver error can embed the whole offending payload
  // in its message. A plain Error is "foreign" (not a DomainError), so its
  // message must never reach the wire, not even a short one.
  const res = await dispatchRequest(req("turn"), {
    turn: () => {
      throw new Error("boom");
    },
  });
  assertEquals(res, failure(1, RpcErrorCode.internalError, "[Error, 4 bytes]"));
});

Deno.test("dispatchRequest: a generic throw with an oversized message leaks no prefix of it", async () => {
  const payload = "SELECT ".repeat(20_000); // well over 100KB
  const res = await dispatchRequest(req("turn"), {
    turn: () => {
      throw new Error(payload);
    },
  });
  const message = (res as { error: { message: string } }).error.message;
  assert(!message.includes(payload.slice(0, 50)));
  assertStringIncludes(message, "Error");
  assertStringIncludes(
    message,
    `${new TextEncoder().encode(payload).byteLength} bytes`,
  );
  assert(message.length < 200);
});

// --- error codes ---

Deno.test("the DYFJ fail-closed error range matches the contract", () => {
  assertEquals(RpcErrorCode.paidNotApproved, -32010);
  assertEquals(RpcErrorCode.budgetExceeded, -32011);
  assertEquals(RpcErrorCode.modelUnavailable, -32012);
  assertEquals(RpcErrorCode.remoteCannotSpend, -32013);
});

Deno.test("the JSON-RPC standard error codes are unchanged", () => {
  assertEquals(RpcErrorCode.parseError, -32700);
  assertEquals(RpcErrorCode.invalidRequest, -32600);
  assertEquals(RpcErrorCode.methodNotFound, -32601);
  assertEquals(RpcErrorCode.invalidParams, -32602);
  assertEquals(RpcErrorCode.internalError, -32603);
});
