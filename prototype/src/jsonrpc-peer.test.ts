import { afterEach, describe, expect, test } from "vitest";
import { JsonRpcPeer } from "./jsonrpc-peer";
import { RpcError, RpcErrorCode, type RpcHandlers } from "./jsonrpc";

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

describe("JsonRpcPeer", () => {
  test("client request -> server handler -> result", async () => {
    const { client } = await connectPair({ "models/list": () => ({ models: [] }) });
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
      await server.request("approval", { tool: "bash", command: "rm -rf build/" }),
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

  test("notifications reach a matching handler fire-and-forget", async () => {
    let seen: unknown;
    const { client } = await connectPair({ stream: (p) => { seen = p; } });
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

  test("pending requests reject when the connection closes", async () => {
    const { client } = await connectPair({
      slow: () => new Promise(() => {}), // never resolves
    });
    const pending = client.request("slow");
    client.close();
    await expect(pending).rejects.toThrow();
  });
});
