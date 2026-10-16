/**
 * The runtime child's launch, computed by the client: its Node arguments and
 * the operator's launch-resolved configuration the runtime policy is composed
 * from (the memory MCP host, external MCP hosts, `[network] allow`, the Node
 * executable, the secrets resolver). The flags themselves come from the
 * runtime policy module (`config/runtime-policy.ts`).
 */

import { lstat, realpath, stat } from "node:fs/promises";
import process from "node:process";
import { hasDotPathComponent } from "../../kernel/mod.ts";
import {
  type Env,
  loadMcpServersConfig,
  loadNetworkAllow,
  loadSecretsConfig,
  type McpHttpServerConfig,
  nodePermissionArgs,
  processEnv,
  readLauncherEnvVar,
  readTextFile as defaultReadTextFile,
  RUNTIME_NODE_PERMISSION_FLAGS,
  type SecretsConfig,
} from "../../config/mod.ts";

/** Validate the selected executable and carry that same path into the run policy. */
export async function nodeRunGrant(
  env: Env = processEnv,
): Promise<string | null> {
  const configured = env.get("DYFJ_NODE_PATH");
  if (configured === undefined || configured === "") return null;
  if (!configured.startsWith("/")) {
    throw new Error("DYFJ_NODE_PATH must name an absolute executable");
  }
  if (configured.includes(",") || configured.includes(":")) {
    throw new Error("DYFJ_NODE_PATH contains an unsupported delimiter");
  }
  let resolved: string;
  try {
    resolved = await realpath(configured);
    const info = await stat(resolved);
    if (
      !info.isFile() ||
      (process.platform !== "win32" && (info.mode & 0o111) === 0)
    ) throw new Error("not executable");
  } catch {
    throw new Error("DYFJ_NODE_PATH executable is unavailable");
  }
  if (resolved.includes(",") || resolved.includes(":")) {
    throw new Error(
      "DYFJ_NODE_PATH canonical target contains an unsupported delimiter",
    );
  }
  return configured;
}

/** Validate the optional toolchain path using only the CLI's read authority. */
export async function toolchainReadGrant(
  env: Env = processEnv,
): Promise<string | null> {
  const configured = env.get("DYFJ_CODEX_TOOLCHAIN_PATH");
  if (configured === undefined || configured === "") return null;
  if (!configured.startsWith("/")) {
    throw new Error("Codex toolchain path must name an absolute directory");
  }
  if (configured.includes(",") || configured.includes(":")) {
    throw new Error("Codex toolchain path contains an unsupported delimiter");
  }
  if (hasDotPathComponent(configured)) {
    throw new Error("Codex toolchain path must not contain dot components");
  }
  if (/^\/+$/u.test(configured)) {
    throw new Error("Codex toolchain directory is unavailable");
  }
  try {
    const noFollowPath = configured === "/"
      ? configured
      : configured.replace(/\/+$/, "");
    const info = await lstat(noFollowPath);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("unavailable directory");
    }
    const resolved = await realpath(noFollowPath);
    if (resolved.includes(",") || resolved.includes(":")) {
      throw new Error("unsafe canonical path");
    }
  } catch {
    throw new Error("Codex toolchain directory is unavailable");
  }
  return configured;
}

/** Validate the optional Rustup home using only the CLI's read authority. */
export async function rustupHomeReadGrant(
  env: Env = processEnv,
): Promise<string | null> {
  const configured = env.get("DYFJ_CODEX_RUSTUP_HOME");
  if (configured === undefined || configured === "") return null;
  if (!configured.startsWith("/")) {
    throw new Error("Codex Rustup home must name an absolute directory");
  }
  if (configured.includes(",") || configured.includes(":")) {
    throw new Error("Codex Rustup home contains an unsupported delimiter");
  }
  if (hasDotPathComponent(configured)) {
    throw new Error("Codex Rustup home must not contain dot components");
  }
  if (/^\/+$/u.test(configured)) {
    throw new Error("Codex Rustup home directory is unavailable");
  }
  try {
    const noFollowPath = configured === "/"
      ? configured
      : configured.replace(/\/+$/, "");
    const info = await lstat(noFollowPath);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("unavailable directory");
    }
    const resolved = await realpath(noFollowPath);
    if (resolved.includes(",") || resolved.includes(":")) {
      throw new Error("unsafe canonical path");
    }
  } catch {
    throw new Error("Codex Rustup home directory is unavailable");
  }
  return configured;
}

