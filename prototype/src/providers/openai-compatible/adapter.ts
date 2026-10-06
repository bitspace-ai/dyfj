/**
 * The OpenAI-compatible adapter: chat/completions over SSE or JSON, for local
 * loopback servers (no key) and hosted providers pinned to their https host
 * and bearer key. It is the one adapter that streams tool calls and recovers
 * tool calls a model leaked as text markup.
 */
import { DomainError } from "../../contract/mod.ts";
import type {
  BaseUrlCheck,
  ProviderAdapter,
  ProviderIO,
  ProviderTurnRequest,
} from "../adapter.ts";
import {
  HostedProviderCredentialMissingError,
  ProviderContextExceededError,
  WorkbenchHostedProviderBaseUrlError,
  WorkbenchLocalProviderBaseUrlError,
} from "../errors.ts";
import { fetchWithHeaderTimeout, providerFetchDeadline } from "../http.ts";
import type { WorkbenchModel, WorkbenchTurnResult } from "../types.ts";
import { annotateProviderAbort } from "../shared/abort.ts";
import { classifyContextExceeded } from "../shared/context-exceeded.ts";
import {
  isAllowedHostedProviderBaseUrl,
  isAllowedLocalProviderBaseUrl,
} from "../shared/base-url.ts";
import { outputCap } from "../shared/output-cap.ts";
import { stopReasonWithAbort } from "../shared/stop-reason.ts";
import {
  canonicalToolCallSignature,
  detectUnparsedToolCallMarkup,
  extractTextToolCallsInternal,
  stripIncompleteTextToolCallSuffix,
} from "../shared/text-tool-calls.ts";
import { withTimePerOutputToken } from "../shared/tokens.ts";
import { toolWireNames } from "../shared/tool-names.ts";
import { abortedWorkbenchTurnResult } from "../shared/turn-result.ts";
import {
  HOSTED_OPENAI_DEFAULT_MAX_TOKENS,
  openAICompatibleLocalProviders,
  openAIHostedProviderContracts,
  openAIHostedProviders,
} from "./providers.ts";
import { buildOpenAIChatRequest } from "./request.ts";
import { readBoundedOpenAIText, readOpenAIChatJson } from "./response.ts";
import { normaliseFinishReason } from "./stop-reason.ts";
import { readOpenAIChatStream } from "./stream.ts";
import { openAIChatUsage } from "./usage.ts";

export const openAICompatibleAdapter: ProviderAdapter = {
  api: "openai-compatible",
  providers: new Set([
    ...openAICompatibleLocalProviders,
    ...openAIHostedProviders,
  ]),
  streamsToolCalls: true,
  supportsTranscriptRetry: true,
  defaultOutputTokens: (model) =>
    openAIHostedProviders.has(model.provider)
      ? HOSTED_OPENAI_DEFAULT_MAX_TOKENS
      : undefined,
  validateBaseUrl(model): BaseUrlCheck {
    const hostedContract = openAIHostedProviderContracts.get(model.provider);
    if (hostedContract !== undefined) {
      // Hosted OpenAI-compatible reuses the local wire path; it differs only by
      // requiring the provider's pinned https host and its own bearer key.
      return isAllowedHostedProviderBaseUrl(model.baseUrl, hostedContract.host)
        ? { ok: true }
        : {
          ok: false,
          error: new WorkbenchHostedProviderBaseUrlError(
            model.slug,
            model.baseUrl,
          ),
        };
    }
    return isAllowedLocalProviderBaseUrl(model.baseUrl) ? { ok: true } : {
      ok: false,
      error: new WorkbenchLocalProviderBaseUrlError(
        model.slug,
        model.baseUrl,
      ),
    };
  },
  run(request, io) {
    const { model } = request;
    const hostedContract = openAIHostedProviderContracts.get(model.provider);
    if (hostedContract === undefined) {
      return executeOpenAICompatibleTurn(request, io, {});
    }
    const apiKey = io.env.get(hostedContract.keyEnvVar);
    if (!apiKey) {
      throw new HostedProviderCredentialMissingError(
        model.slug,
        hostedContract.keyEnvVar,
      );
    }
    const extraHeaders: Record<string, string> = {};
    if (model.provider === "xai" && request.sessionId) {
      extraHeaders["x-grok-conv-id"] = request.sessionId;
    }
    return executeOpenAICompatibleTurn(request, io, {
      authHeader: `Bearer ${apiKey}`,
      extraHeaders,
    });
  },
};

