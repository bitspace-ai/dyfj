/**
 * The memory-recall endpoint rule, shared by the runtime's recall config
 * (`memory-search.ts`) and the launcher's net grants (`cli/launcher/`): the
 * recall token and private queries never travel in cleartext.
 */

/** Loopback hosts, the only place plain-http recall is tolerable. */
function isLoopbackHostname(hostname: string): boolean {
  if (
    hostname === "localhost" || hostname === "::1" || hostname === "[::1]"
  ) {
    return true;
  }
  // 127.0.0.0/8 as a strict dotted-quad parse: a DNS name that merely STARTS
  // with "127." (127.attacker.example) must never classify as loopback — it
  // would license cleartext transport to an attacker-controlled host.
  const quad = hostname.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return quad !== null && quad.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Reject any recall endpoint that would carry the token and the private
 * queries in cleartext: https everywhere, plain http only to loopback. Throws
 * so misconfiguration fails closed and loudly — the alternative is silently
 * shipping a credential over the network.
 */
export function assertSecureMemoryUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DYFJ_MEMORY_MCP_URL is not a valid URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("DYFJ_MEMORY_MCP_URL must not include credentials");
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
    return;
  }
  throw new Error(
    "DYFJ_MEMORY_MCP_URL must be https (plain http is allowed only for loopback hosts)",
  );
}
