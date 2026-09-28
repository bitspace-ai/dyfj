/**
 * The Anthropic Messages adapter.
 */
import type { BaseUrlCheck, ProviderAdapter } from "../adapter.ts";
import {
  HostedProviderCredentialMissingError,
  WorkbenchHostedProviderBaseUrlError,
} from "../errors.ts";
import { fetchWithHeaderTimeout, providerFetchDeadline } from "../http.ts";
import { annotateProviderAbort } from "../shared/abort.ts";
import { isAllowedHostedProviderBaseUrl } from "../shared/base-url.ts";
import { outputCap } from "../shared/output-cap.ts";
import { stopReasonWithAbort } from "../shared/stop-reason.ts";
import {
  estimateParamsInputText,
  estimateTextTokens,
  withTimePerOutputToken,
} from "../shared/tokens.ts";
import { toolWireNames } from "../shared/tool-names.ts";
import { abortedWorkbenchTurnResult } from "../shared/turn-result.ts";
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  buildAnthropicMessagesRequest,
} from "./request.ts";
import { normaliseAnthropicStopReason } from "./stop-reason.ts";
import {
  readAnthropicMessagesJson,
  readAnthropicMessagesStream,
} from "./stream.ts";
import { anthropicCost } from "./usage.ts";

/**
 * The env var the Anthropic key is read from, and the one https host and base
 * paths that key may be sent to: the same key-to-host contract the hosted
 * OpenAI-compatible providers declare in `openAIHostedProviderContracts`, so a
 * catalog row cannot pair the key with any other endpoint. The host and paths
 * are the canonical endpoint `getModelAccessModality` classifies as
 * frontier-hosted.
 */
export const anthropicHostedContract = {
  keyEnvVar: "ANTHROPIC_API_KEY",
  host: "api.anthropic.com",
  paths: ["", "/"],
} as const;

export const anthropicAdapter: ProviderAdapter = {
  api: "anthropic",
  providers: new Set(["anthropic"]),
  // The streaming reader carries text only, so tool-offering calls buffer.
  streamsToolCalls: false,
  supportsTranscriptRetry: true,
  defaultOutputTokens: () => ANTHROPIC_DEFAULT_MAX_TOKENS,
  validateBaseUrl(model): BaseUrlCheck {
    return isAllowedHostedProviderBaseUrl(
        model.baseUrl,
        anthropicHostedContract.host,
        anthropicHostedContract.paths,
      )
      ? { ok: true }
      : {
        ok: false,
        error: new WorkbenchHostedProviderBaseUrlError(
          model.slug,
          model.baseUrl,
        ),
      };
  },
  async run(request, io) {
    const { model, selection } = request;
    const apiKey = io.env.get(anthropicHostedContract.keyEnvVar);
    if (!apiKey) {
      throw new HostedProviderCredentialMissingError(
        model.slug,
        anthropicHostedContract.keyEnvVar,
      );
    }
    if (io.signal?.aborted) {
      return abortedWorkbenchTurnResult(request, 0, false);
    }

    const now = () => io.clock.now();
    const onFrame = io.onFrame;
    const stream = onFrame !== undefined;
    const requestStarted = now();
    const response = await fetchWithHeaderTimeout(
      io.fetch,
      `${model.baseUrl.replace(/\/+$/, "")}/v1/messages`,
      {
        method: "POST",
        signal: io.signal,
        // Refuse redirects, as every adapter does: the request goes only to
        // the validated base URL.
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify(
          buildAnthropicMessagesRequest(
            model.slug,
            request.systemPrompt,
            request.prompt,
            stream,
            {
              jsonObject: request.jsonObject,
              tools: request.tools,
              messages: request.messages,
              maxTokens: outputCap(
                model,
                request.maxOutputTokens,
                ANTHROPIC_DEFAULT_MAX_TOKENS,
              ),
            },
          ),
        ),
      },
      `anthropic/${model.slug}`,
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

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Anthropic request failed for ${model.slug}: HTTP ${response.status}` +
          (detail ? ` ${detail.slice(0, 300)}` : ""),
      );
    }

    const result = onFrame !== undefined
      ? await readAnthropicMessagesStream(
        response,
        (delta) => onFrame({ type: "text_delta", delta }),
        now,
        requestStarted,
        headersReceived,
        io.signal,
      )
      : await readAnthropicMessagesJson(
        response,
        now,
        requestStarted,
        headersReceived,
      );

    // Map wire tool names back to the registry names the runtime dispatches on.
    let toolCalls = result.toolCalls;
    if (!result.aborted && toolCalls && request.tools) {
      const originalByWire = new Map(
        toolWireNames(request.tools).map((
          { wire, tool },
        ) => [wire, tool.name]),
      );
      toolCalls = toolCalls.map((call) => ({
        ...call,
        name: originalByWire.get(call.name) ?? call.name,
      }));
    }

    const input = result.inputTokens ??
      estimateTextTokens(estimateParamsInputText(request));
    const output = result.outputTokens ?? estimateTextTokens(result.text);
    const cacheRead = result.cacheReadTokens ?? 0;
    const cacheWrite = result.cacheWriteTokens ?? 0;
    const timings = withTimePerOutputToken(result.timings, output);
    const costTotal = anthropicCost(model, {
      input,
      output,
      cacheRead,
      cacheWrite,
    });

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
      stopReason: stopReasonWithAbort(
        result.aborted,
        normaliseAnthropicStopReason(result.stopReason),
      ),
      toolCalls: result.aborted ? undefined : toolCalls,
      timings,
    };
  },
};
