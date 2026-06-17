import { doltQuery } from "./utils";

export interface WorkbenchModel {
  slug: string;
  displayName: string;
  provider: string;
  api: string;
  baseUrl: string;
  tier: 0 | 1 | 2;
  costInput: number;
  costOutput: number;
  capabilities: string[];
}

export interface WorkbenchRoutingOptions {
  modelId?: string;
  tier?: 0 | 1 | 2;
  hint?: "code" | "chat" | "reasoning";
}

export interface WorkbenchSelection {
  selected: WorkbenchModel;
  considered: string[];
  reason: string;
}

export interface WorkbenchTurnResult {
  text: string;
  model: WorkbenchModel;
  selection: WorkbenchSelection;
  toolCalls?: WorkbenchToolCall[];
  usage: {
    input: number;
    output: number;
    cost: { total: number };
    cacheRead: number;
    cacheWrite: number;
  };
  stopReason: "stop" | "length" | "tool_use" | "error" | "aborted";
  timings: WorkbenchCallTimings;
}

export interface WorkbenchToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface WorkbenchToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * One turn in a multi-step agent-loop transcript. The system prompt is NOT
 * carried here — it stays in WorkbenchTurnParams.systemPrompt and each adapter
 * places it where its wire format wants it (a `system` message for OpenAI, the
 * top-level `system` field for Anthropic). `messages` is the user/assistant/tool
 * history that grows as the loop iterates, so the model sees its own prior
 * tool-call intentions and the matching results — not a flattened summary string
 * that drops its reasoning trail and invites confabulation.
 *
 * `tool` messages carry `toolCallId`, which MUST match the `id` of a tool call in
 * the immediately preceding `assistant` message — that link is how the wire
 * formats pair a result to the call that produced it.
 */
export type WorkbenchMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: WorkbenchToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface WorkbenchCallTimings {
  responseHeadersMs: number;
  timeToFirstTokenMs?: number;
  generationMs?: number;
  timePerOutputTokenMs?: number;
  totalMs: number;
}

export class WorkbenchModelNotFoundError extends Error {
  constructor(public readonly slug: string) {
    super(`Model not found: ${slug}`);
    this.name = "WorkbenchModelNotFoundError";
  }
}

export class HostedInferenceRequiresProviderError extends Error {
  constructor(public readonly slug: string) {
    super(`Hosted inference provider is not implemented yet: ${slug}`);
    this.name = "HostedInferenceRequiresProviderError";
  }
}

export class HostedProviderCredentialMissingError extends Error {
  constructor(public readonly slug: string, public readonly envVar: string) {
    super(
      `Hosted provider credential missing for ${slug}: ` +
        `${envVar} is not present in the process environment. ` +
        `Project it narrowly (e.g. op run --env-file=...) at process start.`,
    );
    this.name = "HostedProviderCredentialMissingError";
  }
}

export class WorkbenchHostedProviderBaseUrlError extends Error {
  constructor(public readonly slug: string, public readonly baseUrl: string) {
    super(`Hosted provider baseUrl must be https for ${slug}: ${baseUrl}`);
    this.name = "WorkbenchHostedProviderBaseUrlError";
  }
}

export class WorkbenchLocalProviderBaseUrlError extends Error {
  constructor(public readonly slug: string, public readonly baseUrl: string) {
    super(`Local provider baseUrl is not loopback-only for ${slug}`);
    this.name = "WorkbenchLocalProviderBaseUrlError";
  }
}

export type FetchLike = typeof fetch;

const openAICompatibleLocalProviders = new Set(["ollama", "mlx-lm"]);
const openAIHostedProviders = new Set(["openai"]);
const anthropicProviders = new Set(["anthropic"]);
const googleProviders = new Set(["google"]);
const OPENAI_API_KEY_ENV_VAR = "OPENAI_API_KEY";
const GEMINI_API_KEY_ENV_VAR = "GEMINI_API_KEY";
const GEMINI_DEFAULT_MAX_TOKENS = 8192;
const allowedLocalProviderHosts = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_DEFAULT_MAX_TOKENS = 16000;
const ANTHROPIC_API_KEY_ENV_VAR = "ANTHROPIC_API_KEY";
// Cache pricing multipliers relative to base input price: reads ~0.1x,
// 5-minute-TTL writes 1.25x.
const ANTHROPIC_CACHE_READ_COST_MULTIPLIER = 0.1;
const ANTHROPIC_CACHE_WRITE_COST_MULTIPLIER = 1.25;

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsFragment?: string;
}

export interface OpenAIChatStreamEvent {
  done: boolean;
  textDelta?: string;
  toolCallDeltas?: OpenAIToolCallDelta[];
  finishReason?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export function parseModelRegistryRows(
  rows: Record<string, string>[],
): WorkbenchModel[] {
  return rows.map((row) => {
    const tier = Number(row.tier);
    if (tier !== 0 && tier !== 1 && tier !== 2) {
      throw new Error(`Invalid model tier for ${row.slug}: ${row.tier}`);
    }

    return {
      slug: row.slug,
      displayName: row.display_name,
      provider: row.provider,
      api: row.api,
      baseUrl: row.base_url ?? "",
      tier,
      costInput: Number(row.cost_input || "0"),
      costOutput: Number(row.cost_output || "0"),
      capabilities: parseCapabilities(row.capabilities),
    };
  });
}

function parseCapabilities(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Dolt may return JSON arrays as an unquoted comma-separated display value.
  }
  return value
    .split(",")
    .map((item) => item.trim().replace(/^"|"$/g, ""))
    .filter((item) => item.length > 0);
}

