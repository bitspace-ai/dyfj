/**
 * Target checks for the web tools: a fetch target must be a public HTTPS URL
 * whose host is, or resolves only to, public addresses.
 */

import { CommandExecutionError } from "../definition.ts";
import { type DnsLookup, type DnsResolver, systemDnsResolver } from "./dns.ts";

/**
 * Check if a host string is an IP address literal within an enumerated private, loopback,
 * link-local, multicast, documentation, or reserved network range.
 * Returns false for standard domain names without IP octets/colons.
 */
export function isPrivateOrLoopbackIp(rawHost: string): boolean {
  let host = rawHost.trim().toLowerCase();

  // Strip IPv6 brackets if present
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }

  // Handle IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (host.startsWith("::ffff:") || host.startsWith("0:0:0:0:0:ffff:")) {
    const mappedPart = host.split("ffff:")[1] ?? "";
    if (mappedPart.includes(".")) {
      host = mappedPart;
    } else if (mappedPart.includes(":")) {
      const parts = mappedPart.split(":");
      if (parts.length === 2) {
        const hexA = parseInt(parts[0], 16);
        const hexB = parseInt(parts[1], 16);
        if (!isNaN(hexA) && !isNaN(hexB)) {
          const a = (hexA >> 8) & 0xff;
          const b = hexA & 0xff;
          const c = (hexB >> 8) & 0xff;
          const d = hexB & 0xff;
          host = `${a}.${b}.${c}.${d}`;
        }
      }
    }
  }

  // IPv4 checks
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return true; // invalid octet -> reject
    const [a, b, c] = octets;
    if (a === 0) return true; // 0.0.0.0/8 Current network
    if (a === 10) return true; // 10.0.0.0/8 Private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 Shared Address Space (CGNAT)
    if (a === 127) return true; // 127.0.0.0/8 Loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 Link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 Private
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF Protocol Assignments
    if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1 (documentation)
    if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 Relay Anycast
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 Private
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 Network Benchmark Tests
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2 (documentation)
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3 (documentation)
    if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 Multicast
    if (a >= 240) return true; // 240.0.0.0/4 Reserved / Broadcast
    return false;
  }

  // IPv6 checks only apply if the string contains a colon
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true; // Loopback & Unspecified
    if (
      host.startsWith("fe8") || host.startsWith("fe9") ||
      host.startsWith("fea") || host.startsWith("feb")
    ) {
      return true; // fe80::/10 link-local
    }
    if (host.startsWith("fc") || host.startsWith("fd")) {
      return true; // fc00::/7 unique local
    }
    if (host.startsWith("ff")) {
      return true; // ff00::/8 multicast
    }
    if (host.startsWith("2001:db8:") || host.startsWith("2001:0db8:")) {
      return true; // 2001:db8::/32 documentation
    }
    if (host.startsWith("2001:2:") || host.startsWith("2001:0002:")) {
      return true; // 2001:2::/48 benchmarking
    }
    if (host.startsWith("64:ff9b:")) {
      return true; // 64:ff9b::/96 IPv4/IPv6 translation
    }
    if (host.startsWith("100::") || host.startsWith("0100::")) {
      return true; // 100::/64 Discard-only prefix
    }
  }

  return false;
}

/**
 * Validate that a target URL is an HTTPS address and does not target
 * localhost, enumerated private IP literals, or embedded credentials.
 */
export function assertPublicHttpsUrl(
  rawUrl: string,
  allowLoopbackHttpForTesting = false,
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CommandExecutionError("Invalid URL format");
  }

  if (url.username || url.password) {
    throw new CommandExecutionError(
      "URLs containing user credentials are not permitted",
    );
  }

  const hostname = url.hostname.toLowerCase();

  // Test exception for local in-process mock server
  if (
    allowLoopbackHttpForTesting && url.protocol === "http:" &&
    (hostname === "127.0.0.1" || hostname === "localhost")
  ) {
    return url;
  }

  if (url.protocol !== "https:") {
    throw new CommandExecutionError("Only HTTPS URLs are permitted");
  }

  if (
    hostname === "localhost" || hostname === "localhost." ||
    hostname.endsWith(".localhost") || hostname.endsWith(".localhost.") ||
    hostname === "0.0.0.0"
  ) {
    throw new CommandExecutionError(
      "Requests to localhost or local addresses are forbidden",
    );
  }

  const bareHost = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  if (isPrivateOrLoopbackIp(bareHost)) {
    throw new CommandExecutionError(
      "Requests to private, loopback, or internal addresses are forbidden",
    );
  }

  return url;
}

/** Whether `host` is an IPv4 or IPv6 literal (brackets allowed) rather than a name. */
function isIpLiteral(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare) || bare.includes(":");
}

/**
 * Preflight address check with a bounded wait. A target passes only when it
 * is verified public: an IP literal outside the private, loopback and internal
 * ranges, or a hostname whose A and AAAA lookups both answer (either may have
 * no records), together return at least one address, and return no private,
 * loopback or internal address. A lookup
 * that fails, a resolver that is unavailable, a name with no addresses and a
 * lookup that outlives `signal` all reject the target.
 */
export async function assertPublicDnsResolution(
  hostname: string,
  allowLoopbackHttpForTesting = false,
  signal?: AbortSignal,
  resolver: DnsResolver = systemDnsResolver,
): Promise<void> {
  if (
    allowLoopbackHttpForTesting &&
    (hostname === "127.0.0.1" || hostname === "localhost")
  ) {
    return;
  }
  if (isPrivateOrLoopbackIp(hostname)) {
    throw new CommandExecutionError(
      `Target host '${hostname}' is an enumerated private or internal IP address`,
    );
  }
  if (isIpLiteral(hostname)) return;
  if (signal?.aborted) {
    throw new CommandExecutionError("DNS lookup timed out");
  }

  // Listen for the deadline before starting the lookups, so a timeout
  // settles the race ahead of any lookup the signal cancels.
  const abortPromise = new Promise<never>((_, reject) => {
    signal?.addEventListener("abort", () => {
      reject(new CommandExecutionError("DNS lookup timed out"));
    }, { once: true });
  });
  let results: DnsLookup[];
  try {
    results = await Promise.race([
      Promise.all([
        resolver.resolve(hostname, "A", signal),
        resolver.resolve(hostname, "AAAA", signal),
      ]),
      abortPromise,
    ]);
  } catch (err) {
    if (err instanceof CommandExecutionError) throw err;
    throw new CommandExecutionError(
      `Target host '${hostname}' could not be verified: DNS lookup failed`,
    );
  }

  const addresses: string[] = [];
  for (const lookup of results) {
    if (!lookup.ok) {
      throw new CommandExecutionError(
        `Target host '${hostname}' could not be verified: DNS lookup ${
          lookup.reason === "unavailable" ? "unavailable" : "failed"
        }`,
      );
    }
    addresses.push(...lookup.addresses);
  }
  if (addresses.length === 0) {
    throw new CommandExecutionError(
      `Target host '${hostname}' does not resolve to any address`,
    );
  }
  for (const ip of addresses) {
    if (isPrivateOrLoopbackIp(ip)) {
      throw new CommandExecutionError(
        `Target host '${hostname}' resolves to private or internal IP address ${ip}`,
      );
    }
  }
}
