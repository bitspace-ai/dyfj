/**
 * Google Generative AI (Gemini) request bodies.
 *
 * Gemini's wire format is its own: model in the URL path, x-goog-api-key
 * header, contents/systemInstruction/generationConfig request, and
 * candidates[].content.parts[].text + usageMetadata response. This adapter
 * currently serves text/JSON turns.
 */

export const GEMINI_DEFAULT_MAX_TOKENS = 8192;
// Gemini 3.x are thinking models and draw thinking tokens from maxOutputTokens
//. Bound thinking so it doesn't starve the answer; "low" keeps the
// reasoning trail cheap while leaving the 8192 budget mostly for output. (2.5
// rows would need thinkingBudget instead, but those are inactive.)
const GEMINI_THINKING_LEVEL = "low";

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
      thinkingConfig: { thinkingLevel: GEMINI_THINKING_LEVEL },
    },
  };
  if (options.jsonObject) {
    body.generationConfig.responseMimeType = "application/json";
  }
  return body;
}
