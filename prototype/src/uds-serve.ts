// Runtime server launcher: serve the workbench JSON-RPC seam over the default
// per-user Unix socket. Engine-side (pulls the runtime via uds-server)
// and intentionally NOT imported by the thin CLI client.
//   deno task serve-unix

import { serveWorkbenchUnix } from "./uds-server";
import { ensureSocketDir, resolveSocketPath } from "./uds-path";
import { loadConfig } from "./config";

const socketPath = resolveSocketPath();
ensureSocketDir(socketPath);

// Engine config (defaults → ~/.dyfj/config.toml → env), resolved once at the
// boundary and passed into the runtime; a malformed config fails the boot loudly.
const config = await loadConfig();

const server = serveWorkbenchUnix(socketPath, {
  onParseError: (detail) => console.error(`[uds] ${detail}`),
  defaultCompanionModel: config.defaultCompanionModel,
});
console.error(
  `dyfj runtime: JSON-RPC over UDS at ${socketPath}  (ctrl-c to stop)`,
);

Deno.addSignalListener("SIGINT", async () => {
  await server.close();
  Deno.exit(0);
});
