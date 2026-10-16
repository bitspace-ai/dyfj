/**
 * The `[network]` table: hosts the operator adds to the runtime's network
 * policy (`runtime-policy.ts`), for example a local model server on a port
 * the static list does not name.
 *
 *   [network]
 *   allow = ["127.0.0.1:1234"]
 *
 * Each entry is exactly `host:port`: a required port, a bracketed IPv6
 * literal, and no scheme, path, credentials, wildcard, comma or whitespace.
 * Hosts are lowercased and lose a trailing dot. An invalid entry fails the
 * config load; none is ever dropped. config.toml is the operator's trust
 * boundary, so this is the only place an operator adds a host; runtime data
 * such as the model catalog never does.
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
const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/;

/** The normalized `host:port`, or null when `entry` is not one. */
function normalizeEntry(entry: string): string | null {
  const match = entry.match(/^(\[[^\]]*\]|[^:\[\]]+):([0-9]{1,5})$/);
  if (match === null) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535 || String(port) !== match[2]) return null;
  let host = match[1].toLowerCase();
  if (IPV6_LITERAL.test(host)) {
    let canonical: string;
    try {
      canonical = new URL(`http://${host}/`).hostname;
    } catch {
      return null;
    }
    return `${canonical}:${port}`;
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "" || host.length > 253) return null;
  if (!host.split(".").every((label) => HOST_LABEL.test(label))) return null;
  return `${host}:${port}`;
}

/** `[network] allow` from a parsed config file, validated and normalized. */
export function parseNetworkAllow(
  table: Record<string, unknown> | null,
  path: string,
): string[] {
  if (table === null) return [];
  const where = configLabel(path);
  const section = table["network"];
  if (section === undefined) return [];
  if (
    typeof section !== "object" || section === null || Array.isArray(section)
  ) {
    throw new Error(`config: [network] must be a table in ${where}`);
  }
  for (const key of Object.keys(section)) {
    if (key !== "allow") {
      throw new Error(`config: unknown key in [network] in ${where}`);
    }
  }
  const allow = (section as Record<string, unknown>)["allow"];
  if (allow === undefined) return [];
  if (!Array.isArray(allow)) {
    throw new Error(
      `config: [network] allow must be an array of "host:port" strings in ${where}`,
    );
  }
  const entries: string[] = [];
  for (const [index, entry] of allow.entries()) {
    const normalized = typeof entry === "string"
      ? normalizeEntry(entry)
      : null;
    if (normalized === null) {
      throw new Error(
        `config: [network] allow entry ${index + 1} in ${where} must be ` +
          `exactly "host:port" (a required port, bracketed IPv6, no scheme, ` +
          `path, wildcard, comma or whitespace)`,
      );
    }
    if (!entries.includes(normalized)) entries.push(normalized);
  }
  return entries;
}

/** Load `[network] allow` from the config file the environment names. */
export async function loadNetworkAllow(
  deps: LoadConfigDeps = {},
): Promise<string[]> {
  const env = deps.env ?? processEnv;
  const path = configFilePath(env);
  const table = await readConfigFile(
    path,
    deps.readTextFile ?? defaultReadTextFile,
    deps.parseToml ?? defaultParseToml,
  );
  return parseNetworkAllow(table, path);
}
