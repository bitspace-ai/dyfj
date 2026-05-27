import {
  estimateTextTokens,
  type FetchLike,
  runWorkbenchTurn,
  type WorkbenchModel,
  type WorkbenchRoutingOptions,
} from "./provider";

export interface ContextPayload {
  label: string;
  systemPrompt: string;
}

export interface ContextPayloadReport {
  label: string;
  streamed: boolean;
  provider: string;
  model: string;
  api: string;
  routing_reason: string;
  estimated_input_tokens: number;
  actual_input_tokens: number;
  output_tokens: number;
  total_latency_ms: number;
  time_to_first_token_ms: number | null;
  cost_total_usd: number;
  text: string;
}

export async function compareContextPayloads(params: {
  prompt: string;
  routing: WorkbenchRoutingOptions;
  payloads: ContextPayload[];
  models?: WorkbenchModel[];
  now?: () => number;
  fetchFn?: FetchLike;
}): Promise<ContextPayloadReport[]> {
  const reports: ContextPayloadReport[] = [];
  for (const payload of params.payloads) {
    const turn = await runWorkbenchTurn({
      systemPrompt: payload.systemPrompt,
      prompt: params.prompt,
      routing: params.routing,
      models: params.models,
      onTextDelta: () => {},
      now: params.now,
      fetchFn: params.fetchFn,
    });

    reports.push({
      label: payload.label,
      streamed: true,
      provider: turn.model.provider,
      model: turn.model.slug,
      api: turn.model.api,
      routing_reason: turn.selection.reason,
      estimated_input_tokens: estimateTextTokens(
        `${payload.systemPrompt}\n${params.prompt}`,
      ),
      actual_input_tokens: turn.usage.input,
      output_tokens: turn.usage.output,
      total_latency_ms: turn.timings.totalMs,
      time_to_first_token_ms: turn.timings.timeToFirstTokenMs ?? null,
      cost_total_usd: turn.usage.cost.total,
      text: turn.text,
    });
  }
  return reports;
}