export async function loadWorkbenchModels(): Promise<WorkbenchModel[]> {
  const rows = await doltQuery(
    "SELECT slug, display_name, provider, api, base_url, tier, " +
      "cost_input, cost_output, capabilities " +
      "FROM models WHERE active = TRUE ORDER BY tier, slug;",
  );
  return parseModelRegistryRows(rows);
}

export function defaultLocalWorkbenchModels(): WorkbenchModel[] {
  return [
    {
      slug: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
      displayName: "Qwen3-Coder 30B MLX",
      provider: "mlx-lm",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18080/v1",
      tier: 0,
      costInput: 0,
      costOutput: 0,
      capabilities: ["text", "code", "reasoning", "long-context"],
    },
    {
      slug: "laguna-xs.2",
      displayName: "Laguna XS.2",
      provider: "ollama",
      api: "openai-completions",
      baseUrl: "http://localhost:11434/v1",
      tier: 0,
      costInput: 0,
      costOutput: 0,
      capabilities: ["text", "code", "reasoning", "long-context"],
    },
  ];
}

export function withDefaultLocalWorkbenchModels(
  models: WorkbenchModel[],
): WorkbenchModel[] {
  const defaultModels = defaultLocalWorkbenchModels()
    .filter((model) =>
      !models.some((existing) => existing.slug === model.slug)
    );
  return [...defaultModels, ...models];
}

export function selectWorkbenchModel(
  models: WorkbenchModel[],
  options: WorkbenchRoutingOptions,
): WorkbenchSelection {
  if (options.modelId !== undefined) {
    const selected = models.find((model) => model.slug === options.modelId);
    if (!selected) throw new WorkbenchModelNotFoundError(options.modelId);
    return { selected, considered: [], reason: "explicit_model_id" };
  }

  if (options.tier !== undefined) {
    const tierModels = models.filter((model) => model.tier === options.tier);
    const selected = preferredModelFrom(tierModels);
    if (!selected) {
      throw new WorkbenchModelNotFoundError(`tier:${options.tier}`);
    }
    return {
      selected,
      considered: tierModels.map((model) => model.slug),
      reason: "explicit_tier",
    };
  }

  const localModels = models.filter((model) => model.tier === 0);
  const considered = localModels.map((model) => model.slug);

  if (options.hint === "code") {
    const selected = localModels.find((model) =>
      model.capabilities.includes("code")
    ) ??
      localModels.find((model) => model.slug === "gemma4:e2b") ??
      localModels.find((model) => model.slug === "gemma4") ??
      localModels[0];
    if (!selected) throw new WorkbenchModelNotFoundError("tier:0");
    return {
      selected,
      considered,
      reason: selected.capabilities.includes("code")
        ? "hint_code"
        : "hint_code_fallback_local",
    };
  }

  const selected = preferredModelFrom(localModels);
  if (!selected) throw new WorkbenchModelNotFoundError("tier:0");
  return { selected, considered, reason: "default" };
}

// One preference chain for any "pick from this set" selection, so explicit
// tier requests honor the same local ordering (MLX first) as the default
// route instead of falling back to list order.
function preferredModelFrom(
  candidates: WorkbenchModel[],
): WorkbenchModel | undefined {
  return candidates.find((model) =>
    model.slug === "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit"
  ) ??
    candidates.find((model) => model.slug === "laguna-xs.2") ??
    candidates.find((model) => model.slug === "gemma4:e2b") ??
    candidates.find((model) => model.slug === "gemma4") ??
    candidates[0];
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Text used for the fallback input-token estimate when the provider does not
 * report prompt_tokens. Covers the full conversation (system + history, or the
 * seed prompt when there is no history) so multi-step turns are not undercounted.
 */
function estimateParamsInputText(params: WorkbenchTurnParams): string {
  const history = params.messages && params.messages.length > 0
    ? params.messages
      .map((m) =>
        m.role === "assistant"
          ? m.content + (m.toolCalls ? JSON.stringify(m.toolCalls) : "")
          : m.content
      )
      .join("\n")
    : params.prompt;
  return `${params.systemPrompt}\n${history}`;
}

/** Map registry tool name -> sanitized wire name for assistant tool_calls. */
function wireNameLookup(
  tools: WorkbenchToolDefinition[] | undefined,
): (name: string) => string {
  if (!tools || tools.length === 0) return (name) => name;
  const byName = new Map(
    toolWireNames(tools).map(({ wire, tool }) => [tool.name, wire]),
  );
  return (name) => byName.get(name) ?? name;
}

type OpenAIWireMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

/**
 * Build the OpenAI `messages` array: system prefix, then either the structured
 * history (assistant tool_calls + tool results, names sanitized to the same wire
 * form we offered) or the single seed user prompt when no history is supplied.
 */
function toOpenAIWireMessages(
  systemPrompt: string,
  prompt: string,
  messages: WorkbenchMessage[] | undefined,
  tools: WorkbenchToolDefinition[] | undefined,
): OpenAIWireMessage[] {
  const wire: OpenAIWireMessage[] = [
    { role: "system", content: systemPrompt },
  ];
  if (!messages || messages.length === 0) {
    wire.push({ role: "user", content: prompt });
    return wire;
  }
  const wireName = wireNameLookup(tools);
  for (const m of messages) {
    if (m.role === "user") {
      wire.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const out: OpenAIWireMessage = { role: "assistant", content: m.content };
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: wireName(tc.name),
            arguments: JSON.stringify(tc.arguments ?? {}),
          },
        }));
      }
      wire.push(out);
    } else {
      wire.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return wire;
}

