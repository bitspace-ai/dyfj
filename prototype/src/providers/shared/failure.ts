/**
 * The shared provider-failure classifier, and the two helpers every adapter
 * calls with it: one for a non-2xx response, one for a `fetch` that threw.
 *
 * Classification reads the HTTP status first and the body's documented
 * markers second; the body is matched, never relayed. Every error the
 * helpers produce is a `ProviderFailureError` whose message Workbench
 * wrote, so the operator sees the condition and a way out instead of the
 * opaque `[Error, N bytes]` label that a foreign error renders as. The
 * context-size verdict and its counts stay in `context-exceeded.ts`; this
 * module composes it with the other classes.
 */
import { DomainError } from "../../contract/mod.ts";
import {
  ProviderAuthenticationError,
  ProviderContextExceededError,
  type ProviderFailureError,
  ProviderModelNotFoundError,
  ProviderRateLimitedError,
  type ProviderRateLimitReason,
  ProviderRedirectedError,
  ProviderRequestFailedError,
  ProviderRequestTooLargeError,
  type ProviderTarget,
  ProviderUnreachableError,
  type ProviderUnreachableReason,
} from "../errors.ts";
import { isAbortFromSignal, ProviderRequestAbortedError } from "./abort.ts";
import {
  classifyContextExceeded,
  type ContextExceededReport,
} from "./context-exceeded.ts";

/** What a non-2xx response was recognised as. */
export type ProviderResponseVerdict =
  | { kind: "context_exceeded"; report: ContextExceededReport }
  | { kind: "authentication" }
  | { kind: "rate_limited"; cause: ProviderRateLimitReason }
  | { kind: "model_not_found" }
  | { kind: "request_too_large" };

/** The regex work is bounded regardless of the caller's reader. */
const MAX_MATCHED_BYTES = 4_096;

// Body markers, by API family. A marker is consulted only under the
// statuses noted beside it; a 5xx is never read as a client-side class.

// Anthropic `authentication_error` / `permission_error`; OpenAI's
// invalid-key code ("Incorrect ... key provided"); Gemini's HTTP 400 "... key
// not valid" with its key-invalid reason, and its UNAUTHENTICATED /
// PERMISSION_DENIED statuses; OpenRouter "No auth credentials found";
// llama-server "Invalid ... Key". The key-shaped phrases are matched with the
// separator free (space, underscore or hyphen), so one pattern covers the
// code, the reason and the prose form. Consulted on 400 and 422.
const AUTHENTICATION_MARKERS =
  /authentication_error|permission_error|invalid[ _-]?(?:x-)?api[ _-]?key|incorrect api[ _-]?key|api[ _-]?key[ _-]?(?:not[ _-]?valid|invalid)|unauthenticated|permission_denied|no auth credentials/i;

// OpenAI `insufficient_quota` ("You exceeded your current quota"); Gemini's
// RESOURCE_EXHAUSTED quota message says "quota" too. Consulted on 429.
const QUOTA_MARKERS = /insufficient_quota|quota|insufficient credits/i;

// Anthropic `overloaded_error` (HTTP 529); Gemini's HTTP 503 "The model is
// overloaded"; OpenAI's "The engine is currently overloaded". Consulted on
// 503.
const OVERLOADED_MARKERS = /overloaded/i;

// OpenAI `model_not_found` arrives as 404; OpenRouter answers an unknown id
// with HTTP 400 "is not a valid model ID" and a served-by-no-one id with 404
// "No endpoints found"; Anthropic's 404 `not_found_error` message is
// "model: <id>"; Gemini's is "models/<id> is not found"; llama-server's
// router answers "model '…' not found". Consulted on 400, 404 and 422: a 404
// alone proves only that the route was missing (a wrong base-URL path, or
// llama-server's "File Not Found"), so without one of these the response
// stays unclassified.
const MODEL_NOT_FOUND_MARKERS =
  /model_not_found|not a valid model id|no endpoints found|model '[^']{0,200}' not found|\bmodel: \S|models\/[^\s"]{1,200} is not found|the model .{0,200}?does not exist/i;

// Anthropic `request_too_large` arrives as 413; Gemini refuses an oversized
// payload with HTTP 400 "Request payload size exceeds the limit"; a proxy's
// "Request Entity Too Large" is 413. Consulted on 400 and 422.
const REQUEST_TOO_LARGE_MARKERS =
  /request_too_large|entity too large|payload (?:size )?(?:too large|exceeds)|request too large/i;

/**
 * The verdict for a non-2xx response, or null when the status and body say
 * nothing the classifier recognises. A context-size rejection wins over
 * every other reading of the same response, because the engine recovers
 * from it where the others end the turn.
 */
