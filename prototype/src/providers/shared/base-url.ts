/**
 * Base-URL predicates: loopback-only for local providers, https (optionally
 * host- and path-pinned) for hosted ones.
 */

const allowedLocalProviderHosts = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

export function isAllowedLocalProviderBaseUrl(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  return allowedLocalProviderHosts.has(parsed.hostname.toLowerCase());
}

/**
 * Whether a hosted base URL is https — and, when the caller pins an expected
 * host and optional path allowlist, exactly that host on the default port and
 * an exact allowed path. The pin is what keeps a credential from traveling
 * to a different (still-https) endpoint named by catalog data; `URL`
 * normalizes an explicit `:443` to an empty port, so the port check rejects
 * only genuinely non-default ports.
 */
export function isAllowedHostedProviderBaseUrl(
  baseUrl: string,
  expectedHost?: string,
  allowedPaths?: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return false;
  }
  if (
    expectedHost !== undefined &&
    (parsed.hostname !== expectedHost || parsed.port !== "")
  ) {
    return false;
  }
  if (allowedPaths !== undefined) {
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    if (!allowedPaths.some((p) => normalizedPath === p.replace(/\/+$/, ""))) {
      return false;
    }
  }
  return true;
}
