import { describe, expect, test } from "vitest";
import {
  anthropicToolWireNames,
  buildAnthropicMessagesRequest,
  buildOpenAIChatRequest,
  defaultLocalWorkbenchModels,
  estimateTextTokens,
  HostedProviderCredentialMissingError,
  parseAnthropicStreamLine,
  parseModelRegistryRows,
  parseOpenAIChatStreamLine,
  runWorkbenchTurn,
  selectWorkbenchModel,
  withDefaultLocalWorkbenchModels,
  withTimePerOutputToken,
  WorkbenchHostedProviderBaseUrlError,
  WorkbenchLocalProviderBaseUrlError,
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

  test("explicit tier applies the local preference chain", () => {
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

  test("rejects local providers with non-loopback base URLs", async () => {
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "poisoned-local" },
      models: [{
        slug: "poisoned-local",
        displayName: "Poisoned local model",
        provider: "mlx-lm",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        tier: 0,
        costInput: 0,
        costOutput: 0,
        capabilities: ["text"],
      }],
      fetchFn: async () => {
        throw new Error("fetch should not be called");
      },
    })).rejects.toBeInstanceOf(WorkbenchLocalProviderBaseUrlError);
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

describe("runWorkbenchTurn hosted OpenAI", () => {
  const gptModel: WorkbenchModel = {
    slug: "gpt-test",
    displayName: "GPT test",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    tier: 2,
    costInput: 5,
    costOutput: 30,
    capabilities: ["text", "code", "reasoning"],
  };

  test("calls the OpenAI platform with a bearer key and meters cost", async () => {
    let requestUrl = "";
    let authHeader: string | null = null;

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gpt-test" },
      models: [gptModel],
      getEnv: (name) => name === "OPENAI_API_KEY" ? "sk-test-key" : undefined,
      fetchFn: async (input, init) => {
        requestUrl = String(input);
        authHeader = new Headers(init?.headers).get("authorization");
        return new Response(
          JSON.stringify({
            choices: [{
              message: { content: "hello from gpt" },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
          }),
          { status: 200 },
        );
      },
    });

    expect(requestUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(authHeader).toBe("Bearer sk-test-key");
    expect(result.model.provider).toBe("openai");
    expect(result.text).toBe("hello from gpt");
    // 1M input * $5 + 1M output * $30, per-MTok rates.
    expect(result.usage.cost.total).toBeCloseTo(35, 5);
  });

  test("fails closed when OPENAI_API_KEY is absent", async () => {
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gpt-test" },
      models: [gptModel],
      getEnv: () => undefined,
      fetchFn: async () => {
        throw new Error("fetch should not be called without a key");
      },
    })).rejects.toBeInstanceOf(HostedProviderCredentialMissingError);
  });

  test("rejects a non-https hosted base URL before inference", async () => {
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gpt-poisoned" },
      models: [{
        ...gptModel,
        slug: "gpt-poisoned",
        baseUrl: "http://api.openai.com/v1",
      }],
      getEnv: () => "sk-test-key",
      fetchFn: async () => {
        throw new Error("fetch should not be called");
      },
    })).rejects.toBeInstanceOf(WorkbenchHostedProviderBaseUrlError);
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

