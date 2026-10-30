/**
 * The tool catalog: the one place a command registry is assembled
 * (`specs/01-architecture.md` section 5.4). The runtime's per-turn toolset,
 * the `tools/list` and `tools/inspect` listing and the friction extension's
 * Linear registry are all built here.
 *
 * Adding a builtin tool is one module under `builtin/` that exports its
 * `define<Name>`, plus one line in `BUILTIN_TOOLS` (`specs/recipes/add-tool.md`).
 */

import type { CommandDefinition, CommandTraceContext } from "./definition.ts";
import { type CommandRegistry, createCommandRegistry } from "./registry.ts";
import { defineMemoryRead, defineMemorySearch } from "./builtin/memory.ts";
import {
  defineEditFile,
  defineGlobFiles,
  defineGrepFiles,
  defineListFiles,
  defineReadFile,
  defineWriteFile,
} from "./builtin/file.ts";
import type { RootAnchors, WorkspaceRoot } from "./builtin/root-anchors.ts";
import { defineBash } from "./builtin/exec.ts";
import type { ExecutorDialer } from "./builtin/executor-transport.ts";
import type { CommandSandbox } from "./builtin/srt-sandbox.ts";
import type { Env } from "../config/mod.ts";
import { defineGit } from "./builtin/git.ts";
import { definePublishTools } from "./builtin/publish.ts";

/** Runtime capabilities a tool is backed by. Absent ones leave their tools out. */
export interface ToolCatalogPorts {
  /**
   * Backs `memory.read`. A catalog built only to list the tools may omit it;
   * executing `memory.read` without it fails.
   */
  readMemory?: (slug: string) => Promise<string> | string;
  /**
   * When set, register the `memory.search` recall tool backed by this function.
   * Gated by the caller: pass it only for loopback/operator turns with an
   * external memory endpoint configured, so the tool is absent otherwise.
   */
  searchMemory?: (
    query: string,
    traceContext?: CommandTraceContext,
  ) => Promise<string> | string;
  /**
   * The engine's workspace-root anchors, which the file tools verify the root
   * against on every call. Required whenever `workspaceRoot` is set; the
   * composition root builds one per engine so an anchor outlives the turn.
   */
  rootAnchors?: RootAnchors;
  /**
   * Dials the isolated machine's executor socket, for the `bash` tool when
   * `DYFJ_EXECUTOR_SOCKET` is set. Absent, such a `bash` refuses every
   * command rather than run it here.
   */
  dialExecutor?: ExecutorDialer;
  /**
   * The engine's environment, where the `bash` and `git` tools look for
   * `DYFJ_EXECUTOR_SOCKET`; the process environment when absent.
   */
  env?: Env;
  /**
   * The runtime's srt sandbox (BIT-662). When it is on and no executor
   * socket is set, the bash, git and write tools run their commands in it.
   * Absent or off, they take the native route.
   */
  sandbox?: CommandSandbox;
  /**
   * The publish tools' ports (BIT-786): the operator's `[publish]` config, the
   * runtime's ticket registry, its spawn policy and the turn's session id.
   * Absent - no `[publish]` section - leaves the publish tools unregistered.
   */
  publish?: PublishCatalogPorts;
}

/** What the publish tools need, resolved by the caller that passes them. */
export interface PublishCatalogPorts {
  config: import("../config/publish-config.ts").PublishConfig;
  tickets: import("./builtin/publish-tickets.ts").PublishTickets;
  policy: import("../config/runtime-policy.ts").RuntimePolicy;
  sessionId: string;
  /** The layout reader and command runner, injected by tests. */
  readLayout?: (root: string) => Promise<
    import("./builtin/publish-git.ts").GitLayout
  >;
  startCommand?: typeof import("./builtin/publish-run.ts").startPublishCommand;
  resolveImplementer: (
    sessionId: string,
  ) => Promise<string | undefined>;
}

/** Resolved settings that shape the builtin tools. */
export interface ToolCatalogConfig {
  /** When set, register the workspace file, exec and git tools rooted here. */
  workspaceRoot?: string;
  /** The slugs `memory.read` accepts; any slug when absent. */
  allowedMemorySlugs?: readonly string[];
}

export type ToolCatalogDependencies = ToolCatalogPorts & ToolCatalogConfig;

/**
 * One catalog line: the tool it defines from the catalog's dependencies, or
 * `undefined` when a dependency the tool needs is absent.
 */
export type ToolCatalogEntry = (
  deps: ToolCatalogDependencies,
) => CommandDefinition | undefined;

/**
 * A workspace-rooted process tool: present only when a workspace root is
 * resolved, and given the engine's environment and executor dialer.
 */
