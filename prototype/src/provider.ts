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

export interface WorkbenchCallTimings {
  responseHeadersMs: number;
  timeToFirstTokenMs?: number;
  generationMs?: number;
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

  const selected = localModels.find((model) => model.slug === "gemma4:e2b") ??
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
) {
  return {
    model,
    stream,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
  };
}

export async function runWorkbenchTurn(params: {
  systemPrompt: string;
  prompt: string;
  routing: WorkbenchRoutingOptions;
  models?: WorkbenchModel[];
  onTextDelta?: (delta: string) => void;
  now?: () => number;
  fetchFn?: FetchLike;
}): Promise<WorkbenchTurnResult> {
  const models = params.models ?? await loadWorkbenchModels();
  const selection = selectWorkbenchModel(models, params.routing);
  const model = selection.selected;

  if (model.provider !== "ollama") {
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
    timings: result.timings,
  };
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
  timings: WorkbenchCallTimings;
}> {
  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const completed = now();
  return {
    text: json.choices?.[0]?.message?.content ?? "",
    finishReason: json.choices?.[0]?.finish_reason,
    usage: json.usage,
    timings: {
      responseHeadersMs: Math.round(headersReceived - requestStarted),
      totalMs: Math.round(completed - requestStarted),
    },
  };
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