describe("anthropic provider adapter", () => {
  const anthropicModel = models.find((m) => m.provider === "anthropic")!;

  test("buildAnthropicMessagesRequest puts cache_control on the stable system block", () => {
    const body = buildAnthropicMessagesRequest(
      "claude-haiku-4-5",
      "You are the workbench.",
      "Say hi.",
      false,
      { jsonObject: true },
    );
    expect(body.system[0]).toMatchObject({
      text: "You are the workbench.",
      cache_control: { type: "ephemeral" },
    });
    expect(body.system[1].cache_control).toBeUndefined();
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages).toEqual([{ role: "user", content: "Say hi." }]);
  });

  test("buildAnthropicMessagesRequest maps tools to input_schema shape", () => {
    const body = buildAnthropicMessagesRequest(
      "claude-haiku-4-5",
      "sys",
      "prompt",
      false,
      {
        tools: [{
          name: "memory.read",
          description: "Read a memory",
          parameters: { type: "object", properties: {} },
        }],
      },
    );
    expect(body.tools).toEqual([{
      name: "memory_read",
      description: "Read a memory",
      input_schema: { type: "object", properties: {} },
    }]);
  });

  test("parseAnthropicStreamLine extracts deltas, usage, and stop reason", () => {
    expect(
      parseAnthropicStreamLine(
        'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":4000,"cache_creation_input_tokens":100}}}',
      ),
    ).toMatchObject({
      inputTokens: 12,
      cacheReadTokens: 4000,
      cacheWriteTokens: 100,
    });
    expect(
      parseAnthropicStreamLine(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}',
      ),
    ).toMatchObject({ textDelta: "Hel" });
    expect(
      parseAnthropicStreamLine(
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
      ),
    ).toMatchObject({ stopReason: "end_turn", outputTokens: 9 });
    expect(
      parseAnthropicStreamLine('data: {"type":"message_stop"}'),
    ).toMatchObject({ done: true });
    expect(parseAnthropicStreamLine("event: message_start")).toBeNull();
  });

  test("non-streaming turn returns text, tool calls, cache-aware cost", async () => {
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("test-key-not-real");
      expect(headers["anthropic-version"]).toBeTruthy();
      return new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "Hello from Claude." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "memory.read",
              input: { slug: "x" },
            },
          ],
          stop_reason: "tool_use",
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_read_input_tokens: 1_000_000,
            cache_creation_input_tokens: 1_000_000,
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await runWorkbenchTurn({
      systemPrompt: "sys",
      prompt: "hi",
      routing: { modelId: anthropicModel.slug },
      models,
      fetchFn,
      getEnv: (name) =>
        name === "ANTHROPIC_API_KEY" ? "test-key-not-real" : undefined,
    });

    expect(result.text).toBe("Hello from Claude.");
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([
      { id: "toolu_1", name: "memory.read", arguments: { slug: "x" } },
    ]);
    expect(result.usage.cacheRead).toBe(1_000_000);
    expect(result.usage.cacheWrite).toBe(1_000_000);
    // 1M of each at costInput=1/costOutput=5: 1 + 0.1 + 1.25 + 5 = 7.35
    expect(result.usage.cost.total).toBeCloseTo(7.35, 5);
  });

  test("streaming turn accumulates deltas and usage", async () => {
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");
    const fetchFn =
      (async () =>
        new Response(sse, { status: 200 })) as unknown as typeof fetch;

    const deltas: string[] = [];
    const result = await runWorkbenchTurn({
      systemPrompt: "sys",
      prompt: "hi",
      routing: { modelId: anthropicModel.slug },
      models,
      fetchFn,
      onTextDelta: (d) => deltas.push(d),
      getEnv: () => "test-key-not-real",
    });

    expect(deltas.join("")).toBe("Hello");
    expect(result.text).toBe("Hello");
    expect(result.stopReason).toBe("stop");
    expect(result.usage.input).toBe(10);
    expect(result.usage.output).toBe(2);
  });

  test("fails closed when the credential is not projected", async () => {
    await expect(
      runWorkbenchTurn({
        systemPrompt: "sys",
        prompt: "hi",
        routing: { modelId: anthropicModel.slug },
        models,
        getEnv: () => undefined,
      }),
    ).rejects.toThrow(HostedProviderCredentialMissingError);
  });

  test("rejects non-https hosted base URLs", async () => {
    const insecure = {
      ...anthropicModel,
      slug: "insecure",
      baseUrl: "http://api.anthropic.com",
    };
    await expect(
      runWorkbenchTurn({
        systemPrompt: "sys",
        prompt: "hi",
        routing: { modelId: "insecure" },
        models: [...models, insecure],
        getEnv: () => "test-key-not-real",
      }),
    ).rejects.toThrow(WorkbenchHostedProviderBaseUrlError);
  });
});

describe("anthropic tool wire names", () => {
  const anthropicModel = models.find((m) => m.provider === "anthropic")!;

  test("sanitizes dotted command ids and avoids collisions", () => {
    const mapped = anthropicToolWireNames([
      { name: "memory.read", description: "a", parameters: {} },
      { name: "memory_read", description: "b", parameters: {} },
    ]);
    expect(mapped[0].wire).toBe("memory_read");
    expect(mapped[1].wire).not.toBe(mapped[0].wire);
    expect(mapped[1].wire).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  test("round-trips registry names through the wire", async () => {
    let sentBody = "";
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sentBody = String(init?.body);
      return new Response(
        JSON.stringify({
          content: [{
            type: "tool_use",
            id: "toolu_1",
            name: "memory_read",
            input: { slug: "x" },
          }],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await runWorkbenchTurn({
      systemPrompt: "sys",
      prompt: "hi",
      routing: { modelId: anthropicModel.slug },
      models,
      tools: [{
        name: "memory.read",
        description: "Read a memory",
        parameters: { type: "object", properties: {} },
      }],
      fetchFn,
      getEnv: () => "test-key-not-real",
    });

    expect(JSON.parse(sentBody).tools[0].name).toBe("memory_read");
    expect(result.toolCalls?.[0].name).toBe("memory.read");
  });

  test("error surfaces the provider response body", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          error: { message: "tools.0.name: should match pattern" },
        }),
        { status: 400 },
      )) as unknown as typeof fetch;
    await expect(
      runWorkbenchTurn({
        systemPrompt: "sys",
        prompt: "hi",
        routing: { modelId: anthropicModel.slug },
        models,
        fetchFn,
        getEnv: () => "test-key-not-real",
      }),
    ).rejects.toThrow(/HTTP 400.*should match pattern/);
  });
});

describe("explicit tier preference", () => {
  test("tier 0 honors the MLX-first chain over list order", () => {
    const tierZero: WorkbenchModel[] = [
      {
        slug: "laguna-xs.2",
        displayName: "Laguna XS.2",
        provider: "ollama",
        api: "openai-completions",
        baseUrl: "http://localhost:11434/v1",
        tier: 0,
        costInput: 0,
        costOutput: 0,
        capabilities: ["text"],
      },
      {
        slug: "mlx-community/Qwen3.5-4B-8bit",
        displayName: "Qwen3.5 4B MLX",
        provider: "mlx-lm",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:18080/v1",
        tier: 0,
        costInput: 0,
        costOutput: 0,
        capabilities: ["text", "code", "reasoning"],
      },
    ];
    const selection = selectWorkbenchModel(tierZero, { tier: 0 });
    expect(selection.selected.slug).toBe("mlx-community/Qwen3.5-4B-8bit");
    expect(selection.reason).toBe("explicit_tier");
    expect(selection.considered).toEqual([
      "laguna-xs.2",
      "mlx-community/Qwen3.5-4B-8bit",
    ]);
  });
});
