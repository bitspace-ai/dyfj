// Runtime server launcher: serve the workbench JSON-RPC seam over the default
// per-user Unix socket. Engine-side (pulls the runtime via uds-server)
// and intentionally NOT imported by the thin CLI client.
//   deno task serve-unix

import { serveWorkbenchUnix } from "./uds-server";
import { ensureSocketDir, resolveSocketPath } from "./uds-path";
import { loadConfig, loadSecretsConfig } from "./config";
import { resolveSecretsIntoEnv } from "./secrets";
import { installRuntimeSigintHandler } from "./runtime-sigint";

const socketPath = resolveSocketPath();
const autostarted = Deno.args.includes("--autostarted");
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

let resolveCloseServer!: (close: () => Promise<void>) => void;
const closeServerReady = new Promise<() => Promise<void>>((resolve) => {
  resolveCloseServer = resolve;
});
installRuntimeSigintHandler(
  autostarted,
  async () => await (await closeServerReady)(),
  { add: (handler) => Deno.addSignalListener("SIGINT", handler) },
  Deno.exit,
);

try {
  const server = await serveWorkbenchUnix(socketPath, {
    onParseError: (detail) => console.error(`[uds] ${detail}`),
    engineConfig: config,
  });
  resolveCloseServer(() => server.close());
  console.error(
    `dyfj runtime: JSON-RPC over UDS at ${socketPath}  ${
      autostarted ? "(autostarted)" : "(ctrl-c to stop)"
    }`,
  );
} catch (error) {
  resolveCloseServer(() => Promise.reject(error));
  throw error;
}
