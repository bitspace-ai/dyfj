// The shared provider-failure classifier: one verdict per recorded body,
// from the HTTP status and the body's documented markers, and one per
// transport failure. The body is matched, never relayed; the verdict carries
// only what the engine or the operator needs.

import { assertEquals, assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import * as F from "../../../testing/providers/failure-fixtures.ts";
import { classifyFetchFailure, classifyProviderResponse } from "./failure.ts";

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
    assertEquals(classifyProviderResponse(404, ""), {
      kind: "model_not_found",
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

  it("anything else is not a transport failure", () => {
    assertStrictEquals(
      classifyFetchFailure(new Error("local model unavailable")),
      null,
    );
    assertStrictEquals(classifyFetchFailure("refused"), null);
    assertStrictEquals(classifyFetchFailure(undefined), null);
  });
});
