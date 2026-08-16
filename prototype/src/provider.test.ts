import { describe, expect, test } from "vitest";
import {
  buildAnthropicMessagesRequest,
  buildGeminiRequest,
  buildOpenAIChatRequest,
  defaultLocalWorkbenchModels,
  detectUnparsedToolCallMarkup,
  estimateTextTokens,
  extractTextToolCalls,
  fetchWithHeaderTimeout,
  getModelAccessModality,
  HostedProviderCredentialMissingError,
  MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS,
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
  WorkbenchModelNotFoundError,
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

function interruptibleSse(body: string): typeof fetch {
  return (async (_input, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          init?.signal?.addEventListener("abort", () => {
            controller.error(init.signal?.reason);
          }, { once: true });
        },
      }),
      { status: 200 },
    )) as typeof fetch;
}

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

  test("parses catalog token limits when the row declares them", () => {
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
        capabilities: '["text"]',
        context_window: "131072",
        max_output_tokens: "8192",
      },
    ]);

    expect(parsed[0].contextWindow).toBe(131072);
    expect(parsed[0].maxOutputTokens).toBe(8192);
  });

  test("absent, zero, fractional, or malformed limits load as unknown, not as a tiny limit", () => {
    const base = {
      slug: "gemma4",
      display_name: "Gemma 4 27B",
      provider: "ollama",
      api: "openai-completions",
      base_url: "http://localhost:11434/v1",
      tier: "0",
      cost_input: "0",
      cost_output: "0",
      capabilities: '["text"]',
    };
    const [absent] = parseModelRegistryRows([base]);
    const [zero] = parseModelRegistryRows([
      { ...base, context_window: "0", max_output_tokens: "0" },
    ]);
    const [garbage] = parseModelRegistryRows([
      { ...base, context_window: "lots", max_output_tokens: "-1" },
    ]);
    // A fractional value must not floor into a defined zero-token limit.
    const [fractional] = parseModelRegistryRows([
      { ...base, context_window: "0.5", max_output_tokens: "0.9" },
    ]);

    for (const model of [absent, zero, garbage, fractional]) {
      expect(model.contextWindow).toBeUndefined();
      expect(model.maxOutputTokens).toBeUndefined();
    }
  });

  test("derives access modality across local, frontier, aggregator, and subscription providers", () => {
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
        capabilities: '["text"]',
      },
      {
        slug: "claude-sonnet-4-6",
        display_name: "Claude Sonnet 4.6",
        provider: "anthropic",
        api: "anthropic-messages",
        base_url: "https://api.anthropic.com",
        tier: "1",
        cost_input: "3",
        cost_output: "15",
        capabilities: '["text","code"]',
      },
      {
        slug: "deepseek/deepseek-v4-flash",
        display_name: "DeepSeek V4 Flash",
        provider: "openrouter",
        api: "openai-completions",
        base_url: "https://openrouter.ai/api/v1",
        tier: "1",
        cost_input: "0.1",
        cost_output: "0.2",
        capabilities: '["text","code"]',
      },
      {
        slug: "chatgpt-subscription",
        display_name: "ChatGPT Plus",
        provider: "codex-chatgpt",
        api: "openai-completions",
        base_url: "",
        tier: "2",
        cost_input: "1",
        cost_output: "1",
        capabilities: '["text"]',
      },
    ]);

    expect(parsed[0].modality).toBe("local");
    expect(parsed[1].modality).toBe("frontier-hosted");
    expect(parsed[2].modality).toBe("aggregator-hosted");
    expect(parsed[3].modality).toBe("subscription-oauth");
  });
});

