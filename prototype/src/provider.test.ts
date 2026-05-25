import { describe, expect, test } from "vitest";
import {
  buildOpenAIChatRequest,
  estimateTextTokens,
  parseModelRegistryRows,
  selectWorkbenchModel,
  type WorkbenchModel,
} from "./provider";

const models: WorkbenchModel[] = [
  {
    slug: "gemma4",
    displayName: "Gemma 4 27B",
    provider: "ollama",
    api: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    tier: 0,
    costInput: 0,
    costOutput: 0,
    capabilities: ["text", "reasoning"],
  },
  {
    slug: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    tier: 1,
    costInput: 1,
    costOutput: 5,
    capabilities: ["text", "code"],
  },
];

describe("parseModelRegistryRows", () => {
  test("parses active model rows from Dolt-shaped strings", () => {
    const parsed = parseModelRegistryRows([
      {
        slug: "gemma4",
        display_name: "Gemma 4 27B",
        provider: "ollama",
        api: "openai-completions",
        base_url: "http://localhost:11434/v1",
        tier: "0",
        cost_input: "0",
        cost_output: "0",
        capabilities: '["text","reasoning"]',
      },
    ]);

    expect(parsed[0]).toMatchObject({
      slug: "gemma4",
      displayName: "Gemma 4 27B",
      tier: 0,
      capabilities: ["text", "reasoning"],
    });
  });

  test("accepts Dolt JSON display values for capabilities", () => {
    const parsed = parseModelRegistryRows([
      {
        slug: "gemma4",
        display_name: "Gemma 4 27B",
        provider: "ollama",
        api: "openai-completions",
        base_url: "http://localhost:11434/v1",
        tier: "0",
        cost_input: "0",
        cost_output: "0",
        capabilities: "text,reasoning",
      },
    ]);

    expect(parsed[0].capabilities).toEqual(["text", "reasoning"]);
  });
});

describe("selectWorkbenchModel", () => {
  test("defaults to the local gemma4 model", () => {
    const selection = selectWorkbenchModel(models, {});

    expect(selection.selected.slug).toBe("gemma4");
    expect(selection.reason).toBe("default");
  });

  test("explicit tier selects the first model in that tier", () => {
    const selection = selectWorkbenchModel(models, { tier: 1 });

    expect(selection.selected.slug).toBe("claude-haiku-4-5");
    expect(selection.reason).toBe("explicit_tier");
  });

  test("unknown explicit model fails before inference", () => {
    expect(() => selectWorkbenchModel(models, { modelId: "missing" }))
      .toThrow("Model not found: missing");
  });
});

describe("estimateTextTokens", () => {
  test("uses a conservative four-character estimate", () => {
    expect(estimateTextTokens("12345678")).toBe(2);
  });
});

describe("buildOpenAIChatRequest", () => {
  test("builds a non-streaming OpenAI-compatible chat request", () => {
    const body = buildOpenAIChatRequest("gemma4", "system", "hello");

    expect(body).toEqual({
      model: "gemma4",
      stream: false,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
      ],
    });
  });
});
