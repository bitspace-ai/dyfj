/**
 * Start the local runtime as a child process with the grants computed in
 * `grants.ts`, from a trusted prototype root.
 */

import { constants as osConstants } from "node:os";
import {
  cliRuntimePolicy,
  composeRuntimePolicy,
  type Env,
  guardedSpawn,
  processEnv,
  readLauncherEnvVar,
  readNameserverNetGrants,
  readTextFile,
  runtimeChildEnv,
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
 * The prototype root whose `deno.json` (net/run grants) and `.env` the spawned
 * runtime trusts — derived from a TRUSTED source, never the arbitrary cwd. A
 * hostile cwd could seed a `deno.json` that grants broad net/run to the child;
 * so `dyfj start` refuses to trust it. Precedence:
 *   1. DYFJ_PROTOTYPE_ROOT — the launcher always sets it (compiled + deno routes).
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
      "the runtime's permission grants.",
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

/**
 * Start the runtime and wait for it to exit. The runtime's policy is composed
 * here from the same sources the engine composes it from at boot
 * (`composeRuntimePolicy`): its Deno grants are built from it, and its
 * environment is exactly the policy's names plus the runtime-platform
 * variables (`runtimeChildEnv`), with nothing inherited. The runtime binary
 * itself must pass the CLI's own run policy (`cliRuntimePolicy`).
 */
export async function startLocalRuntime(
  config: CliConfig,
  options: StartRuntimeOptions = {},
): Promise<number> {
  const command = options.command ?? "deno";
  const cwd = options.cwd ?? defaultPrototypeRoot();
  const autostarted = options.autostarted === true;
  const env = options.env ?? processEnv;
  const memoryMcpUrl = await readLauncherEnvVar(
    cwd,
    "DYFJ_MEMORY_MCP_URL",
    readTextFile,
    env,
  );
  const secretsCfg = await readLauncherSecretsConfig(cwd, readTextFile, env);
  const mcpServers = await readLauncherMcpServersConfig(
    cwd,
    secretsCfg,
    readTextFile,
    env,
  );
  const networkAllow = await readLauncherNetworkAllow(cwd, readTextFile, env);
  const nameserverGrants = await readNameserverNetGrants();
  const nodeGrant = await nodeRunGrant(env);
  await toolchainReadGrant(env);
  await rustupHomeReadGrant(env);
  // The runtime is started by name (`deno`), which the static run list
  // already holds, so the launcher's own executable is not added.
  const policy = composeRuntimePolicy({
    mcpServers,
    memoryMcpUrl,
    networkAllow,
    nameserverGrants,
    secrets: secretsCfg,
    nodePath: nodeGrant,
    runtimeExecutable: null,
  });
  const childEnv = runtimeChildEnv(policy, env);
  // Autostarted supervisor and server share the client's terminal process
  // group. Both must survive the SIGINT that the client converts into cancel.
  const ignoreSigint = () => {};
  if (autostarted) processSigintSource.add(ignoreSigint);
  try {
    const child = guardedSpawn(cliRuntimePolicy())(
      command,
      buildRuntimeArgs(policy, config.socket, autostarted),
      { cwd, stdio: "inherit", env: childEnv },
    );
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
    if (autostarted) processSigintSource.remove(ignoreSigint);
  }
}