describe("getModelAccessModality", () => {
  test("identifies loopback endpoints as local", () => {
    expect(
      getModelAccessModality({
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
    ).toBe("local");
    expect(
      getModelAccessModality({
        provider: "mlx-lm",
        baseUrl: "http://localhost:18080/v1",
      }),
    ).toBe("local");
  });

  test("classifies non-loopback URLs for local providers as custom-hosted", () => {
    expect(
      getModelAccessModality({
        provider: "ollama",
        baseUrl: "https://remote-ollama.example.com/v1",
      }),
    ).toBe("custom-hosted");
    expect(
      getModelAccessModality({
        provider: "litellm",
        baseUrl: "https://litellm.example.com/v1",
      }),
    ).toBe("custom-hosted");
  });

  test("identifies openrouter as aggregator-hosted", () => {
    expect(
      getModelAccessModality({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
    ).toBe("aggregator-hosted");
  });

  test("identifies direct vendor APIs as frontier-hosted", () => {
    expect(
      getModelAccessModality({
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
      }),
    ).toBe("frontier-hosted");
    expect(
      getModelAccessModality({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toBe("frontier-hosted");
    expect(
      getModelAccessModality({
        provider: "google",
        baseUrl: "https://generativelanguage.googleapis.com",
      }),
    ).toBe("frontier-hosted");
  });

  test("classifies non-canonical or proxy vendor endpoints as custom-hosted", () => {
    expect(
      getModelAccessModality({
        provider: "openai",
        baseUrl: "https://internal-proxy.example.com/v1",
      }),
    ).toBe("custom-hosted");
    expect(
      getModelAccessModality({
        provider: "openai",
        baseUrl: "https://api.openai.com/badpath",
      }),
    ).toBe("custom-hosted");
    expect(
      getModelAccessModality({
        provider: "anthropic",
        baseUrl: "http://localhost:8080",
      }),
    ).toBe("custom-hosted");
    expect(
      getModelAccessModality({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/garbage",
      }),
    ).toBe("custom-hosted");
    expect(
      getModelAccessModality({
        provider: "openrouter",
        baseUrl: "https://openrouter.proxy.corp/v1",
      }),
    ).toBe("custom-hosted");
  });

  test("identifies local ACP subscription runner adapters as subscription-oauth", () => {
    expect(
      getModelAccessModality({
        provider: "codex-chatgpt",
        baseUrl: "",
      }),
    ).toBe("subscription-oauth");
    expect(
      getModelAccessModality({
        provider: "claude-acp",
        baseUrl: "http://127.0.0.1:18080/v1",
      }),
    ).toBe("subscription-oauth");
    expect(
      getModelAccessModality({
        provider: "codex-chatgpt",
        baseUrl: "https://remote-proxy.example.com",
      }),
    ).toBe("custom-hosted");
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

  test("uses a local configured default model on a bare turn", () => {
    const selection = selectWorkbenchModel(models, {}, "gemma4:e2b");
    expect(selection.selected.slug).toBe("gemma4:e2b");
    expect(selection.reason).toBe("default_config");
  });

  test("a hosted configured default never rides a bare turn — local by default", () => {
    // Hosted inference is an explicit escalation (modelId/tier + paid consent);
    // a hosted slug in standing config must not become the ambient default.
    const selection = selectWorkbenchModel(models, {}, "claude-haiku-4-5");
    expect(selection.selected.slug).toBe("laguna-xs.2");
    expect(selection.selected.tier).toBe(0);
    expect(selection.reason).toBe("default_local");
  });

  test("a mis-tiered hosted row is never the ambient default", () => {
    // Tier is catalog metadata; locality is decided by provider + loopback
    // base URL. A tier-0 row naming a hosted provider must not ride the
    // ambient default (tier-0 selection skips the paid-consent preflight).
    const misTiered: WorkbenchModel = {
      slug: "hosted-mistiered",
      displayName: "Hosted Mis-tiered",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      tier: 0,
      costInput: 0,
      costOutput: 0,
      capabilities: ["text", "code"],
    };
    const selection = selectWorkbenchModel([misTiered, ...models], {});
    expect(selection.selected.slug).toBe("laguna-xs.2");
    expect(selection.considered).not.toContain("hosted-mistiered");

    // With no genuinely local row at all, the ambient default fails closed
    // rather than routing the mis-tiered hosted row without consent.
    expect(() => selectWorkbenchModel([misTiered], {})).toThrow(
      "Model not found: tier:0",
    );
  });

  test("explicit tier 0 is locality-bounded too — a mis-tiered hosted row never routes", () => {
    // Tier 0 is the LOCAL tier and its selections skip the paid-consent
    // preflight, so even an explicit --tier 0 request must not land on a
    // hosted provider: the local candidate wins, and with no local candidate
    // the request fails closed instead of running hosted without consent.
    const misTiered: WorkbenchModel = {
      slug: "hosted-mistiered",
      displayName: "Hosted Mis-tiered",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      tier: 0,
      costInput: 0,
      costOutput: 0,
      capabilities: ["text", "code"],
    };
    const selection = selectWorkbenchModel([misTiered, ...models], { tier: 0 });
    expect(selection.selected.slug).toBe("laguna-xs.2");
    expect(selection.reason).toBe("explicit_tier");
    expect(selection.considered).not.toContain("hosted-mistiered");

    expect(() => selectWorkbenchModel([misTiered], { tier: 0 })).toThrow(
      "Model not found: tier:0",
    );

    // Hosted tiers stay tier-based: explicit tier 1 still routes the priced
    // hosted row (and remains consent-gated downstream).
    const hosted = selectWorkbenchModel([misTiered, ...models], { tier: 1 });
    expect(hosted.selected.slug).toBe("claude-haiku-4-5");
  });

  test("hint routing is bounded by locality like the bare default", () => {
    // A hint names a capability, not a model — it is ambient routing, not a
    // hosted escalation, so a mis-tiered hosted row (tier 0, code-capable)
    // must not satisfy it even when no local row carries the capability.
    const misTieredCoder: WorkbenchModel = {
      slug: "hosted-mistiered-coder",
      displayName: "Hosted Mis-tiered Coder",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      tier: 0,
      costInput: 0,
      costOutput: 0,
      capabilities: ["text", "code"],
    };
    const noLocalCoder = models.filter((model) => model.slug === "gemma4:e2b");
    const selection = selectWorkbenchModel(
      [misTieredCoder, ...noLocalCoder],
      { hint: "code" },
    );
    expect(selection.selected.slug).toBe("gemma4:e2b");
    expect(selection.reason).toBe("hint_code_fallback_local");
    expect(selection.considered).not.toContain("hosted-mistiered-coder");
  });

  test("a hosted configured default still routes when named explicitly", () => {
    const selection = selectWorkbenchModel(
      models,
      { modelId: "claude-haiku-4-5" },
      "claude-haiku-4-5",
    );
    expect(selection.selected.slug).toBe("claude-haiku-4-5");
    expect(selection.reason).toBe("explicit_model_id");
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

  test("can carry an explicit completion ceiling", () => {
    const body = buildOpenAIChatRequest("hosted", "system", "hello", true, {
      maxCompletionTokens: 8192,
    });

    expect(body.max_completion_tokens).toBe(8192);
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

  test("keeps historical tool calls wire-safe for a no-tools conclusion", () => {
    const tools = [
      { name: "memory.read", description: "a", parameters: {} },
      { name: "memory_read", description: "b", parameters: {} },
      {
        name: "x".repeat(64) + ".second",
        description: "c",
        parameters: {},
      },
      {
        name: "x".repeat(64) + ".third",
        description: "d",
        parameters: {},
      },
    ];
    const messages = [{
      role: "assistant" as const,
      content: "Gathering context.",
      toolCalls: tools.map((tool, index) => ({
        id: `call-${index}`,
        name: tool.name,
        arguments: {},
      })),
    }];
    const gather = buildOpenAIChatRequest("model", "system", "seed", false, {
      tools,
      messages,
    });
    const forced = buildOpenAIChatRequest("model", "system", "seed", false, {
      historyTools: tools,
      messages,
    });

    expect(forced).not.toHaveProperty("tools");
    expect(forced).not.toHaveProperty("tool_choice");
    const expectedWireNames = [
      "memory_read",
      "memory_read_1",
      "x".repeat(64),
      `${"x".repeat(60)}_3`,
    ];
    expect(gather.tools?.map((tool) => tool.function.name)).toEqual(
      expectedWireNames,
    );
    expect(forced.messages[1]?.tool_calls?.map((call) => call.function.name))
      .toEqual(expectedWireNames);
    expect(expectedWireNames.every((name) => name.length <= 64)).toBe(true);
    expect(messages[0].toolCalls.map((call) => call.name)).toEqual(
      tools.map((tool) => tool.name),
    );
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

  test("extracts plaintext reasoning without duplicating legacy aliases", () => {
    const event = parseOpenAIChatStreamLine(
      'data: {"choices":[{"delta":{"reasoning":"duplicate","reasoning_details":[{"type":"reasoning.text","text":"private thought"},{"type":"reasoning.encrypted","data":"opaque"}]}}],"usage":{"completion_tokens":9,"completion_tokens_details":{"reasoning_tokens":7}}}',
    );

    expect(event?.reasoningDelta).toBe("private thought");
    expect(event?.usage).toEqual({
      completion_tokens: 9,
      completion_tokens_details: { reasoning_tokens: 7 },
    });
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

  test("recovers tool markup at the candidate limit", () => {
    const text = Array.from(
      { length: 64 },
      (_, index) =>
        `<function=list_files><parameter=path>${index}</parameter></function>`,
    ).join("");
    const { toolCalls, cleaned } = extractTextToolCalls(text);
    expect(toolCalls).toHaveLength(64);
    expect(cleaned).toBe("");
  });

  test("leaves a large batch of unwrapped offered-function examples as prose", () => {
    const text = Array.from(
      { length: 10_000 },
      (_, index) =>
        `<function=list_files><parameter=path>${index}</parameter></function>`,
    ).join("\n");
    const { toolCalls, cleaned } = extractTextToolCalls(
      text,
      new Set(["list_files"]),
    );
    expect(toolCalls).toEqual([]);
    expect(cleaned).toBe(text);
  });

  test("leaves excessive incomplete function candidates as prose", () => {
    const text = "<function=list_files".repeat(10_000);
    const { toolCalls, cleaned } = extractTextToolCalls(text);
    expect(toolCalls).toEqual([]);
    expect(cleaned).toBe(text);
  });

  test("leaves excessive incomplete parameter candidates as prose", () => {
    const text = `<function=list_files>${
      "<parameter=path".repeat(10_000)
    }</function>`;
    const { toolCalls, cleaned } = extractTextToolCalls(text);
    expect(toolCalls).toEqual([]);
    expect(cleaned).toBe(text);
  });
});

describe("detectUnparsedToolCallMarkup", () => {
  test("requires at least two unmatched openings", () => {
    expect(
      detectUnparsedToolCallMarkup(
        "The literal marker is <tool_call> in this sentence.",
      ),
    ).toBeUndefined();
    expect(
      detectUnparsedToolCallMarkup(
        "Examples: <tool_call></tool_call> and <tool_call></tool_call>.",
      ),
    ).toBeUndefined();
    expect(
      detectUnparsedToolCallMarkup(
        "One stray <tool_call> plus <tool_call></tool_call>.",
      ),
    ).toBeUndefined();
  });

  test("does not classify a direct input beyond the accepted-response bound", () => {
    const opening = "<tool_call>";
    const closing = "</tool_call>";
    expect(MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS).toBe(4 * 1_024 * 1_024);
    const atBound = opening.repeat(2) + "x".repeat(
      MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS - (2 * opening.length),
    );
    const beyondBound = `${atBound}x`;
    const wrapperStraddlingBound = opening + "x".repeat(
      MAX_UNPARSED_TOOL_CALL_SCAN_CHARACTERS - (2 * opening.length),
    ) + opening + closing;

    expect(detectUnparsedToolCallMarkup(atBound)).toEqual({
      count: 2,
      countIsLowerBound: false,
    });
    expect(detectUnparsedToolCallMarkup(beyondBound)).toBeUndefined();
    expect(detectUnparsedToolCallMarkup(wrapperStraddlingBound))
      .toBeUndefined();
  });

  test("counts unmatched openings before capping the reported count", () => {
    expect(
      detectUnparsedToolCallMarkup(
        "</tool_call></tool_call><tool_call><tool_call>",
      ),
    ).toEqual({ count: 2, countIsLowerBound: false });
    expect(
      detectUnparsedToolCallMarkup(
        "<tool_call>".repeat(71) + "</tool_call>".repeat(70),
      ),
    ).toBeUndefined();
    expect(
      detectUnparsedToolCallMarkup(
        "<tool_call>".repeat(71) + "</tool_call>".repeat(1),
      ),
    ).toEqual({ count: 64, countIsLowerBound: true });
    expect(
      detectUnparsedToolCallMarkup(
        "<tool_call>".repeat(72) + "</tool_call>".repeat(70),
      ),
    ).toEqual({ count: 2, countIsLowerBound: false });
    expect(
      detectUnparsedToolCallMarkup(
        "<tool_call>".repeat(71) + "</tool_call>".repeat(71),
      ),
    ).toBeUndefined();
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

  test("refuses redirects on the provider request (no off-box body egress via 307/308)", async () => {
    let capturedRedirect: RequestRedirect | undefined;
    await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "laguna-xs.2" },
      models: defaultLocalWorkbenchModels(),
      fetchFn: (_input, init) => {
        capturedRedirect = init?.redirect;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
            { status: 200 },
          ),
        );
      },
    });
    // Only the initial base URL is validated as loopback; with redirect: "error"
    // the platform fetch throws on a 307/308 instead of re-POSTing the (private)
    // transcript body to the redirect target off loopback.
    expect(capturedRedirect).toBe("error");
  });

  test("bounds an OpenAI-compatible error response body", async () => {
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      fetchFn: async () =>
        new Response("x".repeat(4 * 1024 * 1024 + 1), { status: 500 }),
    })).rejects.toThrow("Provider response exceeded the adapter limit");
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

  test("lower-bounds a completed stream's early usage with later text", async () => {
    const laterText = "x".repeat(400);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: async () =>
        new Response(
          `data: ${
            JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 7, completion_tokens: 1 },
            })
          }\n` +
            `data: ${
              JSON.stringify({
                choices: [{
                  delta: { content: laterText },
                  finish_reason: "stop",
                }],
              })
            }\n` +
            "data: [DONE]\n",
          { status: 200 },
        ),
    });

    expect(result).toMatchObject({
      text: laterText,
      stopReason: "stop",
      usage: { input: 7, output: 101 },
    });
  });

  test("does not let an equal usage-only total erase intervening text", async () => {
    const laterText = "x".repeat(400);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: async () =>
        new Response(
          `data: ${
            JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 7, completion_tokens: 100 },
            })
          }\n` +
            `data: ${
              JSON.stringify({
                choices: [{ delta: { content: laterText } }],
              })
            }\n` +
            `data: ${
              JSON.stringify({
                choices: [],
                usage: { prompt_tokens: 7, completion_tokens: 100 },
              })
            }\n` +
            "data: [DONE]\n",
          { status: 200 },
        ),
    });

    expect(result.usage).toMatchObject({ input: 7, output: 200 });
  });

  test("does not let an earlier finish enable a stale equal usage frame", async () => {
    const laterText = "x".repeat(400);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: async () =>
        new Response(
          `data: ${
            JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 7, completion_tokens: 100 },
            })
          }\n` +
            `data: ${
              JSON.stringify({
                choices: [{ delta: { content: laterText } }],
              })
            }\n` +
            `data: ${
              JSON.stringify({
                choices: [{ delta: {}, finish_reason: "stop" }],
              })
            }\n` +
            `data: ${
              JSON.stringify({
                choices: [],
                usage: { prompt_tokens: 7, completion_tokens: 100 },
              })
            }\n` +
            "data: [DONE]\n",
          { status: 200 },
        ),
    });

    expect(result.usage).toMatchObject({ input: 7, output: 200 });
  });

  test("preserves HTTP status diagnostics for a bodyless error response", async () => {
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      fetchFn: async () => new Response(null, { status: 500 }),
    })).rejects.toThrow("Model request failed for gemma4:e2b: HTTP 500");
  });

  test("trusts final provider usage over the character estimate", async () => {
    const text = "x".repeat(400);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: async () =>
        new Response(
          `data: ${
            JSON.stringify({
              choices: [{
                delta: { content: text },
                finish_reason: "stop",
              }],
              usage: { prompt_tokens: 7, completion_tokens: 1 },
            })
          }\n` +
            "data: [DONE]\n",
          { status: 200 },
        ),
    });

    expect(result.usage).toMatchObject({ input: 7, output: 1 });
  });

  test("an aborted stream returns partial text and observed usage without tool calls", async () => {
    const abortController = new AbortController();
    const generated = "partial<tool_call><function=list_files>" +
      "<parameter=path>.</parameter></function></tool_call>";
    let sawDelta!: () => void;
    const firstDelta = new Promise<void>((resolve) => {
      sawDelta = resolve;
    });
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: () => sawDelta(),
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{
              delta: {
                content: generated,
              },
            }],
          })
        }\n` +
          `data: ${
            JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 7, completion_tokens: 2 },
            })
          }`,
      ),
    });

    await firstDelta;
    abortController.abort();
    const result = await pending;

    expect(result).toMatchObject({
      text: "partial",
      stopReason: "aborted",
      usage: { input: 7, output: estimateTextTokens(generated) },
    });
    expect(result.toolCalls).toBeUndefined();
  });

  test("abort fallback meters structured tool-call fragments", async () => {
    const abortController = new AbortController();
    const name = "write_file";
    const argumentsFragment = `{"content":"${"x".repeat(8_192)}"}`;
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name,
        description: "Write a file.",
        parameters: { type: "object" },
      }],
      onTextDelta: () => {},
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "tc-1",
                  type: "function",
                  function: { name, arguments: argumentsFragment },
                }],
              },
            }],
          })
        }\n`,
      ),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;

    expect(result).toMatchObject({
      stopReason: "aborted",
      usage: {
        output: Math.ceil((name.length + argumentsFragment.length) / 4),
      },
    });
    expect(result.toolCalls).toBeUndefined();
  });

  test("an aborted stream preserves excessive complete tool markup as prose", async () => {
    const abortController = new AbortController();
    const markup = Array.from(
      { length: 65 },
      (_, index) =>
        `<tool_call><function=list_files><parameter=path>${index}</parameter></function></tool_call>`,
    ).join("");
    const deltas: string[] = [];
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({ choices: [{ delta: { content: markup } }] })
        }\n`,
      ),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;

    expect(deltas).toEqual([markup]);
    expect(result).toMatchObject({ text: markup, stopReason: "aborted" });
    expect(result.toolCalls).toBeUndefined();
  });

  test("an aborted stream retains usage fields split across frames", async () => {
    const abortController = new AbortController();
    let sawDelta!: () => void;
    const firstDelta = new Promise<void>((resolve) => {
      sawDelta = resolve;
    });
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => sawDelta(),
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: "partial" } }],
            usage: { prompt_tokens: 100 },
          })
        }\n` +
          `data: ${
            JSON.stringify({
              choices: [],
              usage: { completion_tokens: 20 },
            })
          }\n`,
      ),
    });

    await firstDelta;
    abortController.abort();
    const result = await pending;

    expect(result.usage).toMatchObject({ input: 100, output: 20 });
  });

  test("an abort observed before dispatch records no provider call usage", async () => {
    const abortController = new AbortController();
    abortController.abort();
    let fetchCalled = false;

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      fetchFn: async () => {
        fetchCalled = true;
        return new Response();
      },
    });

    expect(fetchCalled).toBe(false);
    expect(result.stopReason).toBe("aborted");
    expect(result.requestDispatched).toBe(false);
    expect(result.usage).toMatchObject({
      input: 0,
      output: 0,
      cost: { total: 0 },
    });
  });

  test("a concurrent abort does not mask a malformed provider frame", async () => {
    const abortController = new AbortController();
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      fetchFn: async () => {
        abortController.abort();
        return new Response("data: {malformed}\n\n", { status: 200 });
      },
    })).rejects.toBeInstanceOf(SyntaxError);
  });

  test("a concurrent abort does not mask a truncated frame at clean EOF", async () => {
    const abortController = new AbortController();
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      fetchFn: async () => {
        abortController.abort();
        return new Response('data: {"choices":[');
      },
    })).rejects.toBeInstanceOf(SyntaxError);
  });

  test("an abort does not suppress a complete malformed buffered frame", async () => {
    const abortController = new AbortController();
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      fetchFn: interruptibleSse("data: {malformed}"),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();

    await expect(pending).rejects.toBeInstanceOf(SyntaxError);
  });

  test("an abort does not suppress a buffered frame with mismatched delimiters", async () => {
    const abortController = new AbortController();
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      fetchFn: interruptibleSse('data: {"choices":[}'),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();

    await expect(pending).rejects.toBeInstanceOf(SyntaxError);
  });

  test("an abort does not suppress an invalid token inside an unfinished object", async () => {
    const abortController = new AbortController();
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      fetchFn: interruptibleSse('data: {"choices": @'),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();

    await expect(pending).rejects.toBeInstanceOf(SyntaxError);
  });

  test("a concurrent independent AbortError is not attributed to the caller", async () => {
    const abortController = new AbortController();
    const independent = new DOMException("independent", "AbortError");
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      fetchFn: async () => {
        abortController.abort();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(independent);
            },
          }),
          { status: 200 },
        );
      },
    })).rejects.toBe(independent);
  });

  test("a provider terminal error outranks a concurrent cancellation", async () => {
    const abortController = new AbortController();
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      fetchFn: interruptibleSse(
        'data: {"choices":[{"delta":{},"finish_reason":"error"}]}\n',
      ),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();

    await expect(pending).resolves.toMatchObject({
      stopReason: "error",
    });
  });

  test("a top-level provider error envelope fails the stream", async () => {
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"partial"}}]}\n' +
            'data: {"error":{"message":"upstream failed"}}\n',
          { status: 200 },
        ),
    })).rejects.toThrow("Provider stream returned an error envelope");
  });

  test("a top-level provider error envelope fails a buffered response", async () => {
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      fetchFn: async () =>
        Response.json({ error: { message: "quota exceeded" } }),
    })).rejects.toThrow("Provider response returned an error envelope");
  });

  test("a provider terminal error outranks recoverable textual tool markup", async () => {
    const deltas: string[] = [];
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "write_file",
        description: "Write a file.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: async () =>
        new Response(
          `data: ${
            JSON.stringify({
              choices: [{
                delta: {
                  content:
                    "<tool_call><function=write_file><parameter=path>notes.md</parameter></function></tool_call>",
                },
                finish_reason: "error",
              }],
            })
          }\n`,
          { status: 200 },
        ),
    });

    expect(result.stopReason).toBe("error");
    expect(result.text).toBe("");
    expect(deltas).toEqual([]);
    expect(result.toolCalls).toBeUndefined();
  });

  test("a buffered provider error cannot be reclassified as textual tool use", async () => {
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "write_file",
        description: "Write a file.",
        parameters: { type: "object" },
      }],
      fetchFn: async () =>
        Response.json({
          choices: [{
            message: {
              content:
                "<tool_call><function=write_file><parameter=path>notes.md</parameter></function></tool_call>",
            },
            finish_reason: "error",
          }],
        }),
    });

    expect(result.stopReason).toBe("error");
    expect(result.toolCalls).toBeUndefined();
  });

  test("an abort ignores only an incomplete buffered frame", async () => {
    const abortController = new AbortController();
    let sawDelta!: () => void;
    const firstDelta = new Promise<void>((resolve) => {
      sawDelta = resolve;
    });
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => sawDelta(),
      fetchFn: interruptibleSse(
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n' +
          'data: {"choices":[',
      ),
    });

    await firstDelta;
    abortController.abort();

    await expect(pending).resolves.toMatchObject({
      text: "partial",
      stopReason: "aborted",
    });
  });

  test("an aborted stream strips a long incomplete leaked tool-call suffix", async () => {
    const abortController = new AbortController();
    let sawDelta!: () => void;
    const firstDelta = new Promise<void>((resolve) => {
      sawDelta = resolve;
    });
    const generated =
      "partial<tool_call><function=list_files><parameter=path>" +
      "x".repeat(1024);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: () => sawDelta(),
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{
              delta: {
                content: generated,
              },
            }],
          })
        }\n`,
      ),
    });

    await firstDelta;
    abortController.abort();
    const result = await pending;

    expect(result.text).toBe("partial");
    expect(result.stopReason).toBe("aborted");
    expect(result.toolCalls).toBeUndefined();
    expect(result.usage.output).toBe(estimateTextTokens(generated));
  });

  test("an aborted stream preserves an ambiguous literal wrapper suffix", async () => {
    const abortController = new AbortController();
    let sawDelta!: () => void;
    const firstDelta = new Promise<void>((resolve) => {
      sawDelta = resolve;
    });
    const text = "explain <tool_call>";
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain syntax",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: () => sawDelta(),
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: text } }],
          })
        }\n`,
      ),
    });

    await firstDelta;
    abortController.abort();
    const result = await pending;

    expect(result.text).toBe(text);
    expect(result.stopReason).toBe("aborted");
    expect(result.toolCalls).toBeUndefined();
  });

  test("an abort ignores a truncated buffered JSON array at the input boundary", async () => {
    const abortController = new AbortController();
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      fetchFn: interruptibleSse('data: {"choices":[1,2'),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();

    await expect(pending).resolves.toMatchObject({
      stopReason: "aborted",
    });
  });

  test("an aborted stream preserves whitespace before stripped tool markup", async () => {
    const abortController = new AbortController();
    let sawDelta!: () => void;
    const firstDelta = new Promise<void>((resolve) => {
      sawDelta = resolve;
    });
    const prefix = "partial  \n";
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: () => sawDelta(),
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{
              delta: {
                content:
                  `${prefix}<tool_call><function=list_files><parameter=path>`,
              },
            }],
          })
        }\n`,
      ),
    });

    await firstDelta;
    abortController.abort();
    const result = await pending;

    expect(result.text).toBe(prefix);
    expect(result.stopReason).toBe("aborted");
  });

  test("an aborted stream preserves tool-like prose when no matching tool was offered", async () => {
    const abortController = new AbortController();
    let sawDelta!: () => void;
    const firstDelta = new Promise<void>((resolve) => {
      sawDelta = resolve;
    });
    const text =
      "The syntax is <tool_call><function=foo></function></tool_call>.";
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: () => sawDelta(),
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: text } }],
          })
        }\n`,
      ),
    });

    await firstDelta;
    abortController.abort();
    const result = await pending;

    expect(result.text).toBe(text);
    expect(result.stopReason).toBe("aborted");
  });

  test("an aborted no-tools stream preserves complete function-like prose", async () => {
    const abortController = new AbortController();
    let sawDelta!: () => void;
    const received = new Promise<void>((resolve) => {
      sawDelta = resolve;
    });
    const text = "Use <function=foo> literally";
    const deltas: string[] = [];
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      onTextDelta: (delta) => {
        deltas.push(delta);
        sawDelta();
      },
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: text } }],
          })
        }\n`,
      ),
    });

    await received;
    abortController.abort();
    const result = await pending;

    expect(deltas.join("")).toBe(text);
    expect(result.text).toBe(text);
    expect(result.stopReason).toBe("aborted");
  });

  test("an aborted stream releases an ambiguous tool prefix once later text disproves it", async () => {
    const abortController = new AbortController();
    let sawDelta!: () => void;
    const received = new Promise<void>((resolve) => {
      sawDelta = resolve;
    });
    const deltas: string[] = [];
    const text = "Use <function=list_users> literally";
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => {
        deltas.push(delta);
        if (deltas.join("") === text) sawDelta();
      },
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: "Use <function=list_" } }],
          })
        }\n` +
          `data: ${
            JSON.stringify({
              choices: [{ delta: { content: "users> literally" } }],
            })
          }\n`,
      ),
    });

    await received;
    abortController.abort();
    const result = await pending;

    expect(deltas.join("")).toBe(text);
    expect(result.text).toBe(text);
    expect(result.stopReason).toBe("aborted");
  });

  test("releases a malformed wrapped opening after a bounded prefix", async () => {
    const abortController = new AbortController();
    let received!: () => void;
    const sawText = new Promise<void>((resolve) => {
      received = resolve;
    });
    const text = "<tool_call><function=list_files " + "x".repeat(128);
    const deltas: string[] = [];
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => {
        deltas.push(delta);
        if (deltas.join("") === text) received();
      },
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: text } }],
          })
        }\n`,
      ),
    });

    await sawText;
    abortController.abort();
    const result = await pending;

    expect(deltas.join("")).toBe(text);
    expect(result.text).toBe(text);
  });

  test("an aborted stream preserves an empty function-name prefix", async () => {
    const abortController = new AbortController();
    let received!: () => void;
    const sawText = new Promise<void>((resolve) => {
      received = resolve;
    });
    const text = "Explain <function=";
    const deltas: string[] = [];
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => {
        deltas.push(delta);
        if (deltas.join("") === text) received();
      },
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: text } }],
          })
        }\n`,
      ),
    });

    await sawText;
    abortController.abort();
    const result = await pending;

    expect(deltas.join("")).toBe(text);
    expect(result.text).toBe(text);
  });

  test("a pre-header abort records elapsed time without claiming headers arrived", async () => {
    const abortController = new AbortController();
    const nowValues = [105, 130];
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      now: () => nowValues.shift() ?? 130,
      fetchFn: ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason);
          }, { once: true });
        })) as typeof fetch,
    });

    abortController.abort();
    const result = await pending;

    expect(result.stopReason).toBe("aborted");
    expect(result.timings).toEqual({
      responseHeadersMs: 0,
      totalMs: 25,
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

  test("removes textual tool markup when a structured call is also present", async () => {
    const deltas: string[] = [];
    const text =
      "before <tool_call><function=list_files><parameter=depth>1</parameter><parameter=path>.</parameter></function></tool_call> after";
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list the files",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([
        {
          choices: [{
            delta: {
              content: text,
              tool_calls: [{
                index: 0,
                id: "tc-1",
                type: "function",
                function: {
                  name: "list_files",
                  arguments: '{"path":".","depth":1}',
                },
              }],
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    });

    expect(deltas.join("")).toBe("before  after");
    expect(result.text).toBe("before  after");
    expect(result.toolCalls).toEqual([
      {
        id: "tc-1",
        name: "list_files",
        arguments: { path: ".", depth: 1 },
      },
    ]);
  });

  test("retains a distinct textual call alongside a structured call", async () => {
    const text =
      "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>";
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "read and list",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [
        {
          name: "read_file",
          description: "Read a file.",
          parameters: { type: "object" },
        },
        {
          name: "list_files",
          description: "List files.",
          parameters: { type: "object" },
        },
      ],
      onTextDelta: () => {},
      fetchFn: sseStream([
        {
          choices: [{
            delta: {
              content: text,
              tool_calls: [{
                index: 0,
                id: "tc-1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"README.md"}',
                },
              }],
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    });

    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([
      { id: "tc-1", name: "read_file", arguments: { path: "README.md" } },
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
  });

  test("rejects deeply nested structured arguments before mixed-call recovery", async () => {
    let deepArguments = '{"leaf":true}';
    for (let depth = 0; depth < 10_000; depth += 1) {
      deepArguments = `{"nested":${deepArguments}}`;
    }
    const text =
      "<tool_call><function=read_file><parameter=path>other.md</parameter></function></tool_call>";
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "read and list",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "read_file",
        description: "Read a file.",
        parameters: { type: "object" },
      }],
      onTextDelta: () => {},
      fetchFn: sseStream([
        {
          choices: [{
            delta: {
              content: text,
              tool_calls: [{
                index: 0,
                id: "tc-1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: `{"payload":${deepArguments}}`,
                },
              }],
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    });

    await expect(pending).rejects.toThrow(
      "Provider returned oversized tool arguments",
    );
  });

  test("rejects overly wide structured arguments before mixed-call recovery", async () => {
    const wideArguments = `{
      ${
      Array.from({ length: 10_000 }, (_, index) => `"k${index}":${index}`).join(
        ",",
      )
    }
    }`;
    const text =
      "<tool_call><function=read_file><parameter=path>other.md</parameter></function></tool_call>";
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "read",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "read_file",
        description: "Read a file.",
        parameters: { type: "object" },
      }],
      onTextDelta: () => {},
      fetchFn: sseStream([
        {
          choices: [{
            delta: {
              content: text,
              tool_calls: [{
                index: 0,
                id: "tc-1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: `{"payload":${wideArguments}}`,
                },
              }],
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    });

    await expect(pending).rejects.toThrow(
      "Provider returned oversized tool arguments",
    );
  });

  test("over-budget textual tool arguments remain prose", async () => {
    let deep = "true";
    for (let depth = 0; depth < 65; depth += 1) deep = `{"nested":${deep}}`;
    const wide = `{
      ${
      Array.from({ length: 1_025 }, (_, index) => `"k${index}":${index}`).join(
        ",",
      )
    }
    }`;
    const long = JSON.stringify("x".repeat(64 * 1_024));

    for (const raw of [deep, wide, long]) {
      const markup =
        `<tool_call><function=read_file><parameter=payload>${raw}</parameter></function></tool_call>`;
      const deltas: string[] = [];
      const result = await runWorkbenchTurn({
        systemPrompt: "system",
        prompt: "read",
        routing: { modelId: "gemma4:e2b" },
        models,
        tools: [{
          name: "read_file",
          description: "Read a file.",
          parameters: { type: "object" },
        }],
        onTextDelta: (delta) => deltas.push(delta),
        fetchFn: sseStream([{
          choices: [{
            delta: { content: markup },
            finish_reason: "stop",
          }],
        }]),
      });

      expect(result.text).toBe(markup);
      expect(result.toolCalls).toBeUndefined();
      expect(deltas).toEqual([markup]);
    }
  });

  test("flags repeated unmatched tool-call openings without creating calls", async () => {
    const malformed = Array.from(
      { length: 71 },
      (_, index) =>
        `<tool_call>\n${index % 2 === 0 ? "edit_file" : "read_file"}\n`,
    ).join("") + "</tool_call>";
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "make the change",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [
        {
          name: "edit_file",
          description: "Edit a file.",
          parameters: { type: "object" },
        },
        {
          name: "read_file",
          description: "Read a file.",
          parameters: { type: "object" },
        },
      ],
      fetchFn: async () =>
        Response.json({
          choices: [{
            message: { content: malformed },
            finish_reason: "stop",
          }],
        }),
    });

    expect(result.text).toBe(malformed);
    expect(result.toolCalls).toBeUndefined();
    expect(result.unparsedToolCallMarkup).toEqual({
      count: 64,
      countIsLowerBound: true,
    });
  });

  test("flags streamed unparsed openings while preserving visible text", async () => {
    const malformed =
      "before <tool_call>\nedit_file\n<tool_call>\nread_file\n after";
    const deltas: string[] = [];
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "make the change",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "edit_file",
        description: "Edit a file.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([{
        choices: [{
          delta: { content: malformed },
          finish_reason: "stop",
        }],
      }]),
    });

    expect(deltas.join("")).toBe(malformed);
    expect(result.text).toBe(malformed);
    expect(result.toolCalls).toBeUndefined();
    expect(result.unparsedToolCallMarkup).toEqual({
      count: 2,
      countIsLowerBound: false,
    });
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

  test("rejects oversized structured tool arguments before parsing them", async () => {
    const oversized = `{"payload":"${"x".repeat(64 * 1_024)}"}`;
    const common = {
      systemPrompt: "system",
      prompt: "read a file",
      routing: { modelId: "gemma4:e2b" },
      models,
    };

    await expect(runWorkbenchTurn({
      ...common,
      fetchFn: async () =>
        Response.json({
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: "tc-buffered",
                type: "function",
                function: { name: "read_file", arguments: oversized },
              }],
            },
            finish_reason: "tool_calls",
          }],
        }),
    })).rejects.toThrow("Provider returned oversized tool arguments");

    await expect(runWorkbenchTurn({
      ...common,
      onTextDelta: () => {},
      fetchFn: sseStream([{
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "tc-streamed",
              type: "function",
              function: { name: "read_file", arguments: oversized },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }]),
    })).rejects.toThrow("Provider returned oversized tool arguments");
  });

  test("bounds buffered and streamed OpenAI-compatible responses before JSON parsing", async () => {
    const oversized = `{"payload":"${"x".repeat(4 * 1024 * 1024)}"}`;
    const response = {
      choices: [{
        message: {
          content: "",
          tool_calls: [{
            id: "tc-large",
            type: "function",
            function: { name: "read_file", arguments: oversized },
          }],
        },
        finish_reason: "tool_calls",
      }],
    };
    const common = {
      systemPrompt: "system",
      prompt: "read a file",
      routing: { modelId: "gemma4:e2b" },
      models,
    };

    await expect(runWorkbenchTurn({
      ...common,
      fetchFn: async () => Response.json(response),
    })).rejects.toThrow("Provider response exceeded the adapter limit");

    await expect(runWorkbenchTurn({
      ...common,
      onTextDelta: () => {},
      fetchFn: sseStream([response]),
    })).rejects.toThrow("Provider response exceeded the adapter limit");
  });

  test("bounds response fragmentation in buffered and streamed modes", async () => {
    const fragmentedResponse = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < 8_193; index++) {
              controller.enqueue(new Uint8Array([0x20]));
            }
          },
        }),
      );
    const common = {
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
    };

    await expect(runWorkbenchTurn({
      ...common,
      fetchFn: async () => fragmentedResponse(),
    })).rejects.toThrow("Provider response exceeded the adapter limit");

    await expect(runWorkbenchTurn({
      ...common,
      onTextDelta: () => {},
      fetchFn: async () => fragmentedResponse(),
    })).rejects.toThrow("Provider response exceeded the adapter limit");
  });

  test("does not count zero-byte reads toward the fragmentation limit", async () => {
    const responseAfterEmptyReads = (body: string) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < 8_193; index++) {
              controller.enqueue(new Uint8Array());
            }
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
      );
    const common = {
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
    };
    const response = {
      choices: [{
        message: { content: "ok" },
        finish_reason: "stop",
      }],
    };

    const buffered = await runWorkbenchTurn({
      ...common,
      fetchFn: async () => responseAfterEmptyReads(JSON.stringify(response)),
    });
    const streamed = await runWorkbenchTurn({
      ...common,
      onTextDelta: () => {},
      fetchFn: async () =>
        responseAfterEmptyReads(`data: ${JSON.stringify(response)}\n\n`),
    });

    expect(buffered.text).toBe("ok");
    expect(streamed.text).toBe("ok");
  });

  test("bounds total response reads even when every read is empty", async () => {
    const emptyReads = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < 16_385; index++) {
              controller.enqueue(new Uint8Array());
            }
          },
        }),
      );
    const common = {
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
    };

    await expect(runWorkbenchTurn({
      ...common,
      fetchFn: async () => emptyReads(),
    })).rejects.toThrow("Provider response exceeded the adapter limit");
    await expect(runWorkbenchTurn({
      ...common,
      onTextDelta: () => {},
      fetchFn: async () => emptyReads(),
    })).rejects.toThrow("Provider response exceeded the adapter limit");
  });

  test("does not wait for reader cancellation before rejecting a response limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      },
      cancel() {
        return new Promise<void>(() => {});
      },
    });
    const rejection = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: async () => new Response(body),
    });

    await expect(Promise.race([
      rejection,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("reader cancellation blocked")), 100)
      ),
    ])).rejects.toThrow("Provider response exceeded the adapter limit");
  });

  test("bounds streamed structured-call count and aggregate name fragments", async () => {
    const calls = Array.from({ length: 129 }, (_, index) => ({
      index,
      id: `tc-${index}`,
      type: "function",
      function: { name: "read_file", arguments: "{}" },
    }));
    const common = {
      systemPrompt: "system",
      prompt: "read files",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
    };

    await expect(runWorkbenchTurn({
      ...common,
      fetchFn: sseStream([{
        choices: [{ delta: { tool_calls: calls } }],
      }]),
    })).rejects.toThrow("Provider returned too many structured tool calls");

    await expect(runWorkbenchTurn({
      ...common,
      fetchFn: sseStream([{
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: "x".repeat(64 * 1024 + 1) },
            }],
          },
        }],
      }]),
    })).rejects.toThrow("Provider returned too many structured tool calls");
  });

  test("cancels the response reader when mid-stream validation fails", async () => {
    let cancelled = false;
    const calls = Array.from({ length: 129 }, (_, index) => ({
      index,
      function: { name: "read_file", arguments: "{}" },
    }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${
            JSON.stringify({
              choices: [{ delta: { tool_calls: calls } }],
            })
          }\n\n`,
        ));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "read files",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: async () => new Response(body),
    })).rejects.toThrow("Provider returned too many structured tool calls");
    expect(cancelled).toBe(true);
  });

  test("cancels the response reader when a complete SSE line is malformed", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {oops}\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: async () => new Response(body),
    })).rejects.toBeInstanceOf(SyntaxError);
    expect(cancelled).toBe(true);
  });

  test("cancels an open response as soon as tool arguments exceed the limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${
            JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    function: {
                      name: "read_file",
                      arguments: "x".repeat(64 * 1024 + 1),
                    },
                  }],
                },
              }],
            })
          }\n\n`,
        ));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "read a file",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "read_file",
        description: "Read a file.",
        parameters: { type: "object" },
      }],
      onTextDelta: () => {},
      fetchFn: async () => new Response(body),
    })).rejects.toThrow("Provider returned oversized tool arguments");
    expect(cancelled).toBe(true);
  });

  test("accumulates fragmented tool-call names by index", async () => {
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "write a file",
      routing: { modelId: "gemma4:e2b" },
      models,
      onTextDelta: () => {},
      fetchFn: sseStream([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "tc-3",
                type: "function",
                function: { name: "write" },
              }],
            },
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: {
                  name: "_file",
                  arguments: '{"path":"notes.md"}',
                },
              }],
            },
            finish_reason: "tool_calls",
          }],
        },
      ]),
    });

    expect(result.toolCalls).toEqual([{
      id: "tc-3",
      name: "write_file",
      arguments: { path: "notes.md" },
    }]);
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
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([
        { choices: [{ delta: { content: "I'll check. " } }] },
        {
          choices: [{
            delta: {
              content:
                "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>",
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

  test("recovers multiple textual calls from SSE without warning metadata", async () => {
    const markup =
      "<tool_call><function=read_file><parameter=path>README.md</parameter></function></tool_call>" +
      "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>";
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "read and list",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [
        {
          name: "read_file",
          description: "Read a file.",
          parameters: { type: "object" },
        },
        {
          name: "list_files",
          description: "List files.",
          parameters: { type: "object" },
        },
      ],
      onTextDelta: () => {},
      fetchFn: sseStream([
        { choices: [{ delta: { content: markup } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    });

    expect(result.toolCalls).toEqual([
      {
        id: "text-tool-1",
        name: "read_file",
        arguments: { path: "README.md" },
      },
      { id: "text-tool-2", name: "list_files", arguments: { path: "." } },
    ]);
    expect(result.unparsedToolCallMarkup).toBeUndefined();
  });

  test("withholds a standalone wrapper until the next delta confirms an offered tool", async () => {
    const deltas: string[] = [];
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list files",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([
        { choices: [{ delta: { content: "I'll check. <tool_call>" } }] },
        {
          choices: [{
            delta: {
              content:
                "<function=list_files><parameter=path>.</parameter></function></tool_call>",
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    });

    expect(deltas.join("")).toBe("I'll check. ");
    expect(result.toolCalls).toEqual([
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
  });

  test("does not treat a tool_call-prefixed word as protocol markup", async () => {
    const deltas: string[] = [];
    const text = "Use <tool_calling> as the heading.";
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain syntax",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([
        { choices: [{ delta: { content: text } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    });

    expect(result.text).toBe(text);
    expect(deltas.join("")).toBe(text);
  });

  test("does not use tool_calling prose as the wrapper for a later tool call", async () => {
    const deltas: string[] = [];
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain then list",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([
        {
          choices: [{
            delta: {
              content: "Use <tool_calling> as a heading; ",
            },
          }],
        },
        {
          choices: [{
            delta: {
              content:
                "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>",
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    });

    expect(deltas.join("")).toBe("Use <tool_calling> as a heading; ");
    expect(result.text).toBe("Use <tool_calling> as a heading; ");
    expect(result.toolCalls).toEqual([
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
  });

  test("preserves an unrelated literal tool_call wrapper before a later tool call", async () => {
    const deltas: string[] = [];
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain then list",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([
        {
          choices: [{
            delta: {
              content: "The literal marker is <tool_call> in this sentence. ",
            },
          }],
        },
        {
          choices: [{
            delta: {
              content:
                "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>",
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    });

    const narration = "The literal marker is <tool_call> in this sentence.";
    expect(deltas.join("")).toBe(`${narration} `);
    expect(result.text).toBe(`${narration} `);
    expect(result.toolCalls).toEqual([
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
  });

  test("streams a large batch of literal wrapper markers as prose", async () => {
    const deltas: string[] = [];
    const text = Array.from(
      { length: 10_000 },
      (_, index) => `literal <tool_call> marker ${index}\n`,
    ).join("");
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "show markers",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([
        { choices: [{ delta: { content: text } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    });

    expect(deltas.join("")).toBe(text);
    expect(result.text).toBe(text);
    expect(result.toolCalls).toBeUndefined();
  });

  test("recovers a leaked tool call from a buffered (non-streamed) turn", async () => {
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list files",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                content:
                  "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>",
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

  test("recovers multiple textual calls from JSON without warning metadata", async () => {
    const markup =
      "<tool_call><function=read_file><parameter=path>README.md</parameter></function></tool_call>" +
      "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>";
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "read and list",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [
        {
          name: "read_file",
          description: "Read a file.",
          parameters: { type: "object" },
        },
        {
          name: "list_files",
          description: "List files.",
          parameters: { type: "object" },
        },
      ],
      fetchFn: async () =>
        Response.json({
          choices: [{
            message: { content: markup },
            finish_reason: "stop",
          }],
        }),
    });

    expect(result.toolCalls).toEqual([
      {
        id: "text-tool-1",
        name: "read_file",
        arguments: { path: "README.md" },
      },
      { id: "text-tool-2", name: "list_files", arguments: { path: "." } },
    ]);
    expect(result.unparsedToolCallMarkup).toBeUndefined();
  });

  test("does not recover a textual call to a tool that was not offered", async () => {
    const text =
      "<function=write_file><parameter=path>x</parameter></function>";
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [{
              message: { content: text },
              finish_reason: "stop",
            }],
          }),
          { status: 200 },
        ),
    });

    expect(result.text).toBe(text);
    expect(result.toolCalls).toBeUndefined();
    expect(result.stopReason).toBe("stop");
  });

  test("does not recover an unwrapped textual call to an offered tool", async () => {
    const text =
      "Example: <function=list_files><parameter=path>.</parameter></function>";
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain syntax",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [{
              message: { content: text },
              finish_reason: "stop",
            }],
          }),
          { status: 200 },
        ),
    });

    expect(result.text).toBe(text);
    expect(result.toolCalls).toBeUndefined();
  });

  test("does not recover an offered call with an unclosed wrapper", async () => {
    const text =
      "<tool_call><function=list_files><parameter=path>.</parameter></function>";
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain syntax",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [{
              message: { content: text },
              finish_reason: "stop",
            }],
          }),
          { status: 200 },
        ),
    });

    expect(result.text).toBe(text);
    expect(result.toolCalls).toBeUndefined();
  });

  test("preserves unoffered function prose while recovering a later offered call", async () => {
    const deltas: string[] = [];
    const text = "Example: <function=write_file>not available</function>. " +
      "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>";
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain then list",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([
        { choices: [{ delta: { content: text } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    });

    const prose = "Example: <function=write_file>not available</function>.";
    expect(deltas.join("")).toBe(`${prose} `);
    expect(result.text).toBe(`${prose} `);
    expect(result.toolCalls).toEqual([
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
  });

  test("preserves a closed function name that only prefixes an offered tool", async () => {
    const abortController = new AbortController();
    const deltas: string[] = [];
    let received!: () => void;
    const sawText = new Promise<void>((resolve) => {
      received = resolve;
    });
    const text = "Use <function=list> literally";
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => {
        deltas.push(delta);
        received();
      },
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: text } }],
          })
        }\n`,
      ),
    });

    await sawText;
    abortController.abort();
    const result = await pending;

    expect(deltas.join("")).toBe(text);
    expect(result.text).toBe(text);
  });

  test("preserves a closed wrapped name that only prefixes an offered tool", async () => {
    const abortController = new AbortController();
    const deltas: string[] = [];
    let received!: () => void;
    const sawText = new Promise<void>((resolve) => {
      received = resolve;
    });
    const text =
      "Use <tool_call><function=list></function></tool_call> literally";
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "explain",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => {
        deltas.push(delta);
        received();
      },
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: text } }],
          })
        }\n`,
      ),
    });

    await sawText;
    abortController.abort();
    const result = await pending;

    expect(deltas.join("")).toBe(text);
    expect(result.text).toBe(text);
  });

  test("preserves ordinary text after a complete offered call when aborted", async () => {
    const abortController = new AbortController();
    const deltas: string[] = [];
    let received!: () => void;
    const sawPrefix = new Promise<void>((resolve) => {
      received = resolve;
    });
    const text =
      "before <tool_call><function=list_files><parameter=path>.</parameter></function></tool_call> after";
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list files",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => {
        deltas.push(delta);
        if (deltas.join("") === "before ") received();
      },
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: text } }],
          })
        }\n`,
      ),
    });

    await sawPrefix;
    abortController.abort();
    const result = await pending;

    expect(deltas.join("")).toBe("before  after");
    expect(result.text).toBe("before  after");
    expect(result.toolCalls).toBeUndefined();
  });

  test("streams ordinary text after a complete offered call", async () => {
    const deltas: string[] = [];
    const text =
      "  before <tool_call><function=list_files><parameter=path>.</parameter></function></tool_call> after  ";
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list files",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([
        { choices: [{ delta: { content: text } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    });

    expect(deltas).toEqual(["  before ", " after  "]);
    expect(result.text).toBe("  before  after  ");
    expect(result.toolCalls).toEqual([
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
  });

  test("fails boundedly when textual marker limits cross after hidden calls", async () => {
    const call =
      "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>";
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list files",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: () => {},
      fetchFn: sseStream(Array.from(
        { length: 65 },
        () => ({ choices: [{ delta: { content: call } }] }),
      )),
    })).rejects.toThrow(
      "Provider returned too many textual tool-call markers",
    );
  });

  test("keeps live and durable text aligned after a complete call and incomplete suffix", async () => {
    const deltas: string[] = [];
    const complete =
      "<tool_call><function=list_files><parameter=path>.</parameter></function></tool_call>";
    const incomplete =
      "<tool_call><function=read_file><parameter=path>README.md";
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "inspect files",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }, {
        name: "read_file",
        description: "Read a file.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([
        {
          choices: [{
            delta: {
              content: `before ${complete} between ${incomplete}`,
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    });

    expect(deltas.join("")).toBe("before  between ");
    expect(result.text).toBe("before  between ");
    expect(result.toolCalls).toEqual([
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
  });

  test("does not retain an incomplete offered call hidden from live output", async () => {
    const deltas: string[] = [];
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list files",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([
        {
          choices: [{
            delta: {
              content: "answer<tool_call><function=list_files>",
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    });

    expect(deltas.join("")).toBe("answer");
    expect(result.text).toBe("answer");
    expect(result.toolCalls).toBeUndefined();
  });

  test("withholds both permitted tool-call whitespace gaps across deltas", async () => {
    const deltas: string[] = [];
    const wrapperGap = " ".repeat(32);
    const functionGap = " ".repeat(32);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list files",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([
        {
          choices: [{
            delta: {
              content: `answer<tool_call>${wrapperGap}<function=list_files `,
            },
          }],
        },
        {
          choices: [{
            delta: {
              content: `${
                functionGap.slice(1)
              }><parameter=path>.</parameter></function></tool_call>`,
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    });

    expect(deltas.join("")).toBe("answer");
    expect(result.text).toBe("answer");
    expect(result.toolCalls).toEqual([
      { id: "text-tool-1", name: "list_files", arguments: { path: "." } },
    ]);
  });

  test("treats an excessive wrapper gap as prose live and durably", async () => {
    const deltas: string[] = [];
    const text = "<tool_call>" + " ".repeat(33) +
      "<function=list_files><parameter=path>.</parameter></function></tool_call>";
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "show syntax",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([
        {
          choices: [{
            delta: { content: "<tool_call>" + " ".repeat(33) },
          }],
        },
        {
          choices: [{
            delta: {
              content:
                "<function=list_files><parameter=path>.</parameter></function></tool_call>",
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    });

    expect(deltas.join("")).toBe(text);
    expect(result.text).toBe(text);
    expect(result.toolCalls).toBeUndefined();
  });

  test("treats excessive whitespace after a function name as prose", async () => {
    const deltas: string[] = [];
    const prefix = "<tool_call><function=list_files" + " ".repeat(33);
    const suffix = "><parameter=path>.</parameter></function></tool_call>";
    const text = prefix + suffix;
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const encoder = new TextEncoder();
    const resultPromise = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "show syntax",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => {
        deltas.push(delta);
        if (deltas.join("") !== prefix) return;
        streamController?.enqueue(encoder.encode(
          `data: ${
            JSON.stringify({
              choices: [{ delta: { content: suffix } }],
            })
          }\n\ndata: ${
            JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop" }],
            })
          }\n\n`,
        ));
        streamController?.close();
      },
      fetchFn: (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              streamController = controller;
              controller.enqueue(encoder.encode(
                `data: ${
                  JSON.stringify({
                    choices: [{ delta: { content: prefix } }],
                  })
                }\n\n`,
              ));
            },
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    const result = await resultPromise;

    expect(deltas[0]).toBe(prefix);
    expect(deltas.join("")).toBe(text);
    expect(result.text).toBe(text);
    expect(result.toolCalls).toBeUndefined();
  });

  test("treats an excessive post-name gap in one delta as prose", async () => {
    const deltas: string[] = [];
    const text = "<tool_call><function=list_files" + " ".repeat(33) +
      "><parameter=path>.</parameter></function></tool_call>";
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "show syntax",
      routing: { modelId: "gemma4:e2b" },
      models,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => deltas.push(delta),
      fetchFn: sseStream([
        {
          choices: [{
            delta: {
              content: "<tool_call><function=list_files" + " ".repeat(33),
            },
          }],
        },
        {
          choices: [{
            delta: {
              content: "><parameter=path>.</parameter></function></tool_call>",
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    });

    expect(deltas.join("")).toBe(text);
    expect(result.text).toBe(text);
    expect(result.toolCalls).toBeUndefined();
  });

  test("a literal wrapper cannot hide a later incomplete offered call on abort", async () => {
    const abortController = new AbortController();
    let received!: () => void;
    const sawPrefix = new Promise<void>((resolve) => {
      received = resolve;
    });
    const prefix = "Literal <tool_call> prose. ";
    const text = `${prefix}<tool_call><function=list_`;
    const deltas: string[] = [];
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "list files",
      routing: { modelId: "gemma4:e2b" },
      models,
      abortSignal: abortController.signal,
      tools: [{
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      }],
      onTextDelta: (delta) => {
        deltas.push(delta);
        if (deltas.join("") === prefix) received();
      },
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: text } }],
          })
        }\n`,
      ),
    });

    await sawPrefix;
    abortController.abort();
    const result = await pending;

    expect(deltas.join("")).toBe(prefix);
    expect(result.text).toBe(prefix);
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
    let requestBody: Record<string, unknown> = {};

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gpt-test" },
      models: [gptModel],
      getEnv: (name) => name === "OPENAI_API_KEY" ? "sk-test-key" : undefined,
      fetchFn: async (input, init) => {
        requestUrl = String(input);
        authHeader = new Headers(init?.headers).get("authorization");
        requestBody = JSON.parse(String(init?.body));
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
    expect(requestBody.max_completion_tokens).toBe(8192);
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

  test("an abort during credential lookup records zero pre-dispatch usage", async () => {
    const abortController = new AbortController();
    let fetchCalled = false;

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gpt-test" },
      models: [gptModel],
      abortSignal: abortController.signal,
      getEnv: () => {
        abortController.abort();
        return "present";
      },
      fetchFn: async () => {
        fetchCalled = true;
        return new Response();
      },
    });

    expect(fetchCalled).toBe(false);
    expect(result).toMatchObject({
      stopReason: "aborted",
      usage: {
        input: 0,
        output: 0,
        cost: { total: 0 },
      },
    });
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

  test("an openai row never sends its key to another provider's https host", async () => {
    // The credential contract pins the host, not just the scheme: catalog
    // data must not be able to redirect OPENAI_API_KEY to a different
    // (still-https) endpoint.
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gpt-cross-host" },
      models: [{
        ...gptModel,
        slug: "gpt-cross-host",
        baseUrl: "https://openrouter.ai/api/v1",
      }],
      getEnv: () => "sk-test-key",
      fetchFn: async () => {
        throw new Error("fetch should not be called");
      },
    })).rejects.toBeInstanceOf(WorkbenchHostedProviderBaseUrlError);
  });

  test("an openai row never reads another provider's key", async () => {
    // The per-provider map must not widen what satisfies the openai path:
    // an OpenRouter key alone leaves an openai row fail-closed.
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gpt-test" },
      models: [gptModel],
      getEnv: (name) => name === "OPENROUTER_API_KEY" ? "sk-or-key" : undefined,
      fetchFn: async () => {
        throw new Error("fetch should not be called without a key");
      },
    })).rejects.toBeInstanceOf(HostedProviderCredentialMissingError);
  });
});

