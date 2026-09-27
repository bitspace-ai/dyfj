// Default Unix-socket path for the workbench runtime seam. Engine-free
// so the thin CLI client and the server both import it.

import { type Env, processEnv } from "./config/mod.ts";

// DYFJ_SOCKET wins; otherwise a per-user runtime dir ($XDG_RUNTIME_DIR/dyfj, or
// ~/.dyfj/run). The dir is created owner-only (0700) by ensureSocketDir.
export function resolveSocketPath(env: Env = processEnv): string {
  const explicit = env.get("DYFJ_SOCKET");
  if (explicit && explicit.length > 0) return explicit;
  const runtimeDir = env.get("XDG_RUNTIME_DIR");
  const base = runtimeDir && runtimeDir.length > 0
    ? `${runtimeDir}/dyfj`
    : `${env.get("HOME") ?? "."}/.dyfj/run`;
  return `${base}/workbench.sock`;
}

// Create the socket's parent dir owner-only (0700). Server-side launcher use.
export function ensureSocketDir(socketPath: string): void {
  const slash = socketPath.lastIndexOf("/");
  if (slash <= 0) return;
  Deno.mkdirSync(socketPath.slice(0, slash), { recursive: true, mode: 0o700 });
}