export function buildOpenAIChatRequest(
  model: string,
  systemPrompt: string,
  prompt: string,
  stream = false,
  options: {
    jsonObject?: boolean;
    tools?: WorkbenchToolDefinition[];
    messages?: WorkbenchMessage[];
  } = {},
) {
  const body: {
    model: string;
    stream: boolean;
    messages: OpenAIWireMessage[];
    response_format?: { type: "json_object" };
    tools?: Array<{
      type: "function";
      function: WorkbenchToolDefinition;
    }>;
    tool_choice?: "auto";
  } = {
    model,
    stream,
    messages: toOpenAIWireMessages(
      systemPrompt,
      prompt,
      options.messages,
      options.tools,
    ),
  };
  if (options.jsonObject) {
    body.response_format = { type: "json_object" };
  }
  if (options.tools && options.tools.length > 0) {
    // Sanitize names to ^[a-zA-Z0-9_-]+$ — OpenAI rejects dotted command ids
    // (e.g. memory.read) with HTTP 400. Mapped back in executeOpenAICompatibleTurn.
    body.tools = toolWireNames(options.tools).map(({ wire, tool }) => ({
      type: "function",
      function: { ...tool, name: wire },
    }));
    body.tool_choice = "auto";
  }
  return body;
}

export interface WorkbenchTurnParams {
  systemPrompt: string;
  prompt: string;
  /**
   * Multi-step conversation history (user/assistant/tool), excluding the system
   * prompt. When present and non-empty it supersedes `prompt` as the conversation
   * the model sees; `prompt` remains the first-turn seed and the fallback for
   * adapters without history mapping (Google, which never emits tool calls and so
   * never loops). Adapters that loop (OpenAI-compatible, Anthropic) build their
   * wire request from this.
   */
  messages?: WorkbenchMessage[];
  routing: WorkbenchRoutingOptions;
  models?: WorkbenchModel[];
  onTextDelta?: (delta: string) => void;
  jsonObject?: boolean;
  tools?: WorkbenchToolDefinition[];
  now?: () => number;
  fetchFn?: FetchLike;
  getEnv?: (name: string) => string | undefined;
}

/**
 * Whether a streamed turn for this model can also carry tool calls. Only the
 * OpenAI-compatible wire path parses tool calls out of the SSE stream
 * (readOpenAIChatStream); the Anthropic and Google streaming readers do not, so
 * a streamed tool-bearing turn there would silently drop the calls. The runtime
 * uses this to decide whether to stream a tool-offering call or buffer it.
 */
export function modelStreamsToolCalls(model: WorkbenchModel): boolean {
  return openAIHostedProviders.has(model.provider) ||
    openAICompatibleLocalProviders.has(model.provider);
}

export async function runWorkbenchTurn(
  params: WorkbenchTurnParams,
): Promise<WorkbenchTurnResult> {
  const models = params.models ?? await loadWorkbenchModels();
  const selection = selectWorkbenchModel(models, params.routing);
  const model = selection.selected;

  if (anthropicProviders.has(model.provider)) {
    return await runAnthropicMessagesTurn(params, model, selection);
  }

  if (googleProviders.has(model.provider)) {
    return await runGoogleGenerativeAITurn(params, model, selection);
  }

  if (openAIHostedProviders.has(model.provider)) {
    // Hosted OpenAI reuses the OpenAI-compatible wire path; it differs from
    // the local path only by requiring an https base URL and a bearer key.
    if (!isAllowedHostedProviderBaseUrl(model.baseUrl)) {
      throw new WorkbenchHostedProviderBaseUrlError(model.slug, model.baseUrl);
    }
    const getEnv = params.getEnv ?? ((name: string) => Deno.env.get(name));
    const apiKey = getEnv(OPENAI_API_KEY_ENV_VAR);
    if (!apiKey) {
      throw new HostedProviderCredentialMissingError(
        model.slug,
        OPENAI_API_KEY_ENV_VAR,
      );
    }
    return await executeOpenAICompatibleTurn(params, model, selection, {
      authHeader: `Bearer ${apiKey}`,
    });
  }

  if (!openAICompatibleLocalProviders.has(model.provider)) {
    throw new HostedInferenceRequiresProviderError(model.slug);
  }
  if (!isAllowedLocalProviderBaseUrl(model.baseUrl)) {
    throw new WorkbenchLocalProviderBaseUrlError(model.slug, model.baseUrl);
  }
  return await executeOpenAICompatibleTurn(params, model, selection, {});
}

/**
 * Execute one OpenAI-compatible chat/completions turn. Shared by the local
 * provider path (no auth) and the hosted OpenAI path (bearer key). The caller
 * has already validated the base URL and provider.
 */