describe("runWorkbenchTurn hosted OpenRouter", () => {
  const openRouterModel: WorkbenchModel = {
    slug: "z-ai/glm-5.2",
    displayName: "GLM 5.2",
    provider: "openrouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    tier: 1,
    costInput: 0.2688,
    costOutput: 0.8448,
    capabilities: ["text", "code", "reasoning"],
  };

  test("calls OpenRouter with its own bearer key and meters cost from the row", async () => {
    let requestUrl = "";
    let authHeader: string | null = null;
    let requestBody: Record<string, unknown> = {};

    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      getEnv: (name) => name === "OPENROUTER_API_KEY" ? "sk-or-key" : undefined,
      fetchFn: async (input, init) => {
        requestUrl = String(input);
        authHeader = new Headers(init?.headers).get("authorization");
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            choices: [{
              message: { content: "hello from openrouter" },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
          }),
          { status: 200 },
        );
      },
    });

    expect(requestUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(authHeader).toBe("Bearer sk-or-key");
    expect(requestBody.max_completion_tokens).toBe(8192);
    expect(result.model.provider).toBe("openrouter");
    expect(result.text).toBe("hello from openrouter");
    // 1M input * $0.2688 + 1M output * $0.8448, per-MTok rates.
    expect(result.usage.cost.total).toBeCloseTo(1.1136, 5);
  });

  test("meters buffered structured tool calls when usage is absent", async () => {
    const name = "write_file";
    const argumentsJson = `{"content":"${"x".repeat(8_192)}"}`;
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      tools: [{
        name,
        description: "Write a file.",
        parameters: { type: "object" },
      }],
      getEnv: () => "sk-or-key",
      fetchFn: async () =>
        Response.json({
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: "tc-1",
                type: "function",
                function: { name, arguments: argumentsJson },
              }],
            },
            finish_reason: "tool_calls",
          }],
        }),
    });

    expect(result.usage.output).toBe(
      Math.ceil((name.length + argumentsJson.length) / 4),
    );
    expect(result.usage.cost.total).toBeGreaterThan(0);
  });

  test("splits provider-reported reasoning from visible output without double charging", async () => {
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      getEnv: () => "sk-or-key",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 9,
              completion_tokens_details: { reasoning_tokens: 7 },
            },
          }),
          { status: 200 },
        ),
    });

    expect(result.usage).toMatchObject({ input: 10, output: 2, reasoning: 7 });
    expect(result.usage.cost.total).toBeCloseTo(
      (10 * 0.2688 + 9 * 0.8448) / 1_000_000,
      12,
    );
  });

  test("OpenAI-compatible TPOT excludes earlier reasoning tokens", async () => {
    const nowValues = [0, 10, 20, 120];
    const visible = "x".repeat(40);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      onTextDelta: () => {},
      now: () => nowValues.shift() ?? 120,
      getEnv: () => "sk-or-key",
      fetchFn: async () =>
        new Response(
          `data: ${
            JSON.stringify({
              choices: [{
                delta: { content: visible },
                finish_reason: "stop",
              }],
              usage: {
                prompt_tokens: 9,
                completion_tokens: 510,
                completion_tokens_details: { reasoning_tokens: 500 },
              },
            })
          }\n`,
          { status: 200 },
        ),
    });

    expect(result.usage).toMatchObject({ output: 10, reasoning: 500 });
    expect(result.timings).toMatchObject({
      generationMs: 100,
      timePerOutputTokenMs: 11,
    });
  });

  test("ignores a nonnumeric provider reasoning-token value", async () => {
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      getEnv: () => "sk-or-key",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 9,
              completion_tokens_details: { reasoning_tokens: "7" },
            },
          }),
          { status: 200 },
        ),
    });

    expect(result.usage).toMatchObject({ input: 10, output: 9, reasoning: 0 });
    expect(result.usage.cost.total).toBeCloseTo(
      (10 * 0.2688 + 9 * 0.8448) / 1_000_000,
      12,
    );
  });

  test("uses a smaller catalog completion ceiling when one is declared", async () => {
    let requestBody: Record<string, unknown> = {};
    await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [{ ...openRouterModel, maxOutputTokens: 1024 }],
      getEnv: () => "sk-or-key",
      fetchFn: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200 },
        );
      },
    });

    expect(requestBody.max_completion_tokens).toBe(1024);
  });

  test("estimates streamed plaintext reasoning when cancellation precedes usage", async () => {
    const abortController = new AbortController();
    const reasoning = "1234567890123456789012345678901234567890";
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv: () => "sk-or-key",
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{
              delta: {
                reasoning_details: [{
                  type: "reasoning.text",
                  text: reasoning,
                }],
              },
            }],
          })
        }\n`,
      ),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;
    const input = estimateTextTokens("system\nhello");
    const reasoningTokens = estimateTextTokens(reasoning);

    expect(result).toMatchObject({
      text: "",
      stopReason: "aborted",
      usage: { input, output: 0, reasoning: reasoningTokens },
    });
    expect(result.usage.cost.total).toBeCloseTo(
      (input * 0.2688 + reasoningTokens * 0.8448) / 1_000_000,
      12,
    );
  });

  test("estimates abort-time reasoning when only interim completion usage arrived", async () => {
    const abortController = new AbortController();
    const reasoning = "1234567890123456789012345678901234567890";
    const visible = "12345678901234567890123456789012";
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv: () => "sk-or-key",
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [{
              delta: {
                reasoning_details: [{
                  type: "reasoning.text",
                  text: reasoning,
                }],
              },
            }],
            usage: { prompt_tokens: 7, completion_tokens: 2 },
          })
        }\n` +
          `data: ${
            JSON.stringify({ choices: [{ delta: { content: visible } }] })
          }\n`,
      ),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;
    const reasoningTokens = estimateTextTokens(reasoning);

    expect(result).toMatchObject({
      text: visible,
      stopReason: "aborted",
      usage: { input: 7, output: 8, reasoning: reasoningTokens },
    });
    expect(result.usage.cost.total).toBeCloseTo(
      (7 * 0.2688 + (8 + reasoningTokens) * 0.8448) / 1_000_000,
      12,
    );
  });

  test("merges reasoning-token detail across streamed usage frames", async () => {
    const abortController = new AbortController();
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv: () => "sk-or-key",
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 7,
              completion_tokens: 9,
              completion_tokens_details: { reasoning_tokens: 7 },
            },
          })
        }\n` +
          `data: ${
            JSON.stringify({
              choices: [],
              usage: {
                completion_tokens_details: {
                  accepted_prediction_tokens: 1,
                },
              },
            })
          }\n`,
      ),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;

    expect(result).toMatchObject({
      stopReason: "aborted",
      usage: { input: 7, output: 2, reasoning: 7 },
    });
  });

  test("lower-bounds interim reasoning usage with later plaintext reasoning", async () => {
    const abortController = new AbortController();
    const laterReasoning = "r".repeat(400);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv: () => "sk-or-key",
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 7,
              completion_tokens: 1,
              completion_tokens_details: { reasoning_tokens: 1 },
            },
          })
        }\n` +
          `data: ${
            JSON.stringify({
              choices: [{
                delta: {
                  reasoning_details: [{
                    type: "reasoning.text",
                    text: laterReasoning,
                  }],
                },
              }],
            })
          }\n`,
      ),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;

    expect(result).toMatchObject({
      stopReason: "aborted",
      usage: { input: 7, output: 0, reasoning: 101 },
    });
    expect(result.usage.cost.total).toBeCloseTo(
      (7 * 0.2688 + 101 * 0.8448) / 1_000_000,
      12,
    );
  });

  test("retains reasoning usage reported without a completion total", async () => {
    const abortController = new AbortController();
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv: () => "sk-or-key",
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 7,
              completion_tokens_details: { reasoning_tokens: 7 },
            },
          })
        }\n`,
      ),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;

    expect(result).toMatchObject({
      stopReason: "aborted",
      usage: { input: 7, output: 0, reasoning: 7 },
    });
    expect(result.usage.cost.total).toBeCloseTo(
      (7 * 0.2688 + 7 * 0.8448) / 1_000_000,
      12,
    );
  });

  test("lower-bounds completed usage when plaintext reasoning follows its frame", async () => {
    const laterReasoning = "r".repeat(400);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      onTextDelta: () => {},
      getEnv: () => "sk-or-key",
      fetchFn: async () =>
        new Response(
          `data: ${
            JSON.stringify({
              choices: [],
              usage: {
                prompt_tokens: 7,
                completion_tokens: 1,
                completion_tokens_details: { reasoning_tokens: 1 },
              },
            })
          }\n\n` +
            `data: ${
              JSON.stringify({
                choices: [{
                  delta: {
                    reasoning_details: [{
                      type: "reasoning.text",
                      text: laterReasoning,
                    }],
                  },
                  finish_reason: "stop",
                }],
              })
            }\n\n` +
            "data: [DONE]\n\n",
          { status: 200 },
        ),
    });

    expect(result.usage).toMatchObject({
      input: 7,
      output: 0,
      reasoning: 101,
    });
    expect(result.usage.cost.total).toBeCloseTo(
      (7 * 0.2688 + 101 * 0.8448) / 1_000_000,
      12,
    );
  });

  test("does not refresh completion coverage from a prompt-only usage frame", async () => {
    const laterText = "x".repeat(400);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      onTextDelta: () => {},
      getEnv: () => "sk-or-key",
      fetchFn: async () =>
        new Response(
          `data: ${
            JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 7, completion_tokens: 1 },
            })
          }\n\n` +
            `data: ${
              JSON.stringify({ choices: [{ delta: { content: laterText } }] })
            }\n\n` +
            `data: ${
              JSON.stringify({
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 7 },
              })
            }\n\n` +
            "data: [DONE]\n\n",
          { status: 200 },
        ),
    });

    expect(result.usage).toMatchObject({ input: 7, output: 101 });
  });

  test("adds post-snapshot text to the highest cumulative usage total", async () => {
    const laterText = "x".repeat(400);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      onTextDelta: () => {},
      getEnv: () => "sk-or-key",
      fetchFn: async () =>
        new Response(
          `data: ${
            JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 7, completion_tokens: 100 },
            })
          }\n\n` +
            `data: ${
              JSON.stringify({
                choices: [{
                  delta: { content: laterText },
                  finish_reason: "stop",
                }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              })
            }\n\n` +
            "data: [DONE]\n\n",
          { status: 200 },
        ),
    });

    expect(result.usage).toMatchObject({ input: 7, output: 200 });
  });

  test("trusts a final completion total without a repeated reasoning split", async () => {
    const laterReasoning = "r".repeat(400);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      onTextDelta: () => {},
      getEnv: () => "sk-or-key",
      fetchFn: async () =>
        new Response(
          `data: ${
            JSON.stringify({
              choices: [],
              usage: {
                prompt_tokens: 7,
                completion_tokens: 10,
                completion_tokens_details: { reasoning_tokens: 1 },
              },
            })
          }\n\n` +
            `data: ${
              JSON.stringify({
                choices: [{
                  delta: {
                    reasoning_details: [{
                      type: "reasoning.text",
                      text: laterReasoning,
                    }],
                  },
                }],
              })
            }\n\n` +
            `data: ${
              JSON.stringify({
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: { completion_tokens: 10 },
              })
            }\n\n` +
            "data: [DONE]\n\n",
          { status: 200 },
        ),
    });

    expect(result.usage).toMatchObject({
      input: 7,
      output: 0,
      reasoning: 10,
    });
    expect(result.usage.cost.total).toBeCloseTo(
      (7 * 0.2688 + 10 * 0.8448) / 1_000_000,
      12,
    );
  });

  test("fails closed naming OPENROUTER_API_KEY — an OpenAI key does not satisfy it", async () => {
    // Presence-only, per-provider: OPENAI_API_KEY being set must not leak
    // onto an openrouter row, and the error names the missing env var (never
    // a value).
    const failure = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [openRouterModel],
      getEnv: (name) => name === "OPENAI_API_KEY" ? "sk-openai-key" : undefined,
      fetchFn: async () => {
        throw new Error("fetch should not be called without a key");
      },
    }).then(() => undefined, (error) => error);

    expect(failure).toBeInstanceOf(HostedProviderCredentialMissingError);
    const missing = failure as HostedProviderCredentialMissingError;
    expect(missing.envVar).toBe("OPENROUTER_API_KEY");
    expect(missing.message).toContain("OPENROUTER_API_KEY");
    expect(missing.message).not.toContain("sk-openai-key");
  });

  test("rejects a non-https OpenRouter base URL before inference", async () => {
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [{
        ...openRouterModel,
        baseUrl: "http://openrouter.ai/api/v1",
      }],
      getEnv: () => "sk-or-key",
      fetchFn: async () => {
        throw new Error("fetch should not be called");
      },
    })).rejects.toBeInstanceOf(WorkbenchHostedProviderBaseUrlError);
  });

  test("an openrouter row never sends its key to another provider's https host", async () => {
    // A mis-catalogued row pairing provider "openrouter" with another
    // provider's https base URL must fail closed before any request leaves.
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [{
        ...openRouterModel,
        baseUrl: "https://api.openai.com/v1",
      }],
      getEnv: () => "sk-or-key",
      fetchFn: async () => {
        throw new Error("fetch should not be called");
      },
    })).rejects.toBeInstanceOf(WorkbenchHostedProviderBaseUrlError);
  });

  test("rejects a pinned host on a non-default port before inference", async () => {
    // openrouter.ai:8443 is not the pinned endpoint even though the hostname
    // matches — the net grant and the contract both name port 443 only.
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [{
        ...openRouterModel,
        baseUrl: "https://openrouter.ai:8443/api/v1",
      }],
      getEnv: () => "sk-or-key",
      fetchFn: async () => {
        throw new Error("fetch should not be called");
      },
    })).rejects.toBeInstanceOf(WorkbenchHostedProviderBaseUrlError);
  });

  test("accepts an explicit :443 on the pinned host — it is the default port", async () => {
    // The pin passes only when URL normalizes the explicit :443 to an empty
    // port; a row that spells the default port out must still route, or the
    // check would reject a legitimate endpoint. Complements the :8443
    // rejection above, which shares this normalization path.
    let requestUrl = "";
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "z-ai/glm-5.2" },
      models: [{
        ...openRouterModel,
        baseUrl: "https://openrouter.ai:443/api/v1",
      }],
      getEnv: (name) => name === "OPENROUTER_API_KEY" ? "sk-or-key" : undefined,
      fetchFn: async (input) => {
        requestUrl = String(input);
        return new Response(
          JSON.stringify({
            choices: [{
              message: { content: "ok" },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200 },
        );
      },
    });

    expect(requestUrl).toBe(
      "https://openrouter.ai:443/api/v1/chat/completions",
    );
    expect(result.model.provider).toBe("openrouter");
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
    expect(event?.reasoningCharacters).toBe("secret reasoning".length);
  });

  test("surfaces thinking-token usage separately from visible output", () => {
    const event = parseGeminiStreamLine(
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2,"thoughtsTokenCount":140}}',
    );
    // candidatesTokenCount is visible output; thoughtsTokenCount is the
    // reasoning that also drew from the output budget.
    expect(event?.outputTokens).toBe(2);
    expect(event?.reasoningTokens).toBe(140);
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
              thoughtsTokenCount: 500_000,
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
    expect(result.usage.reasoning).toBe(500_000);
    // 1M input * $2 + 1.5M billable output * $12, per-MTok rates.
    expect(result.usage.cost.total).toBeCloseTo(20, 5);
  });

  test("an aborted stream keeps Gemini partial text and reported usage", async () => {
    const abortController = new AbortController();
    let sawDelta!: () => void;
    const firstDelta = new Promise<void>((resolve) => {
      sawDelta = resolve;
    });
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-test" },
      models: [geminiModel],
      abortSignal: abortController.signal,
      onTextDelta: () => sawDelta(),
      getEnv: () => "gem-test-key",
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "partial" }] } }],
            usageMetadata: {
              promptTokenCount: 9,
              candidatesTokenCount: 2,
            },
          })
        }\n\n`,
      ),
    });

    await firstDelta;
    abortController.abort();
    const result = await pending;

    expect(result).toMatchObject({
      text: "partial",
      stopReason: "aborted",
      usage: { input: 9, output: 2 },
    });
  });

  test("Gemini error envelopes outrank a concurrent cancellation", async () => {
    const abortController = new AbortController();
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-test" },
      models: [geminiModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv: () => "gem-test-key",
      fetchFn: interruptibleSse(
        'data: {"error":{"code":429,"message":"quota"}}\n',
      ),
    });
    const rejection = expect(pending).rejects.toThrow(
      "Gemini stream returned an error envelope",
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();

    await rejection;
  });

  test("estimates streamed Gemini reasoning received before cancellation", async () => {
    const abortController = new AbortController();
    const reasoning = "r".repeat(400);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-test" },
      models: [geminiModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv: () => "gem-test-key",
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            candidates: [{
              content: { parts: [{ text: reasoning, thought: true }] },
            }],
          })
        }\n`,
      ),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;

    expect(result).toMatchObject({
      stopReason: "aborted",
      usage: { reasoning: 100 },
    });
  });

  test("lower-bounds aborted Gemini usage with later preserved text", async () => {
    const abortController = new AbortController();
    const laterText = "x".repeat(400);
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-test" },
      models: [geminiModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv: () => "gem-test-key",
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            candidates: [],
            usageMetadata: {
              promptTokenCount: 9,
              candidatesTokenCount: 1,
            },
          })
        }\n` +
          `data: ${
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: laterText }] } }],
            })
          }\n`,
      ),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;

    expect(result).toMatchObject({
      text: laterText,
      stopReason: "aborted",
      usage: { input: 9, output: 101 },
    });
  });

  test("retains the highest Gemini usage total before cancellation", async () => {
    const abortController = new AbortController();
    const pending = runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-test" },
      models: [geminiModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv: () => "gem-test-key",
      fetchFn: interruptibleSse(
        `data: ${
          JSON.stringify({
            candidates: [],
            usageMetadata: {
              promptTokenCount: 9,
              candidatesTokenCount: 100,
            },
          })
        }\n` +
          `data: ${
            JSON.stringify({
              candidates: [],
              usageMetadata: {
                promptTokenCount: 1,
                candidatesTokenCount: 1,
              },
            })
          }\n`,
      ),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    const result = await pending;

    expect(result).toMatchObject({
      stopReason: "aborted",
      usage: { input: 9, output: 100 },
    });
  });

  test("does not refresh Gemini output coverage from prompt-only usage", async () => {
    const laterText = "x".repeat(400);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-test" },
      models: [geminiModel],
      onTextDelta: () => {},
      getEnv: () => "gem-test-key",
      fetchFn: async () =>
        new Response(
          `data: ${
            JSON.stringify({
              candidates: [],
              usageMetadata: {
                promptTokenCount: 9,
                candidatesTokenCount: 1,
              },
            })
          }\n\n` +
            `data: ${
              JSON.stringify({
                candidates: [{ content: { parts: [{ text: laterText }] } }],
              })
            }\n\n` +
            `data: ${
              JSON.stringify({
                candidates: [{ finishReason: "STOP" }],
                usageMetadata: { promptTokenCount: 9 },
              })
            }\n\n`,
          { status: 200 },
        ),
    });

    expect(result).toMatchObject({
      text: laterText,
      usage: { input: 9, output: 101 },
    });
  });

  test("Gemini TPOT uses visible generation tokens, not earlier reasoning", async () => {
    const nowValues = [0, 10, 20, 120];
    const visible = "x".repeat(40);
    const result = await runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-test" },
      models: [geminiModel],
      onTextDelta: () => {},
      now: () => nowValues.shift() ?? 120,
      getEnv: () => "gem-test-key",
      fetchFn: async () =>
        new Response(
          `data: ${
            JSON.stringify({
              candidates: [{
                content: { parts: [{ text: visible }] },
                finishReason: "STOP",
              }],
              usageMetadata: {
                promptTokenCount: 9,
                candidatesTokenCount: 10,
                thoughtsTokenCount: 500,
              },
            })
          }\n`,
          { status: 200 },
        ),
    });

    expect(result.usage).toMatchObject({ output: 10, reasoning: 500 });
    expect(result.timings).toMatchObject({
      generationMs: 100,
      timePerOutputTokenMs: 11,
    });
  });

  test("Gemini clean EOF preserves a concurrent trailing-frame error", async () => {
    const abortController = new AbortController();
    await expect(runWorkbenchTurn({
      systemPrompt: "system",
      prompt: "hello",
      routing: { modelId: "gemini-test" },
      models: [geminiModel],
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv: () => "gem-test-key",
      fetchFn: async () => {
        abortController.abort();
        return new Response('data: {"candidates":[');
      },
    })).rejects.toBeInstanceOf(SyntaxError);
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

  test("buildAnthropicMessagesRequest flags failed tool results with is_error", () => {
    const tools = [{
      name: "read_file",
      description: "Read a file",
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
          { role: "user", content: "read the friction log" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "tu-bad", name: "read_file", arguments: {} }],
          },
          {
            role: "tool",
            toolCallId: "tu-bad",
            name: "read_file",
            content:
              "invalid arguments for read_file: missing required argument: path",
            isError: true,
          },
        ],
      },
    );

    // The denial travels as a tool_result the model reads as an ERROR — not as
    // ordinary tool output — which is what invites a corrected retry.
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-bad",
          content:
            "invalid arguments for read_file: missing required argument: path",
          is_error: true,
        },
      ],
    });
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

  test("an aborted stream keeps Anthropic partial text and received input usage", async () => {
    const abortController = new AbortController();
    let sawDelta!: () => void;
    const firstDelta = new Promise<void>((resolve) => {
      sawDelta = resolve;
    });
    const pending = runWorkbenchTurn({
      systemPrompt: "sys",
      prompt: "hi",
      routing: { modelId: anthropicModel.slug },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => sawDelta(),
      getEnv: () => "test-key-not-real",
      fetchFn: interruptibleSse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}',
        "",
      ].join("\n")),
    });

    await firstDelta;
    abortController.abort();
    const result = await pending;

    expect(result).toMatchObject({
      text: "partial",
      stopReason: "aborted",
      usage: { input: 10, output: 2 },
    });
  });

  test("Anthropic clean EOF honors a concurrent abort signal", async () => {
    const abortController = new AbortController();
    const result = await runWorkbenchTurn({
      systemPrompt: "sys",
      prompt: "hi",
      routing: { modelId: anthropicModel.slug },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv: () => "test-key-not-real",
      fetchFn: async () => {
        abortController.abort();
        return new Response([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
          "",
        ].join("\n"));
      },
    });

    expect(result).toMatchObject({
      text: "partial",
      stopReason: "aborted",
      usage: { input: 10, output: 2 },
    });
  });

  test("Anthropic clean EOF preserves a concurrent trailing-frame error", async () => {
    const abortController = new AbortController();
    await expect(runWorkbenchTurn({
      systemPrompt: "sys",
      prompt: "hi",
      routing: { modelId: anthropicModel.slug },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv: () => "test-key-not-real",
      fetchFn: async () => {
        abortController.abort();
        return new Response('data: {"type":"content_block_delta"');
      },
    })).rejects.toBeInstanceOf(SyntaxError);
  });

  test("Anthropic error envelopes outrank a concurrent cancellation", async () => {
    const abortController = new AbortController();
    const pending = runWorkbenchTurn({
      systemPrompt: "sys",
      prompt: "hi",
      routing: { modelId: anthropicModel.slug },
      models,
      abortSignal: abortController.signal,
      onTextDelta: () => {},
      getEnv: () => "test-key-not-real",
      fetchFn: interruptibleSse(
        'data: {"type":"error","error":{"type":"overloaded_error"}}\n',
      ),
    });
    const rejection = expect(pending).rejects.toThrow(
      "Anthropic stream returned an error envelope",
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();

    await rejection;
  });

  test("Anthropic keeps the highest streamed usage totals", async () => {
    const result = await runWorkbenchTurn({
      systemPrompt: "sys",
      prompt: "hi",
      routing: { modelId: anthropicModel.slug },
      models,
      onTextDelta: () => {},
      getEnv: () => "test-key-not-real",
      fetchFn: async () =>
        new Response([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
          'data: {"type":"message_delta","usage":{"output_tokens":100}}',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
          'data: {"type":"message_stop"}',
          "",
        ].join("\n")),
    });

    expect(result.usage).toMatchObject({ input: 10, output: 100 });
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
    const blackhole =
      ((_url: string | URL | Request, init?: RequestInit) =>
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
    const ok =
      (() => Promise.resolve(new Response("hi"))) as unknown as typeof fetch;
    const response = await fetchWithHeaderTimeout(ok, "http://x/", {}, "l", 30);
    expect(await response.text()).toBe("hi");
  });

  test("non-abort failures pass through unchanged", async () => {
    const refused = (() =>
      Promise.reject(
        new Error("connection refused"),
      )) as unknown as typeof fetch;
    await expect(
      fetchWithHeaderTimeout(refused, "http://x/", {}, "l", 1000),
    ).rejects.toThrow("connection refused");
  });

  test("an earlier external abort wins when the header timer later fires before fetch rejects", async () => {
    const controller = new AbortController();
    let rejectFetch!: (reason: unknown) => void;
    const delayedAbort =
      ((_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = () => reject(init?.signal?.reason);
        })) as typeof fetch;
    const pending = fetchWithHeaderTimeout(
      delayedAbort,
      "http://x/",
      { signal: controller.signal },
      "l",
      5,
    );

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    rejectFetch(controller.signal.reason);

    await expect(pending).rejects.toBe(controller.signal.reason);
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
    expect(
      modelHasCatalogPricing({ ...unpriced, costInput: 15, costOutput: 75 }),
    )
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

  test("an unpriced hosted configured default is bypassed, not routed", () => {
    // Hosted configured defaults never ride a bare turn (local-by-default), so
    // the pricing rule for this row binds only on explicit selection — which
    // still throws, per the explicit-modelId test above.
    const selection = selectWorkbenchModel(
      [...models, unpriced],
      {},
      "gpt-6-preview",
    );
    expect(selection.selected.tier).toBe(0);
    expect(selection.reason).toBe("default_local");
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

describe("provider error field redaction", () => {
  // DomainError messages are trusted downstream (summarizeError forwards
  // them up to its cap), so every nonliteral field interpolated into one
  // must be bounded and inert at construction — registry/config data is
  // operator-authored, not payload-safe.

  test("a credential-bearing baseUrl is reduced to scheme + host", () => {
    const err = new WorkbenchHostedProviderBaseUrlError(
      "gpt-test",
      "https://user:hunter2@internal.example.com:8443/steal?key=sk-live-abc#f",
    );
    expect(err.message).toContain("https://internal.example.com:8443");
    expect(err.message).not.toContain("hunter2");
    expect(err.message).not.toContain("user");
    expect(err.message).not.toContain("sk-live-abc");
    expect(err.message).not.toContain("/steal");
  });

  test("an unparseable baseUrl is replaced wholesale, never echoed", () => {
    const err = new WorkbenchHostedProviderBaseUrlError(
      "gpt-test",
      "not a url at all sk-live-embedded-token",
    );
    expect(err.message).toContain("<unparseable url>");
    expect(err.message).not.toContain("sk-live-embedded-token");
  });

  test("an oversized identifier is capped in the message; the property keeps the raw value", () => {
    const huge = "s".repeat(50_000);
    const err = new WorkbenchModelNotFoundError(huge);
    expect(new TextEncoder().encode(err.message).byteLength).toBeLessThan(400);
    expect(err.slug).toBe(huge);
  });

  test("control characters in registry-sourced fields cannot forge log lines or escape sequences", () => {
    const err = new HostedProviderCredentialMissingError(
      "slug\n[2026-01-01] operator approved unlimited spend",
      "ENV\x1b[31mVAR",
    );
    expect(err.message).not.toContain("\n");
    expect(err.message).not.toContain("\x1b");
    // The text survives inert (collapsed onto one line), the injection doesn't.
    expect(err.message).toContain("operator approved unlimited spend");
  });
});