export function classifyProviderResponse(
  status: number,
  body: string,
): ProviderResponseVerdict | null {
  const exceeded = classifyContextExceeded(status, body);
  if (exceeded !== null) return { kind: "context_exceeded", report: exceeded };
  const text = body.slice(0, MAX_MATCHED_BYTES);
  if (status >= 500) {
    if (status === 529 || (status === 503 && OVERLOADED_MARKERS.test(text))) {
      return { kind: "rate_limited", cause: "overloaded" };
    }
    return null;
  }
  if (status === 401 || status === 403) return { kind: "authentication" };
  if (status === 429) {
    return {
      kind: "rate_limited",
      cause: QUOTA_MARKERS.test(text) ? "quota" : "rate_limit",
    };
  }
  if (status === 404) {
    return MODEL_NOT_FOUND_MARKERS.test(text)
      ? { kind: "model_not_found" }
      : null;
  }
  if (status === 413) return { kind: "request_too_large" };
  if (status === 400 || status === 422) {
    if (AUTHENTICATION_MARKERS.test(text)) return { kind: "authentication" };
    if (MODEL_NOT_FOUND_MARKERS.test(text)) return { kind: "model_not_found" };
    if (REQUEST_TOO_LARGE_MARKERS.test(text)) {
      return { kind: "request_too_large" };
    }
  }
  return null;
}

/**
 * The error to throw for a non-2xx response: the classified failure when
 * the verdict names one, else the unclassified failure carrying the
 * provider, the status and the body's size.
 */
export function providerResponseError(
  target: ProviderTarget,
  status: number,
  body: string,
): ProviderFailureError {
  const verdict = classifyProviderResponse(status, body);
  switch (verdict?.kind) {
    case "context_exceeded":
      return new ProviderContextExceededError(target, status, verdict.report);
    case "authentication":
      return new ProviderAuthenticationError(target, status);
    case "rate_limited":
      return new ProviderRateLimitedError(target, status, verdict.cause);
    case "model_not_found":
      return new ProviderModelNotFoundError(target, status);
    case "request_too_large":
      return new ProviderRequestTooLargeError(target, status);
    default:
      return new ProviderRequestFailedError(target, {
        status,
        bodyBytes: new TextEncoder().encode(body).byteLength,
      });
  }
}

/**
 * The transport-level reasons the classifier recognises; none is a
 * response. A redirect is the platform refusing to follow one under
 * `redirect: "error"`, which every adapter sets.
 */
export type FetchFailureReason =
  | Exclude<ProviderUnreachableReason, "timeout">
  | "redirect";

// What the runtime's `fetch` says when nothing answers. The messages are the
// runtime's (Deno's reqwest-backed client, or a Node-style code), not the
// provider's, and they are still matched rather than relayed.
const REFUSED_MARKERS =
  /connection refused|econnrefused|os error 61\b|os error 111\b/i;
const DNS_MARKERS =
  /dns error|failed to lookup address|enotfound|eai_again|nodename nor servname|name or service not known|no such host/i;
// The runtime's own diagnostic for a redirect it refused to follow (Deno:
// "Encountered redirect while redirect mode is set to 'error'"; undici:
// "unexpected redirect"). Anchored to the diagnostic, never the bare word:
// connection errors quote the request URL, which may contain it.
const REDIRECT_MARKERS =
  /encountered redirect|redirect mode is set to ['"]error['"]|unexpected redirect/i;
const NETWORK_MARKERS =
  /no route to host|network is unreachable|network unreachable|ehostunreach|enetunreach|connection reset|econnreset|broken pipe|epipe|connection closed before message completed|tcp connect error|os error 5[14]\b|os error 6[45]\b/i;

/** The messages of an error and its `cause` chain, bounded in depth. */
function causeChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    parts.push(current.message.slice(0, MAX_MATCHED_BYTES));
    current = current.cause;
  }
  return parts.join("\n");
}

/**
 * The transport-level cause of a `fetch` rejection, or null when the throw
 * is not one the classifier recognises as the provider being unreachable.
 */
export function classifyFetchFailure(
  error: unknown,
): FetchFailureReason | null {
  if (!(error instanceof Error)) return null;
  const text = causeChainText(error);
  if (REFUSED_MARKERS.test(text)) return "refused";
  if (DNS_MARKERS.test(text)) return "dns";
  if (NETWORK_MARKERS.test(text)) return "network";
  if (REDIRECT_MARKERS.test(text)) return "redirect";
  return null;
}

/**
 * Rethrow a `fetch` rejection as what it is: the caller's own abort stays
 * the abort (so the turn settles as cancelled, not failed), a bounded
 * DomainError passes through, a refused redirect becomes
 * `ProviderRedirectedError`, a recognised transport failure becomes
 * `ProviderUnreachableError`, and anything else becomes the unclassified
 * failure that names the provider and keeps the foreign message out.
 */
export function providerFetchFailure(
  target: ProviderTarget,
  error: unknown,
  signal: AbortSignal | undefined,
  now: () => number,
  requestStarted: number,
): never {
  if (isAbortFromSignal(error, signal)) {
    throw new ProviderRequestAbortedError(
      Math.max(0, Math.round(now() - requestStarted)),
      { cause: error },
    );
  }
  if (error instanceof DomainError) throw error;
  const reason = classifyFetchFailure(error);
  if (reason === "redirect") throw new ProviderRedirectedError(target);
  if (reason !== null) throw new ProviderUnreachableError(target, reason);
  throw new ProviderRequestFailedError(target, { cause: error });
}
