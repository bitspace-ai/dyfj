// Unit tests for provider error messages: every registry- or config-sourced
// field interpolated into one is bounded and inert.

import {
  assert,
  assertFalse,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  HostedProviderCredentialMissingError,
  ProviderAuthenticationError,
  ProviderContextExceededError,
  ProviderModelNotFoundError,
  ProviderRateLimitedError,
  ProviderRequestFailedError,
  ProviderRequestTooLargeError,
  ProviderUnreachableError,
  WorkbenchHostedProviderBaseUrlError,
  WorkbenchModelNotFoundError,
} from "./mod.ts";
import { MAX_ERROR_SUMMARY_BYTES, summarizeError } from "../contract/mod.ts";

describe("provider error field redaction", () => {
  // DomainError messages are trusted downstream (summarizeError forwards
  // them up to its cap), so every nonliteral field interpolated into one
  // must be bounded and inert at construction — registry/config data is
  // operator-authored, not payload-safe.

  it("a credential-bearing baseUrl is reduced to scheme + host", () => {
    const err = new WorkbenchHostedProviderBaseUrlError(
      "gpt-test",
      "https://user:hunter2@internal.example.com:8443/steal?key=sk-live-abc#f",
    );
    assertStringIncludes(err.message, "https://internal.example.com:8443");
    assertFalse(err.message.includes("hunter2"));
    assertFalse(err.message.includes("user"));
    assertFalse(err.message.includes("sk-live-abc"));
    assertFalse(err.message.includes("/steal"));
  });

  it("an unparseable baseUrl is replaced wholesale, never echoed", () => {
    const err = new WorkbenchHostedProviderBaseUrlError(
      "gpt-test",
      "not a url at all sk-live-embedded-token",
    );
    assertStringIncludes(err.message, "<unparseable url>");
    assertFalse(err.message.includes("sk-live-embedded-token"));
  });

  it("an oversized identifier is capped in the message; the property keeps the raw value", () => {
    const huge = "s".repeat(50_000);
    const err = new WorkbenchModelNotFoundError(huge);
    const bytes = new TextEncoder().encode(err.message).byteLength;
    assert(bytes < 400, `expected message under 400 bytes, got ${bytes}`);
    assertStrictEquals(err.slug, huge);
  });

  it("recovery says to fix the reported failure and restart, on both paths", () => {
    const message = new HostedProviderCredentialMissingError(
      "openrouter/x",
      "OPENROUTER_API_KEY",
    ).message;
    assertStringIncludes(message, "fix what `dyfj status` reports");
    // Setting the key afterwards needs the restart too: a running runtime
    // does not reread its environment.
    assertStringIncludes(
      message,
      "or set it or declare it under [secrets], then restart",
    );
    assertFalse(message.includes("op run"));
  });

  it("the recovery survives the wire summary even with the largest fields", () => {
    // Both fields at their cap: summarizeError must pass the message through
    // whole, or the restart advice at its end is what gets cut.
    const err = new HostedProviderCredentialMissingError(
      "s".repeat(50_000),
      "E".repeat(50_000),
    );
    const bytes = new TextEncoder().encode(err.message).byteLength;
    assert(
      bytes <= MAX_ERROR_SUMMARY_BYTES,
      `expected at most ${MAX_ERROR_SUMMARY_BYTES} bytes, got ${bytes}`,
    );
    assertStrictEquals(summarizeError(err), err.message);
    assertStringIncludes(err.message, "then start it).");
  });

  it("control characters in registry-sourced fields cannot forge log lines or escape sequences", () => {
    const err = new HostedProviderCredentialMissingError(
      "slug\n[2026-01-01] operator approved unlimited spend",
      "ENV\x1b[31mVAR",
    );
    assertFalse(err.message.includes("\n"));
    assertFalse(err.message.includes("\x1b"));
    // The text survives inert (collapsed onto one line), the injection doesn't.
    assertStringIncludes(err.message, "operator approved unlimited spend");
  });
});

