/**
 * Unix socket paths for integration tests that bind or dial a real socket (the
 * `src/transport/`, `src/server/` and `src/cli/` integration tests).
 *
 * The integration lane (`scripts/isolated-dolt-integration.ts`) creates one
 * directory, passes it in `UDS_TEST_SOCKET_DIR_ENV`, and removes it after the
 * run. Every socket a test binds is named here, inside that directory. A test
 * that needs another socket adds its name to the list.
 */

import { processEnv } from "../../src/config/env.ts";

export const UDS_TEST_SOCKET_DIR_ENV = "DYFJ_UDS_TEST_SOCKET_DIR";

export const UDS_TEST_SOCKETS = [
  "peer",
  "node-socket",
  "client-roundtrip",
  "client-approval",
  "client-lifecycle",
  "client-missing",
  "listener-serve",
  "listener-keep-peers",
  "listener-client-eof",
  "listener-half-close",
  "listener-live",
  "listener-stale",
  "listener-file",
  "listener-count",
  "server-acp-close",
  "server-sigint",
  "server-stop",
  "server-unknown-method",
  "server-console-canary",
  "server-events-asof",
  "server-session-model",
  "server-idle-stop",
  "server-idle-cancel",
  "server-sole-client-race",
  "server-manual-stays",
  "cli-stop-live",
  "cli-stop-fails",
  "cli-stop-missing",
  "cli-stop-dead",
  "cli-stop-mute",
  "cli-stop-slow",
  "cli-status-live",
  "cli-status-mute",
  "cli-connect-aborted",
  "cli-connect-inflight",
  "cli-turn-roundtrip",
] as const;

export type UdsTestSocket = typeof UDS_TEST_SOCKETS[number];

export function udsTestSocketPath(dir: string, name: UdsTestSocket): string {
  return `${dir}/${name}.sock`;
}

/** The `--allow-net` entries for every socket named above. */
export function udsTestSocketGrants(dir: string): string[] {
  return UDS_TEST_SOCKETS.map((name) => `unix:${udsTestSocketPath(dir, name)}`);
}

/** The granted path for `name`, inside the directory the lane passed in. */
export function udsTestSocket(name: UdsTestSocket): string {
  const dir = processEnv.get(UDS_TEST_SOCKET_DIR_ENV);
  if (!dir) {
    throw new Error(
      `${UDS_TEST_SOCKET_DIR_ENV} is unset: run this file through the integration lane`,
    );
  }
  return udsTestSocketPath(dir, name);
}
