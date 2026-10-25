// A scripted client for `l8-work.sh --probe` (BIT-779): it stands in for the
// REPL, so acceptance can run a whole work session with no terminal and no
// model call. It connects to the runtime's socket, asks `runtime/status` and
// `sessions/list` (the second reads the machine's Dolt store), prints one
// line each, and disconnects.
//
//   node work-probe.ts <runtime socket>
import process from "node:process";
import { connectUnixClient } from "../../src/transport/uds-client.ts";

const socket = process.argv[2];
if (socket === undefined) {
  process.stderr.write("usage: work-probe.ts <runtime socket>\n");
  process.exit(2);
}

const client = await connectUnixClient(socket);
try {
  const status = await client.request("runtime/status") as { runtime?: { code?: unknown } };
  process.stdout.write(`work-probe: runtime/status ok${status.runtime === undefined ? " (no runtime field)" : ""}\n`);
  const sessions = await client.request("sessions/list", {});
  const count = Array.isArray(sessions)
    ? sessions.length
    : Array.isArray((sessions as { sessions?: unknown[] })?.sessions)
    ? (sessions as { sessions: unknown[] }).sessions.length
    : "?";
  process.stdout.write(`work-probe: sessions/list ok (${count} sessions)\n`);
} catch (error) {
  process.stdout.write(`work-probe: FAIL ${(error as Error).message}\n`);
  process.exitCode = 1;
} finally {
  client.close();
}
