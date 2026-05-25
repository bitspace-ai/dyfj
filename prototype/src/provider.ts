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

export function parseModelRegistryRows(rows: Record<string, string>[]): WorkbenchModel[] {
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
    if (!selected) throw new WorkbenchModelNotFoundError(`tier:${options.tier}`);
    return { selected, considered: [], reason: "explicit_tier" };
  }

  const localModels = models.filter((model) => model.tier === 0);
  const considered = localModels.map((model) => model.slug);

  if (options.hint === "code") {
    const selected =
      localModels.find((model) => model.capabilities.includes("code")) ??
      localModels.find((model) => model.slug === "gemma4") ??
      localModels[0];
    if (!selected) throw new WorkbenchModelNotFoundError("tier:0");
    return {
      selected,
      considered,
      reason: selected.capabilities.includes("code") ? "hint_code" : "hint_code_fallback_local",
    };
  }

  const selected =
    localModels.find((model) => model.slug === "gemma4") ??
    localModels[0];
  if (!selected) throw new WorkbenchModelNotFoundError("tier:0");
  return { selected, considered, reason: "default" };
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildOpenAIChatRequest(model: string, systemPrompt: string, prompt: string) {
  return {
    model,
    stream: false,
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
  fetchFn?: FetchLike;
}): Promise<WorkbenchTurnResult> {
  const models = await loadWorkbenchModels();
  const selection = selectWorkbenchModel(models, params.routing);
  const model = selection.selected;

  if (model.provider !== "ollama") {
    throw new HostedInferenceRequiresProviderError(model.slug);
  }

  const fetchFn = params.fetchFn ?? fetch;
  const response = await fetchFn(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildOpenAIChatRequest(model.slug, params.systemPrompt, params.prompt)),
  });

  if (!response.ok) {
    throw new Error(`Local model request failed: HTTP ${response.status}`);
  }

  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = json.choices?.[0]?.message?.content ?? "";
  const input = json.usage?.prompt_tokens ?? estimateTextTokens(`${params.systemPrompt}\n${params.prompt}`);
  const output = json.usage?.completion_tokens ?? estimateTextTokens(text);
  const costTotal =
    (input / 1_000_000) * model.costInput +
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
    stopReason: normaliseFinishReason(json.choices?.[0]?.finish_reason),
  };
}

function normaliseFinishReason(reason: string | undefined): WorkbenchTurnResult["stopReason"] {
  if (reason === "length") return "length";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "error") return "error";
  return "stop";
}
