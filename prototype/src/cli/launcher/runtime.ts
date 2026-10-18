/**
 * Start the local runtime as a child process on Node, with the arguments
 * computed in `grants.ts`, from a trusted prototype root.
 */

import { constants as osConstants } from "node:os";
import process from "node:process";
import {
  cliRuntimePolicy,
  composeRuntimePolicy,
  type Env,
  guardedSpawn,
  processEnv,
  readLauncherEnv,
  readNameserverNetGrants,
  readTextFile,
  resolveDoltEndpoint,
  runtimeChildEnv,
  type RuntimePolicy,
} from "../../config/mod.ts";
import type { CliConfig } from "../args.ts";
import { processSigintSource } from "../io.ts";
import {
  buildRuntimeArgs,
  nodeRunGrant,
  readLauncherMcpServersConfig,
  readLauncherNetworkAllow,
  readLauncherSecretsConfig,
  rustupHomeReadGrant,
  toolchainReadGrant,
} from "./grants.ts";

export interface StartRuntimeOptions {
  command?: string;
  cwd?: string;
  autostarted?: boolean;
  /**
   * Where the launcher reads its configuration and the values it forwards to
   * the runtime; the process environment when absent.
   */
  env?: Env;
}

/**
 * The prototype root whose server entry and `.env` the spawned runtime trusts —
 * derived from a TRUSTED source, never the arbitrary cwd. A hostile cwd could
 * seed a `src/server/main.ts` or a `.env` the child would run with; so
 * `dyfj start` refuses to trust it. Precedence:
 *   1. DYFJ_PROTOTYPE_ROOT — the launcher always sets it.
 *   2. The install root derived from this module's own file: URL (running
 *      the client directly from a checkout without the launcher).
 *   3. Otherwise throw — better to fail closed than trust the current directory.
 */
function defaultPrototypeRoot(): string {
  const envRoot = processEnv.get("DYFJ_PROTOTYPE_ROOT");
  if (envRoot && envRoot.length > 0) return envRoot;
  const installRoot = installRootFromModuleUrl(import.meta.url);
  if (installRoot !== null) return installRoot;
  throw new Error(
    "cannot determine the prototype root: set DYFJ_PROTOTYPE_ROOT or launch via " +
      "the dyfj launcher. Refusing to trust the current working directory for " +
      "the runtime's entry and environment.",
  );
}

/**
 * Derive the prototype root from this module's URL:
 * `.../prototype/src/cli/launcher/runtime.ts` → `.../prototype`. Only a `file:` URL is trusted (the code's real on-disk
 * home); a remote (`https:`) module has no trustworthy local install root, so
 * this returns null and the caller fails closed.
 */
export function installRootFromModuleUrl(moduleUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(moduleUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;
  const path = decodeURIComponent(url.pathname);
  // Strip this module's own trailing `/src/cli/launcher/<file>` to reach root.
  const match = path.match(/^(.*)\/src\/cli\/launcher\/[^/]+$/);
  if (match === null) return null;
  return match[1];
}

/** What the launcher starts the runtime with. */
export interface RuntimeLaunch {
  /** The composed policy; the runtime's env and its guards both read it. */
  policy: RuntimePolicy;
  /** The runtime's Node args. No `--env-file`: `env` already holds it. */
  args: string[];
  /** The runtime's complete environment. */
  env: Record<string, string>;
}

/**
 * Compose the runtime's policy from the same sources the engine composes it
 * from at boot (`composeRuntimePolicy`), and derive its args and environment.
 * Every value is read from the environment the runtime would see: the
 * ambient environment with `<cwd>/.env` filling what it leaves unset
 * (`readLauncherEnv`). That environment is then filtered to the policy's
 * names plus the runtime-platform variables (`runtimeChildEnv`), so a `.env`
 * name outside the policy never reaches the runtime. `DYFJ_SOCKET` is set to
 * `socketPath`, so the runtime listens where the client resolved, `--socket`
 * included.
 */
export async function resolveRuntimeLaunch(
  cwd: string,
  socketPath: string,
  autostarted: boolean,
  options: {
    env?: Env;
    readTextFile?: (path: string) => Promise<string>;
  } = {},
): Promise<RuntimeLaunch> {
  const read = options.readTextFile ?? readTextFile;
  const env = await readLauncherEnv(cwd, read, options.env ?? processEnv);
  const memoryMcpUrl = env.get("DYFJ_MEMORY_MCP_URL");
  const resolverConfig = await readLauncherSecretsConfig(cwd, read, env);
  const mcpServers = await readLauncherMcpServersConfig(
    cwd,
    resolverConfig,
    read,
    env,
  );
  const networkAllow = await readLauncherNetworkAllow(cwd, read, env);
  const nameserverGrants = await readNameserverNetGrants();
  const nodeGrant = await nodeRunGrant(env);
  await toolchainReadGrant(env);
  await rustupHomeReadGrant(env);
  // The runtime runs on the launcher's own Node executable
  // (`process.execPath`), the default `runtimeExecutable`.
  const policy = composeRuntimePolicy({
    mcpServers,
    memoryMcpUrl,
    networkAllow,
    nameserverGrants,
    secrets: resolverConfig,
    nodePath: nodeGrant,
    dolt: resolveDoltEndpoint(env),
  });
  return {
    policy,
    args: buildRuntimeArgs(autostarted),
    env: { ...runtimeChildEnv(policy, env), DYFJ_SOCKET: socketPath },
  };
}

/**
 * Start the runtime and wait for it to exit, with the args and environment
 * `resolveRuntimeLaunch` derives. The runtime binary is the Node executable
 * running this client unless `options.command` names another, and it must
 * pass the CLI's own run policy (`cliRuntimePolicy`).
 */
export async function startLocalRuntime(
  config: CliConfig,
  options: StartRuntimeOptions = {},
): Promise<number> {
  const command = options.command ?? process.execPath;
  const cwd = options.cwd ?? defaultPrototypeRoot();
  const autostarted = options.autostarted === true;
  const launch = await resolveRuntimeLaunch(cwd, config.socket, autostarted, {
    env: options.env ?? processEnv,
  });
  // This process and the runtime share a terminal process group, so a
  // terminal Ctrl-C reaches the runtime directly; this process never acts on
  // it. Autostarted, both must survive the SIGINT that the client converts
  // into cancel. In the foreground, this process holds the terminal until the
  // runtime exits, so a repeated Ctrl-C reaches the runtime's escalation
  // (server/sigint.ts) instead of the shell.
  const ignoreSigint = () => {};
  processSigintSource.add(ignoreSigint);
  try {
    const child = guardedSpawn(cliRuntimePolicy())(command, launch.args, {
      cwd,
      stdio: "inherit",
      env: launch.env,
    });
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        const number = signal === null
          ? undefined
          : (osConstants.signals as Record<string, number>)[signal];
        resolve(code ?? (number === undefined ? 1 : 128 + number));
      });
    });
  } finally {
    processSigintSource.remove(ignoreSigint);
  }
}