/**
 * Load the `[secrets]` config the SAME way the spawned child will locate it, so
 * the launcher's composed policy (its resolver binary and `inherit_env` names)
 * matches the resolver the runtime actually invokes. The config file lives at `$DYFJ_ROOT/config.toml` (else
 * `$HOME/.dyfj/config.toml`). The child's environment fills a var from `.env`
 * only when it is NOT already in the ambient environment — so `DYFJ_ROOT`
 * is taken from `.env` ONLY when it is ambiently UNSET. An ambient empty string
 * (`DYFJ_ROOT=""`) is left as-is and treated as absent by `configFilePath`,
 * exactly as the child sees it (`.env` cannot override the empty value).
 * Reading `.env` on `""` too would make the launcher and child pick different
 * configs and forward the wrong `inherit_env` names.
 */
export async function readLauncherSecretsConfig(
  cwd: string,
  readTextFile: (path: string) => Promise<string> = defaultReadTextFile,
  env: Env = processEnv,
  parseToml?: (raw: string) =>
    | Record<string, unknown>
    | Promise<
      Record<string, unknown>
    >,
): Promise<Awaited<ReturnType<typeof loadSecretsConfig>>> {
  const root = await readLauncherEnvVar(cwd, "DYFJ_ROOT", readTextFile, env);
  const home = env.get("HOME");
  const configEnv = {
    get: (name: string): string | undefined =>
      name === "DYFJ_ROOT" ? root : name === "HOME" ? home : undefined,
  };
  return loadSecretsConfig({ env: configEnv, readTextFile, parseToml });
}

export async function readLauncherMcpServersConfig(
  cwd: string,
  secrets: SecretsConfig | null,
  readTextFile: (path: string) => Promise<string> = defaultReadTextFile,
  env: Env = processEnv,
  parseToml?: (raw: string) =>
    | Record<string, unknown>
    | Promise<Record<string, unknown>>,
): Promise<McpHttpServerConfig[]> {
  const root = await readLauncherEnvVar(cwd, "DYFJ_ROOT", readTextFile, env);
  const home = env.get("HOME");
  const configEnv = {
    get: (name: string): string | undefined =>
      name === "DYFJ_ROOT" ? root : name === "HOME" ? home : undefined,
  };
  return loadMcpServersConfig(
    { env: configEnv, readTextFile, parseToml },
    secrets,
  );
}

/** `[network] allow` from the same child-visible config.toml. */
export async function readLauncherNetworkAllow(
  cwd: string,
  readTextFile: (path: string) => Promise<string> = defaultReadTextFile,
  env: Env = processEnv,
  parseToml?: (raw: string) =>
    | Record<string, unknown>
    | Promise<Record<string, unknown>>,
): Promise<string[]> {
  const root = await readLauncherEnvVar(cwd, "DYFJ_ROOT", readTextFile, env);
  const home = env.get("HOME");
  const configEnv = {
    get: (name: string): string | undefined =>
      name === "DYFJ_ROOT" ? root : name === "HOME" ? home : undefined,
  };
  return loadNetworkAllow({ env: configEnv, readTextFile, parseToml });
}

/**
 * The runtime's Node arguments: its permission flags (none: the runtime runs
 * as plain `node`), the server entry (relative to the prototype root it runs
 * in) and, for a runtime the launcher started in the background,
 * `--autostarted`. Hosts, binaries and env names are not flags under Node: the
 * runtime enforces them in code from the policy it composes at boot, and the
 * launcher passes it only the policy's env.
 */
export function buildRuntimeArgs(autostarted = false): string[] {
  return [
    ...nodePermissionArgs(RUNTIME_NODE_PERMISSION_FLAGS),
    "src/server/main.ts",
    ...(autostarted ? ["--autostarted"] : []),
  ];
}
