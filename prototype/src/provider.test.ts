import { describe, expect, test } from "vitest";
import {
  fetchWithHeaderTimeout,
  buildAnthropicMessagesRequest,
  buildGeminiRequest,
  buildOpenAIChatRequest,
  defaultLocalWorkbenchModels,
  estimateTextTokens,
  extractTextToolCalls,
  HostedProviderCredentialMissingError,
  parseAnthropicStreamLine,
  parseGeminiStreamLine,
  parseModelRegistryRows,
  parseOpenAIChatStreamLine,
  runWorkbenchTurn,
  selectWorkbenchModel,
  toolWireNames,
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

    expect(selection.selected.slug).toBe(
      "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
    );
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
      modelId: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
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

  test("uses the configured default model on a bare turn", () => {
    const selection = selectWorkbenchModel(models, {}, "claude-haiku-4-5");
    expect(selection.selected.slug).toBe("claude-haiku-4-5");
    expect(selection.reason).toBe("default_config");
  });

  test("explicit modelId beats the configured default", () => {
    const selection = selectWorkbenchModel(
      models,
      { modelId: "laguna-xs.2" },
      "claude-haiku-4-5",
    );
    expect(selection.selected.slug).toBe("laguna-xs.2");
    expect(selection.reason).toBe("explicit_model_id");
  });

  test("a routing hint suppresses the configured default", () => {
    const selection = selectWorkbenchModel(
      models,
      { hint: "code" },
      "claude-haiku-4-5",
    );
    expect(selection.reason).not.toBe("default_config");
    expect(selection.selected.tier).toBe(0);
  });

  test("absent/empty default falls through to the local default", () => {
    expect(selectWorkbenchModel(models, {}, null).reason).toBe("default");
    expect(selectWorkbenchModel(models, {}, "").reason).toBe("default");
  });

  test("an unknown configured default fails before inference", () => {
    expect(() => selectWorkbenchModel(models, {}, "nope"))
      .toThrow("Model not found: nope");
  });
});

describe("defaultLocalWorkbenchModels", () => {
  test("provides a zero-cost Tier 0 MLX local default", () => {
    const defaults = defaultLocalWorkbenchModels();

    expect(defaults[0]).toMatchObject({
      slug: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
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
      "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
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
            // Dotted command id sanitized to OpenAI's ^[a-zA-Z0-9_-]+$ pattern.
            name: "memory_read",
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

  test("maps a multi-step transcript to system + user/assistant/tool wire messages", () => {
    const tools = [
      {
        name: "memory.read",
        description: "Load one Dolt-backed memory by slug.",
        parameters: {
          type: "object",
          properties: { slug: { type: "string" } },
        },
      },
    ];
    const body = buildOpenAIChatRequest("gemma4", "system", "seed", false, {
      tools,
      messages: [
        { role: "user", content: "what is this repo?" },
        {
          role: "assistant",
          content: "Reading memory.",
          toolCalls: [
            {
              id: "call-1",
              name: "memory.read",
              arguments: { slug: "project_dyfj" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          name: "memory.read",
          content: "# DYFJ",
        },
      ],
    });

    expect(body.messages[0]).toEqual({ role: "system", content: "system" });
    expect(body.messages[1]).toEqual({
      role: "user",
      content: "what is this repo?",
    });
    // Assistant turn carries the tool-call intentions; dotted name sanitized to
    // the same wire form offered in `tools`, arguments serialized to a string.
    expect(body.messages[2]).toEqual({
      role: "assistant",
      content: "Reading memory.",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "memory_read",
            arguments: JSON.stringify({ slug: "project_dyfj" }),
          },
        },
      ],
    });
    // Tool result links back to the call by id (the seed `prompt` is ignored).
    expect(body.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call-1",
      content: "# DYFJ",
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

  test("extracts streamed tool-call deltas", () => {
    const event = parseOpenAIChatStreamLine(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"list_files","arguments":"{\\"path\\":\\".\\"}"}}]}}]}',
    );
    expect(event?.toolCallDeltas).toEqual([
      {
        index: 0,
        id: "call-1",
        name: "list_files",
        argumentsFragment: '{"path":"."}',
      },
    ]);
  });

  test("ignores blank and non-data lines", () => {
    expect(parseOpenAIChatStreamLine("")).toBeNull();
    expect(parseOpenAIChatStreamLine("event: message")).toBeNull();
  });
});

