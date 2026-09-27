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
  WorkbenchHostedProviderBaseUrlError,
  WorkbenchModelNotFoundError,
} from "./mod.ts";

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
