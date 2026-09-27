import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { buildGeminiRequest } from "./request.ts";

describe("buildGeminiRequest", () => {
  it("puts the system prompt in systemInstruction and the user turn in contents", () => {
    const body = buildGeminiRequest("You are the workbench.", "Say hi.");
    assertEquals(body.systemInstruction, {
      parts: [{ text: "You are the workbench." }],
    });
    assertEquals(body.contents, [
      { role: "user", parts: [{ text: "Say hi." }] },
    ]);
    assert(
      body.generationConfig.maxOutputTokens > 0,
      "maxOutputTokens should be positive",
    );
    assertStrictEquals(body.generationConfig.responseMimeType, undefined);
    // Gemini 3.x thinking is bounded so it doesn't starve the answer
    // (thinking tokens come out of maxOutputTokens).
    assertEquals(body.generationConfig.thinkingConfig, {
      thinkingLevel: "low",
    });
  });

  it("requests a JSON mime type for strict JSON output", () => {
    const body = buildGeminiRequest("sys", "prompt", { jsonObject: true });
    assertStrictEquals(
      body.generationConfig.responseMimeType,
      "application/json",
    );
  });
});