async function executeOpenAICompatibleTurn(
  params: WorkbenchTurnParams,
  model: WorkbenchModel,
  selection: WorkbenchSelection,
  opts: { authHeader?: string },
): Promise<WorkbenchTurnResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const now = params.now ?? performance.now.bind(performance);
  const stream = params.onTextDelta !== undefined;
  const requestStarted = now();
  const response = await fetchFn(
    `${model.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.authHeader ? { authorization: opts.authHeader } : {}),
      },
      body: JSON.stringify(
        buildOpenAIChatRequest(
          model.slug,
          params.systemPrompt,
          params.prompt,
          stream,
          {
            jsonObject: params.jsonObject,
            tools: params.tools,
            messages: params.messages,
          },
        ),
      ),
    },
  );
  const headersReceived = now();

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Model request failed for ${model.slug}: HTTP ${response.status}` +
        (detail ? ` ${detail.slice(0, 300)}` : ""),
    );
  }

  const result = stream
    ? await readOpenAIChatStream(
      response,
      params.onTextDelta!,
      now,
      requestStarted,
      headersReceived,
    )
    : await readOpenAIChatJson(response, now, requestStarted, headersReceived);
  let text = result.text;
  let toolCalls = result.toolCalls;
  let finishReason = result.finishReason;
  // Some servers (mlx_lm + Qwen3-Coder) leak tool calls as text instead of
  // parsing them; recover them so the agent loop still fires.
  if (!toolCalls || toolCalls.length === 0) {
    const recovered = extractTextToolCalls(text);
    if (recovered.toolCalls.length > 0) {
      toolCalls = recovered.toolCalls;
      text = recovered.cleaned;
      finishReason = "tool_calls";
    }
  }
  // Map wire tool names back to the registry names the runtime dispatches on.
  if (toolCalls && params.tools) {
    const originalByWire = new Map(
      toolWireNames(params.tools).map(({ wire, tool }) => [wire, tool.name]),
    );
    toolCalls = toolCalls.map((call) => ({
      ...call,
      name: originalByWire.get(call.name) ?? call.name,
    }));
  }
  const input = result.usage?.prompt_tokens ??
    estimateTextTokens(estimateParamsInputText(params));
  const output = result.usage?.completion_tokens ?? estimateTextTokens(text);
  const timings = withTimePerOutputToken(result.timings, output);
  const costTotal = (input / 1_000_000) * model.costInput +
    (output / 1_000_000) * model.costOutput;

  return {
    text,
    model,
    selection,
    usage: {
      input,
      output,
      cost: { total: costTotal },
      cacheRead: 0,
      cacheWrite: 0,
    },
    stopReason: normaliseFinishReason(finishReason),
    toolCalls,
    timings,
  };
}

function isAllowedLocalProviderBaseUrl(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  return allowedLocalProviderHosts.has(parsed.hostname.toLowerCase());
}

function isAllowedHostedProviderBaseUrl(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  return parsed.protocol === "https:";
}

export interface AnthropicStreamEvent {
  done: boolean;
  textDelta?: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// Anthropic tool names must match ^[a-zA-Z0-9_-]{1,64}$. DYFJ command ids
// use dots (memory.read), so the adapter maps names onto the wire and back.
/**
 * Map each tool's registry name to a wire-safe name matching `^[a-zA-Z0-9_-]+$`
 * (e.g. `memory.read` -> `memory_read`), truncated to 64 and de-duplicated. Both
 * the OpenAI-compatible and Anthropic adapters require this pattern — dotted
 * command ids are rejected (OpenAI returns HTTP 400). Returns `{wire, tool}`
 * pairs so the caller can map response tool calls back to the registry name it
 * dispatches on.
 */
export function toolWireNames(
  tools: WorkbenchToolDefinition[],
): Array<{ wire: string; tool: WorkbenchToolDefinition }> {
  const used = new Set<string>();
  return tools.map((tool) => {
    let wire = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    while (used.has(wire)) wire = `${wire.slice(0, 60)}_${used.size}`;
    used.add(wire);
    return { wire, tool };
  });
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

type AnthropicWireMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

/**
 * Map the agent-loop history to Anthropic's message shape: assistant turns carry
 * `tool_use` blocks (names sanitized to the wire form we offered), and tool
 * results become `tool_result` blocks in a following user turn. Consecutive tool
 * results are merged into a single user turn, which is how Anthropic expects a
 * batch of results for one assistant turn's tool calls.
 */
function toAnthropicWireMessages(
  prompt: string,
  messages: WorkbenchMessage[] | undefined,
  tools: WorkbenchToolDefinition[] | undefined,
): AnthropicWireMessage[] {
  if (!messages || messages.length === 0) {
    return [{ role: "user", content: prompt }];
  }
  const wireName = wireNameLookup(tools);
  const wire: AnthropicWireMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      wire.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content && m.content.trim().length > 0) {
        blocks.push({ type: "text", text: m.content });
      }
      for (const tc of m.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: wireName(tc.name),
          input: tc.arguments ?? {},
        });
      }
      wire.push({ role: "assistant", content: blocks });
    } else {
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
      };
      const last = wire[wire.length - 1];
      if (
        last && last.role === "user" && Array.isArray(last.content) &&
        last.content[0]?.type === "tool_result"
      ) {
        last.content.push(block);
      } else {
        wire.push({ role: "user", content: [block] });
      }
    }
  }
  return wire;
}

