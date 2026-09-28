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
import { defineBash } from "./builtin/exec.ts";
import { defineGit } from "./builtin/git.ts";

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

/** A workspace-rooted tool: present only when a workspace root is resolved. */
function workspaceTool(
  define: (root: string) => CommandDefinition,
): ToolCatalogEntry {
  return ({ workspaceRoot }) =>
    workspaceRoot === undefined ? undefined : define(workspaceRoot);
}

/** The builtin tools, in registration (and listing) order. */
export const BUILTIN_TOOLS: readonly ToolCatalogEntry[] = [
  (deps) => defineMemoryRead(deps),
  ({ searchMemory }) =>
    searchMemory === undefined ? undefined : defineMemorySearch(searchMemory),
  workspaceTool(defineReadFile),
  workspaceTool(defineListFiles),
  workspaceTool(defineGrepFiles),
  workspaceTool(defineGlobFiles),
  workspaceTool(defineWriteFile),
  workspaceTool(defineEditFile),
  workspaceTool(defineBash),
  workspaceTool(defineGit),
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
): CommandRegistry {
  const registry = createCommandRegistry();
  const deps: ToolCatalogDependencies = { ...ports, ...config };
  for (const entry of entries) {
    const command = entry(deps);
    if (command !== undefined) registry.register(command);
  }
  for (const command of extensions) registry.register(command);
  return registry;
}