function workspaceTool(
  define: (
    root: string,
    opts: { dialExecutor?: ExecutorDialer; env?: Env; sandbox?: CommandSandbox },
  ) => CommandDefinition,
): ToolCatalogEntry {
  return ({ workspaceRoot, dialExecutor, env, sandbox }) =>
    workspaceRoot === undefined ? undefined : define(workspaceRoot, {
      ...(dialExecutor === undefined ? {} : { dialExecutor }),
      ...(env === undefined ? {} : { env }),
      ...(sandbox === undefined ? {} : { sandbox }),
    });
}

/**
 * A workspace file tool: present only when a workspace root is resolved, and
 * bound to the engine's anchors for that root. Fails closed without them.
 */
function workspaceFileTool(
  define: (
    root: WorkspaceRoot,
    opts: { dialExecutor?: ExecutorDialer; env?: Env; sandbox?: CommandSandbox },
  ) => CommandDefinition,
): ToolCatalogEntry {
  return ({ workspaceRoot, rootAnchors, dialExecutor, env, sandbox }) => {
    if (workspaceRoot === undefined) return undefined;
    if (rootAnchors === undefined) {
      throw new Error(
        "tool catalog: the workspace file tools need root anchors",
      );
    }
    return define(rootAnchors.root(workspaceRoot), {
      ...(dialExecutor === undefined ? {} : { dialExecutor }),
      ...(env === undefined ? {} : { env }),
      ...(sandbox === undefined ? {} : { sandbox }),
    });
  };
}

/** The builtin tools, in registration (and listing) order. */
export const BUILTIN_TOOLS: readonly ToolCatalogEntry[] = [
  (deps) => defineMemoryRead(deps),
  ({ searchMemory }) =>
    searchMemory === undefined ? undefined : defineMemorySearch(searchMemory),
  workspaceFileTool(defineReadFile),
  workspaceFileTool(defineListFiles),
  workspaceFileTool(defineGrepFiles),
  workspaceFileTool(defineGlobFiles),
  workspaceFileTool(defineWriteFile),
  workspaceFileTool(defineEditFile),
  workspaceTool(defineBash),
  workspaceTool(defineGit),
];

/**
 * The publish tools (BIT-786), a group because one entry yields three commands
 * sharing one ticket registry. Present only when the operator configured
 * `[publish]` and the turn resolved a root with anchors to check it against:
 * no config, no tools.
 */
function publishTools(
  { workspaceRoot, rootAnchors, env, publish }: ToolCatalogDependencies,
): readonly CommandDefinition[] {
  if (publish === undefined || workspaceRoot === undefined) return [];
  if (rootAnchors === undefined) {
    throw new Error("tool catalog: the publish tools need root anchors");
  }
  return definePublishTools({
    config: publish.config,
    tickets: publish.tickets,
    policy: publish.policy,
    sessionId: publish.sessionId,
    workspaceRoot,
    rootAnchors,
    ...(env === undefined ? {} : { env }),
    ...(publish.readLayout === undefined
      ? {}
      : { readLayout: publish.readLayout }),
    ...(publish.startCommand === undefined
      ? {}
      : { startCommand: publish.startCommand }),
    resolveImplementer: publish.resolveImplementer,
  });
}

/** Commands registered as a group: several from one dependency decision. */
export type ToolCatalogGroup = (
  deps: ToolCatalogDependencies,
) => readonly CommandDefinition[];

/** The builtin groups, registered after `BUILTIN_TOOLS`, in this order. */
export const BUILTIN_GROUPS: readonly ToolCatalogGroup[] = [
  publishTools,
];

/**
 * Build a command registry: the builtin tools `entries` define from `ports`
 * and `config`, then `extensions` in order. `extensions` are commands
 * contributed from outside the builtin set: the configured external MCP tools
 * today, and extension commands once the extension interface lands. A caller
 * that wants only its own commands passes an empty `entries` list.
 */
export function buildToolCatalog(
  ports: ToolCatalogPorts,
  config: ToolCatalogConfig,
  extensions: readonly CommandDefinition[] = [],
  entries: readonly ToolCatalogEntry[] = BUILTIN_TOOLS,
  groups: readonly ToolCatalogGroup[] = BUILTIN_GROUPS,
): CommandRegistry {
  const registry = createCommandRegistry();
  const deps: ToolCatalogDependencies = { ...ports, ...config };
  for (const entry of entries) {
    const command = entry(deps);
    if (command !== undefined) registry.register(command);
  }
  for (const group of groups) {
    for (const command of group(deps)) registry.register(command);
  }
  for (const command of extensions) registry.register(command);
  return registry;
}
