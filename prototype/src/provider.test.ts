import { describe, expect, test } from "vitest";
import {
  buildOpenAIChatRequest,
  defaultLocalWorkbenchModels,
  estimateTextTokens,
  parseModelRegistryRows,
  parseOpenAIChatStreamLine,
  runWorkbenchTurn,
  selectWorkbenchModel,
  withDefaultLocalWorkbenchModels,
  withTimePerOutputToken,
  type WorkbenchModel,
} from "./provider";

const models: WorkbenchModel[] = [
  {
    slug: "laguna-xs.2",
    displayName: "Laguna XS.2",
    provider: "ollama",
    api: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    tier: 0,
    costInput: 0,
    costOutput: 0,
    capabilities: ["text", "code", "reasoning"],
  },
  {
    slug: "gemma4:e2b",
    displayName: "Gemma 4 E2B",
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
  test("defaults to the local MLX Qwen model when available", () => {
    const selection = selectWorkbenchModel(defaultLocalWorkbenchModels(), {});

    expect(selection.selected.slug).toBe("mlx-community/Qwen3.5-4B-8bit");
    expect(selection.selected.provider).toBe("mlx-lm");
    expect(selection.reason).toBe("default");
  });

  test("falls back to Ollama when MLX Qwen is not available", () => {
    const selection = selectWorkbenchModel(models, {});

    expect(selection.selected.slug).toBe("laguna-xs.2");
    expect(selection.selected.provider).toBe("ollama");
    expect(selection.reason).toBe("default");
  });

  test("explicit model selection can select the MLX Qwen model", () => {
    const selection = selectWorkbenchModel(defaultLocalWorkbenchModels(), {
      modelId: "mlx-community/Qwen3.5-4B-8bit",
    });

    expect(selection.selected.provider).toBe("mlx-lm");
    expect(selection.reason).toBe("explicit_model_id");
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

describe("defaultLocalWorkbenchModels", () => {
  test("provides a zero-cost Tier 0 MLX local default", () => {
    const defaults = defaultLocalWorkbenchModels();

    expect(defaults[0]).toMatchObject({
      slug: "mlx-community/Qwen3.5-4B-8bit",
      provider: "mlx-lm",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18080/v1",
      tier: 0,
      costInput: 0,
      costOutput: 0,
      capabilities: expect.arrayContaining(["text", "code"]),
    });
  });

  test("keeps Ollama as a zero-cost Tier 0 fallback model", () => {
    const defaults = defaultLocalWorkbenchModels();

    expect(defaults[1]).toMatchObject({
      slug: "laguna-xs.2",
      provider: "ollama",
      tier: 0,
      costInput: 0,
      costOutput: 0,
      capabilities: expect.arrayContaining([
        "text",
        "code",
        "reasoning",
        "long-context",
      ]),
    });
  });
});

describe("withDefaultLocalWorkbenchModels", () => {
  test("overlays the measured local default when the registry lacks it", () => {
    const merged = withDefaultLocalWorkbenchModels([{
      ...models[0],
      slug: "gemma4",
      displayName: "Gemma 4 latest",
    }]);

    expect(merged.map((model) => model.slug).slice(0, 2)).toEqual([
      "mlx-community/Qwen3.5-4B-8bit",
      "laguna-xs.2",
    ]);
  });

  test("does not duplicate the default when the registry already has it", () => {
    const merged = withDefaultLocalWorkbenchModels(models);

    expect(merged.filter((model) => model.slug === "laguna-xs.2")).toHaveLength(
      1,
    );
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

  test("can request an OpenAI-compatible streaming response", () => {
    const body = buildOpenAIChatRequest("gemma4", "system", "hello", true);

    expect(body.stream).toBe(true);
  });

  test("can require strict JSON object output", () => {
    const body = buildOpenAIChatRequest("gemma4", "system", "hello", false, {
      jsonObject: true,
    });

    expect(body).toMatchObject({
      response_format: { type: "json_object" },
    });
  });

  test("can project commands as OpenAI-compatible tools", () => {
    const body = buildOpenAIChatRequest("gemma4", "system", "hello", false, {
      tools: [
        {
          name: "memory.read",
          description: "Load one Dolt-backed memory by slug.",
          parameters: {
            type: "object",
            required: ["slug"],
            properties: { slug: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
    });

    expect(body).toMatchObject({
      tools: [
        {
          type: "function",
          function: {
            name: "memory.read",
            description: "Load one Dolt-backed memory by slug.",
            parameters: {
              type: "object",
              required: ["slug"],
              properties: { slug: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: "auto",
    });
  });
});

describe("parseOpenAIChatStreamLine", () => {
  test("extracts text deltas and finish reason from SSE data lines", () => {
    const event = parseOpenAIChatStreamLine(
      'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}',
    );

    expect(event).toEqual({
      done: false,
      textDelta: "hello",
      finishReason: "stop",
      usage: undefined,
    });
  });

  test("recognizes stream completion sentinel", () => {
    expect(parseOpenAIChatStreamLine("data: [DONE]")).toEqual({ done: true });
  });

  test("ignores blank and non-data lines", () => {
    expect(parseOpenAIChatStreamLine("")).toBeNull();
    expect(parseOpenAIChatStreamLine("event: message")).toBeNull();
  });
});

describe("runWorkbenchTurn streaming", () => {
  test("uses an OpenAI-compatible MLX local provider", async () => {
    let requestUrl = "";
    let requestModel = "";

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "mlx-community/Qwen3.5-4B-8bit" },
      models: defaultLocalWorkbenchModels(),
      fetchFn: async (input, init) => {
        requestUrl = String(input);
        requestModel = JSON.parse(String(init?.body)).model;
        return new Response(
          JSON.stringify({
            choices: [{
              message: { content: "hello from mlx" },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 10, completion_tokens: 3 },
          }),
          { status: 200 },
        );
      },
    });

    expect(requestUrl).toBe("http://127.0.0.1:18080/v1/chat/completions");
    expect(requestModel).toBe("mlx-community/Qwen3.5-4B-8bit");
    expect(result.model.provider).toBe("mlx-lm");
    expect(result.text).toBe("hello from mlx");
  });

  test("prints deltas as they arrive and returns accumulated text", async () => {
    const deltas: string[] = [];
    const nowValues = [0, 10, 15, 20];
    const responseBody = [
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: (delta) => deltas.push(delta),
      now: () => nowValues.shift() ?? 20,
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(responseBody));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    });

    expect(deltas).toEqual(["hello", " world"]);
    expect(result.text).toBe("hello world");
    expect(result.usage.input).toBe(10);
    expect(result.usage.output).toBe(2);
    expect(result.stopReason).toBe("stop");
    expect(result.timings).toEqual({
      responseHeadersMs: 10,
      timeToFirstTokenMs: 15,
      generationMs: 5,
      timePerOutputTokenMs: 5,
      totalMs: 20,
    });
  });
});

describe("runWorkbenchTurn tool calls", () => {
  test("returns requested model tool calls without executing them", async () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call-memory",
                type: "function",
                function: {
                  name: "memory.read",
                  arguments: '{"slug":"project_dyfj"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 1 },
    });

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "read memory",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [
        {
          name: "memory.read",
          description: "Load one Dolt-backed memory by slug.",
          parameters: {
            type: "object",
            required: ["slug"],
            properties: { slug: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
      fetchFn: async () => new Response(body, { status: 200 }),
    });

    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([
      {
        id: "call-memory",
        name: "memory.read",
        arguments: { slug: "project_dyfj" },
      },
    ]);
  });
});

describe("withTimePerOutputToken", () => {
  test("uses post-first-token generation time for streaming TPOT", () => {
    expect(
      withTimePerOutputToken({
        responseHeadersMs: 10,
        timeToFirstTokenMs: 40,
        generationMs: 60,
        totalMs: 100,
      }, 4).timePerOutputTokenMs,
    ).toBe(20);
  });

  test("does not label total latency as TPOT without streaming timing", () => {
    expect(
      withTimePerOutputToken({
        responseHeadersMs: 10,
        totalMs: 80,
      }, 4).timePerOutputTokenMs,
    ).toBeUndefined();
  });
});
