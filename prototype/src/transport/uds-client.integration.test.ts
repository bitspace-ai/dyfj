import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import {
  type UdsTestSocket,
  udsTestSocket,
} from "../../testing/servers/uds-sockets.ts";
import { RpcError, RpcErrorCode, type RpcHandlers } from "./jsonrpc.ts";
import { connectUnixClient, type ToolApprovalVerdict } from "./uds-client.ts";
import { serveUnixJsonRpc } from "./uds-listener.ts";

// The client end of the Unix-socket transport against a real server socket.
// Socket paths come from the integration lane's exact grants
// (testing/servers/uds-sockets.ts).

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch {
    // already gone
  }
}

async function serve(name: UdsTestSocket, handlers: RpcHandlers) {
  const socketPath = udsTestSocket(name);
  await removeIfPresent(socketPath);
  const server = await serveUnixJsonRpc(socketPath, { handlers });
  return {
    socketPath,
    async [Symbol.asyncDispose]() {
      await server.close();
      await removeIfPresent(socketPath);
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

Deno.test("connectUnixClient sends requests and delivers results and RPC errors", async () => {
  await using server = await serve("client-roundtrip", {
    "models/list": () => ({ models: ["local-x"] }),
    turn: () => {
      throw new RpcError(RpcErrorCode.paidNotApproved, "paid not approved", {
        turnId: "t1",
      });
    },
  });
  const client = await connectUnixClient(server.socketPath);
  try {
    assertEquals(await client.request("models/list"), {
      models: ["local-x"],
    });
    const err = await rejection(client.request("turn", { prompt: "x" }));
    assertInstanceOf(err, RpcError);
    assertEquals(err.code, RpcErrorCode.paidNotApproved);
    assertEquals(err.message, "paid not approved");
    assertEquals(err.data, { turnId: "t1" });
    const missing = await rejection(client.request("nope"));
    assertInstanceOf(missing, RpcError);
    assertEquals(missing.code, RpcErrorCode.methodNotFound);
  } finally {
    client.close();
  }
});

Deno.test("connectUnixClient connects when given a live signal", async () => {
  await using server = await serve("client-roundtrip", {
    ping: () => "pong",
  });
  const controller = new AbortController();
  const client = await connectUnixClient(
    server.socketPath,
    {},
    controller.signal,
  );
  try {
    // Aborting the connect signal after connecting leaves the client usable.
    controller.abort();
    assertEquals(await client.request("ping"), "pong");
  } finally {
    client.close();
  }
});

Deno.test("onStream receives the server's stream notifications during a request", async () => {
  await using server = await serve("client-approval", {
    turn: async (_params, ctx) => {
      await ctx.notify("stream", { type: "delta", text: "a" });
      await ctx.notify("stream", { type: "delta", text: "b" });
      return { done: true };
    },
  });
  const frames: unknown[] = [];
  const client = await connectUnixClient(server.socketPath, {
    onStream: (params) => frames.push(params),
  });
  try {
    assertEquals(await client.request("turn"), { done: true });
    assertEquals(frames, [
      { type: "delta", text: "a" },
      { type: "delta", text: "b" },
    ]);
  } finally {
    client.close();
  }
});

Deno.test("onApproval answers the server's approval request", async () => {
  const asked: unknown[] = [];
  await using server = await serve("client-approval", {
    turn: async (_params, ctx) => ({
      verdict: await ctx.request("approval", { tool: "write_file" }),
    }),
  });
  const client = await connectUnixClient(server.socketPath, {
    onApproval: (request): ToolApprovalVerdict => {
      asked.push(request);
      return { decision: "deny", reason: "not now" };
    },
  });
  try {
    assertEquals(await client.request("turn"), {
      verdict: { decision: "deny", reason: "not now" },
    });
    assertEquals(asked, [{ tool: "write_file" }]);
  } finally {
    client.close();
  }
});

Deno.test("without onApproval the server's approval request fails closed", async () => {
  await using server = await serve("client-approval", {
    turn: async (_params, ctx) => {
      try {
        await ctx.request("approval", { tool: "write_file" });
        return { approved: true };
      } catch (err) {
        return { approved: false, code: (err as RpcError).code };
      }
    },
  });
  const client = await connectUnixClient(server.socketPath);
  try {
    assertEquals(await client.request("turn"), {
      approved: false,
      code: RpcErrorCode.methodNotFound,
    });
  } finally {
    client.close();
  }
});

Deno.test("a request signal aborts only that request", async () => {
  await using server = await serve("client-lifecycle", {
    hang: () => new Promise(() => {}),
    ping: () => "pong",
  });
  const client = await connectUnixClient(server.socketPath);
  try {
    const controller = new AbortController();
    const reason = new Error("stop waiting");
    const pending = client.request("hang", undefined, controller.signal);
    controller.abort(reason);
    assertStrictEquals(await rejection(pending), reason);
    assertEquals(await client.request("ping"), "pong");
  } finally {
    client.close();
  }
});

Deno.test("close() rejects requests still in flight", async () => {
  await using server = await serve("client-lifecycle", {
    hang: () => new Promise(() => {}),
  });
  const client = await connectUnixClient(server.socketPath);
  const pending = client.request("hang");
  client.close();
  await assertRejects(() => pending, Error, "connection closed");
});

Deno.test("connectUnixClient rejects when nothing is listening at the path", async () => {
  const socketPath = udsTestSocket("client-missing");
  await removeIfPresent(socketPath);
  const err = await rejection(connectUnixClient(socketPath));
  assertEquals((err as { code?: string }).code, "ENOENT", String(err));
});
