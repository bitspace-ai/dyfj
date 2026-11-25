/**
 * The server's operator-configured tool sections, booted in one step: the
 * `[gate]`, `[publish]`, `[dispatch]` and `[sandbox]` tables from
 * `~/.dyfj/config.toml`, the tool sandbox they configure, and the
 * workspace-profile resolver that decides which of them applies to a turn.
 *
 * Split out of `main()` so the boot order is stated in one place: the sections
 * are loaded and validated first (a malformed one fails the boot loudly), then
 * the profile resolver is built from them, then the sandbox boots, because the
 * sandbox's per-run policy is the profile's to narrow.
 *
 * Nothing here reads a file inside a workspace: the resolver's trust boundary
 * is the operator's own config (`config/workspaces-config.ts`).
 */

import {
  type DispatchConfig,
  type Env,
  type GateConfig,
  loadApprovalsConfig,
  loadDispatchConfig,
  loadGateConfig,
  loadPublishConfig,
  loadSandboxConfig,
  type PublishConfig,
  type RuntimePolicy,
  type WorkspacesConfig,
  WorkspaceProfiles,
} from "../config/mod.ts";
import {
  bootSandbox,
  type CommandSandbox,
  describeSandbox,
  GATE_START_APPROVALS,
  type GateRuntimePorts,
  GateRuns,
  PublishTickets,
} from "../tools/mod.ts";

/** What the server holds for the publish tools across turns. */
export interface PublishServerPorts {
  config: PublishConfig;
  tickets: PublishTickets;
}

/** A loopback listener the sandbox's boot probe checks the network with. */
export interface BootProbeListener {
  (): Promise<{
    readonly port: number;
    accepted(): boolean;
    close(): void;
  }>;
}

export interface ToolSectionBoot {
  /** The operator's `[[workspaces]]`, already parsed by `loadConfig`. */
  workspaces: WorkspacesConfig;
  /** The operator's standing instruction trust: the global profile default. */
  trustInstructions: boolean;
  /** The runtime's spawn and egress policy, which the gate and gate runs use. */
  policy: RuntimePolicy;
  /** Opens the sandbox's boot probe listener. */
  listenProbe: BootProbeListener;
  env?: Env;
  /** Where the one-line boot diagnostics go; stderr when absent. */
  say?: (line: string) => void;
}

/** Everything a turn's catalog, sandbox and dispatch service read from config. */
export interface ToolSections {
  readonly workspaceConfig: WorkspaceProfiles;
  readonly sandbox: CommandSandbox;
  readonly publish: PublishServerPorts | undefined;
  readonly dispatch: DispatchConfig | undefined;
  readonly gate: GateRuntimePorts | undefined;
}

/**
 * The operator's `[publish]` section, parsed and validated once. Absent, the
 * publish tools are not registered: this repository ships no default that
 * would name a private path. A malformed section fails the boot loudly, like
 * every other config section.
 */
function bootPublish(
  config: PublishConfig | null,
): PublishServerPorts | undefined {
  if (config === null) return undefined;
  // One registry per runtime, so a ticket and the gate it started outlive the
  // turn that opened them.
  return { config, tickets: new PublishTickets({ ttlMs: config.ticketTtlMs }) };
}

/**
 * The gate's ports, with the one approval command eligible for a session
 * grant. An absent `[gate]` leaves the gate tools unregistered entirely.
 */
async function bootGate(
  config: GateConfig | null,
  policy: RuntimePolicy,
): Promise<GateRuntimePorts | undefined> {
  if (config === null) return undefined;
  const approvals = await loadApprovalsConfig([GATE_START_APPROVALS]);
  return {
    config,
    runs: new GateRuns(),
    policy,
    ...(approvals === null
      ? {}
      : { sessionGrantable: approvals.sessionGrantable }),
  };
}

/**
 * Load the sections, build the workspace-profile resolver from them, and boot
 * the tool sandbox under the profiles. The order matters: the sandbox's
 * per-run policy asks the resolver which workspace it is compiling for, so the
 * resolver exists first.
 */
export async function bootToolSections(
  input: ToolSectionBoot,
): Promise<ToolSections> {
  const say = input.say ?? ((line: string) => console.error(line));
  const sandboxConfig = await loadSandboxConfig();
  const gateConfig = await loadGateConfig();
  const publishConfig = await loadPublishConfig();
  const dispatchConfig = await loadDispatchConfig();
  // Which config applies to a workspace: the operator's `[[workspaces]]`
  // profile that covers the turn's resolved root, else these globals. Built
  // once, from the same sections.
  const workspaceConfig = new WorkspaceProfiles(input.workspaces, {
    trustInstructions: input.trustInstructions,
    gate: gateConfig,
    publish: publishConfig,
    sandbox: sandboxConfig,
    dispatch: dispatchConfig,
  });
  const sandbox = await bootSandbox({
    listenProbe: input.listenProbe,
    ...(input.env === undefined ? {} : { env: input.env }),
    allowDomains: sandboxConfig.allowDomains,
    denyRead: sandboxConfig.denyRead,
    allowDomainsFor: (root) => workspaceConfig.allowDomainsFor(root),
    denyReadFor: (root) => workspaceConfig.denyReadFor(root),
    requireWorktreeFor: (root) => workspaceConfig.requireWorktreeFor(root),
  });
  say(`dyfj runtime: ${describeSandbox(sandbox.status)}`);
  if (workspaceConfig.profiles.length > 0) {
    say(
      `dyfj runtime: ${workspaceConfig.profiles.length} workspace profile(s) from [[workspaces]]`,
    );
  }
  const publish = bootPublish(publishConfig);
  if (publish !== undefined) say("dyfj runtime: publish tools enabled from [publish]");
  if (dispatchConfig !== null) say("dyfj runtime: dispatch tools enabled from [dispatch]");
  const gate = await bootGate(gateConfig, input.policy);
  if (gate !== undefined) say("dyfj runtime: gate tools enabled from [gate]");
  return {
    workspaceConfig,
    sandbox,
    publish,
    dispatch: dispatchConfig ?? undefined,
    gate,
  };
}