describe("extractTextToolCalls", () => {
  test("recovers a leaked Qwen3-Coder tool call and strips the markup", () => {
    const text =
      "I'll check.\n<function=list_files>\n<parameter=path>\n.\n</parameter>\n</function>\n</tool_call>";
    const { toolCalls, cleaned } = extractTextToolCalls(text);
    expect(toolCalls).toEqual([
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
    expect(cleaned).toBe("I'll check.");
  });

  test("recovers multiple calls and coerces parameter values", () => {
    const text =
      "<function=read_file><parameter=path>schema/current/001_structure.sql</parameter><parameter=max>120</parameter></function>" +
      "<function=list_files><parameter=path>.</parameter></function>";
    const { toolCalls } = extractTextToolCalls(text);
    expect(toolCalls).toEqual([
      {
        id: "text-tool-1",
        name: "read_file",
        arguments: { path: "schema/current/001_structure.sql", max: 120 },
      },
      { id: "text-tool-2", name: "list_files", arguments: { path: "." } },
    ]);
  });

  test("leaves normal text untouched when there is no tool markup", () => {
    const { toolCalls, cleaned } = extractTextToolCalls("just a normal answer");
    expect(toolCalls).toEqual([]);
    expect(cleaned).toBe("just a normal answer");
  });
});

describe("runWorkbenchTurn streaming", () => {
  test("uses an OpenAI-compatible MLX local provider", async () => {
    let requestUrl = "";
    let requestModel = "";

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit" },
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
    expect(requestModel).toBe(
      "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
    );
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

  const sseStream = (chunks: unknown[]) => {
    const body = chunks
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join("") + "data: [DONE]\n\n";
    return async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        { status: 200 },
      );
  };

  test("captures tool calls from the SSE stream (MLX shape, whole call in one delta)", async () => {
    const deltas: string[] = [];
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list the files",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([
        {
          choices: [{
            delta: {
              role: "assistant",
              tool_calls: [{
                index: 0,
                id: "tc-1",
                type: "function",
                function: { name: "list_files", arguments: '{"path":"."}' },
              }],
            },
            finish_reason: null,
          }],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    });

    expect(result.toolCalls).toEqual([
      { id: "tc-1", name: "list_files", arguments: { path: "." } },
    ]);
    expect(result.stopReason).toBe("tool_use");
    expect(deltas).toEqual([]); // a tool-call turn streamed no text
  });

  test("accumulates fragmented tool-call arguments by index (hosted OpenAI shape)", async () => {
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "read a file",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: sseStream([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "tc-2",
                type: "function",
                function: { name: "read_file" },
              }],
            },
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"path":' } }],
            },
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }],
            },
            finish_reason: "tool_calls",
          }],
        },
      ]),
    });

    expect(result.toolCalls).toEqual([
      { id: "tc-2", name: "read_file", arguments: { path: "a.ts" } },
    ]);
  });

  test("sanitizes dotted tool names on the wire and maps the response back", async () => {
    let sentBody: { tools?: Array<{ function: { name: string } }> } = {};
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "load a memory",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "memory.read",
        description: "Load one memory by slug.",
        parameters: {
          type: "object",
          properties: { slug: { type: "string" } },
        },
      }],
      fetchFn: async (_input, init) => {
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: "",
                tool_calls: [{
                  id: "c1",
                  type: "function",
                  function: { name: "memory_read", arguments: '{"slug":"x"}' },
                }],
              },
              finish_reason: "tool_calls",
            }],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
          }),
          { status: 200 },
        );
      },
    });

    // Request carried the sanitized name (OpenAI rejects the dotted form)...
    expect(sentBody.tools?.[0].function.name).toBe("memory_read");
    // ...and the response mapped back to the registry name for dispatch.
    expect(result.toolCalls).toEqual([
      { id: "c1", name: "memory.read", arguments: { slug: "x" } },
    ]);
  });

  test("recovers a leaked tool call from a streamed turn and suppresses the markup", async () => {
    const deltas: string[] = [];
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list files",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([
        { choices: [{ delta: { content: "I'll check. " } }] },
        {
          choices: [{
            delta: {
              content:
                "<function=list_files><parameter=path>.</parameter></function>",
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    });

    expect(result.toolCalls).toEqual([
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
    // The narration streamed; the tool-call markup was suppressed.
    expect(deltas.join("")).toBe("I'll check. ");
  });

  test("recovers a leaked tool call from a buffered (non-streamed) turn", async () => {
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list files",
      routing: { modelId: "gemma4:e2b" },
      models,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                content:
                  "<function=list_files><parameter=path>.</parameter></function></tool_call>",
              },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 5, completion_tokens: 10 },
          }),
          { status: 200 },
        ),
    });

    expect(result.toolCalls).toEqual([
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
    expect(result.stopReason).toBe("tool_use");
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

describe("buildGeminiRequest", () => {
  test("puts the system prompt in systemInstruction and the user turn in contents", () => {
    const body = buildGeminiRequest("You are the workbench.", "Say hi.");
    expect(body.systemInstruction).toEqual({
      parts: [{ text: "You are the workbench." }],
    });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "Say hi." }] },
    ]);
    expect(body.generationConfig.maxOutputTokens).toBeGreaterThan(0);
    expect(body.generationConfig.responseMimeType).toBeUndefined();
    // Gemini 3.x thinking is bounded so it doesn't starve the answer
    // (thinking tokens come out of maxOutputTokens).
    expect(body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "low",
    });
  });

  test("requests a JSON mime type for strict JSON output", () => {
    const body = buildGeminiRequest("sys", "prompt", { jsonObject: true });
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });
});