export function buildAnthropicMessagesRequest(
  model: string,
  systemPrompt: string,
  prompt: string,
  stream = false,
  options: {
    jsonObject?: boolean;
    tools?: WorkbenchToolDefinition[];
    messages?: WorkbenchMessage[];
  } = {},
) {
  // The stable system prompt is the cache prefix: cache_control on the first
  // block, volatile additions in later blocks, so repeated turns read the
  // prefix at cache pricing instead of re-paying full input price.
  const system: Array<{
    type: "text";
    text: string;
    cache_control?: { type: "ephemeral" };
  }> = [
    {
      type: "text",
      text: systemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ];
  if (options.jsonObject) {
    system.push({
      type: "text",
      text: "Respond with a single valid JSON object and nothing else.",
    });
  }

  const body: {
    model: string;
    max_tokens: number;
    stream: boolean;
    system: typeof system;
    messages: AnthropicWireMessage[];
    tools?: Array<{
      name: string;
      description: string;
      input_schema: Record<string, unknown>;
    }>;
  } = {
    model,
    max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
    stream,
    system,
    messages: toAnthropicWireMessages(prompt, options.messages, options.tools),
  };
  if (options.tools && options.tools.length > 0) {
    body.tools = toolWireNames(options.tools).map(
      ({ wire, tool }) => ({
        name: wire,
        description: tool.description,
        input_schema: tool.parameters,
      }),
    );
  }
  return body;
}

export function parseAnthropicStreamLine(
  line: string,
): AnthropicStreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("data:")) return null;

  const json = JSON.parse(trimmed.slice("data:".length).trim()) as {
    type?: string;
    message?: {
      usage?: {
        input_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };
    delta?: { type?: string; text?: string; stop_reason?: string };
    usage?: { output_tokens?: number };
  };

  switch (json.type) {
    case "message_start":
      return {
        done: false,
        inputTokens: json.message?.usage?.input_tokens,
        cacheReadTokens: json.message?.usage?.cache_read_input_tokens,
        cacheWriteTokens: json.message?.usage?.cache_creation_input_tokens,
      };
    case "content_block_delta":
      return json.delta?.type === "text_delta"
        ? { done: false, textDelta: json.delta.text }
        : { done: false };
    case "message_delta":
      return {
        done: false,
        stopReason: json.delta?.stop_reason,
        outputTokens: json.usage?.output_tokens,
      };
    case "message_stop":
      return { done: true };
    default:
      return null;
  }
}

function normaliseAnthropicStopReason(
  reason: string | undefined,
): WorkbenchTurnResult["stopReason"] {
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_use";
  if (reason === "refusal") return "error";
  return "stop";
}

async function runAnthropicMessagesTurn(
  params: WorkbenchTurnParams,
  model: WorkbenchModel,
  selection: WorkbenchSelection,
): Promise<WorkbenchTurnResult> {
  if (!isAllowedHostedProviderBaseUrl(model.baseUrl)) {
    throw new WorkbenchHostedProviderBaseUrlError(model.slug, model.baseUrl);
  }
  const getEnv = params.getEnv ?? ((name: string) => Deno.env.get(name));
  const apiKey = getEnv(ANTHROPIC_API_KEY_ENV_VAR);
  if (!apiKey) {
    throw new HostedProviderCredentialMissingError(
      model.slug,
      ANTHROPIC_API_KEY_ENV_VAR,
    );
  }

  const fetchFn = params.fetchFn ?? fetch;
  const now = params.now ?? performance.now.bind(performance);
  const stream = params.onTextDelta !== undefined;
  const requestStarted = now();
  const response = await fetchFn(
    `${model.baseUrl.replace(/\/$/, "")}/v1/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify(
        buildAnthropicMessagesRequest(
          model.slug,
          params.systemPrompt,
          params.prompt,
          stream,
          {
            jsonObject: params.jsonObject,
            tools: params.tools,
            messages: params.messages,
          },
        ),
      ),
    },
  );
  const headersReceived = now();

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Anthropic request failed for ${model.slug}: HTTP ${response.status}` +
        (detail ? ` ${detail.slice(0, 300)}` : ""),
    );
  }

  const result = stream
    ? await readAnthropicMessagesStream(
      response,
      params.onTextDelta!,
      now,
      requestStarted,
      headersReceived,
    )
    : await readAnthropicMessagesJson(
      response,
      now,
      requestStarted,
      headersReceived,
    );

  // Map wire tool names back to the registry names the runtime dispatches on.
  let toolCalls = result.toolCalls;
  if (toolCalls && params.tools) {
    const originalByWire = new Map(
      toolWireNames(params.tools).map((
        { wire, tool },
      ) => [wire, tool.name]),
    );
    toolCalls = toolCalls.map((call) => ({
      ...call,
      name: originalByWire.get(call.name) ?? call.name,
    }));
  }

  const input = result.inputTokens ??
    estimateTextTokens(estimateParamsInputText(params));
  const output = result.outputTokens ?? estimateTextTokens(result.text);
  const cacheRead = result.cacheReadTokens ?? 0;
  const cacheWrite = result.cacheWriteTokens ?? 0;
  const timings = withTimePerOutputToken(result.timings, output);
  // input_tokens excludes cache traffic; total prompt = input + read + write.
  const costTotal = (input / 1_000_000) * model.costInput +
    (cacheRead / 1_000_000) * model.costInput *
      ANTHROPIC_CACHE_READ_COST_MULTIPLIER +
    (cacheWrite / 1_000_000) * model.costInput *
      ANTHROPIC_CACHE_WRITE_COST_MULTIPLIER +
    (output / 1_000_000) * model.costOutput;

  return {
    text: result.text,
    model,
    selection,
    usage: {
      input,
      output,
      cost: { total: costTotal },
      cacheRead,
      cacheWrite,
    },
    stopReason: normaliseAnthropicStopReason(result.stopReason),
    toolCalls,
    timings,
  };
}

