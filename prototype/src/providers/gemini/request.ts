/**
 * Google Generative AI (Gemini) request bodies.
 *
 * Gemini's wire format is its own: model in the URL path, x-goog-api-key
 * header, contents/systemInstruction/generationConfig request, and
 * candidates[].content.parts[].text + usageMetadata response. This adapter
 * currently serves text/JSON turns.
 */

import { DEFAULT_REASONING_EFFORT } from "../shared/reasoning-output.ts";

export const GEMINI_DEFAULT_MAX_TOKENS = 8192;

export function buildGeminiRequest(
  systemPrompt: string,
  prompt: string,
  options: { jsonObject?: boolean; maxOutputTokens?: number } = {},
) {
  const body: {
    systemInstruction: { parts: Array<{ text: string }> };
    contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    generationConfig: {
      maxOutputTokens: number;
      responseMimeType?: string;
      thinkingConfig: { thinkingLevel: string };
    };
  } = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: options.maxOutputTokens ?? GEMINI_DEFAULT_MAX_TOKENS,
      thinkingConfig: { thinkingLevel: DEFAULT_REASONING_EFFORT },
    },
  };
  if (options.jsonObject) {
    body.generationConfig.responseMimeType = "application/json";
  }
  return body;
}