describe("parseGeminiStreamLine", () => {
  test("extracts text and usage from an SSE data line", () => {
    const event = parseGeminiStreamLine(
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2}}',
    );
    expect(event).toEqual({
      done: false,
      textDelta: "hi",
      stopReason: "STOP",
      inputTokens: 7,
      outputTokens: 2,
    });
  });

  test("ignores blank and non-data lines", () => {
    expect(parseGeminiStreamLine("")).toBeNull();
    expect(parseGeminiStreamLine("event: message")).toBeNull();
  });

  test("excludes thinking parts from the text delta", () => {
    const event = parseGeminiStreamLine(
      'data: {"candidates":[{"content":{"parts":[{"text":"secret reasoning","thought":true},{"text":"the answer"}]}}]}',
    );
    expect(event?.textDelta).toBe("the answer");
  });
});

describe("runWorkbenchTurn Google Gemini", () => {
  const geminiModel: WorkbenchModel = {
    slug: "gemini-test",
    displayName: "Gemini test",
    provider: "google",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com",
    tier: 2,
    costInput: 2,
    costOutput: 12,
    capabilities: ["text", "code", "reasoning"],
  };

  test("calls generateContent with the key header and meters cost", async () => {
    let requestUrl = "";
    let keyHeader: string | null = null;

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-test" },
      models: [geminiModel],
      getEnv: (name) => name === "GEMINI_API_KEY" ? "gem-test-key" : undefined,
      fetchFn: async (input, init) => {
        requestUrl = String(input);
        keyHeader = new Headers(init?.headers).get("x-goog-api-key");
        return new Response(
          JSON.stringify({
            candidates: [{
              content: { parts: [{ text: "hello from gemini" }] },
              finishReason: "STOP",
            }],
            usageMetadata: {
              promptTokenCount: 1_000_000,
              candidatesTokenCount: 1_000_000,
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(requestUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent",
    );
    expect(keyHeader).toBe("gem-test-key");
    expect(result.model.provider).toBe("google");
    expect(result.text).toBe("hello from gemini");
    // 1M input * $2 + 1M output * $12, per-MTok rates.
    expect(result.usage.cost.total).toBeCloseTo(14, 5);
  });

  test("fails closed when GEMINI_API_KEY is absent", async () => {
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-test" },
      models: [geminiModel],
      getEnv: () => undefined,
      fetchFn: async () => {
        throw new Error("fetch should not be called without a key");
      },
    })).rejects.toBeInstanceOf(HostedProviderCredentialMissingError);
  });

  test("rejects a non-https base URL before inference", async () => {
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-poisoned" },
      models: [{
        ...geminiModel,
        slug: "gemini-poisoned",
        baseUrl: "http://generativelanguage.googleapis.com",
      }],
      getEnv: () => "gem-test-key",
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

  test("buildAnthropicMessagesRequest maps a transcript to tool_use/tool_result blocks", () => {
    const tools = [{
      name: "memory.read",
      description: "Read a memory",
      parameters: { type: "object", properties: {} },
    }];
    const body = buildAnthropicMessagesRequest(
      "claude-haiku-4-5",
      "sys",
      "seed",
      false,
      {
        tools,
        messages: [
          { role: "user", content: "what is this repo?" },
          {
            role: "assistant",
            content: "Reading memory.",
            toolCalls: [
              { id: "tu-1", name: "memory.read", arguments: { slug: "a" } },
              { id: "tu-2", name: "memory.read", arguments: { slug: "b" } },
            ],
          },
          {
            role: "tool",
            toolCallId: "tu-1",
            name: "memory.read",
            content: "A",
          },
          {
            role: "tool",
            toolCallId: "tu-2",
            name: "memory.read",
            content: "B",
          },
        ],
      },
    );

    // System stays top-level; the seed `prompt` is not used when history exists.
    expect(body.system[0]).toMatchObject({ text: "sys" });
    expect(body.messages[0]).toEqual({
      role: "user",
      content: "what is this repo?",
    });
    // Assistant turn: text block + one tool_use block per call (name sanitized).
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Reading memory." },
        {
          type: "tool_use",
          id: "tu-1",
          name: "memory_read",
          input: { slug: "a" },
        },
        {
          type: "tool_use",
          id: "tu-2",
          name: "memory_read",
          input: { slug: "b" },
        },
      ],
    });
    // Consecutive tool results merge into ONE following user turn (Anthropic shape).
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu-1", content: "A" },
        { type: "tool_result", tool_use_id: "tu-2", content: "B" },
      ],
    });
    expect(body.messages).toHaveLength(3);
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

describe("tool wire names", () => {
  const anthropicModel = models.find((m) => m.provider === "anthropic")!;

  test("sanitizes dotted command ids and avoids collisions", () => {
    const mapped = toolWireNames([
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
        slug: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
        displayName: "Qwen3-Coder 30B MLX",
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
    expect(selection.selected.slug).toBe(
      "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
    );
    expect(selection.reason).toBe("explicit_tier");
    expect(selection.considered).toEqual([
      "laguna-xs.2",
      "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
    ]);
  });
});

describe("fetchWithHeaderTimeout", () => {
  test("aborts a blackholed connection with a named error", async () => {
    const blackhole = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as unknown as typeof fetch;
    await expect(
      fetchWithHeaderTimeout(blackhole, "http://x/", {}, "anthropic/test", 30),
    ).rejects.toThrow(/anthropic\/test: no response headers within 30ms/);
  });

  test("passes a normal response through and clears the timer", async () => {
    const ok = (() =>
      Promise.resolve(new Response("hi"))) as unknown as typeof fetch;
    const response = await fetchWithHeaderTimeout(ok, "http://x/", {}, "l", 30);
    expect(await response.text()).toBe("hi");
  });

  test("non-abort failures pass through unchanged", async () => {
    const refused = (() =>
      Promise.reject(new Error("connection refused"))) as unknown as typeof fetch;
    await expect(
      fetchWithHeaderTimeout(refused, "http://x/", {}, "l", 1000),
    ).rejects.toThrow("connection refused");
  });
});

// ── catalog-row routability ───────────────────────────────────────────────────

describe("unpriced models are unroutable", () => {
  const unpriced: WorkbenchModel = {
    slug: "gpt-6-preview",
    displayName: "GPT-6 Preview",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    tier: 2,
    costInput: 0, // schema default — nobody priced the row
    costOutput: 0,
    capabilities: ["text", "code"],
  };

  test("modelHasCatalogPricing: tier 0 zero-cost is priced (free by declaration)", async () => {
    const { modelHasCatalogPricing } = await import("./provider");
    expect(modelHasCatalogPricing(models[0])).toBe(true); // tier 0, $0
    expect(modelHasCatalogPricing(models[2])).toBe(true); // tier 1, priced
    expect(modelHasCatalogPricing(unpriced)).toBe(false); // tier 2, $0
    expect(modelHasCatalogPricing({ ...unpriced, costInput: 15 })).toBe(false); // half-priced
    expect(modelHasCatalogPricing({ ...unpriced, costInput: 15, costOutput: 75 }))
      .toBe(true);
  });

  test("explicit modelId selection of an unpriced paid model throws the named error", async () => {
    const { WorkbenchModelNotRoutableError } = await import("./provider");
    expect(() =>
      selectWorkbenchModel([...models, unpriced], { modelId: "gpt-6-preview" })
    ).toThrow(WorkbenchModelNotRoutableError);
    expect(() =>
      selectWorkbenchModel([...models, unpriced], { modelId: "gpt-6-preview" })
    ).toThrow(/no catalog pricing/);
  });

  test("configured default companion that is unpriced throws instead of routing", async () => {
    const { WorkbenchModelNotRoutableError } = await import("./provider");
    expect(() =>
      selectWorkbenchModel([...models, unpriced], {}, "gpt-6-preview")
    ).toThrow(WorkbenchModelNotRoutableError);
  });

  test("tier routing skips unpriced candidates and picks a priced one", () => {
    const pricedTier2: WorkbenchModel = {
      ...unpriced,
      slug: "claude-opus-4-8",
      displayName: "Claude Opus 4.8",
      provider: "anthropic",
      api: "anthropic-messages",
      costInput: 15,
      costOutput: 75,
    };
    const selection = selectWorkbenchModel(
      [...models, unpriced, pricedTier2],
      { tier: 2 },
    );
    expect(selection.selected.slug).toBe("claude-opus-4-8");
    expect(selection.considered).toEqual(["claude-opus-4-8"]); // unpriced not considered
  });

  test("a tier whose only candidates are unpriced names the catalog problem", async () => {
    const { WorkbenchModelNotRoutableError } = await import("./provider");
    expect(() => selectWorkbenchModel([...models, unpriced], { tier: 2 }))
      .toThrow(WorkbenchModelNotRoutableError);
    expect(() => selectWorkbenchModel([...models, unpriced], { tier: 2 }))
      .toThrow(/all candidates unpriced: gpt-6-preview/);
    // An empty tier is still a not-found, not a pricing complaint.
    expect(() => selectWorkbenchModel(models, { tier: 2 }))
      .toThrow(/not found|tier:2/);
  });

  test("tier 0 routing is unaffected (free models stay routable)", () => {
    expect(selectWorkbenchModel([...models, unpriced], {}).selected.tier)
      .toBe(0);
  });

  test("malformed catalog costs parse to the unpriced bucket, never NaN", () => {
    const parsed = parseModelRegistryRows([
      {
        slug: "broken",
        display_name: "Broken Row",
        provider: "openai",
        api: "openai-completions",
        base_url: "https://api.openai.com/v1",
        tier: "2",
        cost_input: "garbage",
        cost_output: "-5",
        capabilities: "text",
      },
    ]);
    expect(parsed[0].costInput).toBe(0);
    expect(parsed[0].costOutput).toBe(0);
    expect(Number.isNaN(parsed[0].costInput)).toBe(false);
  });
});
