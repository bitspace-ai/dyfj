// Unit tests for provider error messages: every registry- or config-sourced
// field interpolated into one is bounded and inert.

import assert from "node:assert/strict";
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
    assert.strictEqual(
      err.message,
      "Hosted provider baseUrl is not the provider's https endpoint for " +
        "gpt-test: https://internal.example.com:8443",
    );
    assert.ok(!err.message.includes("hunter2"));
    assert.ok(!err.message.includes("user"));
    assert.ok(!err.message.includes("sk-live-abc"));
    assert.ok(!err.message.includes("/steal"));
  });

  it("an unparseable baseUrl is replaced wholesale, never echoed", () => {
    const err = new WorkbenchHostedProviderBaseUrlError(
      "gpt-test",
      "not a url at all sk-live-embedded-token",
    );
    assert.ok(
      err.message.includes("<unparseable url>"),
      `expected err.message to include "<unparseable url>"`,
    );
    assert.ok(!err.message.includes("sk-live-embedded-token"));
  });

  it("an oversized identifier is capped in the message; the property keeps the raw value", () => {
    const huge = "s".repeat(50_000);
    const err = new WorkbenchModelNotFoundError(huge);
    const bytes = new TextEncoder().encode(err.message).byteLength;
    assert.ok(bytes < 400, `expected message under 400 bytes, got ${bytes}`);
    assert.strictEqual(err.slug, huge);
  });

  it("recovery says to fix the reported failure and restart, on both paths", () => {
    const message = new HostedProviderCredentialMissingError(
      "openrouter/x",
      "OPENROUTER_API_KEY",
    ).message;
    assert.ok(
      message.includes("fix what `dyfj status` reports"),
      `expected ${
        JSON.stringify(message)
      } to include "fix what \`dyfj status\` reports"`,
    );
    // Setting the key afterwards needs the restart too: a running runtime
    // does not reread its environment.
    assert.ok(
      message.includes("or set it or declare it under [secrets], then restart"),
      `expected ${
        JSON.stringify(message)
      } to include "or set it or declare it under [secrets], then restart"`,
    );
    assert.ok(!message.includes("op run"));
  });

  it("the recovery survives the wire summary even with the largest fields", () => {
    // Both fields at their cap: summarizeError must pass the message through
    // whole, or the restart advice at its end is what gets cut.
    const err = new HostedProviderCredentialMissingError(
      "s".repeat(50_000),
      "E".repeat(50_000),
    );
    const bytes = new TextEncoder().encode(err.message).byteLength;
    assert.ok(
      bytes <= MAX_ERROR_SUMMARY_BYTES,
      `expected at most ${MAX_ERROR_SUMMARY_BYTES} bytes, got ${bytes}`,
    );
    assert.strictEqual(summarizeError(err), err.message);
    assert.ok(
      err.message.includes("then start it)."),
      `expected err.message to include "then start it)."`,
    );
  });

  it("control characters in registry-sourced fields cannot forge log lines or escape sequences", () => {
    const err = new HostedProviderCredentialMissingError(
      "slug\n[2026-01-01] operator approved unlimited spend",
      "ENV\x1b[31mVAR",
    );
    assert.ok(!err.message.includes("\n"));
    assert.ok(!err.message.includes("\x1b"));
    // The text survives inert (collapsed onto one line), the injection doesn't.
    assert.ok(
      err.message.includes("operator approved unlimited spend"),
      `expected err.message to include "operator approved unlimited spend"`,
    );
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
    assert.ok(
      err.message.includes("llama-cpp/qwen3.6-35b-a3b"),
      `expected err.message to include "llama-cpp/qwen3.6-35b-a3b"`,
    );
    assert.ok(
      err.message.includes("82366 tokens"),
      `expected err.message to include "82366 tokens"`,
    );
    assert.ok(
      err.message.includes("32768-token"),
      `expected err.message to include "32768-token"`,
    );
    assert.ok(
      err.message.includes("HTTP 400"),
      `expected err.message to include "HTTP 400"`,
    );
    assert.ok(
      err.message.includes("larger context window"),
      `expected err.message to include "larger context window"`,
    );
    assert.ok(
      err.message.includes("new session"),
      `expected err.message to include "new session"`,
    );
    assert.strictEqual(err.kind, "context_exceeded");
    assert.strictEqual(err.status, 400);
  });

  it("context exceeded without counts still states the condition and the way out", () => {
    const err = new ProviderContextExceededError(target, 413, {});
    assert.ok(
      err.message.includes("context window"),
      `expected err.message to include "context window"`,
    );
    assert.ok(
      err.message.includes("new session"),
      `expected err.message to include "new session"`,
    );
    assert.ok(!err.message.includes("undefined"));
  });

  it("authentication failed points at the provider's key and the restart", () => {
    const err = new ProviderAuthenticationError(
      { provider: "anthropic", slug: "claude-x" },
      401,
    );
    assert.ok(
      err.message.includes("Authentication failed"),
      `expected err.message to include "Authentication failed"`,
    );
    assert.ok(
      err.message.includes("anthropic/claude-x"),
      `expected err.message to include "anthropic/claude-x"`,
    );
    assert.ok(
      err.message.includes("HTTP 401"),
      `expected err.message to include "HTTP 401"`,
    );
    assert.ok(
      err.message.includes("dyfj status"),
      `expected err.message to include "dyfj status"`,
    );
    assert.ok(
      err.message.includes("restart"),
      `expected err.message to include "restart"`,
    );
    assert.strictEqual(err.kind, "authentication");
  });

  it("a 403 is an access problem, not a bad key: the hint points at the account's access", () => {
    const err = new ProviderAuthenticationError(
      { provider: "anthropic", slug: "claude-x" },
      403,
    );
    assert.ok(
      err.message.includes("Access denied"),
      `expected err.message to include "Access denied"`,
    );
    assert.ok(
      err.message.includes("HTTP 403"),
      `expected err.message to include "HTTP 403"`,
    );
    assert.ok(
      err.message.includes("accepted"),
      `expected err.message to include "accepted"`,
    );
    assert.ok(
      err.message.includes("/model"),
      `expected err.message to include "/model"`,
    );
    assert.ok(!err.message.includes("restart"));
    assert.strictEqual(err.kind, "authentication");
  });

  it("rate limited says to wait or switch; quota and overload say so by name", () => {
    const limited = new ProviderRateLimitedError(target, 429, "rate_limit");
    assert.ok(
      limited.message.includes("Rate limited"),
      `expected limited.message to include "Rate limited"`,
    );
    assert.ok(
      limited.message.includes("HTTP 429"),
      `expected limited.message to include "HTTP 429"`,
    );
    assert.ok(
      limited.message.includes("/model"),
      `expected limited.message to include "/model"`,
    );
    // A body that says "quota" may be a per-minute limit that resets on its
    // own or an account that needs credit; the body does not say which, so
    // the hint covers both and never sends the operator to billing alone.
    const quota = new ProviderRateLimitedError(target, 429, "quota");
    assert.ok(
      quota.message.includes("quota"),
      `expected quota.message to include "quota"`,
    );
    assert.ok(
      quota.message.includes("reset"),
      `expected quota.message to include "reset"`,
    );
    assert.ok(
      quota.message.includes("credit"),
      `expected quota.message to include "credit"`,
    );
    assert.ok(
      quota.message.includes("/model"),
      `expected quota.message to include "/model"`,
    );
    const overloaded = new ProviderRateLimitedError(target, 529, "overloaded");
    assert.ok(
      overloaded.message.includes("overloaded"),
      `expected overloaded.message to include "overloaded"`,
    );
    assert.strictEqual(overloaded.reason, "overloaded");
    assert.strictEqual(overloaded.kind, "rate_limited");
  });

  it("model not found keeps both readings: not served, or not accessible to this account", () => {
    // OpenAI's recorded 404 says "does not exist or you do not have access
    // to it", so the hint must cover the account's access as well as the
    // registry row and the base URL.
    const err = new ProviderModelNotFoundError(target, 404);
    assert.ok(
      err.message.includes("Model not found"),
      `expected err.message to include "Model not found"`,
    );
    assert.ok(
      err.message.includes("qwen3.6-35b-a3b"),
      `expected err.message to include "qwen3.6-35b-a3b"`,
    );
    assert.ok(
      err.message.includes("HTTP 404"),
      `expected err.message to include "HTTP 404"`,
    );
    assert.ok(
      err.message.includes("no access"),
      `expected err.message to include "no access"`,
    );
    assert.ok(
      err.message.includes("registry"),
      `expected err.message to include "registry"`,
    );
    assert.ok(
      err.message.includes("base URL"),
      `expected err.message to include "base URL"`,
    );
    assert.ok(
      err.message.includes("account's access"),
      `expected err.message to include "account's access"`,
    );
    assert.strictEqual(err.kind, "model_not_found");
  });

  it("unreachable states the cause it classified and has no status", () => {
    const refused = new ProviderUnreachableError(target, "refused");
    assert.ok(
      refused.message.includes("unreachable"),
      `expected refused.message to include "unreachable"`,
    );
    assert.ok(
      refused.message.includes("refused"),
      `expected refused.message to include "refused"`,
    );
    assert.ok(
      refused.message.includes("base URL"),
      `expected refused.message to include "base URL"`,
    );
    assert.strictEqual(refused.status, undefined);
    assert.strictEqual(refused.kind, "unreachable");
    const dns = new ProviderUnreachableError(target, "dns");
    assert.ok(
      dns.message.includes("resolved"),
      `expected dns.message to include "resolved"`,
    );
    const timeout = new ProviderUnreachableError(target, "timeout", {
      timeoutMs: 30_000,
      mode: "streaming",
    });
    assert.ok(
      timeout.message.includes(
        "no response headers within 30000ms (streaming request exceeded its budget",
      ),
      `expected timeout.message to include "no response headers within 30000ms (streaming request exceeded its budget"`,
    );
  });

  it("request too large distinguishes size from token count", () => {
    const err = new ProviderRequestTooLargeError(target, 413);
    assert.ok(
      err.message.includes("Request too large"),
      `expected err.message to include "Request too large"`,
    );
    assert.ok(
      err.message.includes("HTTP 413"),
      `expected err.message to include "HTTP 413"`,
    );
    assert.ok(
      err.message.includes("not by token count"),
      `expected err.message to include "not by token count"`,
    );
    assert.strictEqual(err.kind, "request_too_large");
  });

  it("an unclassified HTTP failure reports provider, status and body size only", () => {
    const err = new ProviderRequestFailedError(target, {
      status: 500,
      bodyBytes: 260,
    });
    assert.ok(
      err.message.includes("Provider request failed"),
      `expected err.message to include "Provider request failed"`,
    );
    assert.ok(
      err.message.includes("llama-cpp/qwen3.6-35b-a3b"),
      `expected err.message to include "llama-cpp/qwen3.6-35b-a3b"`,
    );
    assert.ok(
      err.message.includes("HTTP 500"),
      `expected err.message to include "HTTP 500"`,
    );
    assert.ok(
      err.message.includes("260 bytes"),
      `expected err.message to include "260 bytes"`,
    );
    assert.ok(
      err.message.includes("log"),
      `expected err.message to include "log"`,
    );
    assert.strictEqual(err.status, 500);
    assert.strictEqual(err.kind, "unclassified");
  });

  it("an unclassified HTTP failure whose body was cut at the reader's cap reports a lower bound", () => {
    // The read stops at the cap whether or not more follows, so the count
    // is "at least", never "more than".
    const err = new ProviderRequestFailedError(target, {
      status: 502,
      bodyBytes: 65_536,
      truncated: true,
    });
    assert.ok(
      err.message.includes("at least 65536 bytes"),
      `expected err.message to include "at least 65536 bytes"`,
    );
  });

  it("an unclassified failure before any response keeps the opaque label of its cause", () => {
    const err = new ProviderRequestFailedError(target, {
      cause: new Error("local model unavailable"),
    });
    assert.ok(
      err.message.includes("no response"),
      `expected err.message to include "no response"`,
    );
    assert.ok(
      err.message.includes("[Error, 23 bytes]"),
      `expected err.message to include "[Error, 23 bytes]"`,
    );
    assert.ok(!err.message.includes("unavailable"));
    assert.strictEqual(err.status, undefined);
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
      assert.ok(!err.message.includes("\u001b"));
      assert.ok(!err.message.includes("\n"));
      assert.ok(
        new TextEncoder().encode(err.message).byteLength <=
          MAX_ERROR_SUMMARY_BYTES,
        `${err.name}: ${err.message.length}`,
      );
      assert.strictEqual(summarizeError(err), err.message);
    }
  });
});
