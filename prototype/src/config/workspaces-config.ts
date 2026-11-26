/**
 * Operator-owned workspace profiles: `[[workspaces]]` entries in
 * `~/.dyfj/config.toml` (BIT-982).
 *
 *   [[workspaces]]
 *   path = "~/projects/dyfj"
 *   trust_instructions = true
 *
 *   [workspaces.gate]
 *   command = ["npm", "test"]
 *
 *   [workspaces.publish]
 *   base_ref = "origin/main"
 *   pre_gate = ["./scripts/pre-gate", "--range={range}"]
 *   gate     = ["./scripts/gate", "--range={range}", "--report={report}"]
 *
 *   [workspaces.sandbox]
 *   allow_domains = ["static.crates.io"]
 *   deny_read = [".example-tool/token"]
 *   require_worktree = true
 *
 *   [workspaces.dispatch]
 *   roots = ["~/projects/dyfj-worktrees"]
 *
 * One Workbench runtime can then serve several repositories without one
 * project's gate, publish commands, instruction elevation, sandbox additions or
 * dispatch roots leaking into another.
 *
 * **The trust boundary is this file, and only this file.** A profile is read
 * from the operator's own config and never from a file inside the workspace it
 * names: a repository can hold an `AGENTS.md` and arbitrary scripts, so nothing
 * it contains may decide which commands run or which instructions are elevated.
 *
 * Each scoped section is parsed by the parser of its top-level counterpart
 * (`parseGateConfig`, `parsePublishConfig`, `parseSandboxConfig`,
 * `parseDispatchConfig`), so a profile cannot accept a value the global section
 * refuses, and its keys cannot drift from the global ones. An absent section
 * leaves the global section in force; an absent `[[workspaces]]` leaves the flat
 * configuration exactly as it was.
 *
 * Paths are matched canonically, most specific first. Two profiles whose paths
 * resolve to the same directory fail the config load: which one applied would
 * depend on file order, and a profile is a trust decision, not a preference.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type Env, processEnv } from "./env.ts";
import { type DispatchConfig, parseDispatchConfig } from "./dispatch-config.ts";
import { type GateConfig, parseGateConfig } from "./gate-config.ts";
import {
  type PublishConfig,
  parsePublishConfig,
} from "./publish-config.ts";
import { readTextFile as defaultReadTextFile } from "./read-text-file.ts";
import { type SandboxConfig, parseSandboxConfig } from "./sandbox-config.ts";
import {
  configFilePath,
  configLabel,
  defaultParseToml,
  type LoadConfigDeps,
  readConfigFile,
} from "./toml.ts";

/** A profile's additions to the sandbox policy, plus its git-write posture. */
export interface WorkspaceSandboxConfig extends SandboxConfig {
  /**
   * True when sandboxed `git add` and `git commit` must be refused in a main
   * checkout, for this workspace only. It is a local guard rail the operator
   * asks for, not a platform limit; a linked worktree is unaffected either way.
   */
  readonly requireWorktree: boolean;
}

/** One operator-declared workspace, its sections already validated. */
export interface WorkspaceProfile {
  /** The canonical absolute root this profile covers. */
  readonly path: string;
  /** Null leaves the global `[workspace] trust_instructions` in force. */
  readonly trustInstructions: boolean | null;
  readonly gate: GateConfig | null;
  readonly publish: PublishConfig | null;
  readonly sandbox: WorkspaceSandboxConfig | null;
  readonly dispatch: DispatchConfig | null;
}

export interface WorkspacesConfig {
  readonly profiles: readonly WorkspaceProfile[];
  /**
   * The profile covering `root`, most specific first, or null when none does.
   * `root` is matched as a directory: it, or a path under it, never a sibling
   * whose name merely starts with the profile's path.
   */
  match(root: string): WorkspaceProfile | null;
}

/** The `[[workspaces]]` keys, and each scoped section's own key set. */
const PROFILE_KEYS: ReadonlySet<string> = new Set([
  "path",
  "trust_instructions",
  "gate",
  "publish",
  "sandbox",
  "dispatch",
]);

const SANDBOX_PROFILE_KEYS: ReadonlySet<string> = new Set([
  "allow_domains",
  "deny_read",
  "require_worktree",
]);

const NO_PROFILES: WorkspacesConfig = Object.freeze({
  profiles: Object.freeze([]),
  match: () => null,
}) as WorkspacesConfig;