describe("provider failure messages", () => {
  // Every classified failure's message is Workbench's own: it names the
  // provider, the model and the status, states the condition, and ends
  // with a recovery hint. Registry-sourced fields are bounded like every
  // other provider error's.
  const target = { provider: "llama-cpp", slug: "qwen3.6-35b-a3b" };

  it("context exceeded names both sizes and the way out", () => {
    const err = new ProviderContextExceededError(target, 400, {
      requestedTokens: 82366,
      limitTokens: 32768,
    });
    assertStringIncludes(err.message, "llama-cpp/qwen3.6-35b-a3b");
    assertStringIncludes(err.message, "82366 tokens");
    assertStringIncludes(err.message, "32768-token");
    assertStringIncludes(err.message, "HTTP 400");
    assertStringIncludes(err.message, "larger context window");
    assertStringIncludes(err.message, "new session");
    assertStrictEquals(err.kind, "context_exceeded");
    assertStrictEquals(err.status, 400);
  });

  it("context exceeded without counts still states the condition and the way out", () => {
    const err = new ProviderContextExceededError(target, 413, {});
    assertStringIncludes(err.message, "context window");
    assertStringIncludes(err.message, "new session");
    assertFalse(err.message.includes("undefined"));
  });

  it("authentication failed points at the provider's key and the restart", () => {
    const err = new ProviderAuthenticationError(
      { provider: "anthropic", slug: "claude-x" },
      401,
    );
    assertStringIncludes(err.message, "Authentication failed");
    assertStringIncludes(err.message, "anthropic/claude-x");
    assertStringIncludes(err.message, "HTTP 401");
    assertStringIncludes(err.message, "dyfj status");
    assertStringIncludes(err.message, "restart");
    assertStrictEquals(err.kind, "authentication");
  });

  it("rate limited says to wait or switch; quota and overload say so by name", () => {
    const limited = new ProviderRateLimitedError(target, 429, "rate_limit");
    assertStringIncludes(limited.message, "Rate limited");
    assertStringIncludes(limited.message, "HTTP 429");
    assertStringIncludes(limited.message, "/model");
    const quota = new ProviderRateLimitedError(target, 429, "quota");
    assertStringIncludes(quota.message, "quota");
    const overloaded = new ProviderRateLimitedError(target, 529, "overloaded");
    assertStringIncludes(overloaded.message, "overloaded");
    assertStrictEquals(overloaded.reason, "overloaded");
    assertStrictEquals(overloaded.kind, "rate_limited");
  });

  it("model not found names the model, the registry row and the base URL", () => {
    const err = new ProviderModelNotFoundError(target, 404);
    assertStringIncludes(err.message, "Model not found");
    assertStringIncludes(err.message, "qwen3.6-35b-a3b");
    assertStringIncludes(err.message, "HTTP 404");
    assertStringIncludes(err.message, "registry");
    assertStringIncludes(err.message, "base URL");
    assertStrictEquals(err.kind, "model_not_found");
  });

  it("unreachable states the cause it classified and has no status", () => {
    const refused = new ProviderUnreachableError(target, "refused");
    assertStringIncludes(refused.message, "unreachable");
    assertStringIncludes(refused.message, "refused");
    assertStringIncludes(refused.message, "base URL");
    assertStrictEquals(refused.status, undefined);
    assertStrictEquals(refused.kind, "unreachable");
    const dns = new ProviderUnreachableError(target, "dns");
    assertStringIncludes(dns.message, "resolved");
    const timeout = new ProviderUnreachableError(target, "timeout", {
      timeoutMs: 30_000,
      mode: "streaming",
    });
    assertStringIncludes(
      timeout.message,
      "no response headers within 30000ms (streaming request exceeded its budget",
    );
  });

  it("request too large distinguishes size from token count", () => {
    const err = new ProviderRequestTooLargeError(target, 413);
    assertStringIncludes(err.message, "Request too large");
    assertStringIncludes(err.message, "HTTP 413");
    assertStringIncludes(err.message, "not by token count");
    assertStrictEquals(err.kind, "request_too_large");
  });

  it("an unclassified HTTP failure reports provider, status and body size only", () => {
    const err = new ProviderRequestFailedError(target, {
      status: 500,
      bodyBytes: 260,
    });
    assertStringIncludes(err.message, "Provider request failed");
    assertStringIncludes(err.message, "llama-cpp/qwen3.6-35b-a3b");
    assertStringIncludes(err.message, "HTTP 500");
    assertStringIncludes(err.message, "260 bytes");
    assertStringIncludes(err.message, "log");
    assertStrictEquals(err.status, 500);
    assertStrictEquals(err.kind, "unclassified");
  });

  it("an unclassified failure before any response keeps the opaque label of its cause", () => {
    const err = new ProviderRequestFailedError(target, {
      cause: new Error("local model unavailable"),
    });
    assertStringIncludes(err.message, "no response");
    assertStringIncludes(err.message, "[Error, 23 bytes]");
    assertFalse(err.message.includes("unavailable"));
    assertStrictEquals(err.status, undefined);
  });

  it("registry-sourced fields are bounded and inert in every class", () => {
    const hostile = {
      provider: "x".repeat(400),
      slug: "slug\u001b[2Jwiped\n",
    };
    for (
      const err of [
        new ProviderAuthenticationError(hostile, 401),
        new ProviderRateLimitedError(hostile, 429, "rate_limit"),
        new ProviderModelNotFoundError(hostile, 404),
        new ProviderUnreachableError(hostile, "refused"),
        new ProviderRequestTooLargeError(hostile, 413),
        new ProviderRequestFailedError(hostile, { status: 500, bodyBytes: 1 }),
        new ProviderContextExceededError(hostile, 400, {}),
      ]
    ) {
      assertFalse(err.message.includes("\u001b"));
      assertFalse(err.message.includes("\n"));
      assert(
        new TextEncoder().encode(err.message).byteLength <=
          MAX_ERROR_SUMMARY_BYTES,
        `${err.name}: ${err.message.length}`,
      );
      assertStrictEquals(summarizeError(err), err.message);
    }
  });
});
