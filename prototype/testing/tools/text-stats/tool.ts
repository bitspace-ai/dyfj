// A test-only tool, written by following `specs/recipes/add-tool.md`. It is not
// a product tool: it lives under `testing/` as the living example the recipe
// points to, and it passes the tool conformance kit like the builtins.
//
// The tool: `text.stats` counts the characters, words and lines of a text the
// model supplies. It reads nothing and writes nothing, so the policy allows it
// without approval. The text is a payload, so the definition marks it for
// redaction: the durable tool_call event never keeps it.

import type { CommandDefinition } from "../../../src/tools/mod.ts";

/** The executor: code-point, whitespace-separated word and line counts. */
export function executeTextStats(text: string): string {
  const words = text.split(/\s+/).filter((word) => word !== "").length;
  const lines = text === "" ? 0 : text.split(/\r\n|\r|\n/).length;
  return [
    `characters: ${[...text].length}`,
    `words: ${words}`,
    `lines: ${lines}`,
  ].join("\n");
}

export function defineTextStats(): CommandDefinition<string> {
  return {
    id: "text.stats",
    title: "Text Statistics",
    description:
      "Count the characters, words and lines of a text you supply. Reads " +
      "nothing and writes nothing.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: {
          type: "string",
          description: "The text to measure.",
          // A payload, not a parameter: kept out of the durable event.
          redact: true,
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["emit.event"],
      defaultDecision: "allow",
      resources: ["text:stats"],
      network: "none",
      filesystem: "none",
      cost: "none",
    },
    executor: (call) => executeTextStats(String(call.arguments.text)),
  };
}