function expandHome(raw: string, at: string, env: Env, where: string): string {
  if (raw === "~" || raw.startsWith("~/")) {
    const home = env.get("HOME");
    if (home === undefined || home === "" || !isAbsolute(home)) {
      throw new Error(
        `config: ${at} uses "~" but HOME is not set to an absolute path (${configLabel(where)})`,
      );
    }
    return raw === "~" ? resolve(home) : resolve(home, raw.slice(2));
  }
  return raw;
}

/** The canonical form of a path: its real path when it exists, else resolved. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The canonical form of a path that may not exist yet.
 *
 * A whole-path `realpath` fails once any component is missing, which left a
 * profile under a symlinked parent stored as its lexical path while the
 * candidate root was resolved through the symlink: the two never matched. So
 * the nearest EXISTING ancestor is realpathed and the missing suffix is joined
 * back on, which gives the path the directory will have once it exists.
 */
function canonicalAllowingMissing(path: string): string {
  const suffix: string[] = [];
  let head = resolve(path);
  for (;;) {
    try {
      const real = realpathSync(head);
      return suffix.length === 0 ? real : join(real, ...suffix.reverse());
    } catch {
      const parent = dirname(head);
      // The filesystem root exists, so this cannot loop forever; if it is
      // reached with a failing realpath, fall back to the lexical path.
      if (parent === head) return resolve(path);
      suffix.push(basename(head));
      head = parent;
    }
  }
}

function readProfilePath(
  value: unknown,
  at: string,
  env: Env,
  where: string,
): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(
      `config: ${at}.path is required and must be a non-empty string in ${configLabel(where)}`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(
      `config: ${at}.path must not contain a control character in ${configLabel(where)}`,
    );
  }
  if (value.split(/[\\/]/u).includes("..")) {
    throw new Error(
      `config: ${at}.path must not contain a ".." segment in ${configLabel(where)}`,
    );
  }
  const expanded = expandHome(value, `${at}.path`, env, where);
  if (!isAbsolute(expanded)) {
    throw new Error(
      `config: ${at}.path must be an absolute path or start with "~/" in ${configLabel(where)}`,
    );
  }
  return canonicalAllowingMissing(expanded);
}

/**
 * A section's table, as the global parser for it expects to find it. The
 * global parsers read `table[section]`, so a profile's `gate` table is handed
 * over under that same name.
 */
function sectionTable(
  values: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const section = values[name];
  if (section === undefined) return {};
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new Error(`config: workspaces.${name} must be a table`);
  }
  return { [name]: section };
}

function parseProfileSandbox(
  values: Record<string, unknown>,
  path: string,
): WorkspaceSandboxConfig | null {
  const section = values["sandbox"];
  if (section === undefined) return null;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new Error(`config: workspaces.sandbox must be a table`);
  }
  const sandbox = section as Record<string, unknown>;
  for (const key of Object.keys(sandbox)) {
    if (!SANDBOX_PROFILE_KEYS.has(key)) {
      throw new Error(`config: unknown key in workspaces.sandbox in ${configLabel(path)}`);
    }
  }
  const requireWorktree = sandbox["require_worktree"];
  if (requireWorktree !== undefined && typeof requireWorktree !== "boolean") {
    throw new Error(`config: workspaces.sandbox.require_worktree must be a boolean`);
  }
  // Everything but require_worktree goes to the global parser, unchanged: the
  // additions to the deny and allow lists are validated exactly as the
  // top-level `[sandbox]` ones are.
  const { require_worktree: _worktree, ...shared } = sandbox;
  const parsed = parseSandboxConfig({ sandbox: shared }, path);
  return {
    allowDomains: parsed.allowDomains,
    denyRead: parsed.denyRead,
    requireWorktree: requireWorktree === true,
  };
}

function parseProfile(
  entry: unknown,
  index: number,
  env: Env,
  where: string,
): WorkspaceProfile {
  const at = `workspaces[${index}]`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`config: ${at} must be a table in ${configLabel(where)}`);
  }
  const values = entry as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (!PROFILE_KEYS.has(key)) {
      throw new Error(
        `config: unknown key workspaces.${key} in ${configLabel(where)}`,
      );
    }
  }
  if (values["path"] === undefined) {
    throw new Error(
      `config: ${at}.path is required in ${configLabel(where)}`,
    );
  }
  const root = readProfilePath(values["path"], at, env, where);
  const trust = values["trust_instructions"];
  if (trust !== undefined && typeof trust !== "boolean") {
    throw new Error(
      `config: ${at}.trust_instructions must be a boolean in ${configLabel(where)}`,
    );
  }
  const gate = parseGateConfig(sectionTable(values, "gate"), where);
  const publish = parsePublishConfig(sectionTable(values, "publish"), where);
  const dispatch = parseDispatchConfig(sectionTable(values, "dispatch"), where, env);
  return Object.freeze({
    path: root,
    trustInstructions: trust === undefined ? null : trust,
    gate,
    publish,
    sandbox: parseProfileSandbox(values, where),
    dispatch,
  });
}