async function readAnthropicMessagesJson(
  response: Response,
  now: () => number,
  requestStarted: number,
  headersReceived: number,
): Promise<{
  text: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolCalls?: WorkbenchToolCall[];
  timings: WorkbenchCallTimings;
}> {
  const json = await response.json() as {
    content?: Array<{
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  const completed = now();

  let text = "";
  const toolCalls: WorkbenchToolCall[] = [];
  for (const block of json.content ?? []) {
    if (block.type === "text" && block.text) text += block.text;
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? `tool-call-${toolCalls.length + 1}`,
        name: block.name ?? "",
        arguments: block.input ?? {},
      });
    }
  }

  return {
    text,
    stopReason: json.stop_reason,
    inputTokens: json.usage?.input_tokens,
    outputTokens: json.usage?.output_tokens,
    cacheReadTokens: json.usage?.cache_read_input_tokens,
    cacheWriteTokens: json.usage?.cache_creation_input_tokens,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    timings: {
      responseHeadersMs: Math.round(headersReceived - requestStarted),
      totalMs: Math.round(completed - requestStarted),
    },
  };
}

async function readAnthropicMessagesStream(
  response: Response,
  onTextDelta: (delta: string) => void,
  now: () => number,
  requestStarted: number,
  headersReceived: number,
): Promise<{
  text: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolCalls?: WorkbenchToolCall[];
  timings: WorkbenchCallTimings;
}> {
  if (!response.body) {
    throw new Error("Streaming model response did not include a response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let stopReason: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let firstTokenAt: number | undefined;

  const applyEvent = (event: AnthropicStreamEvent) => {
    if (event.textDelta) {
      firstTokenAt ??= now();
      text += event.textDelta;
      onTextDelta(event.textDelta);
    }
    if (event.stopReason) stopReason = event.stopReason;
    if (event.inputTokens !== undefined) inputTokens = event.inputTokens;
    if (event.outputTokens !== undefined) outputTokens = event.outputTokens;
    if (event.cacheReadTokens !== undefined) {
      cacheReadTokens = event.cacheReadTokens;
    }
    if (event.cacheWriteTokens !== undefined) {
      cacheWriteTokens = event.cacheWriteTokens;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseAnthropicStreamLine(line);
      if (event && !event.done) applyEvent(event);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const event = parseAnthropicStreamLine(buffer);
    if (event && !event.done) applyEvent(event);
  }

  const completed = now();
  return {
    text,
    stopReason,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    timings: {
      responseHeadersMs: Math.round(headersReceived - requestStarted),
      timeToFirstTokenMs: firstTokenAt === undefined
        ? undefined
        : Math.round(firstTokenAt - requestStarted),
      generationMs: firstTokenAt === undefined
        ? undefined
        : Math.round(completed - firstTokenAt),
      totalMs: Math.round(completed - requestStarted),
    },
  };
}

// ─── Google Generative AI (Gemini) adapter ───────────────────────────────────
// Gemini's wire format is its own: model in the URL path, x-goog-api-key
// header, contents/systemInstruction/generationConfig request, and
// candidates[].content.parts[].text + usageMetadata response. Tool calling
// uses a different shape and is deferred; Gemini turns are text/JSON only.

export interface GeminiStreamEvent {
  done: boolean;
  textDelta?: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export function buildGeminiRequest(
  systemPrompt: string,
  prompt: string,
  options: { jsonObject?: boolean } = {},
) {
  const body: {
    systemInstruction: { parts: Array<{ text: string }> };
    contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    generationConfig: { maxOutputTokens: number; responseMimeType?: string };
  } = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: GEMINI_DEFAULT_MAX_TOKENS },
  };
  if (options.jsonObject) {
    body.generationConfig.responseMimeType = "application/json";
  }
  return body;
}

export function parseGeminiStreamLine(line: string): GeminiStreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("data:")) return null;

  const json = JSON.parse(trimmed.slice("data:".length).trim()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    };
  };
  const candidate = json.candidates?.[0];
  const textDelta = (candidate?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("") || undefined;
  return {
    done: false,
    textDelta,
    stopReason: candidate?.finishReason,
    inputTokens: json.usageMetadata?.promptTokenCount,
    outputTokens: json.usageMetadata?.candidatesTokenCount,
  };
}

function normaliseGeminiStopReason(
  reason: string | undefined,
): WorkbenchTurnResult["stopReason"] {
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "STOP" || reason === undefined) return "stop";
  // SAFETY, RECITATION, PROHIBITED_CONTENT, OTHER, etc.
  return "error";
}

