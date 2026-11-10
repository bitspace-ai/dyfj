/**
 * The stdio side of the Workbench tool bridge (`workbench-tool-bridge.ts`).
 * Codex starts this file as an MCP server: `node <this file> <socket path>`,
 * with the session token in DYFJ_WORKBENCH_BRIDGE_TOKEN. It connects to the
 * bridge's socket, sends the token as the first line, and then copies stdin
 * to the socket and the socket to stdout. It reads no message and runs no
 * tool. It exits once the socket closes; the end of stdin ends its writes to
 * the socket.
 *
 * It imports only `node:` modules, so it starts without the runtime's code.
 */

import net from "node:net";
import process from "node:process";

const socketPath = process.argv[2];
const token = process.env.DYFJ_WORKBENCH_BRIDGE_TOKEN;
if (socketPath === undefined || token === undefined || token === "") {
  process.stderr.write("workbench-tool-bridge-shim: missing socket path or token\n");
  process.exit(2);
}

const socket = net.connect(socketPath);
socket.once("connect", () => {
  socket.write(`${token}\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout, { end: false });
});
socket.once("error", (error: NodeJS.ErrnoException) => {
  process.stderr.write(
    `workbench-tool-bridge-shim: bridge unavailable (${error.code ?? "error"})\n`,
  );
  process.exit(1);
});
// Stop reading stdin and let the process end on its own, so stdout finishes
// writing what the bridge sent before it exits.
socket.once("close", () => {
  process.stdin.unpipe(socket);
  process.stdin.destroy();
});
process.stdin.once("end", () => socket.end());