/**
 * Parse the `[[workspaces]]` array. An absent table returns a configuration
 * with no profiles, whose `match` always answers null: the flat sections then
 * apply exactly as they did before profiles existed.
 */
export function parseWorkspacesConfig(
  table: Record<string, unknown> | null,
  where: string,
  env: Env = processEnv,
): WorkspacesConfig {
  const list = table?.["workspaces"];
  if (list === undefined) return NO_PROFILES;
  if (!Array.isArray(list)) {
    throw new Error(
      `config: [[workspaces]] must be an array of tables in ${configLabel(where)}`,
    );
  }
  const profiles: WorkspaceProfile[] = [];
  const seen = new Map<string, number>();
  for (const [index, entry] of list.entries()) {
    const profile = parseProfile(entry, index, env, where);
    const first = seen.get(profile.path);
    if (first !== undefined) {
      // Which of two identical roots applied would depend on file order, and a
      // profile decides what runs and what is trusted.
      throw new Error(
        `config: duplicate workspaces path (workspaces[${first}] and ` +
          `workspaces[${index}] both resolve to the same directory) in ` +
          `${configLabel(where)}`,
      );
    }
    seen.set(profile.path, index);
    profiles.push(profile);
  }
  // Most specific first, so the first covering entry is the answer.
  const ordered = Object.freeze(
    [...profiles].sort((a, b) => b.path.length - a.path.length),
  );
  return Object.freeze({
    profiles: ordered,
    match(root: string): WorkspaceProfile | null {
      const canonicalRoot = canonical(root);
      for (const profile of ordered) {
        if (canonicalRoot === profile.path) return profile;
        // A profile's prefix ends at a path boundary. The filesystem root is
        // the one path that already ends at one, so its prefix is itself:
        // joining another slash would test `//` and never match a real root,
        // leaving a configured `path = "/"` silently ineffective. Sorting by
        // length keeps it last, so every deeper profile still wins.
        const prefix = profile.path === "/" ? "/" : `${profile.path}/`;
        if (canonicalRoot.startsWith(prefix)) return profile;
      }
      return null;
    },
  });
}

/**
 * Every program a profile's gate or publish commands name, deduplicated in
 * declaration order.
 *
 * The runtime's spawn policy is composed once at boot, before any turn names a
 * workspace, so it cannot vary by workspace. These names are admitted to the
 * run list there and tagged `workspace-config`; which of them a turn may
 * actually start is still decided by that turn's own gate or publish policy,
 * from the section that applies to its workspace. A program no profile names
 * gains nothing.
 */
export function workspaceProfilePrograms(
  workspaces: WorkspacesConfig,
): readonly string[] {
  const programs: string[] = [];
  const add = (argv: readonly string[] | undefined): void => {
    const program = argv?.[0];
    if (program === undefined || program === "" || programs.includes(program)) {
      return;
    }
    programs.push(program);
  };
  for (const profile of workspaces.profiles) {
    const gate = profile.gate;
    if (gate !== null) {
      for (const mode of Object.keys(gate.commands) as (keyof typeof gate.commands)[]) {
        add(gate.commands[mode]);
      }
    }
    const publish = profile.publish;
    if (publish !== null) {
      add(publish.preGate);
      add(publish.gate);
      add(publish.push);
      add(publish.openPr);
    }
  }
  return Object.freeze(programs);
}

/** Load `[[workspaces]]` from the config file the environment names. */
export async function loadWorkspacesConfig(
  deps: LoadConfigDeps = {},
): Promise<WorkspacesConfig> {
  const env = deps.env ?? processEnv;
  const path = configFilePath(env);
  const table = await readConfigFile(
    path,
    deps.readTextFile ?? defaultReadTextFile,
    deps.parseToml ?? defaultParseToml,
  );
  return parseWorkspacesConfig(table, path, env);
}
