/**
 * Which configuration applies to a workspace (BIT-982): the operator's global
 * sections, overridden by the `[[workspaces]]` profile that covers the turn's
 * resolved root.
 *
 * One runtime serves several repositories. The flat sections stay the default
 * for every workspace, and a profile replaces just the parts it declares:
 * instruction trust, the gate commands, the publish commands, the sandbox
 * additions and the dispatch roots.
 *
 * Built once at boot from the loaded config (`config/workbench.ts`) and the
 * global sections, then read per turn after the workspace root is resolved. It
 * is the single place that decides which section applies where.
 *
 * Two seams widen to the union rather than the profile, and both say so in the
 * docs instead of pretending otherwise:
 *
 * - The runtime's spawn and egress policy (`composeRuntimePolicy`) is composed
 *   once at boot, before any turn names a workspace, so it cannot vary by
 *   workspace. The gate and publish tools widen their own spawn policy per turn
 *   from the config that applies (`publishPolicyFor`, and `gate-runs`' own
 *   `argv[0]` grant), so a profile's commands start under exactly the profile
 *   that declared them; the boot policy is not widened by a profile.
 * - srt's `network.allowedDomains` is installed once at `initialize`, so a
 *   profile's `sandbox.allow_domains` cannot join it. Each sandboxed command
 *   registers its workspace's extra domains with
 *   `registerCommandNetworkLists` under an unguessable id
 *   (`tools/builtin/srt-sandbox.ts`), which lifts the default deny for that one
 *   command and never reopens a `deniedDomains` entry.
 */

import type { DispatchConfig } from "./dispatch-config.ts";
import type { GateConfig } from "./gate-config.ts";
import type { PublishConfig } from "./publish-config.ts";
import type { SandboxConfig } from "./sandbox-config.ts";
import type {
  WorkspaceProfile,
  WorkspacesConfig,
} from "./workspaces-config.ts";

/** The sections that apply to one workspace, after the profile is applied. */
export interface ResolvedWorkspaceConfig {
  /** True only when the operator elevated this workspace's instructions. */
  readonly trustInstructions: boolean;
  readonly gate: GateConfig | null;
  readonly publish: PublishConfig | null;
  readonly sandbox: SandboxConfig;
  /** True when this workspace's profile asks for git writes in a worktree. */
  readonly requireWorktree: boolean;
  readonly dispatch: DispatchConfig | null;
  /** The profile that supplied the overrides; null when the globals apply. */
  readonly profile: WorkspaceProfile | null;
}

/** The global sections a profile may override, as boot resolved them. */
export interface WorkspaceGlobals {
  readonly trustInstructions: boolean;
  readonly gate: GateConfig | null;
  readonly publish: PublishConfig | null;
  readonly sandbox: SandboxConfig;
  readonly dispatch: DispatchConfig | null;
}

export class WorkspaceProfiles {
  readonly #config: WorkspacesConfig;
  readonly #globals: WorkspaceGlobals;

  constructor(config: WorkspacesConfig, globals: WorkspaceGlobals) {
    this.#config = config;
    this.#globals = globals;
  }

  /** The profiles as declared, for diagnostics. */
  get profiles(): WorkspacesConfig["profiles"] {
    return this.#config.profiles;
  }

  /** The profile covering `root`, or null when the global sections apply. */
  match(root: string): WorkspaceProfile | null {
    return this.#config.match(root);
  }

  /**
   * The configuration for `root`. A section a profile declares replaces the
   * global one whole: a profile that sets `gate.command` and no
   * `gate.fast_command` has no fast mode, rather than silently borrowing
   * another workspace's command. A section it omits leaves the global section
   * in force, so an existing flat config keeps working unchanged.
   */
  resolve(root: string): ResolvedWorkspaceConfig {
    const profile = this.#config.match(root);
    const globals = this.#globals;
    return {
      trustInstructions: profile?.trustInstructions ?? globals.trustInstructions,
      gate: profile?.gate ?? globals.gate,
      publish: profile?.publish ?? globals.publish,
      sandbox: profile?.sandbox ?? globals.sandbox,
      requireWorktree: profile?.sandbox?.requireWorktree === true,
      dispatch: profile?.dispatch ?? globals.dispatch,
      profile,
    };
  }

  /**
   * The sandbox domains a workspace adds, for the sandbox's per-command
   * registration. Empty for an unmatched workspace: the globals' domains are
   * already installed at `initialize`.
   */
  async allowDomainsFor(root: string): Promise<readonly string[]> {
    return this.#config.match(root)?.sandbox?.allowDomains ?? [];
  }

  /**
   * The extra read-deny paths this workspace adds, for the sandbox's per-run
   * policy. Additive over the built-in credential list and the global
   * `[sandbox] deny_read`: a profile can add a deny and never remove one.
   */
  async denyReadFor(root: string): Promise<readonly string[]> {
    return this.#config.match(root)?.sandbox?.denyRead ?? [];
  }

  /** Whether this workspace asks for sandboxed git writes to fail closed. */
  async requireWorktreeFor(root: string): Promise<boolean> {
    return this.#config.match(root)?.sandbox?.requireWorktree === true;
  }

  /** The dispatch roots for a coordinator working in `root`. */
  dispatchFor(root: string | undefined): DispatchConfig | null {
    if (root === undefined) return this.#globals.dispatch;
    return this.#config.match(root)?.dispatch ?? this.#globals.dispatch;
  }
}
