/**
 * Egress enforcement at the product's own seams: every HTTP request the
 * runtime makes goes through `guardedFetch`, and the Dolt pool checks its
 * endpoint with `assertConnectAllowed`, against the `RuntimePolicy`
 * (`runtime-policy.ts`).
 *
 * A request is allowed only when its `host:port` is an entry of the policy's
 * `net` list, compared exactly as the runtime's permission flag compares
 * them. A URL the
 * guard cannot reduce to an `http:` or `https:` `host:port` is refused.
 * Redirects are followed here, not by the delegate, so each hop is checked
 * before it is requested. Refusals name only the `host:port`, never the path,
 * query or credentials of the URL.
 */

import type { RuntimePolicy } from "./runtime-policy.ts";

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const NET_POLICY_HINT =
  'To allow it, add it to [network] allow in ~/.dyfj/config.toml (for ' +
  'example allow = ["127.0.0.1:1234"]); an MCP server is allowed by its ' +
  "[[mcp.servers]] entry.";

/** A connection or request the runtime's network policy does not allow. */
export class EgressRefusedError extends Error {
  /** The refused `host:port`, or null when the target could not be read. */
  readonly target: string | null;

  constructor(target: string | null, message: string) {
    super(message);
    this.name = "EgressRefusedError";
    this.target = target;
  }
}

/**
 * The policy refusal on `error` or anywhere on its cause chain, so a seam
 * whose library wraps transport errors can still report the refusal.
 */
export function findEgressRefusal(
  error: unknown,
): EgressRefusedError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof EgressRefusedError) return current;
    current = current.cause;
  }
  return undefined;
}

/** A fetch-shaped transport. */
export type FetchTransport = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * The `host:port` a request to `url` connects to, with the protocol's default
 * port, or null when it is not a well-formed `http:` or `https:` URL.
 */
export function egressTarget(url: string | URL): string | null {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.hostname === "") return null;
  const port = parsed.port !== ""
    ? parsed.port
    : parsed.protocol === "http:"
    ? "80"
    : "443";
  return `${parsed.hostname}:${port}`;
}

/** Throw `EgressRefusedError` unless `url`'s `host:port` is in the policy. */
export function assertEgressAllowed(
  policy: RuntimePolicy,
  url: string | URL,
): void {
  const target = egressTarget(url);
  if (target === null) {
    throw new EgressRefusedError(
      null,
      "network egress refused: the request URL cannot be checked against " +
        "the runtime's network policy (only http and https URLs with a host " +
        "are allowed).",
    );
  }
  if (!policy.net.includes(target)) {
    throw new EgressRefusedError(
      target,
      `network egress to "${target}" refused: the host is not in the ` +
        `runtime's network policy. ${NET_POLICY_HINT}`,
    );
  }
}

/** Throw `EgressRefusedError` unless `host:port` is the configured Dolt endpoint. */
export function assertConnectAllowed(
  policy: RuntimePolicy,
  host: string,
  port: number,
): void {
  const target = `${host}:${port}`;
  if (policy.dolt === null || policy.dolt !== target) {
    throw new EgressRefusedError(
      target,
      `database connection to "${target}" refused: it is not the configured ` +
        "Dolt endpoint. Configure the endpoint with DOLT_HOST and DOLT_PORT.",
    );
  }
}

function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

function isReplayable(body: RequestInit["body"]): boolean {
  return body === undefined || body === null ||
    !(body instanceof ReadableStream);
}

/**
 * Wrap `delegate` so that every request and every redirect hop is checked
 * against `policy` before it is sent. The caller's `redirect` mode is kept:
 * `"error"` rejects on a redirect and `"manual"` returns it unfollowed, as
 * fetch does; `"follow"` (the default) follows up to twenty hops, applying
 * fetch's rules (303, and 301 or 302 after a POST, become a bodiless GET; a
 * cross-origin hop drops `Authorization`). A redirect that would have to
 * resend a stream body is refused, because the body cannot be replayed.
 */
export function guardedFetch(
  policy: RuntimePolicy,
  delegate: FetchTransport = fetch,
): FetchTransport {
  return async (input, init) => {
    assertEgressAllowed(policy, urlOf(input));
    const mode = init?.redirect ??
      (input instanceof Request ? input.redirect : "follow");
    let response = await delegate(input, { ...init, redirect: "manual" });
    if (mode === "manual" || !REDIRECT_STATUSES.has(response.status)) {
      return response;
    }
    let current = new URL(urlOf(input));
    let hopInit: RequestInit = { ...init };
    let method = (init?.method ??
      (input instanceof Request ? input.method : "GET")).toUpperCase();
    for (let hops = 0;; hops++) {
      const location = response.headers.get("location");
      if (location === null) return response;
      await response.body?.cancel().catch(() => {});
      if (mode === "error") {
        throw new TypeError("fetch failed: redirect mode is error");
      }
      if (hops >= MAX_REDIRECTS) {
        throw new TypeError("fetch failed: too many redirects");
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new TypeError("fetch failed: invalid redirect location");
      }
      assertEgressAllowed(policy, next);
      const headers = new Headers(
        hopInit.headers ??
          (input instanceof Request ? input.headers : undefined),
      );
      if (next.origin !== current.origin) headers.delete("authorization");
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method === "POST")
      ) {
        if (method !== "HEAD") method = "GET";
        headers.delete("content-type");
        headers.delete("content-length");
        hopInit = { ...hopInit, method, body: undefined, headers };
      } else {
        if (
          !isReplayable(hopInit.body) ||
          (hopInit.body === undefined && input instanceof Request &&
            input.body !== null)
        ) {
          throw new TypeError(
            "fetch failed: a redirect would resend a stream body",
          );
        }
        hopInit = { ...hopInit, method, headers };
      }
      current = next;
      response = await delegate(next.toString(), {
        ...hopInit,
        redirect: "manual",
      });
      if (!REDIRECT_STATUSES.has(response.status)) return response;
    }
  };
}
