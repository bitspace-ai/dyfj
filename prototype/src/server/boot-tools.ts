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
  DEFAULT_DISPATCH_MAX_CHILDREN,
  DEFAULT_DISPATCH_MAX_WAIT_SECONDS,
  DEFAULT_TICKET_TTL_MS,
  type DispatchConfig,
  type Env,
  type GateConfig,
  loadApprovalsConfig,
  loadDispatchConfig,
  loadGateConfig,
  type LoadConfigDeps,
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
  /**
   * The global `[publish]` section, or null when only workspace profiles
   * declare one. A turn's own section replaces it
   * (`config/workspace-policy.ts`); the registry below is the runtime's
   * either way.
   */
  config: PublishConfig | null;
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
  /**
   * Where the sections are read from. Absent, each loader reads the operator's
   * own config file; a test supplies its own reader and table so it needs no
   * file on disk.
   */
  deps?: LoadConfigDeps;
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
 * Whether any configured workspace profile declares a tool's section, so the
 * runtime must own that tool's registries even with no global section: the
 * turn's own section decides whether the tool is exposed.
 */
function profileDeclares(
  workspaces: WorkspacesConfig,
  section: "gate" | "publish" | "dispatch",
): boolean {
  return workspaces.profiles.some((profile) => profile[section] !== null);
}

/**
 * The publish ports. They exist when the global `[publish]` section or any
 * workspace profile configures publish: one ticket registry per runtime, so a
 * ticket and the gate it started outlive the turn that opened them. Absent
 * both, the tools are not registered at all - this repository ships no default
 * that would name a private path. A malformed section fails the boot loudly,
 * like every other config section.
 */
function bootPublish(
  config: PublishConfig | null,
  workspaces: WorkspacesConfig,
): PublishServerPorts | undefined {
  if (config === null && !profileDeclares(workspaces, "publish")) {
    return undefined;
  }
  // The registry's own TTL is the global one, and each ticket pins the TTL of
  // the section that issued it, so one workspace's shorter lifetime retires
  // its tickets without touching another's.
  return {
    config,
    tickets: new PublishTickets({
      ttlMs: config?.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS,
    }),
  };
}

/**
 * The gate's ports, with the one approval command eligible for a session
 * grant. They exist when the global `[gate]` section or any workspace profile
 * configures a gate; a turn whose workspace resolves to no section gets no
 * gate tools. Absent both, the tools are never registered.
 */
async function bootGate(
  config: GateConfig | null,
  policy: RuntimePolicy,
  workspaces: WorkspacesConfig,
  deps: LoadConfigDeps,
): Promise<GateRuntimePorts | undefined> {
  if (config === null && !profileDeclares(workspaces, "gate")) return undefined;
  const approvals = await loadApprovalsConfig([GATE_START_APPROVALS], deps);
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
 * The fallback `[dispatch]` a runtime boots with when only workspace profiles
 * declare dispatch: no roots, so it can plan nothing, and default bounds. A
 * turn whose workspace resolves to a dispatch section always passes its own,
 * and a workspace that resolves to none gets no dispatch ports at all, so this
 * config is never the one a child launch is planned under.
 */
const BOOT_DISPATCH_FALLBACK: DispatchConfig = Object.freeze({
  maxChildren: DEFAULT_DISPATCH_MAX_CHILDREN,
  maxWaitSeconds: DEFAULT_DISPATCH_MAX_WAIT_SECONDS,
  roots: Object.freeze([]),
});

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
  const deps = input.deps ?? {};
  const sandboxConfig = await loadSandboxConfig(deps);
  const gateConfig = await loadGateConfig(deps);
  const publishConfig = await loadPublishConfig(deps);
  const dispatchConfig = await loadDispatchConfig(deps);
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
  const publish = bootPublish(publishConfig, input.workspaces);
  if (publish !== undefined) {
    say(
      publish.config === null
        ? "dyfj runtime: publish tools enabled from [[workspaces]]"
        : "dyfj runtime: publish tools enabled from [publish]",
    );
  }
  if (dispatchConfig !== null) {
    say("dyfj runtime: dispatch tools enabled from [dispatch]");
  } else if (profileDeclares(input.workspaces, "dispatch")) {
    say("dyfj runtime: dispatch tools enabled from [[workspaces]]");
  }
  const gate = await bootGate(
    gateConfig,
    input.policy,
    input.workspaces,
    deps,
  );
  if (gate !== undefined) {
    say(
      gate.config === null
        ? "dyfj runtime: gate tools enabled from [[workspaces]]"
        : "dyfj runtime: gate tools enabled from [gate]",
    );
  }
  return {
    workspaceConfig,
    sandbox,
    publish,
    // Dispatch needs a service config to boot with, so a runtime with only
    // profile-declared dispatch boots on a fallback that plans nothing: every
    // turn that may dispatch passes its own workspace's section, and one that
    // may not gets no ports at all.
    dispatch: dispatchConfig ??
      (profileDeclares(input.workspaces, "dispatch")
        ? BOOT_DISPATCH_FALLBACK
        : undefined),
    gate,
  };
}
