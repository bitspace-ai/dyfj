/**
 * The Google Generative AI (Gemini) adapter. It serves text and JSON turns:
 * it sends only the seed prompt and never returns tool calls.
 */
import type { BaseUrlCheck, ProviderAdapter } from "../adapter.ts";
import {
  HostedProviderCredentialMissingError,
  ProviderContextExceededError,
  WorkbenchHostedProviderBaseUrlError,
} from "../errors.ts";
import { fetchWithHeaderTimeout, providerFetchDeadline } from "../http.ts";
import { annotateProviderAbort } from "../shared/abort.ts";
import { classifyContextExceeded } from "../shared/context-exceeded.ts";
import { isAllowedHostedProviderBaseUrl } from "../shared/base-url.ts";
import { outputCap } from "../shared/output-cap.ts";
import { stopReasonWithAbort } from "../shared/stop-reason.ts";
import { withTimePerOutputToken } from "../shared/tokens.ts";
import { abortedWorkbenchTurnResult } from "../shared/turn-result.ts";
import { buildGeminiRequest, GEMINI_DEFAULT_MAX_TOKENS } from "./request.ts";
import { normaliseGeminiStopReason } from "./stop-reason.ts";
import { readGeminiJson, readGeminiStream } from "./stream.ts";
import { geminiUsage } from "./usage.ts";

/**
 * The env var the Gemini key is read from, and the one https host and base
 * paths that key may be sent to: the same key-to-host contract the hosted
 * OpenAI-compatible providers declare in `openAIHostedProviderContracts`, so a
 * catalog row cannot pair the key with any other endpoint. The host and paths
 * are the canonical endpoint `getModelAccessModality` classifies as
 * frontier-hosted.
 */
export const geminiHostedContract = {
  keyEnvVar: "GEMINI_API_KEY",
  host: "generativelanguage.googleapis.com",
  paths: ["", "/"],
} as const;

export const geminiAdapter: ProviderAdapter = {
  api: "gemini",
  providers: new Set(["google"]),
  streamsToolCalls: false,
  // The request carries only the seed prompt, so a retry would replay it.
  supportsTranscriptRetry: false,
  defaultOutputTokens: () => GEMINI_DEFAULT_MAX_TOKENS,
  validateBaseUrl(model): BaseUrlCheck {
    return isAllowedHostedProviderBaseUrl(
        model.baseUrl,
        geminiHostedContract.host,
        geminiHostedContract.paths,
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
    const apiKey = io.env.get(geminiHostedContract.keyEnvVar);
    if (!apiKey) {
      throw new HostedProviderCredentialMissingError(
        model.slug,
        geminiHostedContract.keyEnvVar,
      );
    }
    if (io.signal?.aborted) {
      return abortedWorkbenchTurnResult(request, 0, false);
    }

    const now = () => io.clock.now();
    const onFrame = io.onFrame;
    const stream = onFrame !== undefined;
    const base = model.baseUrl.replace(/\/+$/, "");
    // The slug is one path segment: encoded, it cannot add path segments, a
    // query or a fragment to the request URL.
    const modelPath = `${base}/v1beta/models/${encodeURIComponent(model.slug)}`;
    const endpoint = stream
      ? `${modelPath}:streamGenerateContent?alt=sse`
      : `${modelPath}:generateContent`;
    const requestStarted = now();
    const response = await fetchWithHeaderTimeout(
      io.fetch,
      endpoint,
      {
        method: "POST",
        signal: io.signal,
        // Refuse redirects, as every adapter does: the request goes only to
        // the validated base URL.
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(
          buildGeminiRequest(request.systemPrompt, request.prompt, {
            jsonObject: request.jsonObject,
            maxOutputTokens: outputCap(
              model,
              request.maxOutputTokens,
              GEMINI_DEFAULT_MAX_TOKENS,
            ),
          }),
        ),
      },
      `gemini/${model.slug}`,
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
      // A context-size rejection is overflow the engine can recover from.
      const exceeded = classifyContextExceeded(response.status, detail);
      if (exceeded !== null) {
        throw new ProviderContextExceededError(
          model.slug,
          response.status,
          exceeded,
        );
      }
      throw new Error(
        `Gemini request failed for ${model.slug}: HTTP ${response.status}` +
          (detail ? ` ${detail.slice(0, 300)}` : ""),
      );
    }

    const result = onFrame !== undefined
      ? await readGeminiStream(
        response,
        (delta) => onFrame({ type: "text_delta", delta }),
        now,
        requestStarted,
        headersReceived,
        io.signal,
      )
      : await readGeminiJson(response, now, requestStarted, headersReceived);

    const { input, output, reasoning, costTotal } = geminiUsage(
      result,
      request,
      model,
    );
    const timings = withTimePerOutputToken(result.timings, output);

    return {
      text: result.text,
      model,
      selection,
      usage: {
        input,
        output,
        cost: { total: costTotal },
        cacheRead: 0,
        cacheWrite: 0,
        reasoning,
      },
      stopReason: stopReasonWithAbort(
        result.aborted,
        normaliseGeminiStopReason(result.stopReason),
      ),
      toolCalls: undefined,
      timings,
    };
  },
};
