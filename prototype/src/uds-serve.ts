// Runtime server launcher: serve the workbench JSON-RPC seam over the default
// per-user Unix socket (BIT-230). Engine-side (pulls the runtime via uds-server)
// and intentionally NOT imported by the thin CLI client.
//   deno task serve-unix

import { serveWorkbenchUnix } from "./uds-server";
import { ensureSocketDir, resolveSocketPath } from "./uds-path";

const socketPath = resolveSocketPath();
ensureSocketDir(socketPath);

const server = serveWorkbenchUnix(socketPath, {
  onParseError: (detail) => console.error(`[uds] ${detail}`),
});
console.error(`dyfj runtime: JSON-RPC over UDS at ${socketPath}  (ctrl-c to stop)`);

Deno.addSignalListener("SIGINT", async () => {
  await server.close();
  Deno.exit(0);
});
