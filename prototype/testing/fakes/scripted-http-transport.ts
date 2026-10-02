// Test fake for the `HttpTransport` port (`src/providers/http.ts`): a scripted
// sequence of exchanges, each with optional request assertions and a recorded
// response.
//
// It follows the real `fetch` wherever an adapter can observe the difference,
// and the conformance suite in `testing/conformance/http-transport.ts` holds
// it to that against real `fetch` and a loopback server:
// - an already-aborted signal rejects with the signal's reason, and no request
//   is sent;
// - an abort while headers are withheld, or while a held-open body is being
//   read, rejects with the signal's reason (the same object, not a copy);
// - `redirect: "error"` turns a redirect status into a `TypeError`;
// - a scripted response without a body has a `null` body only for the
//   null-body statuses (204, 205, 304), and an empty one otherwise.
//
// A call beyond the script throws, so "the transport was never called" is the
// empty script. `respond` may also be a function returning a `Response`, for a
// body shape the scripted vocabulary does not cover (a stream that errors with
// a particular value, or whose cancel never settles); such a body is test data
// and is outside what the conformance suite proves.
//
// `fetchLike` is the same fake behind the platform `fetch` signature, for code
// that takes `typeof fetch` rather than the port (a URL or `Request` input is
// read into the port's `(url, init)` shape first).

import type { HttpTransport } from "../../src/providers/mod.ts";

/** A request as the transport received it. */
export interface RecordedRequest {
  url: string;
  method: string;
  /** Header names lowercased. */
  headers: Record<string, string>;
  /** The request body as text; "" when there was none. */
  body: string;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
}

export interface ScriptedResponse {
  /** Default 200. */
  status?: number;
  headers?: Record<string, string>;
  /** Body chunks delivered in order; a string is a single chunk. */
  body?: string | readonly (string | Uint8Array)[];
  /**
   * After the chunks, keep the body open until the request's signal aborts,
   * then fail the next read with the abort reason.
   */
  holdOpen?: boolean;
  /** Never deliver headers: the call settles only by the signal aborting. */
  withholdHeaders?: boolean;
}

export interface ScriptedExchange {
  /** Assertions over the request; a throw fails the call. */
  expect?: (request: RecordedRequest) => void;
  respond:
    | ScriptedResponse
    | ((request: RecordedRequest) => Response | Promise<Response>);
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The body of a scripted response, as the platform would present it. */
export function scriptedBody(
  response: ScriptedResponse,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> | null {
  const status = response.status ?? 200;
  const chunks = response.body === undefined
    ? []
    : typeof response.body === "string"
    ? [response.body]
    : response.body;
  if (
    chunks.length === 0 && !response.holdOpen &&
    NULL_BODY_STATUSES.has(status)
  ) {
    return null;
  }
  const encoder = new TextEncoder();
  let onAbort: (() => void) | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      }
      if (!response.holdOpen) {
        controller.close();
        return;
      }
      if (signal?.aborted) {
        controller.error(signal.reason);
        return;
      }
      onAbort = () => controller.error(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
    },
    cancel() {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    },
  });
}

export class ScriptedHttpTransport {
  readonly #script: ScriptedExchange[];
  readonly requests: RecordedRequest[] = [];

  constructor(script: readonly ScriptedExchange[] = []) {
    this.#script = [...script];
  }

  /** How many scripted exchanges have not been used yet. */
  get remaining(): number {
    return this.#script.length;
  }

  /** Throws unless every scripted exchange was used. */
  assertDone(): void {
    if (this.#script.length > 0) {
      throw new Error(
        `ScriptedHttpTransport: ${this.#script.length} scripted exchange(s) unused`,
      );
    }
  }

  readonly fetch: HttpTransport = async (url, init) => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    const exchange = this.#script.shift();
    if (exchange === undefined) {
      throw new Error(
        `ScriptedHttpTransport: unexpected request ${
          init.method ?? "GET"
        } ${url}`,
      );
    }
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body !== "string") {
        throw new Error(
          "ScriptedHttpTransport: only string bodies are scripted",
        );
      }
    }
    const request: RecordedRequest = {
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : "",
      ...(init.redirect === undefined ? {} : { redirect: init.redirect }),
      ...(signal === undefined ? {} : { signal }),
    };
    this.requests.push(request);
    exchange.expect?.(request);

    const respond = exchange.respond;
    if (typeof respond === "function") return await respond(request);

    if (respond.withholdHeaders) {
      return await new Promise<Response>((_, reject) => {
        if (signal === undefined) return;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    }
    const status = respond.status ?? 200;
    if (init.redirect === "error" && REDIRECT_STATUSES.has(status)) {
      throw new TypeError(
        "Fetch failed: Encountered redirect while redirect mode is set to 'error'",
      );
    }
    return new Response(scriptedBody(respond, signal), {
      status,
      headers: respond.headers,
    });
  };

  readonly fetchLike: typeof fetch = async (input, init) => {
    if (!(input instanceof Request)) {
      return await this.fetch(String(input), init ?? {});
    }
    const merged = new Request(input, init);
    const body = merged.body === null ? undefined : await merged.text();
    return await this.fetch(merged.url, {
      method: merged.method,
      headers: merged.headers,
      redirect: merged.redirect,
      signal: merged.signal,
      ...(body === undefined ? {} : { body }),
    });
  };
}