function requestOutputCap(
  model: WorkbenchModel,
  requestedOutputTokens: number | undefined,
): number | undefined {
  return outputCap(
    model,
    requestedOutputTokens,
    openAICompatibleAdapter.defaultOutputTokens(model),
  );
}

/**
 * The error for a non-2xx response. A context-size rejection is overflow
 * the engine can recover from, so it is typed; everything else stays the
 * generic failure (the body is a bounded diagnostic, never a trusted
 * message).
 */
async function httpFailure(
  model: WorkbenchModel,
  response: Response,
): Promise<Error> {
  const detail = response.body === null
    ? ""
    : await readBoundedOpenAIText(response).catch((error) => {
      if (error instanceof DomainError) throw error;
      return "";
    });
  const exceeded = classifyContextExceeded(response.status, detail);
  if (exceeded !== null) {
    return new ProviderContextExceededError(
      model.slug,
      response.status,
      exceeded,
    );
  }
  return new Error(
    `Model request failed for ${model.slug}: HTTP ${response.status}` +
      (detail ? ` ${detail.slice(0, 300)}` : ""),
  );
}

/**
 * Execute one OpenAI-compatible chat/completions turn. Shared by the local
 * provider path (no auth) and the hosted OpenAI path (bearer key). The caller
 * has already validated the base URL and provider.
 */
