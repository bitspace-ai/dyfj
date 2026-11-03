/**
 * A request the other end hangs up on says so.
 *
 * A runtime that died mid-turn reached the operator as `[Error, 17 bytes]`:
 * the peer failed its pending requests with a plain `Error("connection
 * closed")`, which the boundary masks. It is now a `PeerClosedError`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DomainError } from "../contract/mod.ts";
import { JsonRpcPeer, PeerClosedError } from "./jsonrpc-peer.ts";
import { nodeSocketHost } from "./node-socket.ts";

test("a pending request fails with PeerClosedError when the other end closes", async () => {
  const dir = mkdtempSync(join("/tmp", "dyfj_pc_"));
  const listener = await nodeSocketHost.listen(`${dir}/p.sock`);
  try {
    const accepted = listener.accept();
    const client = new JsonRpcPeer(
      await nodeSocketHost.connect(`${dir}/p.sock`),
    );
    void client.run();
    const server = await accepted;
    const pending = client.request("turn", {});
    // The far end reads the request and hangs up, as a killed runtime does.
    await server?.read();
    server?.close();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof PeerClosedError, String(error));
      assert.ok(error instanceof DomainError);
      return true;
    });
    client.close();
  } finally {
    await listener.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
