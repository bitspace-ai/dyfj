import { afterEach, describe, expect, test } from "vitest";
import { JsonRpcPeer } from "./jsonrpc-peer";
import {
  encodeFrame,
  FrameDecoder,
  type JsonRpcMessage,
  notification,
  RpcError,
  RpcErrorCode,
  type RpcHandlers,
} from "./jsonrpc";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// A connected client/server peer pair over a throwaway Unix socket.
async function connectPair(
  serverHandlers: RpcHandlers = {},
  clientHandlers: RpcHandlers = {},
): Promise<{ server: JsonRpcPeer; client: JsonRpcPeer }> {
  const dir = await Deno.makeTempDir();
  const sock = `${dir}/peer.sock`;
  const listener = Deno.listen({ transport: "unix", path: sock });
  const accepting = listener.accept();
  const clientConn = await Deno.connect({ transport: "unix", path: sock });
  const serverConn = await accepting;
  listener.close();
  const server = new JsonRpcPeer(serverConn, { handlers: serverHandlers });
  const client = new JsonRpcPeer(clientConn, { handlers: clientHandlers });
  void server.run();
  void client.run();
  cleanups.push(async () => {
    client.close();
    server.close();
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // already gone
    }
  });
  return { server, client };
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

describe("JsonRpcPeer", () => {
  test("client request -> server handler -> result", async () => {
    const { client } = await connectPair({
      "models/list": () => ({ models: [] }),
    });
    expect(await client.request("models/list")).toEqual({ models: [] });
  });

  test("server-initiated request -> client handler (the approval round-trip)", async () => {
    const { server } = await connectPair({}, {
      approval: (params) => {
        expect(params).toMatchObject({ tool: "bash" });
        return { decision: "approve-once" };
      },
    });
    expect(
      await server.request("approval", {
        tool: "bash",
        command: "rm -rf build/",
      }),
    ).toEqual({ decision: "approve-once" });
  });

  test("unknown method rejects with methodNotFound", async () => {
    const { client } = await connectPair({});
    await expect(client.request("nope")).rejects.toMatchObject({
      code: RpcErrorCode.methodNotFound,
    });
  });

  test("a handler RpcError propagates as a rejection with its code", async () => {
    const { client } = await connectPair({
      turn: () => {
        throw new RpcError(RpcErrorCode.paidNotApproved, "nope");
      },
    });
    await expect(client.request("turn")).rejects.toMatchObject({
      code: RpcErrorCode.paidNotApproved,
    });
  });

  // Reconstructing an RpcError from a wire response must not stamp whatever
  // message arrived as DomainError-trusted content. The wire itself is not a
  // trust boundary — a hostile or misbehaving peer's message must be capped
  // and control-char-stripped before it rides RpcError's capped-passthrough
  // treatment.
  test("reconstructing an RpcError from an oversized/control-character wire message sanitizes it", async () => {
    const esc = String.fromCharCode(27);
    const payload = esc + "[31m" + "SELECT ".repeat(20_000);
    const { client } = await connectPair({
      turn: () => {
        throw new RpcError(RpcErrorCode.internalError, payload);
      },
    });
    let caught: RpcError | undefined;
    try {
      await client.request("turn");
    } catch (err) {
      caught = err as RpcError;
    }
    expect(caught).toBeInstanceOf(RpcError);
    expect(caught?.message).not.toContain(esc);
    expect(caught?.message.length).toBeLessThan(payload.length);
    expect(new TextEncoder().encode(caught?.message ?? "").byteLength)
      .toBeLessThan(1000);
  });

  test("a malformed error envelope rejects the pending request instead of orphaning it", async () => {
    // A raw (non-JsonRpcPeer) peer answers with responses whose error
    // envelope is malformed: a non-string message, then a null error object.
    // The pending promise must settle by rejection in both cases — request()
    // has no timeout, so a throw after the pending entry is removed would be
    // a permanent hang for the caller.
    const dir = await Deno.makeTempDir();
    const sock = `${dir}/peer.sock`;
    const listener = Deno.listen({ transport: "unix", path: sock });
    const accepting = listener.accept();
    const clientConn = await Deno.connect({ transport: "unix", path: sock });
    const rawConn = await accepting;
    listener.close();
    const client = new JsonRpcPeer(clientConn, { handlers: {} });
    void client.run();
    cleanups.push(async () => {
      client.close();
      try {
        rawConn.close();
      } catch {
        // already closed
      }
      try {
        await Deno.remove(dir, { recursive: true });
      } catch {
        // already gone
      }
    });

    const decoder = new FrameDecoder();
    const buf = new Uint8Array(8192);
    const readRequestId = async (): Promise<unknown> => {
      while (true) {
        const n = await rawConn.read(buf);
        if (n === null) throw new Error("raw peer connection closed early");
        for (
          const frame of decoder.push(new TextDecoder().decode(buf.subarray(0, n)))
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
    await expect(req1).rejects.toThrow("malformed error envelope");

    // Case 2: null error object — property access alone would throw.
    const req2 = client.request("turn");
    const id2 = await readRequestId();
    await rawConn.write(encodeFrame(
      { jsonrpc: "2.0", id: id2, error: null } as unknown as JsonRpcMessage,
    ));
    await expect(req2).rejects.toThrow("malformed error envelope");
  });

  test("notifications reach a matching handler fire-and-forget", async () => {
    let seen: unknown;
    const { client } = await connectPair({
      stream: (p) => {
        seen = p;
      },
    });
    await client.notify("stream", { delta: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(seen).toEqual({ delta: "hi" });
  });

  test("a slow request does not block other requests on the same connection", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client } = await connectPair({
      slow: async () => {
        await gate;
        return { done: true };
      },
      fast: () => ({ ok: true }),
    });
    const slow = client.request("slow"); // in flight, parked on the gate
    // fast must resolve even though slow is still pending on the same connection
    expect(await client.request("fast")).toEqual({ ok: true });
    release();
    expect(await slow).toEqual({ done: true });
  });

  test("a handler streams notifications and issues an approval mid-execution (ctx)", async () => {
    const streamed: unknown[] = [];
    const { client } = await connectPair(
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
    expect(await client.request("work")).toEqual({
      decision: { decision: "approve-once" },
    });
    expect(streamed).toEqual([{ delta: "step 1" }, { delta: "step 2" }]);
  });

  test("a large response is delivered intact (handles partial socket writes)", async () => {
    const big = "x".repeat(300_000); // exceeds a single socket write
    const { client } = await connectPair({ big: () => ({ payload: big }) });
    const result = await client.request("big") as { payload: string };
    expect(result.payload.length).toBe(300_000);
    expect(result.payload).toBe(big);
  });

  test("a multibyte character bisected across two reads round-trips byte-for-byte", async () => {
    const payload = "77→15 tok"; // → is E2 86 92
    const bytes = encodeFrame(notification("stream", { delta: payload }));
    const splitAt = bytes.indexOf(0xe2) + 1; // lead byte ends chunk one
    expect(splitAt).toBeGreaterThan(0);
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
    expect(seen).toEqual([{ delta: payload }]);
  });

  test("EOF flush feeds the buffered decoder tail into the frame layer", async () => {
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
    expect(errors).toEqual([`frame exceeds ${head.length} bytes`]);
  });

  test("pending requests reject when the connection closes", async () => {
    const { client } = await connectPair({
      slow: () => new Promise(() => {}), // never resolves
    });
    const pending = client.request("slow");
    client.close();
    await expect(pending).rejects.toThrow();
  });
});
