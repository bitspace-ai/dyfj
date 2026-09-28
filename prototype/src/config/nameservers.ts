/**
 * Launch-resolved `--allow-net` grants for the system's DNS nameservers.
 *
 * `Deno.resolveDns` checks net permission against every nameserver it will
 * query, not against the name being looked up, so the engine can resolve a
 * hostname only when each configured nameserver is granted as `<ip>:53`. The
 * web tools' address check refuses a target it cannot resolve, so `dyfj start`
 * (and `deno task serve-unix`, through `scripts/serve-unix-net-flag.ts`) reads
 * the nameservers from the resolver configuration at launch and appends these
 * grants to the engine's explicit `--allow-net`. They are machine-specific and
 * never belong in the committed permission profile.
 *
 * A `nameserver` entry that is not a plain IP literal (for example a scoped
 * IPv6 address such as `fe80::1%eth0`, which a Deno grant cannot express) gets
 * no grant. Lookups through that resolver then fail, and the address check
 * refuses the target.
 */

export const RESOLV_CONF_PATH = "/etc/resolv.conf";

const IPV4 =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** The canonical form of an IPv6 literal, or undefined when it is not one. */
function canonicalIpv6(address: string): string | undefined {
  if (!address.includes(":") || /[\[\]\/?#@%]/.test(address)) return undefined;
  try {
    return new URL(`http://[${address}]/`).hostname;
  } catch {
    return undefined;
  }
}

/** Derive `<ip>:53` grants from resolv.conf text, in file order, deduplicated. */
export function nameserverNetGrants(resolvConf: string): string[] {
  const grants: string[] = [];
  for (const rawLine of resolvConf.split("\n")) {
    const line = rawLine.replace(/[#;].*$/, "").trim();
    const [keyword, address, ...rest] = line.split(/\s+/);
    if (keyword !== "nameserver" || address === undefined || rest.length > 0) {
      continue;
    }
    const ipv6 = canonicalIpv6(address);
    let grant: string;
    if (IPV4.test(address)) {
      grant = `${address}:53`;
    } else if (ipv6 !== undefined) {
      grant = `${ipv6}:53`;
    } else {
      continue;
    }
    if (!grants.includes(grant)) grants.push(grant);
  }
  return grants;
}

/**
 * Read the nameserver grants from the resolver configuration. A missing or
 * unreadable file yields no grants: the engine still starts, and the address
 * check refuses the hostname targets it then cannot resolve.
 */
export async function readNameserverNetGrants(
  readTextFile: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<string[]> {
  try {
    return nameserverNetGrants(await readTextFile(RESOLV_CONF_PATH));
  } catch {
    return [];
  }
}
