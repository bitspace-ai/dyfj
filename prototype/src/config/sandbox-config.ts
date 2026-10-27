/**
 * The `[sandbox]` table: what the operator adds to the tool sandbox's policy
 * (BIT-662).
 *
 *   [sandbox]
 *   allow_domains = ["static.crates.io", "index.crates.io"]
 *   deny_read = [".example-tool/token", "/srv/example/secret.json"]
 *
 * `allow_domains` adds to the network allowlist, for example a second package
 * registry. Each entry is a hostname, optionally with one leading `*.`
 * wildcard label: no scheme, port, path or whitespace, and never a bare `*`.
 * Hosts are lowercased and lose a trailing dot. The sandbox adds these to
 * `registry.npmjs.org`, and always denies the GitHub domains, which this list
 * cannot reopen (`tools/builtin/srt-policy.ts`).
 *
 * `deny_read` adds paths a sandboxed command may not read, for credential
 * files of the operator's own tools. Each entry is a path relative to the
 * home directory (a leading `~/` is accepted) or an absolute path, with no
 * `..` segment and no control character. It adds to the built-in list
 * (`CREDENTIAL_READ_DENY`); it cannot remove an entry from it.
 *
 * An invalid entry fails the config load; none is ever dropped.
 */

import { processEnv } from "./env.ts";
import { readTextFile as defaultReadTextFile } from "./read-text-file.ts";
import {
  configFilePath,
  configLabel,
  defaultParseToml,
  type LoadConfigDeps,
  readConfigFile,
} from "./toml.ts";

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The normalized domain, or null when `entry` is not one. */
function normalizeDomain(entry: string): string | null {
  let host = entry.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  const wildcard = host.startsWith("*.");
  const name = wildcard ? host.slice(2) : host;
  if (name === "" || name.length > 253) return null;
  const labels = name.split(".");
  // A wildcard must stand over at least a registrable-looking name.
  if (wildcard && labels.length < 2) return null;
  if (!labels.every((label) => HOST_LABEL.test(label))) return null;
  return wildcard ? `*.${name}` : name;
}

/** The normalized deny path, or null when `entry` is not one. */
function normalizeDenyPath(entry: string): string | null {
  let path = entry.startsWith("~/") ? entry.slice(2) : entry;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "" || path === "/" || path === "~") return null;
  // No control character (a newline would split a sandbox profile rule) and
  // no `..`, so an entry names one path and cannot climb out of home.
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  if (path.split("/").some((segment) => segment === "..")) return null;
  return path;
}

/** The operator's additions to the sandbox policy. */
export interface SandboxConfig {
  allowDomains: string[];
  denyRead: string[];
}

const SANDBOX_KEYS: ReadonlySet<string> = new Set(["allow_domains", "deny_read"]);

function parseList(
  list: unknown,
  key: string,
  where: string,
  normalize: (entry: string) => string | null,
  shape: string,
): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    throw new Error(
      `config: [sandbox] ${key} must be an array of strings in ${where}`,
    );
  }
  const entries: string[] = [];
  for (const [index, entry] of list.entries()) {
    const normalized = typeof entry === "string" ? normalize(entry) : null;
    if (normalized === null) {
      throw new Error(
        `config: [sandbox] ${key} entry ${index + 1} in ${where} must ${shape}`,
      );
    }
    if (!entries.includes(normalized)) entries.push(normalized);
  }
  return entries;
}

/** `[sandbox]` from a parsed config file, validated and normalized. */
export function parseSandboxConfig(
  table: Record<string, unknown> | null,
  path: string,
): SandboxConfig {
  const none: SandboxConfig = { allowDomains: [], denyRead: [] };
  if (table === null) return none;
  const where = configLabel(path);
  const section = table["sandbox"];
  if (section === undefined) return none;
  if (
    typeof section !== "object" || section === null || Array.isArray(section)
  ) {
    throw new Error(`config: [sandbox] must be a table in ${where}`);
  }
  for (const key of Object.keys(section)) {
    if (!SANDBOX_KEYS.has(key)) {
      throw new Error(`config: unknown key in [sandbox] in ${where}`);
    }
  }
  const values = section as Record<string, unknown>;
  return {
    allowDomains: parseList(
      values["allow_domains"],
      "allow_domains",
      where,
      normalizeDomain,
      `be a hostname, optionally with one leading "*." (no scheme, port, ` +
        `path, bare wildcard or whitespace)`,
    ),
    denyRead: parseList(
      values["deny_read"],
      "deny_read",
      where,
      normalizeDenyPath,
      `be a path relative to the home directory or an absolute path, with ` +
        `no ".." segment`,
    ),
  };
}

/** Load `[sandbox]` from the config file the environment names. */
export async function loadSandboxConfig(
  deps: LoadConfigDeps = {},
): Promise<SandboxConfig> {
  const env = deps.env ?? processEnv;
  const path = configFilePath(env);
  const table = await readConfigFile(
    path,
    deps.readTextFile ?? defaultReadTextFile,
    deps.parseToml ?? defaultParseToml,
  );
  return parseSandboxConfig(table, path);
}
