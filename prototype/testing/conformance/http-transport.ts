// Conformance suite for the `HttpTransport` port (`src/providers/http.ts`).
//
// The scripted fake (`testing/fakes/scripted-http-transport.ts`) runs it in
// the unit lane; the real adapter, the platform `fetch`, runs it in the
// integration lane against a loopback server that answers from the same
// script vocabulary. Both must agree on everything the provider adapters
// observe: what the request carried, the status, headers and body chunks of
// the response, and how an abort, a redirect and a missing body surface.

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import type { HttpTransport } from "../../src/providers/mod.ts";
import type {
  RecordedRequest,
  ScriptedResponse,
} from "../fakes/scripted-http-transport.ts";

export interface HttpTransportUnderTest {
  transport: HttpTransport;
  /** Where requests go; the path after it is the subject's to route. */
  baseUrl: string;
  /** The requests that reached the far side, in order. */
  requests(): readonly RecordedRequest[];
  close(): Promise<void>;
}

export interface HttpTransportConformanceSubject {
  name: string;
  /** A transport whose far side answers requests from `script`, in order. */
  make(script: readonly ScriptedResponse[]): Promise<HttpTransportUnderTest>;
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(body).text();
}

export function httpTransportConformance(
  subject: HttpTransportConformanceSubject,
): void {
  const run = (
    label: string,
    script: readonly ScriptedResponse[],
    body: (under: HttpTransportUnderTest) => Promise<void>,
  ) => {
    Deno.test(`HttpTransport conformance (${subject.name}): ${label}`, async () => {
      const under = await subject.make(script);
      try {
        await body(under);
      } finally {
        await under.close();
      }
    });
  };

  run(
    "delivers the method, path, headers and body, and returns the response",
    [{ status: 200, headers: { "x-reply": "yes" }, body: "hello" }],
    async ({ transport, baseUrl, requests }) => {
      const response = await transport(`${baseUrl}/v1/chat/completions?x=1`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "k" },
        body: '{"a":1}',
        redirect: "error",
      });
      assertEquals(response.status, 200);
      assertEquals(response.headers.get("x-reply"), "yes");
      assertEquals(await response.text(), "hello");
      const [request] = requests();
      assertEquals(request.method, "POST");
      const url = new URL(request.url);
      assertEquals(url.pathname + url.search, "/v1/chat/completions?x=1");
      assertEquals(request.headers["content-type"], "application/json");
      assertEquals(request.headers["x-api-key"], "k");
      assertEquals(request.body, '{"a":1}');
    },
  );

  run(
    "resolves a non-2xx status with its body instead of rejecting",
    [{ status: 503, body: "overloaded" }],
    async ({ transport, baseUrl }) => {
      const response = await transport(`${baseUrl}/x`, { method: "POST" });
      assertEquals(response.status, 503);
      assertEquals(response.ok, false);
      assertEquals(await response.text(), "overloaded");
    },
  );

  run(
    "delivers body chunks in order",
    [{ body: ["data: one\n", "data: two\n", "data: [DONE]\n"] }],
    async ({ transport, baseUrl }) => {
      const response = await transport(`${baseUrl}/s`, { method: "POST" });
      assertEquals(
        await readAll(response.body!),
        "data: one\ndata: two\ndata: [DONE]\n",
      );
    },
  );

  run(
    "an error status without a body reads as empty, not null",
    [{ status: 500 }],
    async ({ transport, baseUrl }) => {
      const response = await transport(`${baseUrl}/e`, { method: "POST" });
      assert(response.body !== null);
      assertEquals(await response.text(), "");
    },
  );

  run(
    "a null-body status has a null body",
    [{ status: 204 }],
    async ({ transport, baseUrl }) => {
      const response = await transport(`${baseUrl}/n`, { method: "POST" });
      assertStrictEquals(response.body, null);
    },
  );

  run(
    "an already-aborted signal rejects with its reason and sends nothing",
    [],
    async ({ transport, baseUrl, requests }) => {
      const controller = new AbortController();
      const reason = new Error("cancelled before dispatch");
      controller.abort(reason);
      const error = await transport(`${baseUrl}/a`, {
        method: "POST",
        signal: controller.signal,
      }).then(() => undefined, (e) => e);
      assertStrictEquals(error, reason);
      assertEquals(requests().length, 0);
    },
  );

  run(
    "an abort while headers are withheld rejects with the signal's reason",
    [{ withholdHeaders: true }],
    async ({ transport, baseUrl }) => {
      const controller = new AbortController();
      const reason = new Error("cancelled while waiting");
      const pending = transport(`${baseUrl}/w`, {
        method: "POST",
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(reason), 20);
      const error = await pending.then(() => undefined, (e) => e);
      assertStrictEquals(error, reason);
    },
  );

  run(
    "an abort while reading a held-open body fails the read with the reason",
    [{ body: "first", holdOpen: true }],
    async ({ transport, baseUrl }) => {
      const controller = new AbortController();
      const reason = new Error("cancelled mid-body");
      const response = await transport(`${baseUrl}/h`, {
        method: "POST",
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      assertEquals(new TextDecoder().decode(first.value), "first");
      setTimeout(() => controller.abort(reason), 20);
      const error = await reader.read().then(() => undefined, (e) => e);
      assertStrictEquals(error, reason);
    },
  );

  run(
    "an abort without an explicit reason surfaces the signal's own reason",
    [{ body: "first", holdOpen: true }],
    async ({ transport, baseUrl }) => {
      const controller = new AbortController();
      const response = await transport(`${baseUrl}/d`, {
        method: "POST",
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      await reader.read();
      setTimeout(() => controller.abort(), 20);
      const error = await reader.read().then(() => undefined, (e) => e);
      assertStrictEquals(error, controller.signal.reason);
      assertEquals((error as Error).name, "AbortError");
    },
  );

  run(
    'redirect: "error" rejects a redirect status with a TypeError',
    [{ status: 307, headers: { location: "http://127.0.0.1:9/elsewhere" } }],
    async ({ transport, baseUrl }) => {
      const error = await assertRejects(() =>
        transport(`${baseUrl}/r`, { method: "POST", redirect: "error" })
      );
      assertInstanceOf(error, TypeError);
    },
  );
}