async function executeOpenAICompatibleTurn(
  request: ProviderTurnRequest,
  io: ProviderIO,
  opts: { authHeader?: string; extraHeaders?: Record<string, string> },
): Promise<WorkbenchTurnResult> {
  const { model, selection } = request;
  if (io.signal?.aborted) {
    return abortedWorkbenchTurnResult(request, 0, false);
  }
  const now = () => io.clock.now();
  const onFrame = io.onFrame;
  const stream = onFrame !== undefined;
  const requestStarted = now();
  const response = await fetchWithHeaderTimeout(
    io.fetch,
    `${model.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      signal: io.signal,
      // Refuse redirects: only the initial base URL is validated as loopback for
      // local providers, so following a 307/308 could re-POST the (private)
      // transcript body to an off-box target. A redirect on a completions POST
      // is anomalous regardless of provider — fail closed, matching the recall
      // path's redirect posture.
      redirect: "error",
      headers: {
        "content-type": "application/json",
        ...(opts.authHeader ? { authorization: opts.authHeader } : {}),
        ...(opts.extraHeaders ?? {}),
      },
      body: JSON.stringify(
        buildOpenAIChatRequest(
          model.slug,
          request.systemPrompt,
          request.prompt,
          stream,
          {
            jsonObject: request.jsonObject,
            tools: request.tools,
            historyTools: request.historyTools,
            messages: request.messages,
            maxCompletionTokens: openAIHostedProviders.has(model.provider)
              ? requestOutputCap(model, request.maxOutputTokens)
              : request.maxOutputTokens,
            includeStreamUsage: openAIHostedProviders.has(model.provider),
            reasoningEffort: (model.provider === "openai" &&
                model.reasoningEffortControl &&
                request.tools &&
                request.tools.length > 0)
              ? "none"
              : undefined,
          },
        ),
      ),
    },
    `${model.provider}/${model.slug}`,
    ...providerFetchDeadline(stream),
  ).catch((error) =>
    annotateProviderAbort(
      error,
      io.signal,
      now,
      requestStarted,
    )
  );
  const headersReceived = now();

  if (!response.ok) throw await httpFailure(model, response);

  const result = onFrame !== undefined
    ? await readOpenAIChatStream(
      response,
      (delta) => onFrame({ type: "text_delta", delta }),
      now,
      requestStarted,
      headersReceived,
      io.signal,
      request.tools,
    )
    : await readOpenAIChatJson(response, now, requestStarted, headersReceived);
  const generatedText = result.text;
  let text = result.text;
  let toolCalls = result.toolCalls;
  let finishReason = result.finishReason;
  // Some servers (mlx_lm + Qwen3-Coder) leak offered tool calls as text instead
  // of parsing them. Recover only those calls and leave unrelated function-like
  // prose untouched.
  if (result.aborted) {
    text = stripIncompleteTextToolCallSuffix(text, request.tools);
  } else if (finishReason === "error") {
    if (result.visibleText !== undefined) text = result.visibleText;
  } else if (
    request.tools && request.tools.length > 0
  ) {
    const offered = new Set(
      toolWireNames(request.tools).map(({ wire }) => wire),
    );
    const recovered = extractTextToolCallsInternal(text, offered, true);
    if (recovered.toolCalls.length > 0) {
      text = result.visibleText ?? recovered.cleaned;
      if (!toolCalls || toolCalls.length === 0) {
        toolCalls = recovered.toolCalls;
        finishReason = "tool_calls";
      } else {
        const existingToolCalls = toolCalls;
        const signatures = new Set<string>();
        const uncanonicalizedNames = new Set<string>();
        const seenNames = new Set<string>();
        for (const call of existingToolCalls) {
          seenNames.add(call.name);
          const signature = canonicalToolCallSignature(call);
          if (signature === undefined) uncanonicalizedNames.add(call.name);
          else signatures.add(signature);
        }
        const ids = new Set(existingToolCalls.map((call) => call.id));
        const distinct = recovered.toolCalls.flatMap((call) => {
          const signature = canonicalToolCallSignature(call);
          if (signature === undefined) {
            if (seenNames.has(call.name)) {
              throw new DomainError(
                "Provider returned ambiguous mixed tool calls",
              );
            }
            uncanonicalizedNames.add(call.name);
          } else {
            if (signatures.has(signature)) return [];
            if (uncanonicalizedNames.has(call.name)) {
              throw new DomainError(
                "Provider returned ambiguous mixed tool calls",
              );
            }
            signatures.add(signature);
          }
          seenNames.add(call.name);
          let id = call.id;
          let suffix = existingToolCalls.length + 1;
          while (ids.has(id)) id = `text-tool-${suffix++}`;
          ids.add(id);
          return [{ ...call, id }];
        });
        toolCalls = [...existingToolCalls, ...distinct];
      }
    } else if (result.visibleText !== undefined) {
      text = result.visibleText;
    }
  }
  // Map wire tool names back to the registry names the runtime dispatches on.
  if (
    !result.aborted && finishReason !== "error" && toolCalls && request.tools
  ) {
    const originalByWire = new Map(
      toolWireNames(request.tools).map(({ wire, tool }) => [wire, tool.name]),
    );
    toolCalls = toolCalls.map((call) => ({
      ...call,
      name: originalByWire.get(call.name) ?? call.name,
    }));
  }
  const metered = openAIChatUsage(result, generatedText, request, model);
  const timings = withTimePerOutputToken(result.timings, metered.output);
  const unparsedToolCallMarkup = !result.aborted && finishReason !== "error"
    ? detectUnparsedToolCallMarkup(text)
    : undefined;

  return {
    text,
    model,
    selection,
    usage: {
      input: metered.input,
      output: metered.output,
      cost: { total: metered.costTotal },
      cacheRead: metered.cacheRead,
      cacheWrite: metered.cacheWrite,
      reasoning: metered.reasoning,
    },
    stopReason: stopReasonWithAbort(
      result.aborted,
      normaliseFinishReason(finishReason),
    ),
    toolCalls: result.aborted || finishReason === "error"
      ? undefined
      : toolCalls,
    ...(unparsedToolCallMarkup ? { unparsedToolCallMarkup } : {}),
    timings,
  };
}
