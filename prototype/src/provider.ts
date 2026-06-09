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

export type FetchLike = typeof fetch;

const openAICompatibleLocalProviders = new Set(["ollama", "mlx-lm"]);

export interface OpenAIChatStreamEvent {
  done: boolean;
  textDelta?: string;
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
    const selected = models.find((model) => model.tier === options.tier);
    if (!selected) {
      throw new WorkbenchModelNotFoundError(`tier:${options.tier}`);
    }
    return { selected, considered: [], reason: "explicit_tier" };
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

  const selected =
    localModels.find((model) =>
      model.slug === "mlx-community/Qwen3.5-4B-8bit"
    ) ??
      localModels.find((model) => model.slug === "laguna-xs.2") ??
      localModels.find((model) => model.slug === "gemma4:e2b") ??
      localModels.find((model) => model.slug === "gemma4") ??
      localModels[0];
  if (!selected) throw new WorkbenchModelNotFoundError("tier:0");
  return { selected, considered, reason: "default" };
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildOpenAIChatRequest(
  model: string,
  systemPrompt: string,
  prompt: string,
  stream = false,
  options: { jsonObject?: boolean; tools?: WorkbenchToolDefinition[] } = {},
) {
  const body: {
    model: string;
    stream: boolean;
    messages: Array<{ role: "system" | "user"; content: string }>;
    response_format?: { type: "json_object" };
    tools?: Array<{
      type: "function";
      function: WorkbenchToolDefinition;
    }>;
    tool_choice?: "auto";
  } = {
    model,
    stream,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
  };
  if (options.jsonObject) {
    body.response_format = { type: "json_object" };
  }
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      function: tool,
    }));
    body.tool_choice = "auto";
  }
  return body;
}

export async function runWorkbenchTurn(params: {
  systemPrompt: string;
  prompt: string;
  routing: WorkbenchRoutingOptions;
  models?: WorkbenchModel[];
  onTextDelta?: (delta: string) => void;
  jsonObject?: boolean;
  tools?: WorkbenchToolDefinition[];
  now?: () => number;
  fetchFn?: FetchLike;
}): Promise<WorkbenchTurnResult> {
  const models = params.models ?? await loadWorkbenchModels();
  const selection = selectWorkbenchModel(models, params.routing);
  const model = selection.selected;

  if (!openAICompatibleLocalProviders.has(model.provider)) {
    throw new HostedInferenceRequiresProviderError(model.slug);
  }

  const fetchFn = params.fetchFn ?? fetch;
  const now = params.now ?? performance.now.bind(performance);
  const stream = params.onTextDelta !== undefined;
  const requestStarted = now();
  const response = await fetchFn(
    `${model.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        buildOpenAIChatRequest(
          model.slug,
          params.systemPrompt,
          params.prompt,
          stream,
          { jsonObject: params.jsonObject, tools: params.tools },
        ),
      ),
    },
  );
  const headersReceived = now();

  if (!response.ok) {
    throw new Error(`Local model request failed: HTTP ${response.status}`);
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
  const text = result.text;
  const input = result.usage?.prompt_tokens ??
    estimateTextTokens(`${params.systemPrompt}\n${params.prompt}`);
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
    stopReason: normaliseFinishReason(result.finishReason),
    toolCalls: result.toolCalls,
    timings,
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
      delta?: { content?: string };
      message?: { content?: string };
      finish_reason?: string;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
    };
  };
  const choice = json.choices?.[0];
  return {
    done: false,
    textDelta: choice?.delta?.content ?? choice?.message?.content ?? undefined,
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

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseOpenAIChatStreamLine(line);
      if (!event) continue;
      if (event.done) continue;
      if (event.textDelta) {
        firstTokenAt ??= now();
        text += event.textDelta;
        onTextDelta(event.textDelta);
      }
      if (event.finishReason) finishReason = event.finishReason;
      if (event.usage) usage = event.usage;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const event = parseOpenAIChatStreamLine(buffer);
    if (event && !event.done) {
      if (event.textDelta) {
        firstTokenAt ??= now();
        text += event.textDelta;
        onTextDelta(event.textDelta);
      }
      if (event.finishReason) finishReason = event.finishReason;
      if (event.usage) usage = event.usage;
    }
  }

  const completed = now();
  return {
    text,
    finishReason,
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
