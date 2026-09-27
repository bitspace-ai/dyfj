// Unit tests for token estimates and time-per-output-token timings.

import { assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { estimateTextTokens, withTimePerOutputToken } from "./tokens.ts";

describe("estimateTextTokens", () => {
  it("uses a conservative four-character estimate", () => {
    assertStrictEquals(estimateTextTokens("12345678"), 2);
  });
});

describe("withTimePerOutputToken", () => {
  it("uses post-first-token generation time for streaming TPOT", () => {
    assertStrictEquals(
      withTimePerOutputToken({
        responseHeadersMs: 10,
        timeToFirstTokenMs: 40,
        generationMs: 60,
        totalMs: 100,
      }, 4).timePerOutputTokenMs,
      20,
    );
  });

  it("does not label total latency as TPOT without streaming timing", () => {
    assertStrictEquals(
      withTimePerOutputToken({
        responseHeadersMs: 10,
        totalMs: 80,
      }, 4).timePerOutputTokenMs,
      undefined,
    );
  });
});
