// BIT-230 transport-seam spike: duplex JSON-RPC 2.0 over a Unix domain socket.
//
// Proves the local transport for the workbench seam (BIT-230), including the
// hard part for BIT-116: a SERVER-INITIATED request mid-turn (tool approval)
// with a correlated client response. Newline-delimited JSON-RPC 2.0 frames.
//
//   deno run --allow-read=/tmp --allow-write=/tmp examples/uds-jsonrpc-spike.ts

const SOCK = "/tmp/dyfj-uds-spike.sock";
try { Deno.removeSync(SOCK); } catch { /* socket absent — fine */ }

const enc = new TextEncoder();
const dec = new TextDecoder();
const send = (c: Deno.Conn, m: unknown) => c.write(enc.encode(JSON.stringify(m) + "\n"));

// deno-lint-ignore no-explicit-any
async function* readMessages(conn: Deno.Conn): AsyncGenerator<any> {
  let buf = "";
  const chunk = new Uint8Array(4096);
  while (true) {
    const n = await conn.read(chunk);
    if (n === null) break;
    buf += dec.decode(chunk.subarray(0, n));
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line);
    }
  }
}

const log: string[] = [];

// --- server: one accepted conn drives a single turn ---
const listener = Deno.listen({ transport: "unix", path: SOCK });
const server = (async () => {
  const conn = await listener.accept(); // accept() (not for-await) so teardown is clean
  for await (const msg of readMessages(conn)) {
    if (msg.method === "turn") {
      await send(conn, { jsonrpc: "2.0", method: "stream", params: { delta: "planning the edit…" } });
      await send(conn, { jsonrpc: "2.0", method: "stream", params: { delta: "needs a shell command" } });
      // server -> client REQUEST mid-turn (the BIT-116 approval round-trip)
      await send(conn, { jsonrpc: "2.0", id: "appr-1", method: "approval", params: { tool: "bash", command: "rm -rf build/" } });
    } else if (msg.id === "appr-1" && "result" in msg) {
      const decision = msg.result.decision;
      await send(conn, { jsonrpc: "2.0", id: 1, result: { status: "done", approvedWith: decision, applied: decision !== "deny" } });
      break;
    }
  }
  conn.close();
  listener.close();
})();

// --- client: send a turn, handle stream + approval, await final result ---
const conn = await Deno.connect({ transport: "unix", path: SOCK });
await send(conn, { jsonrpc: "2.0", id: 1, method: "turn", params: { prompt: "tidy the build dir" } });
for await (const msg of readMessages(conn)) {
  if (msg.method === "stream") {
    log.push(`stream notification: ${msg.params.delta}`);
  } else if (msg.method === "approval") {
    log.push(`approval REQUEST (server→client): ${msg.params.tool} · ${msg.params.command}`);
    await send(conn, { jsonrpc: "2.0", id: msg.id, result: { decision: "approve-once" } });
    log.push(`approval RESPONSE (client→server): approve-once`);
  } else if (msg.id === 1 && "result" in msg) {
    log.push(`final turn result: ${JSON.stringify(msg.result)}`);
    break;
  }
}
conn.close();
await server;
try { Deno.removeSync(SOCK); } catch { /* already gone */ }

console.log("=== BIT-230 spike: duplex JSON-RPC 2.0 over UDS ===");
for (const l of log) console.log("  " + l);
const ok = log.some((l) => l.startsWith("approval RESPONSE")) && log.some((l) => l.startsWith("final turn result"));
console.log(ok ? "\nRESULT: duplex round-trip (incl. server-initiated approval) over UDS works ✓" : "\nRESULT: FAILED");