async function runGoogleGenerativeAITurn(
  params: WorkbenchTurnParams,
  model: WorkbenchModel,
  selection: WorkbenchSelection,
): Promise<WorkbenchTurnResult> {
  if (!isAllowedHostedProviderBaseUrl(model.baseUrl)) {
    throw new WorkbenchHostedProviderBaseUrlError(model.slug, model.baseUrl);
  }
  const getEnv = params.getEnv ?? ((name: string) => Deno.env.get(name));
  const apiKey = getEnv(GEMINI_API_KEY_ENV_VAR);
  if (!apiKey) {
    throw new HostedProviderCredentialMissingError(
      model.slug,
      GEMINI_API_KEY_ENV_VAR,
    );
  }

  const fetchFn = params.fetchFn ?? fetch;
  const now = params.now ?? performance.now.bind(performance);
  const stream = params.onTextDelta !== undefined;
  const base = model.baseUrl.replace(/\/$/, "");
  const endpoint = stream
    ? `${base}/v1beta/models/${model.slug}:streamGenerateContent?alt=sse`
    : `${base}/v1beta/models/${model.slug}:generateContent`;
  const requestStarted = now();
  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(
      buildGeminiRequest(params.systemPrompt, params.prompt, {
        jsonObject: params.jsonObject,
      }),
    ),
  });
  const headersReceived = now();

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Gemini request failed for ${model.slug}: HTTP ${response.status}` +
        (detail ? ` ${detail.slice(0, 300)}` : ""),
    );
  }

  const result = stream
    ? await readGeminiStream(
      response,
      params.onTextDelta!,
      now,
      requestStarted,
      headersReceived,
    )
    : await readGeminiJson(response, now, requestStarted, headersReceived);

  const input = result.inputTokens ??
    estimateTextTokens(estimateParamsInputText(params));
  const output = result.outputTokens ?? estimateTextTokens(result.text);
  const timings = withTimePerOutputToken(result.timings, output);
  const costTotal = (input / 1_000_000) * model.costInput +
    (output / 1_000_000) * model.costOutput;

  return {
    text: result.text,
    model,
    selection,
    usage: {
      input,
      output,
      cost: { total: costTotal },
      cacheRead: 0,
      cacheWrite: 0,
    },
    stopReason: normaliseGeminiStopReason(result.stopReason),
    toolCalls: undefined,
    timings,
  };
}

async function readGeminiJson(
  response: Response,
  now: () => number,
  requestStarted: number,
  headersReceived: number,
): Promise<{
  text: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  timings: WorkbenchCallTimings;
}> {
  const json = await response.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    };
  };
  const completed = now();
  const candidate = json.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");

  return {
    text,
    stopReason: candidate?.finishReason,
    inputTokens: json.usageMetadata?.promptTokenCount,
    outputTokens: json.usageMetadata?.candidatesTokenCount,
    timings: {
      responseHeadersMs: Math.round(headersReceived - requestStarted),
      totalMs: Math.round(completed - requestStarted),
    },
  };
}

async function readGeminiStream(
  response: Response,
  onTextDelta: (delta: string) => void,
  now: () => number,
  requestStarted: number,
  headersReceived: number,
): Promise<{
  text: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  timings: WorkbenchCallTimings;
}> {
  if (!response.body) {
    throw new Error("Streaming model response did not include a response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let stopReason: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let firstTokenAt: number | undefined;

  const applyEvent = (event: GeminiStreamEvent) => {
    if (event.textDelta) {
      firstTokenAt ??= now();
      text += event.textDelta;
      onTextDelta(event.textDelta);
    }
    if (event.stopReason) stopReason = event.stopReason;
    if (event.inputTokens !== undefined) inputTokens = event.inputTokens;
    if (event.outputTokens !== undefined) outputTokens = event.outputTokens;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseGeminiStreamLine(line);
      if (event && !event.done) applyEvent(event);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const event = parseGeminiStreamLine(buffer);
    if (event && !event.done) applyEvent(event);
  }

  const completed = now();
  return {
    text,
    stopReason,
    inputTokens,
    outputTokens,
    timings: {
      responseHeadersMs: Math.round(headersReceived - requestStarted),
      timeToFirstTokenMs: firstTokenAt === undefined
        ? undefined
        : Math.round(firstTokenAt - requestStarted),
      generationMs: firstTokenAt === undefined
        ? undefined
        : Math.round(completed - firstTokenAt),
      totalMs: Math.round(completed - requestStarted),
    },
  };
}

export function withTimePerOutputToken(
  timings: WorkbenchCallTimings,
  outputTokens: number,
): WorkbenchCallTimings {
  if (outputTokens <= 0) return timings;

  if (timings.generationMs !== undefined) {
    if (outputTokens <= 1) return timings;
    return {
      ...timings,
      timePerOutputTokenMs: Math.round(
        timings.generationMs / (outputTokens - 1),
      ),
    };
  }

  return timings;
}

export function parseOpenAIChatStreamLine(
  line: string,
): OpenAIChatStreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("data:")) return null;

  const data = trimmed.slice("data:".length).trim();
  if (data === "[DONE]") return { done: true };

  const json = JSON.parse(data) as {
    choices?: Array<{
      delta?: {
        content?: string;
        tool_calls?: Array<{
          index?: number;
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      message?: { content?: string };
      finish_reason?: string;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
    };
  };
  const choice = json.choices?.[0];
  const rawToolCalls = choice?.delta?.tool_calls;
  const toolCallDeltas = rawToolCalls && rawToolCalls.length > 0
    ? rawToolCalls.map((tc, i) => ({
      index: tc.index ?? i,
      id: tc.id,
      name: tc.function?.name,
      argumentsFragment: tc.function?.arguments,
    }))
    : undefined;
  return {
    done: false,
    textDelta: choice?.delta?.content ?? choice?.message?.content ?? undefined,
    toolCallDeltas,
    finishReason: choice?.finish_reason ?? undefined,
    usage: json.usage,
  };
}

async function readOpenAIChatJson(
  response: Response,
  now: () => number,
  requestStarted: number,
  headersReceived: number,
): Promise<{
  text: string;
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  toolCalls?: WorkbenchToolCall[];
  timings: WorkbenchCallTimings;
}> {
  const json = await response.json() as {
    choices?: Array<{
      message?: {
        content?: string;
        tool_calls?: Array<{
          id?: string;
          type?: string;
          function?: {
            name?: string;
            arguments?: string;
          };
        }>;
      };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const completed = now();
  const choice = json.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    finishReason: choice?.finish_reason,
    usage: json.usage,
    toolCalls: parseOpenAIToolCalls(choice?.message?.tool_calls),
    timings: {
      responseHeadersMs: Math.round(headersReceived - requestStarted),
      totalMs: Math.round(completed - requestStarted),
    },
  };
}

function parseOpenAIToolCalls(
  toolCalls:
    | Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>
    | undefined,
): WorkbenchToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  return toolCalls.map((toolCall, idx) => ({
    id: toolCall.id ?? `tool-call-${idx + 1}`,
    name: toolCall.function?.name ?? "",
    arguments: parseToolArguments(toolCall.function?.arguments),
  }));
}

function parseToolArguments(
  value: string | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

const TEXT_FUNCTION_RE = /<function=([^>\s]+)\s*>([\s\S]*?)<\/function>/g;
const TEXT_PARAM_RE = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g;
const TEXT_TOOLCALL_TAG_RE = /<\/?tool_call>/g;

function coerceParamValue(raw: string): unknown {
  if (raw === "") return "";
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Recover tool calls that a model emitted as text instead of structured
 * tool_calls. Qwen3-Coder (via mlx_lm) frequently leaks its native XML dialect
 * into the content — `<function=NAME><parameter=KEY>VALUE</parameter>…</function>`,
 * optionally wrapped in `<tool_call>` — which the inference server does not
 * parse. This extracts those calls so the agent loop still fires, and returns
 * the text with the markup stripped. Server-agnostic: only triggers when the
 * structured tool_calls are absent and the markup is present.
 */
export function extractTextToolCalls(
  text: string,
): { toolCalls: WorkbenchToolCall[]; cleaned: string } {
  const toolCalls: WorkbenchToolCall[] = [];
  const fn = new RegExp(TEXT_FUNCTION_RE);
  let match: RegExpExecArray | null;
  while ((match = fn.exec(text)) !== null) {
    const args: Record<string, unknown> = {};
    const params = new RegExp(TEXT_PARAM_RE);
    let p: RegExpExecArray | null;
    while ((p = params.exec(match[2])) !== null) {
      args[p[1]] = coerceParamValue(p[2].trim());
    }
    toolCalls.push({
      id: `text-tool-${toolCalls.length + 1}`,
      name: match[1],
      arguments: args,
    });
  }
  if (toolCalls.length === 0) return { toolCalls, cleaned: text };
  const cleaned = text
    .replace(new RegExp(TEXT_FUNCTION_RE), "")
    .replace(TEXT_TOOLCALL_TAG_RE, "")
    .trim();
  return { toolCalls, cleaned };
}

async function readOpenAIChatStream(
  response: Response,
  onTextDelta: (delta: string) => void,
  now: () => number,
  requestStarted: number,
  headersReceived: number,
): Promise<{
  text: string;
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  // The OpenAI-compatible stream carries tool calls as indexed deltas, which
  // this reader accumulates — so a streamed turn can both stream text and
  // request tools (unlike the Anthropic/Google streaming readers).
  toolCalls?: WorkbenchToolCall[];
  timings: WorkbenchCallTimings;
}> {
  if (!response.body) {
    throw new Error("Streaming model response did not include a response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finishReason: string | undefined;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  let firstTokenAt: number | undefined;
  // Once a model leaks tool-call markup into the text (Qwen3-Coder via mlx_lm),
  // stop forwarding deltas to the user — the markup is recovered into structured
  // tool calls by extractTextToolCalls, so showing the raw XML would be noise.
  let suppressing = false;

  // Tool calls arrive as deltas keyed by index; id/name land in the first
  // fragment for that index and arguments stream as string fragments (MLX sends
  // the whole call in one delta, hosted OpenAI fragments it — both accumulate).
  const toolAcc = new Map<
    number,
    { id?: string; name?: string; args: string }
  >();

  const applyEvent = (event: OpenAIChatStreamEvent) => {
    if (event.textDelta) {
      firstTokenAt ??= now();
      const prevLen = text.length;
      text += event.textDelta;
      if (!suppressing) {
        const markup = text.search(/<tool_call>|<function=/);
        if (markup === -1) {
          onTextDelta(event.textDelta);
        } else {
          // Forward only the part of this delta before the markup begins.
          const forwardLen = markup - prevLen;
          if (forwardLen > 0) onTextDelta(event.textDelta.slice(0, forwardLen));
          suppressing = true;
        }
      }
    }
    for (const delta of event.toolCallDeltas ?? []) {
      const acc = toolAcc.get(delta.index) ?? { args: "" };
      if (delta.id) acc.id = delta.id;
      if (delta.name) acc.name = delta.name;
      if (delta.argumentsFragment) acc.args += delta.argumentsFragment;
      toolAcc.set(delta.index, acc);
    }
    if (event.finishReason) finishReason = event.finishReason;
    if (event.usage) usage = event.usage;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseOpenAIChatStreamLine(line);
      if (event && !event.done) applyEvent(event);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const event = parseOpenAIChatStreamLine(buffer);
    if (event && !event.done) applyEvent(event);
  }

  const toolCalls: WorkbenchToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, acc]) => ({
      id: acc.id ?? `tool-call-${index + 1}`,
      name: acc.name ?? "",
      arguments: parseToolArguments(acc.args),
    }));

  const completed = now();
  return {
    text,
    finishReason,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
    timings: {
      responseHeadersMs: Math.round(headersReceived - requestStarted),
      timeToFirstTokenMs: firstTokenAt === undefined
        ? undefined
        : Math.round(firstTokenAt - requestStarted),
      generationMs: firstTokenAt === undefined
        ? undefined
        : Math.round(completed - firstTokenAt),
      totalMs: Math.round(completed - requestStarted),
    },
  };
}

function normaliseFinishReason(
  reason: string | undefined,
): WorkbenchTurnResult["stopReason"] {
  if (reason === "length") return "length";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "error") return "error";
  return "stop";
}
