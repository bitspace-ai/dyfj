/**
 * The adapter registry: which adapter serves a model, what that adapter can
 * do, and `runWorkbenchTurn`, which selects a model and dispatches the turn to
 * its adapter.
 *
 * Adding an API family is one adapter directory plus one line in
 * `PROVIDER_ADAPTERS` (`specs/recipes/add-provider.md`). Adapters are keyed by
 * the catalog `provider` column: each declares the providers it serves, and a
 * provider no adapter serves fails closed before any request.
 */
import { processEnv } from "../../config/mod.ts";
import type { ProviderAdapter, ProviderIO } from "../adapter.ts";
import { HostedInferenceRequiresProviderError } from "../errors.ts";
import type {
  WorkbenchModel,
  WorkbenchTurnParams,
  WorkbenchTurnResult,
} from "../types.ts";
import { outputCap } from "../shared/output-cap.ts";
import {
  abortedWorkbenchTurnResult,
  recoverWorkbenchAbort,
} from "../shared/turn-result.ts";
import { anthropicAdapter } from "../anthropic/adapter.ts";
import { geminiAdapter } from "../gemini/adapter.ts";
import { openAICompatibleAdapter } from "../openai-compatible/adapter.ts";
import { selectWorkbenchModel } from "./routing.ts";

/** The production adapters. One line per API family. */
export const PROVIDER_ADAPTERS: readonly ProviderAdapter[] = [
  anthropicAdapter,
  geminiAdapter,
  openAICompatibleAdapter,
];

export interface ProviderRegistry {
  /** The adapter serving this model's provider, if any. */
  adapterFor(model: WorkbenchModel): ProviderAdapter | undefined;
  runWorkbenchTurn(params: WorkbenchTurnParams): Promise<WorkbenchTurnResult>;
}

/**
 * A registry over `adapters`. Providers must not overlap: the first adapter
 * that declares a provider would win silently, so an overlap throws here.
 */
export function createProviderRegistry(
  adapters: readonly ProviderAdapter[],
): ProviderRegistry {
  const byProvider = new Map<string, ProviderAdapter>();
  for (const adapter of adapters) {
    for (const provider of adapter.providers) {
      const existing = byProvider.get(provider);
      if (existing !== undefined) {
        throw new Error(
          `provider ${provider} is served by both ${existing.api} and ${adapter.api}`,
        );
      }
      byProvider.set(provider, adapter);
    }
  }
  const adapterFor = (model: WorkbenchModel) => byProvider.get(model.provider);

  return {
    adapterFor,
    async runWorkbenchTurn(params) {
      const selection = selectWorkbenchModel(
        params.models,
        params.routing,
        params.defaultModelId,
      );
      const model = selection.selected;
      const request = {
        model,
        selection,
        systemPrompt: params.systemPrompt,
        prompt: params.prompt,
        messages: params.messages,
        jsonObject: params.jsonObject,
        tools: params.tools,
        historyTools: params.historyTools,
        sessionId: params.sessionId,
        maxOutputTokens: params.maxOutputTokens,
      };
      if (params.abortSignal?.aborted) {
        return abortedWorkbenchTurnResult(request, 0, false);
      }

      const adapter = adapterFor(model);
      if (adapter === undefined) {
        throw new HostedInferenceRequiresProviderError(model.slug);
      }
      const baseUrl = adapter.validateBaseUrl(model);
      if (!baseUrl.ok) throw baseUrl.error;

      const onTextDelta = params.onTextDelta;
      const getEnv = params.getEnv;
      const io: ProviderIO = {
        fetch: params.fetchFn ?? fetch,
        clock: { now: params.now ?? performance.now.bind(performance) },
        env: getEnv === undefined ? processEnv : { get: getEnv },
        onFrame: onTextDelta === undefined
          ? undefined
          : (frame) => onTextDelta(frame.delta),
        signal: params.abortSignal,
      };
      try {
        return await adapter.run(request, io);
      } catch (error) {
        return recoverWorkbenchAbort(error, request, io.signal);
      }
    },
  };
}

const defaultRegistry = createProviderRegistry(PROVIDER_ADAPTERS);

export function runWorkbenchTurn(
  params: WorkbenchTurnParams,
): Promise<WorkbenchTurnResult> {
  return defaultRegistry.runWorkbenchTurn(params);
}

/**
 * Whether a streamed turn for this model can also carry tool calls. Only the
 * OpenAI-compatible wire path parses tool calls out of the SSE stream
 * (readOpenAIChatStream); the Anthropic and Google streaming readers do not, so
 * a streamed tool-bearing turn there would silently drop the calls. The runtime
 * uses this to decide whether to stream a tool-offering call or buffer it.
 */
export function modelStreamsToolCalls(model: WorkbenchModel): boolean {
  return defaultRegistry.adapterFor(model)?.streamsToolCalls ?? false;
}

/**
 * Whether a turn for this model can be retried with a rewritten transcript.
 * The OpenAI-compatible and Anthropic adapters build their wire request from
 * `params.messages`; the Google adapter sends only the seed prompt, so a
 * "retry" there would replay the original request verbatim. Length recovery
 * uses this to decide whether a continuation / compressed-transcript retry is
 * even possible.
 */
export function modelSupportsTranscriptRetry(model: WorkbenchModel): boolean {
  return defaultRegistry.adapterFor(model)?.supportsTranscriptRetry ?? false;
}

/**
 * The output cap the adapter puts on the wire for `model`, or undefined when
 * it sends none: a local OpenAI-compatible request carries a cap only when
 * one was requested, so the catalog's `maxOutputTokens` is a limit the
 * server enforces on its own, not a reservation this request makes.
 * Request sizing reserves exactly this much of the context window, since a
 * provider that counts the cap against the window (OpenAI, Anthropic)
 * refuses input + cap over it.
 */
export function modelTransmittedOutputCap(
  model: WorkbenchModel,
  requestedOutputTokens?: number,
): number | undefined {
  const fallback = defaultRegistry.adapterFor(model)?.defaultOutputTokens(
    model,
  );
  if (requestedOutputTokens === undefined && fallback === undefined) {
    return undefined;
  }
  return outputCap(model, requestedOutputTokens, fallback);
}

/**
 * Whether the wire request carries `messages` and the tool definitions, so
 * sizing a request must count them. The same adapter capability as the
 * transcript retry: an adapter that sends only the seed prompt (Gemini)
 * neither replays a rewritten transcript nor sends the history at all.
 */
export function modelRequestCarriesTranscript(model: WorkbenchModel): boolean {
  return modelSupportsTranscriptRetry(model);
}

/**
 * The output-token limit used to classify stopReason "length" and size wire requests.
 * When a turn specifies `requestedOutputTokens`, the cap is bounded by the model's
 * catalog `maxOutputTokens`. When unspecified, hosted providers apply a safe default
 * request ceiling (8k/16k tokens) to prevent runaway generation while allowing explicit
 * overrides up to the catalog limit. Local OpenAI-compatible requests omit a cap unless
 * requested.
 */
export function modelRequestedOutputCap(
  model: WorkbenchModel,
  requestedOutputTokens?: number,
): number | undefined {
  return outputCap(
    model,
    requestedOutputTokens,
    defaultRegistry.adapterFor(model)?.defaultOutputTokens(model),
  );
}
