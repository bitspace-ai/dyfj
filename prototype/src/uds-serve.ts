// Runtime server launcher: serve the workbench JSON-RPC seam over the default
// per-user Unix socket. Engine-side (pulls the runtime via uds-server)
// and intentionally NOT imported by the thin CLI client.
//   deno task serve-unix

import { serveWorkbenchUnix } from "./uds-server";
import { ensureSocketDir, resolveSocketPath } from "./uds-path";
import { loadConfig, loadSecretsConfig } from "./config";
import { resolveSecretsIntoEnv } from "./secrets";

const socketPath = resolveSocketPath();
ensureSocketDir(socketPath);

// Engine config (defaults → ~/.dyfj/config.toml → env), resolved once at the
// boundary and passed into the runtime; a malformed config fails the boot loudly.
const config = await loadConfig();

// Resolve declared secret pointers into the process env BEFORE the runtime
// reads them (providers via getEnv, recall via DYFJ_MEMORY_MCP_TOKEN). env wins;
// presence-only logging; a locked/unavailable pointer degrades that provider
// fail-closed rather than hanging on a prompt. No [secrets] section → no-op, so
// a plain local-only boot is unchanged.
await resolveSecretsIntoEnv(await loadSecretsConfig());

const server = await serveWorkbenchUnix(socketPath, {
  onParseError: (detail) => console.error(`[uds] ${detail}`),
  engineConfig: config,
});
console.error(
  `dyfj runtime: JSON-RPC over UDS at ${socketPath}  (ctrl-c to stop)`,
);

Deno.addSignalListener("SIGINT", async () => {
  await server.close();
  Deno.exit(0);
});
