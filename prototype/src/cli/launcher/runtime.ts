/**
 * Start the local runtime as a child process with the grants computed in
 * `grants.ts`, from a trusted prototype root.
 */

import {
  mcpServerNetGrants,
  processEnv,
  readNameserverNetGrants,
} from "../../config/mod.ts";
import { secretsRunGrant } from "../../secrets.ts";
import type { CliConfig } from "../args.ts";
import { denoTurnInterruptSource } from "../io.ts";
import {
  buildServeUnixArgs,
  nodeRunGrant,
  readLauncherMcpServersConfig,
  readLauncherSecretsConfig,
  readMemoryMcpNetGrant,
  readServeUnixEnvGrants,
  readServeUnixNetGrants,
  readServeUnixRunGrants,
  rustupHomeReadGrant,
  toolchainReadGrant,
} from "./grants.ts";

export interface StartRuntimeOptions {
  command?: string;
  cwd?: string;
  autostarted?: boolean;
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

export async function startLocalRuntime(
  config: CliConfig,
  options: StartRuntimeOptions = {},
): Promise<number> {
  const command = options.command ?? "deno";
  const cwd = options.cwd ?? defaultPrototypeRoot();
  const autostarted = options.autostarted === true;
  const netGrants = await readServeUnixNetGrants(cwd);
  const memoryMcpGrant = await readMemoryMcpNetGrant(cwd);
  // Node and any operator-private resolver binary are launch-resolved. The
  // fixed /bin/kill grant supports the ACP process-group contract.
  const secretsCfg = await readLauncherSecretsConfig(cwd);
  const externalMcpGrants = mcpServerNetGrants(
    await readLauncherMcpServersConfig(cwd, secretsCfg),
  );
  const nameserverGrants = await readNameserverNetGrants();
  const resolverBin = secretsRunGrant(secretsCfg);
  const profileRun = await readServeUnixRunGrants(cwd);
  const nodeGrant = await nodeRunGrant();
  await toolchainReadGrant();
  await rustupHomeReadGrant();
  const dynamicRunGrants = [nodeGrant, "/bin/kill", resolverBin]
    .filter((grant): grant is string => grant !== null);
  const runGrants = [...profileRun];
  for (const grant of dynamicRunGrants) {
    if (!runGrants.includes(grant)) runGrants.push(grant);
  }
  // The resolver spawns with a cleared env and forwards only a minimal base plus
  // [secrets].inherit_env. The runtime must be able to READ those inherit_env
  // vars to forward them, so grant --allow-env for names not already in the
  // profile (launch-resolved: an operator-private var like a service-account
  // token never enters the committed profile). No inherit_env → null → -P's env.
  let envGrants: string[] | null = null;
  const inheritEnv = secretsCfg?.inheritEnv ?? [];
  if (inheritEnv.length > 0) {
    const profileEnv = await readServeUnixEnvGrants(cwd);
    const extra = inheritEnv.filter((name) => !profileEnv.includes(name));
    envGrants = extra.length > 0 ? [...profileEnv, ...extra] : null;
  }
  // Autostarted supervisor and server share the client's terminal process
  // group. Both must survive the SIGINT that the client converts into cancel.
  const ignoreSigint = () => {};
  if (autostarted) denoTurnInterruptSource.add(ignoreSigint);
  try {
    const child = new Deno.Command(command, {
      args: buildServeUnixArgs(
        netGrants,
        config.socket,
        memoryMcpGrant,
        runGrants,
        envGrants,
        autostarted,
        externalMcpGrants,
        nameserverGrants,
      ),
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const status = await child.status;
    return status.code;
  } finally {
    if (autostarted) denoTurnInterruptSource.remove(ignoreSigint);
  }
}
