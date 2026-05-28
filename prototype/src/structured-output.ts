import {
  type FetchLike,
  runWorkbenchTurn,
  type WorkbenchModel,
  type WorkbenchRoutingOptions,
} from "./provider";

export interface StructuredOutputResult {
  answer: string;
  confidence: "low" | "medium" | "high";
}

export type StructuredOutputValidation =
  | { ok: true; value: StructuredOutputResult; errors: [] }
  | { ok: false; value?: undefined; errors: string[] };

export interface StructuredOutputReport {
  mode: "prompt-only" | "json-object";
  json_object_requested: boolean;
  provider: string;
  model: string;
  api: string;
  routing_reason: string;
  total_latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_total_usd: number;
  validation: StructuredOutputValidation;
  parsed: StructuredOutputResult | null;
  text: string;
}

export async function compareStructuredOutputModes(params: {
  systemPrompt: string;
  prompt: string;
  routing: WorkbenchRoutingOptions;
  models?: WorkbenchModel[];
  now?: () => number;
  fetchFn?: FetchLike;
}): Promise<StructuredOutputReport[]> {
  const baseParams = {
    systemPrompt: params.systemPrompt,
    prompt: params.prompt,
    routing: params.routing,
    models: params.models,
    now: params.now,
    fetchFn: params.fetchFn,
  };
  const promptOnly = await runWorkbenchTurn(baseParams);
  const jsonObject = await runWorkbenchTurn({
    ...baseParams,
    jsonObject: true,
  });

  return [
    buildReport("prompt-only", false, promptOnly),
    buildReport("json-object", true, jsonObject),
  ];
}

export function validateStructuredOutput(
  text: string,
): StructuredOutputValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["model output was not strict JSON"] };
  }

  if (!isRecord(parsed)) {
    return { ok: false, errors: ["model output JSON was not an object"] };
  }

  const errors: string[] = [];
  if (typeof parsed.answer !== "string") {
    errors.push("answer must be a string");
  }
  if (
    parsed.confidence !== "low" &&
    parsed.confidence !== "medium" &&
    parsed.confidence !== "high"
  ) {
    errors.push("confidence must be low, medium, or high");
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      answer: parsed.answer,
      confidence: parsed.confidence,
    },
    errors: [],
  };
}

function buildReport(
  mode: StructuredOutputReport["mode"],
  jsonObjectRequested: boolean,
  turn: Awaited<ReturnType<typeof runWorkbenchTurn>>,
): StructuredOutputReport {
  const validation = validateStructuredOutput(turn.text);
  return {
    mode,
    json_object_requested: jsonObjectRequested,
    provider: turn.model.provider,
    model: turn.model.slug,
    api: turn.model.api,
    routing_reason: turn.selection.reason,
    total_latency_ms: turn.timings.totalMs,
    input_tokens: turn.usage.input,
    output_tokens: turn.usage.output,
    cost_total_usd: turn.usage.cost.total,
    validation,
    parsed: validation.ok ? validation.value : null,
    text: turn.text,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
