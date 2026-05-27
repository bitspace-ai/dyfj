import {
  type FetchLike,
  runWorkbenchTurn,
  type WorkbenchModel,
  type WorkbenchRoutingOptions,
} from "./provider";

export interface ResponseModeReport {
  mode: "non-streaming" | "streaming";
  streamed: boolean;
  provider: string;
  model: string;
  api: string;
  routing_reason: string;
  total_latency_ms: number;
  time_to_first_token_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cost_total_usd: number;
  text: string;
}

export async function compareResponseModes(params: {
  systemPrompt: string;
  prompt: string;
  routing: WorkbenchRoutingOptions;
  models?: WorkbenchModel[];
  now?: () => number;
  fetchFn?: FetchLike;
}): Promise<ResponseModeReport[]> {
  const baseParams = {
    systemPrompt: params.systemPrompt,
    prompt: params.prompt,
    routing: params.routing,
    models: params.models,
    now: params.now,
    fetchFn: params.fetchFn,
  };

  const nonStreaming = await runWorkbenchTurn(baseParams);
  const streaming = await runWorkbenchTurn({
    ...baseParams,
    onTextDelta: () => {},
  });

  return [
    buildReport("non-streaming", false, nonStreaming),
    buildReport("streaming", true, streaming),
  ];
}

function buildReport(
  mode: ResponseModeReport["mode"],
  streamed: boolean,
  turn: Awaited<ReturnType<typeof runWorkbenchTurn>>,
): ResponseModeReport {
  return {
    mode,
    streamed,
    provider: turn.model.provider,
    model: turn.model.slug,
    api: turn.model.api,
    routing_reason: turn.selection.reason,
    total_latency_ms: turn.timings.totalMs,
    time_to_first_token_ms: turn.timings.timeToFirstTokenMs ?? null,
    input_tokens: turn.usage.input,
    output_tokens: turn.usage.output,
    cost_total_usd: turn.usage.cost.total,
    text: turn.text,
  };
}
