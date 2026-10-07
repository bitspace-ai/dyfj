// The shared provider-failure classifier: one verdict per recorded body,
// from the HTTP status and the body's documented markers, and one per
// transport failure. The body is matched, never relayed; the verdict carries
// only what the engine or the operator needs.

import { assertEquals, assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import * as F from "../../../testing/providers/failure-fixtures.ts";
import { ScriptedHttpTransport } from "../../../testing/fakes/scripted-http-transport.ts";
import { classifyFetchFailure, classifyProviderResponse } from "./failure.ts";
import { MAX_ERROR_BODY_BYTES, readBoundedErrorBody } from "./error-body.ts";

describe("classifyProviderResponse", () => {
  const cases: ReadonlyArray<
    [F.FailureFixture, ReturnType<typeof classifyProviderResponse>]
  > = [
    [F.LLAMA_SERVER_CONTEXT_EXCEEDED, {
      kind: "context_exceeded",
      report: { requestedTokens: 82366, limitTokens: 32768 },
    }],
    [F.ANTHROPIC_CONTEXT_EXCEEDED, {
      kind: "context_exceeded",
      report: { requestedTokens: 82366, limitTokens: 32768 },
    }],
    [F.GEMINI_CONTEXT_EXCEEDED, {
      kind: "context_exceeded",
      report: { requestedTokens: 82366, limitTokens: 32768 },
    }],
    [F.OPENAI_AUTH, { kind: "authentication" }],
    [F.OPENROUTER_AUTH, { kind: "authentication" }],
    [F.LLAMA_SERVER_AUTH, { kind: "authentication" }],
    [F.ANTHROPIC_AUTH, { kind: "authentication" }],
    [F.ANTHROPIC_PERMISSION, { kind: "authentication" }],
    [F.GEMINI_AUTH, { kind: "authentication" }],
    [F.GEMINI_PERMISSION, { kind: "authentication" }],
    [F.OPENAI_RATE_LIMIT, { kind: "rate_limited", cause: "rate_limit" }],
    [F.OPENAI_QUOTA, { kind: "rate_limited", cause: "quota" }],
    [F.OPENROUTER_RATE_LIMIT, { kind: "rate_limited", cause: "rate_limit" }],
    [F.ANTHROPIC_RATE_LIMIT, { kind: "rate_limited", cause: "rate_limit" }],
    [F.ANTHROPIC_OVERLOADED, { kind: "rate_limited", cause: "overloaded" }],
    [F.GEMINI_QUOTA, { kind: "rate_limited", cause: "quota" }],
    [F.GEMINI_QUOTA_PER_MINUTE, { kind: "rate_limited", cause: "quota" }],
    [F.GEMINI_OVERLOADED, { kind: "rate_limited", cause: "overloaded" }],
    [F.OPENAI_MODEL_NOT_FOUND, { kind: "model_not_found" }],
    [F.OPENROUTER_INVALID_MODEL, { kind: "model_not_found" }],
    [F.OPENROUTER_NO_ENDPOINTS, { kind: "model_not_found" }],
    [F.ANTHROPIC_MODEL_NOT_FOUND, { kind: "model_not_found" }],
    [F.GEMINI_MODEL_NOT_FOUND, { kind: "model_not_found" }],
    [F.PROXY_REQUEST_TOO_LARGE, { kind: "request_too_large" }],
    [F.ANTHROPIC_REQUEST_TOO_LARGE, { kind: "request_too_large" }],
    [F.GEMINI_REQUEST_TOO_LARGE, { kind: "request_too_large" }],
    [F.OPENAI_SERVER_ERROR, null],
    [F.ANTHROPIC_SERVER_ERROR, null],
    [F.GEMINI_SERVER_ERROR, null],
  ];
  for (const [fixture, verdict] of cases) {
    it(
      `${fixture.source} HTTP ${fixture.status}: ${
        verdict === null ? "unclassified" : verdict.kind
      }`,
      () => {
        assertEquals(
          classifyProviderResponse(fixture.status, fixture.body),
          verdict,
        );
      },
    );
  }

  it("the status alone classifies when the body is empty or opaque", () => {
    assertEquals(classifyProviderResponse(401, ""), {
      kind: "authentication",
    });
    assertEquals(classifyProviderResponse(403, "<html>forbidden</html>"), {
      kind: "authentication",
    });
    assertEquals(classifyProviderResponse(429, ""), {
      kind: "rate_limited",
      cause: "rate_limit",
    });
    assertEquals(classifyProviderResponse(413, ""), {
      kind: "request_too_large",
    });
  });

  it("a context-size rejection wins over a 413 or a body that also says too large", () => {
    assertEquals(
      classifyProviderResponse(
        413,
        "request (82366 tokens) exceeds the available context size " +
          "(32768 tokens); payload too large",
      ),
      {
        kind: "context_exceeded",
        report: { requestedTokens: 82366, limitTokens: 32768 },
      },
    );
  });

  it("a 404 is model-not-found only when the body says so: a missing route is unclassified", () => {
    // A local server with a wrong base-URL path answers 404 for
    // /chat/completions with an empty or HTML body, and llama-server's own
    // not-found body names a file, not a model. Neither proves the model.
    assertStrictEquals(classifyProviderResponse(404, ""), null);
    assertStrictEquals(
      classifyProviderResponse(404, "<html><body>404 Not Found</body></html>"),
      null,
    );
    assertStrictEquals(
      classifyProviderResponse(
        404,
        '{"error":{"code":404,"message":"File Not Found","type":"not_found_error"}}',
      ),
      null,
    );
  });

  it("a 400 without a recognised marker stays unclassified", () => {
    assertStrictEquals(
      classifyProviderResponse(400, '{"error":{"message":"bad model"}}'),
      null,
    );
    assertStrictEquals(
      classifyProviderResponse(400, "Invalid parameter: temperature"),
      null,
    );
  });

  it("a 5xx is never read as a client-side class, whatever its body says", () => {
    assertStrictEquals(
      classifyProviderResponse(500, F.OPENAI_AUTH.body),
      null,
    );
    assertStrictEquals(
      classifyProviderResponse(502, F.OPENAI_MODEL_NOT_FOUND.body),
      null,
    );
  });
});

describe("classifyFetchFailure", () => {
  it("a refused connection", () => {
    assertStrictEquals(classifyFetchFailure(F.CONNECTION_REFUSED()), "refused");
    assertStrictEquals(
      classifyFetchFailure(new Error("connect ECONNREFUSED 127.0.0.1:8080")),
      "refused",
    );
  });

  it("a host that does not resolve", () => {
    assertStrictEquals(classifyFetchFailure(F.DNS_FAILURE()), "dns");
    assertStrictEquals(
      classifyFetchFailure(new Error("getaddrinfo ENOTFOUND api.example")),
      "dns",
    );
  });

  it("a route or connection that fails after resolution", () => {
    assertStrictEquals(classifyFetchFailure(F.NO_ROUTE()), "network");
    assertStrictEquals(classifyFetchFailure(F.CONNECTION_RESET()), "network");
  });

  it("the cause chain is read when the top-level message is generic", () => {
    const wrapped = new TypeError("Failed to fetch", {
      cause: F.CONNECTION_REFUSED(),
    });
    assertStrictEquals(classifyFetchFailure(wrapped), "refused");
  });

  it("a redirect the request refused to follow", () => {
    assertStrictEquals(
      classifyFetchFailure(
        new TypeError(
          "Fetch failed: Encountered redirect while redirect mode is set to 'error'",
        ),
      ),
      "redirect",
    );
  });

  it("the word redirect in the request URL does not make a refusal a redirect", () => {
    // The runtime's connection errors quote the URL, so the redirect verdict
    // must come from its redirect diagnostic, never from the URL's text.
    assertStrictEquals(
      classifyFetchFailure(
        new TypeError(
          "error sending request for url (http://127.0.0.1:8080/redirect/v1/chat/completions): " +
            "client error (Connect): tcp connect error: Connection refused (os error 61)",
        ),
      ),
      "refused",
    );
    assertStrictEquals(
      classifyFetchFailure(
        new Error("local model unavailable at http://host/redirect-proxy"),
      ),
      null,
    );
  });

  it("anything else is not a transport failure", () => {
    assertStrictEquals(
      classifyFetchFailure(new Error("local model unavailable")),
      null,
    );
    assertStrictEquals(classifyFetchFailure("refused"), null);
    assertStrictEquals(classifyFetchFailure(undefined), null);
  });
});

/** The promise's value, or "hung" when it has not settled within `ms`. */
async function settlesWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | "hung"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => resolve("hung"), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe("readBoundedErrorBody", () => {
  async function respond(body: string | undefined, status = 500) {
    const transport = new ScriptedHttpTransport([{
      respond: body === undefined
        ? () => new Response(null, { status })
        : { status, body },
    }]);
    return await transport.fetch("http://x/", { method: "POST" });
  }

  it("reads a small body whole and counts its bytes as received", async () => {
    const read = await readBoundedErrorBody(await respond("héllo"));
    assertEquals(read, { text: "héllo", bytes: 6, truncated: false });
  });

  it("a missing body reads as empty", async () => {
    const read = await readBoundedErrorBody(await respond(undefined));
    assertEquals(read, { text: "", bytes: 0, truncated: false });
  });

  it("stops at the cap: the text and the count are bounded, and the cut is reported", async () => {
    const body = F.oversizedErrorBody(MAX_ERROR_BODY_BYTES * 4);
    const read = await readBoundedErrorBody(await respond(body));
    assertEquals(read.truncated, true);
    assertEquals(read.bytes, MAX_ERROR_BODY_BYTES);
    assertEquals(
      new TextEncoder().encode(read.text).byteLength <= MAX_ERROR_BODY_BYTES,
      true,
    );
    assertEquals(read.text.startsWith('{"error":{"message":"xxx'), true);
  });

  it("a body that reaches exactly the cap and stays open settles at the cap instead of waiting", async () => {
    // The header deadline has already been cleared by the time the body is
    // read, so a server that sends exactly the cap and then holds the
    // stream open would otherwise park the adapter forever. Reaching the
    // cap is the end of the read, whether or not more ever arrives.
    const transport = new ScriptedHttpTransport([{
      respond: {
        status: 500,
        body: F.oversizedErrorBody(MAX_ERROR_BODY_BYTES),
        holdOpen: true,
      },
    }]);
    const response = await transport.fetch("http://x/", { method: "POST" });
    const outcome = await settlesWithin(readBoundedErrorBody(response), 500);
    assertEquals(outcome !== "hung", true, "the read never settled");
    assertEquals(outcome, {
      text: F.oversizedErrorBody(MAX_ERROR_BODY_BYTES),
      bytes: MAX_ERROR_BODY_BYTES,
      truncated: true,
    });
  });

  it("a read that fails part-way yields what arrived, not a throw", async () => {
    let delivered = false;
    const transport = new ScriptedHttpTransport([{
      respond: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            // The first pull delivers a chunk; the second fails, as a reset
            // mid-read does. (Erroring inside start would fail the first
            // read before the chunk is delivered.)
            pull(controller) {
              if (controller.desiredSize !== null && !delivered) {
                delivered = true;
                controller.enqueue(new TextEncoder().encode("partial"));
                return;
              }
              controller.error(new Error("socket reset"));
            },
          }),
          { status: 500 },
        ),
    }]);
    const read = await readBoundedErrorBody(
      await transport.fetch("http://x/", { method: "POST" }),
    );
    assertEquals(read, { text: "partial", bytes: 7, truncated: true });
  });
});
