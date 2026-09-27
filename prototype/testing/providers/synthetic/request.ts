// Request bodies for the synthetic API family: one POST to `/v1/generate`
// carrying the system prompt, the conversation, an output cap and any
// offered tools under their wire-safe names.

import type {
  WorkbenchMessage,
  WorkbenchToolDefinition,
} from "../../../src/providers/mod.ts";
import { toolWireNames } from "../../../src/providers/shared/tool-names.ts";

export const SYNTHETIC_DEFAULT_MAX_TOKENS = 4096;

export function buildSyntheticRequest(
  model: string,
  systemPrompt: string,
  prompt: string,
  stream: boolean,
  options: {
    messages?: WorkbenchMessage[];
    tools?: WorkbenchToolDefinition[];
    maxTokens?: number;
  },
) {
  const messages = options.messages && options.messages.length > 0
    ? options.messages.map((m) => ({ role: m.role, content: m.content }))
    : [{ role: "user", content: prompt }];
  return {
    model,
    system: systemPrompt,
    messages,
    max_tokens: options.maxTokens ?? SYNTHETIC_DEFAULT_MAX_TOKENS,
    stream,
    ...(options.tools && options.tools.length > 0
      ? {
        tools: toolWireNames(options.tools).map(({ wire, tool }) => ({
          name: wire,
          description: tool.description,
          schema: tool.parameters,
        })),
      }
      : {}),
  };
}
