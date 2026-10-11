import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { udsTestSocket } from "../../testing/servers/uds-sockets.ts";
import { JsonRpcPeer } from "./jsonrpc-peer.ts";
import type { RpcHandlers } from "./jsonrpc.ts";
import { nodeSocketHost } from "./node-socket.ts";

// The duplex peer over a real Unix socket pair, where the kernel decides
// write sizes and read boundaries. The protocol cases run over in-memory
// connections in jsonrpc-peer.test.ts.

async function connectPair(
  serverHandlers: RpcHandlers,
  clientHandlers: RpcHandlers = {},
) {
  const sock = udsTestSocket("peer");
  const listener = await nodeSocketHost.listen(sock);
  const accepted = listener.accept();
  const clientConn = await nodeSocketHost.connect(sock);
  const serverConn = await accepted;
  assert(serverConn !== null);
  const server = new JsonRpcPeer(serverConn, { handlers: serverHandlers });
  const client = new JsonRpcPeer(clientConn, { handlers: clientHandlers });
  const loops = Promise.all([server.run(), client.run()]);
  return {
    server,
    client,
    async [Symbol.asyncDispose]() {
      client.close();
      server.close();
      listener.close();
      await loops;
      try {
        await Deno.remove(sock);
      } catch {
        // already gone
      }
    },
  };
}

Deno.test("a large response is delivered intact over a real socket (partial writes)", async () => {
  const big = "x".repeat(300_000); // exceeds a single socket write
  await using pair = await connectPair({ big: () => ({ payload: big }) });
  const result = await pair.client.request("big") as { payload: string };
  assertEquals(result.payload.length, 300_000);
  assertStrictEquals(result.payload, big);
});

Deno.test("multibyte payloads round-trip over a real socket", async () => {
  const text = "77→15 tok   😀 ".repeat(20_000);
  await using pair = await connectPair({ echo: (params) => params });
  assertEquals(await pair.client.request("echo", { text }), { text });
});

Deno.test("the approval round-trip crosses a real socket in both directions", async () => {
  const streamed: unknown[] = [];
  await using pair = await connectPair(
    {
      work: async (_params, ctx) => {
        await ctx.notify("stream", { delta: "step" });
        return { decision: await ctx.request("approval", { tool: "bash" }) };
      },
    },
    {
      stream: (params) => {
        streamed.push(params);
      },
      approval: () => ({ decision: "approve" }),
    },
  );
  assertEquals(await pair.client.request("work"), {
    decision: { decision: "approve" },
  });
  assertEquals(streamed, [{ delta: "step" }]);
});
