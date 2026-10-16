/**
 * The runtime child's permission grants, computed at launch. The committed
 * `serve-unix` profile in `deno.json` cannot carry machine-specific or
 * operator-private grants (the socket path, the memory MCP host, external MCP
 * hosts, nameservers, the Node executable, the secrets resolver, inherited env
 * names), so the client resolves them here and passes them explicitly. The
 * static lists those grants extend come from the runtime policy module
 * (`config/runtime-policy.ts`), not from the profile file.
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
  processEnv,
  readLauncherEnvVar,
  readTextFile as defaultReadTextFile,
  type RuntimePolicy,
  SERVE_UNIX_ENV_GRANTS,
  type SecretsConfig,
} from "../../config/mod.ts";

/**
 * Build the `deno run` args for foregrounding the runtime. The serve-unix
 * permission profile cannot carry the machine-specific `unix:<socket>` net
 * grant (deno.json commits no host paths), and a spawned child cannot prompt
 * for it (the CLI holds stdin in raw mode). So `dyfj start` passes an explicit
 * --allow-net that reproduces the profile's net list plus the one resolved
 * socket path — and, when an external memory endpoint is configured, its
 * launch-resolved host grant (same reasoning: an operator-private hostname
 * never belongs in the committed profile), plus `<ip>:53` for each system
 * nameserver, which the web tools' address check needs to resolve a target;
 * -P still supplies every other permission category.
 */
export function buildServeUnixArgs(
  netGrants: string[],
  socketPath: string,
  memoryMcpGrant?: string | null,
  runGrants?: string[] | null,
  envGrants?: string[] | null,
  autostarted = false,
  externalMcpGrants: readonly string[] = [],
  nameserverGrants: readonly string[] = [],
): string[] {
  if (runGrants?.some((grant) => grant.includes(","))) {
    throw new Error("Deno run grants cannot contain commas");
  }
  const socketGrant = `unix:${socketPath}`;
  if (
    [
      ...netGrants,
      socketGrant,
      ...(memoryMcpGrant == null ? [] : [memoryMcpGrant]),
      ...externalMcpGrants,
      ...nameserverGrants,
    ]
      .some((grant) => grant.includes(","))
  ) {
    throw new Error("Deno network grants cannot contain commas");
  }
  let net = netGrants.includes(socketGrant)
    ? netGrants
    : [...netGrants, socketGrant];
  if (memoryMcpGrant != null && !net.includes(memoryMcpGrant)) {
    net = [...net, memoryMcpGrant];
  }
  for (const grant of [...externalMcpGrants, ...nameserverGrants]) {
    if (!net.includes(grant)) net = [...net, grant];
  }
  return [
    "run",
    // A server must never interactively prompt: ungranted access throws
    // NotCapable (fail-closed) instead of parking the runtime on a TTY
    // prompt nobody watches while clients hang on a silent turn.
    "--no-prompt",
    "-P=serve-unix",
    `--allow-net=${net.join(",")}`,
    // An explicit --allow-run REPLACES the profile's run list, so runGrants
    // must carry the profile grants plus the launch-resolved Node executable,
    // /bin/kill, and any configured resolver binary.
    ...(runGrants != null ? [`--allow-run=${runGrants.join(",")}`] : []),
    // An explicit --allow-env likewise REPLACES the profile's env list, so
    // envGrants must carry the profile's own env plus the [secrets].inherit_env
    // names the runtime must READ to forward them into the resolver. Omitted
    // (null) when inherit_env is empty. The forwarded VALUES never enter the
    // committed profile — only launch-resolved from the operator's config.
    ...(envGrants != null ? [`--allow-env=${envGrants.join(",")}`] : []),
    "--env-file=.env",
    "src/server/main.ts",
    ...(autostarted ? ["--autostarted"] : []),
  ];
}

/** Validate the selected executable and carry that same path into exact grants. */
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
 * the launcher's `--allow-run` grant matches the resolver the runtime actually
 * invokes. The config file lives at `$DYFJ_ROOT/config.toml` (else
 * `$HOME/.dyfj/config.toml`). The child reads `--env-file=.env`, which only
 * supplies a var that is NOT already in the ambient environment — so `DYFJ_ROOT`
 * is taken from `.env` ONLY when it is ambiently UNSET. An ambient empty string
 * (`DYFJ_ROOT=""`) is left as-is and treated as absent by `configFilePath`,
 * exactly as the child sees it (its `--env-file` cannot override the empty
 * value). Reading `.env` on `""` too would make the launcher and child pick
 * different configs and mis-grant `--allow-run`.
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
 * The runtime's `deno run` args, built from its composed policy: the net list
 * is the policy's plus the socket, the run list is the policy's, and the env
 * list is the policy's when it adds `[secrets].inherit_env` names to the
 * profile's (else the profile's own, through -P). The in-code guards read the
 * same policy, so the permission flags and the guards cannot drift.
 */
export function buildRuntimeArgs(
  policy: RuntimePolicy,
  socketPath: string,
  autostarted = false,
): string[] {
  return buildServeUnixArgs(
    [...policy.net],
    socketPath,
    null,
    [...policy.run],
    policy.env.length > SERVE_UNIX_ENV_GRANTS.length ? [...policy.env] : null,
    autostarted,
  );
}
