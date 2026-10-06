/**
 * The `HttpTransport` port and the header deadline every provider request
 * carries.
 *
 * `HttpTransport` is the platform `fetch` shape narrowed to what adapters use:
 * a URL string and a `RequestInit`. The real adapter is `fetch`; tests use the
 * scripted transport in `testing/fakes/scripted-http-transport.ts`. Both pass
 * the conformance suite in `testing/conformance/http-transport.ts`.
 */

import { type ProviderTarget, ProviderUnreachableError } from "./errors.ts";

/** Sends one HTTP request and resolves when the response headers arrive. */
export type HttpTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/**
 * Provider requests previously carried no timeout at all, so a blackholed
 * connection (VPN/mesh route flaps, IPv6 with no route) hung the whole turn
 * silently and indefinitely — the operator sees nothing after tool approval.
 * Bound the time to response HEADERS only: once headers arrive the abort timer
 * is cleared, so long streaming bodies are unaffected. A header timeout fails
 * as `ProviderUnreachableError`, naming the target and the budget that
 * elapsed, instead of becoming an infinite hang.
 *
 * This budget suits a STREAMING request, whose endpoints send headers before
 * the body, so 30s without headers is worth failing on whatever the cause —
 * the timer detects missing headers, it does not diagnose why. Endpoints on
 * the buffered path withhold headers until the body exists, so this budget
 * would cap generation there; see PROVIDER_BUFFERED_HEADER_TIMEOUT_MS.
 */
export const PROVIDER_HEADER_TIMEOUT_MS = 30_000;

/**
 * Header budget for a BUFFERED request. Like the streaming budget this bounds
 * the wait for response HEADERS, not the body: the timer is cleared once fetch
 * resolves, and fetch resolves on headers. Body consumption after that is
 * unbounded in both modes, as it was before this split.
 *
 * It is larger because the endpoints this path talks to defer headers until
 * the response body exists, so the wait covers generation in practice. That is
 * an observed property of those endpoints, not something this code enforces.
 * Under the streaming budget an agent-loop turn could not emit an edit taking
 * more than 30s to generate: the Anthropic and Google readers cannot stream
 * tool-offering calls, so every such call was buffered and the turn died
 * mid-write reporting a connection-shaped error.
 *
 * The cost of the split: a buffered request to a blackholed route now waits
 * this long instead of 30s, because before the first byte a connection that is
 * silent while generating and one that is silent because it is dead look the
 * same. Streaming requests keep the tight budget and the fast detection.
 * Streaming the tool-offering calls would remove the tradeoff rather than
 * price it.
 */
export const PROVIDER_BUFFERED_HEADER_TIMEOUT_MS = 300_000;

/**
 * The header deadline a provider request should carry, given whether it
 * streams. Returned as the trailing argument pair so each adapter states the
 * rule once rather than repeating the constant and the mode.
 */
export function providerFetchDeadline(
  stream: boolean,
): [number, "streaming" | "buffered"] {
  return stream
    ? [PROVIDER_HEADER_TIMEOUT_MS, "streaming"]
    : [PROVIDER_BUFFERED_HEADER_TIMEOUT_MS, "buffered"];
}

export async function fetchWithHeaderTimeout(
  fetchFn: HttpTransport,
  url: string,
  init: RequestInit,
  target: ProviderTarget,
  timeoutMs: number = PROVIDER_HEADER_TIMEOUT_MS,
  mode: "streaming" | "buffered" = "streaming",
): Promise<Response> {
  const timeoutController = new AbortController();
  const externalSignal = init.signal;
  let timedOut = false;
  const signal = externalSignal === undefined || externalSignal === null
    ? timeoutController.signal
    : AbortSignal.any([externalSignal, timeoutController.signal]);
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal });
  } catch (err) {
    if (
      externalSignal?.aborted === true &&
      signal.reason === externalSignal.reason
    ) {
      throw err;
    }
    if (timedOut) {
      // Name the mode and the budget that elapsed. The timer cannot see a
      // cause: a queued streaming request and a dead route both present as
      // silence, so the message offers causes as possibilities rather than
      // findings. The budgets differ by an order of magnitude, so which one
      // ran out is itself the useful signal.
      throw new ProviderUnreachableError(target, "timeout", {
        timeoutMs,
        mode,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
