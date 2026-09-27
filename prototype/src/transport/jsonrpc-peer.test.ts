import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertObjectMatch,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { JsonRpcPeer, type JsonRpcPeerOptions } from "./jsonrpc-peer.ts";
import {
  encodeFrame,
  FrameDecoder,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  notification,
  RpcError,
  RpcErrorCode,
  type RpcHandlers,
} from "./jsonrpc.ts";

// Unit tests for the duplex peer over in-memory connections. The peer takes
// its connection as a constructor argument, so these stubs stand in for the
// injected Deno.Conn; the real-socket cases are in
// jsonrpc-peer.integration.test.ts.

// One end of an in-memory byte-stream pair. write() delivers to the other
// end's read(); maxWrite caps the bytes one write() accepts, so a test can
// force the short writes a real socket may perform. close() ends both reads.
class MemoryConn {
  other!: MemoryConn;
  readonly written: Uint8Array[] = [];
  #inbox: Uint8Array[] = [];
  #wake?: () => void;
  #closed = false;
  readonly #maxWrite: number;

  constructor(maxWrite = Infinity) {
    this.#maxWrite = maxWrite;
  }

  async read(p: Uint8Array): Promise<number | null> {
    for (;;) {
      const chunk = this.#inbox[0];
      if (chunk) {
        const n = Math.min(chunk.length, p.length);
        p.set(chunk.subarray(0, n));
        if (n < chunk.length) this.#inbox[0] = chunk.subarray(n);
        else this.#inbox.shift();
        return n;
      }
      if (this.#closed) return null;
      await new Promise<void>((resolve) => this.#wake = resolve);
    }
  }

  write(p: Uint8Array): Promise<number> {
    if (this.#closed || this.other.#closed) {
      return Promise.reject(new Deno.errors.BadResource("closed"));
    }
    const n = Math.min(p.length, this.#maxWrite);
    const bytes = p.slice(0, n);
    this.written.push(bytes);
    this.other.#deliver(bytes);
    return Promise.resolve(n);
  }

  close(): void {
    this.#end();
    this.other.#end();
  }

  #deliver(bytes: Uint8Array): void {
    this.#inbox.push(bytes);
    this.#wakeReader();
  }

  #end(): void {
    this.#closed = true;
    this.#wakeReader();
  }

  #wakeReader(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}

function memoryConnPair(
  maxWrite?: number,
): [MemoryConn, MemoryConn] {
  const a = new MemoryConn(maxWrite);
  const b = new MemoryConn(maxWrite);
  a.other = b;
  b.other = a;
  return [a, b];
}

const asConn = (conn: MemoryConn) => conn as unknown as Deno.Conn;

// A connected client/server peer pair over an in-memory connection. The
// returned close() ends both peers and waits for their read loops to finish.
function connectPair(
  serverHandlers: RpcHandlers = {},
  clientHandlers: RpcHandlers = {},
  options?: {
    server?: Partial<JsonRpcPeerOptions>;
    client?: Partial<JsonRpcPeerOptions>;
    maxWrite?: number;
  },
) {
  const [serverConn, clientConn] = memoryConnPair(options?.maxWrite);
  const server = new JsonRpcPeer(asConn(serverConn), {
    handlers: serverHandlers,
    ...options?.server,
  });
  const client = new JsonRpcPeer(asConn(clientConn), {
    handlers: clientHandlers,
    ...options?.client,
  });
  const loops = Promise.all([server.run(), client.run()]);
  return {
    server,
    client,
    clientConn,
    async [Symbol.asyncDispose]() {
      client.close();
      server.close();
      await loops;
    },
  };
}

// A scripted inbound conn: read() serves the queued chunks in order, so a test
// controls exactly where the byte stream splits — a real socket pair cannot
// guarantee read-boundary placement. Honors the Deno.Reader contract: it never
// writes past p.length, and a chunk larger than the caller's buffer is served
// across successive reads rather than overflowing it.
function scriptedConn(chunks: Uint8Array[]): Deno.Conn {
  const queue = chunks.map((c) => c);
  return {
    read(p: Uint8Array): Promise<number | null> {
      if (queue.length === 0) return Promise.resolve(null);
      const chunk = queue[0];
      const n = Math.min(chunk.length, p.length);
      p.set(chunk.subarray(0, n));
      if (n < chunk.length) queue[0] = chunk.subarray(n);
      else queue.shift();
      return Promise.resolve(n);
    },
    write: (p: Uint8Array) => Promise.resolve(p.length),
    close() {},
  } as unknown as Deno.Conn;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

const concat = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
};

// --- wire equivalence ---

// The peer's request frames, byte for byte, as the peer wrote them when it
// built request envelopes as object literals. The Rust REPL client in
// core/dyfj-repl reads these frames, so the codec builder the peer now uses
// must leave every byte where it was.
Deno.test("request frames on the wire are byte-identical to the literal frames", async () => {
  const [conn] = memoryConnPair();
  const sink = new MemoryConn();
  conn.other = sink;
  sink.other = conn;
  const peer = new JsonRpcPeer(asConn(conn));
  const calls: Array<[string, unknown]> = [
    ["approval", undefined],
    ["approval", { tool: "bash", command: "rm -rf build/" }],
    ["turn", null],
    ["turn", { prompt: "77→15 tok   😀", n: [1, 2.5, true] }],
  ];
  const pending = calls.map(([method, params]) =>
    peer.request(method, params).catch(() => {})
  );
  // Let the serialized write chain drain.
  await new Promise((resolve) => setTimeout(resolve, 0));
  peer.close();
  await Promise.all(pending);

  const expected = calls.map(([method, params], i) => {
    const id = `p${i + 1}`;
    const literal: JsonRpcRequest = params === undefined
      ? { jsonrpc: "2.0", id, method }
      : { jsonrpc: "2.0", id, method, params };
    return encodeFrame(literal);
  });
  assertEquals(concat(conn.written), concat(expected));
  assertEquals(
    new TextDecoder().decode(conn.written[0]),
    '{"jsonrpc":"2.0","id":"p1","method":"approval"}\n',
  );
});

Deno.test("notification and response frames on the wire are unchanged", async () => {
  await using pair = connectPair({ ping: () => ({ pong: true }) });
  const serverConn = pair.clientConn.other;
  await pair.client.notify("stream", { delta: "hi" });
  await pair.client.request("ping");
  const dec = new TextDecoder();
  assertEquals(
    dec.decode(concat(pair.clientConn.written)),
    '{"jsonrpc":"2.0","method":"stream","params":{"delta":"hi"}}\n' +
      '{"jsonrpc":"2.0","id":"p1","method":"ping"}\n',
  );
  assertEquals(
    dec.decode(concat(serverConn.written)),
    '{"jsonrpc":"2.0","id":"p1","result":{"pong":true}}\n',
  );
});

// --- request/response ---

Deno.test("client request -> server handler -> result", async () => {
  await using pair = connectPair({ "models/list": () => ({ models: [] }) });
  assertEquals(await pair.client.request("models/list"), { models: [] });
});

Deno.test("all requests on one connection share one handler context", async () => {
  const contexts: unknown[] = [];
  await using pair = connectPair({
    inspect: (_params, ctx) => {
      contexts.push(ctx);
      return {};
    },
  });

  await pair.client.request("inspect");
  await pair.client.request("inspect");

  assertEquals(contexts.length, 2);
  assertStrictEquals(contexts[0], contexts[1]);
});

Deno.test("server-initiated request -> client handler (the approval round-trip)", async () => {
  await using pair = connectPair({}, {
    approval: (params) => {
      assertObjectMatch(params as Record<string, unknown>, { tool: "bash" });
      return { decision: "approve-once" };
    },
  });
  assertEquals(
    await pair.server.request("approval", {
      tool: "bash",
      command: "rm -rf build/",
    }),
    { decision: "approve-once" },
  );
});

Deno.test("an aborted request removes its pending correlation and ignores a late response", async () => {
  let markApprovalStarted!: () => void;
  const approvalStarted = new Promise<void>((resolve) => {
    markApprovalStarted = resolve;
  });
  let releaseApproval!: () => void;
  const approvalGate = new Promise<void>((resolve) => {
    releaseApproval = resolve;
  });
  await using pair = connectPair({}, {
    approval: async () => {
      markApprovalStarted();
      await approvalGate;
      return { decision: "approve" };
    },
  });
  const abortController = new AbortController();
  const pending = pair.server.request(
    "approval",
    { tool: "write_file" },
    abortController.signal,
  );

  await approvalStarted;
  abortController.abort();
  assertStrictEquals(
    await rejection(pending),
    abortController.signal.reason,
  );
  releaseApproval();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEquals(await pair.server.request("approval", { tool: "next" }), {
    decision: "approve",
  });
});

Deno.test("a request with an already-aborted signal rejects without writing", async () => {
  await using pair = connectPair();
  const abortController = new AbortController();
  abortController.abort();
  assertStrictEquals(
    await rejection(
      pair.client.request("never", undefined, abortController.signal),
    ),
    abortController.signal.reason,
  );
  assertEquals(pair.clientConn.written.length, 0);
});

Deno.test("unknown method rejects with methodNotFound", async () => {
  await using pair = connectPair({});
  const err = await rejection(pair.client.request("nope"));
  assertInstanceOf(err, RpcError);
  assertEquals(err.code, RpcErrorCode.methodNotFound);
});

Deno.test("a handler RpcError propagates as a rejection with its code", async () => {
  await using pair = connectPair({
    turn: () => {
      throw new RpcError(RpcErrorCode.paidNotApproved, "nope");
    },
  });
  const err = await rejection(pair.client.request("turn"));
  assertInstanceOf(err, RpcError);
  assertEquals(err.code, RpcErrorCode.paidNotApproved);
});

// Reconstructing an RpcError from a wire response must not stamp whatever
// message arrived as DomainError-trusted content. The wire itself is not a
// trust boundary — a hostile or misbehaving peer's message must be capped
// and control-char-stripped before it rides RpcError's capped-passthrough
// treatment.
Deno.test("reconstructing an RpcError from an oversized/control-character wire message sanitizes it", async () => {
  const esc = String.fromCharCode(27);
  const payload = esc + "[31m" + "SELECT ".repeat(20_000);
  await using pair = connectPair({
    turn: () => {
      throw new RpcError(RpcErrorCode.internalError, payload);
    },
  });
  const caught = await rejection(pair.client.request("turn"));
  assertInstanceOf(caught, RpcError);
  assert(!caught.message.includes(esc));
  assert(caught.message.length < payload.length);
  assert(new TextEncoder().encode(caught.message).byteLength < 1000);
});

Deno.test("a malformed error envelope rejects the pending request instead of orphaning it", async () => {
  // A raw (non-JsonRpcPeer) end answers with responses whose error envelope
  // is malformed: a non-string message, then a null error object. The
  // pending promise must settle by rejection in both cases — request() has
  // no timeout, so a throw after the pending entry is removed would be a
  // permanent hang for the caller.
  const [clientConn, rawConn] = memoryConnPair();
  const client = new JsonRpcPeer(asConn(clientConn), { handlers: {} });
  const loop = client.run();
  try {
    const decoder = new FrameDecoder();
    const buf = new Uint8Array(8192);
    const readRequestId = async (): Promise<unknown> => {
      while (true) {
        const n = await rawConn.read(buf);
        if (n === null) throw new Error("raw peer connection closed early");
        for (
          const frame of decoder.push(
            new TextDecoder().decode(buf.subarray(0, n)),
          )
        ) {
          if (frame.ok) return (frame.message as { id?: unknown }).id;
        }
      }
    };

    // Case 1: non-string message — sanitizeBoundaryText would throw on it.
    const req1 = client.request("turn");
    const id1 = await readRequestId();
    await rawConn.write(encodeFrame(
      {
        jsonrpc: "2.0",
        id: id1,
        error: { code: -32000, message: 42 },
      } as unknown as JsonRpcMessage,
    ));
    await assertRejects(() => req1, RpcError, "malformed error envelope");

    // Case 2: null error object — property access alone would throw.
    const req2 = client.request("turn");
    const id2 = await readRequestId();
    await rawConn.write(encodeFrame(
      { jsonrpc: "2.0", id: id2, error: null } as unknown as JsonRpcMessage,
    ));
    await assertRejects(() => req2, RpcError, "malformed error envelope");
  } finally {
    client.close();
    await loop;
  }
});

// --- notifications, concurrency, handler context ---

Deno.test("notifications reach a matching handler fire-and-forget", async () => {
  let seen: unknown;
  await using pair = connectPair({
    stream: (p) => {
      seen = p;
    },
  });
  await pair.client.notify("stream", { delta: "hi" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(seen, { delta: "hi" });
});

Deno.test("a slow request does not block other requests on the same connection", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await using pair = connectPair({
    slow: async () => {
      await gate;
      return { done: true };
    },
    fast: () => ({ ok: true }),
  });
  const slow = pair.client.request("slow"); // in flight, parked on the gate
  // fast must resolve even though slow is still pending on the same connection
  assertEquals(await pair.client.request("fast"), { ok: true });
  release();
  assertEquals(await slow, { done: true });
});

Deno.test("a handler streams notifications and issues an approval mid-execution (ctx)", async () => {
  const streamed: unknown[] = [];
  await using pair = connectPair(
    {
      // server handler: streams progress, then asks the client to approve
      work: async (_params, ctx) => {
        await ctx.notify("stream", { delta: "step 1" });
        await ctx.notify("stream", { delta: "step 2" });
        const decision = await ctx.request("approval", { tool: "bash" });
        return { decision };
      },
    },
    {
      // client side: collect stream notifications, answer the approval request
      stream: (p) => {
        streamed.push(p);
      },
      approval: () => ({ decision: "approve-once" }),
    },
  );
  assertEquals(await pair.client.request("work"), {
    decision: { decision: "approve-once" },
  });
  assertEquals(streamed, [{ delta: "step 1" }, { delta: "step 2" }]);
});

// --- byte stream handling ---

Deno.test("a large response is delivered intact across short writes", async () => {
  const big = "x".repeat(300_000);
  await using pair = connectPair({ big: () => ({ payload: big }) }, {}, {
    maxWrite: 4096, // every write() accepts at most 4 KiB
  });
  const result = await pair.client.request("big") as { payload: string };
  assertEquals(result.payload.length, 300_000);
  assertStrictEquals(result.payload, big);
});

Deno.test("a multibyte character bisected across two reads round-trips byte-for-byte", async () => {
  const payload = "77→15 tok"; // → is E2 86 92
  const bytes = encodeFrame(notification("stream", { delta: payload }));
  const splitAt = bytes.indexOf(0xe2) + 1; // lead byte ends chunk one
  assert(splitAt > 0);
  const seen: unknown[] = [];
  const peer = new JsonRpcPeer(
    scriptedConn([bytes.subarray(0, splitAt), bytes.subarray(splitAt)]),
    {
      handlers: {
        stream: (p) => {
          seen.push(p);
        },
      },
    },
  );
  await peer.run();
  assertEquals(seen, [{ delta: payload }]);
});

Deno.test("EOF flush feeds the buffered decoder tail into the frame layer", async () => {
  // With { stream: true } a partial multibyte tail stays in the TextDecoder;
  // the final argument-less flush emits U+FFFD for it into FrameDecoder.push.
  // A partial tail carries no frame terminator, so it is never delivered as a
  // message — its only observable effect is on the frame-size bound. Here head
  // is nine complete bytes and tail is the first two bytes of → (E2 86 92)
  // with maxFrameBytes 9, so only the flushed U+FFFD tips the buffer past the
  // bound and reaches onParseError. Without the flush those bytes never reach
  // the frame layer at all, and no error fires.
  const head = new TextEncoder().encode('{"x":"abc');
  const tail = new Uint8Array([0xe2, 0x86]);
  const errors: string[] = [];
  const peer = new JsonRpcPeer(scriptedConn([head, tail]), {
    maxFrameBytes: head.length, // 9 — exactly the complete bytes received
    onParseError: (detail) => errors.push(detail),
  });
  await peer.run();
  assertEquals(errors, [`frame exceeds ${head.length} bytes`]);
});

Deno.test("malformed frames and invalid messages reach onParseError without closing the connection", async () => {
  const errors: string[] = [];
  const peer = new JsonRpcPeer(
    scriptedConn([
      new TextEncoder().encode('not json\n{"jsonrpc":"1.0","id":1}\n'),
    ]),
    { onParseError: (detail) => errors.push(detail) },
  );
  await peer.run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(errors.length, 2);
  assertEquals(errors[1], "invalid message");
});

// --- lifecycle ---

Deno.test("pending requests reject when the connection closes", async () => {
  await using pair = connectPair({
    slow: () => new Promise(() => {}), // never resolves
  });
  const pending = pair.client.request("slow");
  pair.client.close();
  await assertRejects(() => pending, Error, "connection closed");
});

Deno.test("onRequestSettled fires after response has been written to the connection", async () => {
  const settled: Array<{ method: string; result: unknown; written: number }> =
    [];
  let markSettled!: () => void;
  const settledOnce = new Promise<void>((resolve) => markSettled = resolve);
  await using pair = connectPair(
    { ping: () => ({ pong: true }) },
    {},
    {
      server: {
        onRequestSettled: (req: JsonRpcRequest, res: JsonRpcResponse) => {
          if ("result" in res) {
            settled.push({
              method: req.method,
              result: res.result,
              written: pair.clientConn.other.written.length,
            });
          }
          markSettled();
        },
      },
    },
  );

  assertEquals(await pair.client.request("ping"), { pong: true });
  await settledOnce;
  // The response frame was already on the wire when the hook ran.
  assertEquals(settled, [{
    method: "ping",
    result: { pong: true },
    written: 1,
  }]);
});

Deno.test("onRequestSettled error is caught and routed to onParseError without crashing peer", async () => {
  const errors: string[] = [];
  let markReported: () => void = () => {};
  const nextReport = () =>
    new Promise<void>((resolve) => markReported = resolve);
  await using pair = connectPair(
    { ping: () => ({ ok: true }) },
    {},
    {
      server: {
        onParseError: (err: string) => {
          errors.push(err);
          markReported();
        },
        onRequestSettled: () => {
          throw new Error("hook boom");
        },
      },
    },
  );

  let reported = nextReport();
  assertEquals(await pair.client.request("ping"), { ok: true });
  await reported;
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0], "onRequestSettled error");
  // The peer still serves requests after the hook threw.
  reported = nextReport();
  assertEquals(await pair.client.request("ping"), { ok: true });
  await reported;
  assertEquals(errors.length, 2);
});
