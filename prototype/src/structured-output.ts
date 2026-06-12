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

export interface StreamingStructuredOutputReport {
  mode: "loose-streaming" | "rigid-streaming";
  streamed: true;
  provider: string;
  model: string;
  api: string;
  routing_reason: string;
  total_latency_ms: number;
  time_to_first_token_ms: number | null;
  generation_ms: number | null;
  time_per_output_token_ms: number | null;
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

export async function compareStreamingStructuredOutputModes(params: {
  systemPrompt: string;
  loosePrompt: string;
  rigidPrompt: string;
  routing: WorkbenchRoutingOptions;
  models?: WorkbenchModel[];
  now?: () => number;
  fetchFn?: FetchLike;
}): Promise<StreamingStructuredOutputReport[]> {
  const baseParams = {
    systemPrompt: params.systemPrompt,
    routing: params.routing,
    models: params.models,
    now: params.now,
    fetchFn: params.fetchFn,
  };
  const loose = await runWorkbenchTurn({
    ...baseParams,
    prompt: params.loosePrompt,
    onTextDelta: () => {},
  });
  const rigid = await runWorkbenchTurn({
    ...baseParams,
    prompt: params.rigidPrompt,
    onTextDelta: () => {},
  });

  return [
    buildStreamingReport("loose-streaming", loose),
    buildStreamingReport("rigid-streaming", rigid),
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
  const answer = parsed.answer;
  const confidence = parsed.confidence;
  if (typeof answer !== "string") {
    errors.push("answer must be a string");
  }
  if (
    confidence !== "low" &&
    confidence !== "medium" &&
    confidence !== "high"
  ) {
    errors.push("confidence must be low, medium, or high");
  }
  // Re-state the guards so control flow narrows the types for the return.
  if (
    typeof answer !== "string" ||
    (confidence !== "low" && confidence !== "medium" && confidence !== "high")
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: { answer, confidence },
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

function buildStreamingReport(
  mode: StreamingStructuredOutputReport["mode"],
  turn: Awaited<ReturnType<typeof runWorkbenchTurn>>,
): StreamingStructuredOutputReport {
  const validation = validateStructuredOutput(turn.text);
  return {
    mode,
    streamed: true,
    provider: turn.model.provider,
    model: turn.model.slug,
    api: turn.model.api,
    routing_reason: turn.selection.reason,
    total_latency_ms: turn.timings.totalMs,
    time_to_first_token_ms: turn.timings.timeToFirstTokenMs ?? null,
    generation_ms: turn.timings.generationMs ?? null,
    time_per_output_token_ms: turn.timings.timePerOutputTokenMs ?? null,
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
