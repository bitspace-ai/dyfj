/**
 * The boot sequence's policy and secrets step, split out of `main()` so a test
 * can run it over a fake environment and a fake resolver.
 *
 * Order: compose the runtime policy (it grants the resolver's spawn and the
 * Dolt endpoint), resolve the declared secret pointers under that policy, then
 * read the Dolt connection the pool uses. The policy needs only the Dolt
 * endpoint; the credentials are read after the pointers resolve, because
 * `DOLT_PASSWORD` may be one of them.
 */

import {
  composeRuntimePolicy,
  type DoltConnectionConfig,
  type McpHttpServerConfig,
  type MutableEnv,
  resolveDoltConnection,
  resolveDoltEndpoint,
  resolveSecrets,
  type ResolvedSecrets,
  type RunSecretCommand,
  type RuntimePolicy,
  type SecretsConfig,
} from "../config/mod.ts";

export interface BootInputs {
  env: MutableEnv;
  mcpServers: readonly McpHttpServerConfig[];
  secrets: SecretsConfig | null;
  networkAllow: readonly string[];
  nameserverGrants: readonly string[];
  /**
   * The programs the operator's `[[workspaces]]` profiles declare in their
   * gate and publish commands (`workspaceProfilePrograms`). The policy is
   * composed once, before any turn names a workspace, so every declared
   * program is admitted here and tagged `workspace-config`; which one a turn
   * may start is still decided by that turn's own gate or publish policy.
   */
  workspacePrograms?: readonly string[];
  /** The resolver command runner; the real spawn when absent. */
  runSecretCommand?: RunSecretCommand;
  log?: (message: string) => void;
}

export interface Boot {
  policy: RuntimePolicy;
  resolvedSecrets: ResolvedSecrets;
  doltConnection: DoltConnectionConfig;
}

export async function composeBoot(inputs: BootInputs): Promise<Boot> {
  const { env } = inputs;
  const nodePath = env.get("DYFJ_NODE_PATH");
  const policy = composeRuntimePolicy({
    mcpServers: inputs.mcpServers,
    memoryMcpUrl: env.get("DYFJ_MEMORY_MCP_URL"),
    networkAllow: inputs.networkAllow,
    nameserverGrants: inputs.nameserverGrants,
    secrets: inputs.secrets,
    nodePath: nodePath?.startsWith("/") === true ? nodePath : null,
    dolt: resolveDoltEndpoint(env),
    ...(inputs.workspacePrograms === undefined
      ? {}
      : { workspacePrograms: inputs.workspacePrograms }),
  });
  const resolvedSecrets = await resolveSecrets(inputs.secrets, {
    env,
    policy,
    run: inputs.runSecretCommand,
    log: inputs.log,
  });
  const doltConnection = resolveDoltConnection(env);
  return { policy, resolvedSecrets, doltConnection };
}
