// A test-only adapter for a synthetic API family, written by following
// `specs/recipes/add-provider.md`. It is not a product provider: it lives
// under `testing/` as the living example the recipe points to, and it passes
// the provider conformance kit like the production adapters.
//
// The family: a hosted API pinned to `https://synthetic.invalid`, a bearer
// key in `SYNTHETIC_API_KEY`, `POST /v1/generate`, SSE or JSON responses.

import {
  HostedProviderCredentialMissingError,
  type ProviderAdapter,
  WorkbenchHostedProviderBaseUrlError,
} from "../../../src/providers/mod.ts";
import {
  fetchWithHeaderTimeout,
  providerFetchDeadline,
} from "../../../src/providers/http.ts";
import { annotateProviderAbort } from "../../../src/providers/shared/abort.ts";
import { isAllowedHostedProviderBaseUrl } from "../../../src/providers/shared/base-url.ts";
import { outputCap } from "../../../src/providers/shared/output-cap.ts";
import { stopReasonWithAbort } from "../../../src/providers/shared/stop-reason.ts";
import { withTimePerOutputToken } from "../../../src/providers/shared/tokens.ts";
import { toolWireNames } from "../../../src/providers/shared/tool-names.ts";
import { abortedWorkbenchTurnResult } from "../../../src/providers/shared/turn-result.ts";
import {
  buildSyntheticRequest,
  SYNTHETIC_DEFAULT_MAX_TOKENS,
} from "./request.ts";
import { normaliseSyntheticStopReason } from "./stop-reason.ts";
import { readSyntheticJson, readSyntheticStream } from "./stream.ts";
import { syntheticUsage } from "./usage.ts";

const SYNTHETIC_HOST = "synthetic.invalid";
const SYNTHETIC_API_KEY_ENV_VAR = "SYNTHETIC_API_KEY";

export const syntheticAdapter: ProviderAdapter = {
  api: "synthetic",
  providers: new Set(["synthetic"]),
  streamsToolCalls: true,
  supportsTranscriptRetry: true,
  defaultOutputTokens: () => SYNTHETIC_DEFAULT_MAX_TOKENS,
  validateBaseUrl(model) {
    return isAllowedHostedProviderBaseUrl(model.baseUrl, SYNTHETIC_HOST)
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
    const apiKey = io.env.get(SYNTHETIC_API_KEY_ENV_VAR);
    if (!apiKey) {
      throw new HostedProviderCredentialMissingError(
        model.slug,
        SYNTHETIC_API_KEY_ENV_VAR,
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
      `${model.baseUrl.replace(/\/$/, "")}/v1/generate`,
      {
        method: "POST",
        signal: io.signal,
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(
          buildSyntheticRequest(
            model.slug,
            request.systemPrompt,
            request.prompt,
            stream,
            {
              messages: request.messages,
              tools: request.tools,
              maxTokens: outputCap(
                model,
                request.maxOutputTokens,
                SYNTHETIC_DEFAULT_MAX_TOKENS,
              ),
            },
          ),
        ),
      },
      `synthetic/${model.slug}`,
      ...providerFetchDeadline(stream),
    ).catch((error) =>
      annotateProviderAbort(error, io.signal, now, requestStarted)
    );
    const headersReceived = now();

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Synthetic request failed for ${model.slug}: HTTP ${response.status}`,
      );
    }

    const read = onFrame !== undefined
      ? await readSyntheticStream(
        response,
        (delta) => onFrame({ type: "text_delta", delta }),
        now,
        requestStarted,
        headersReceived,
        io.signal,
      )
      : await readSyntheticJson(response, now, requestStarted, headersReceived);

    // Map wire tool names back to the registry names the runtime dispatches on.
    let toolCalls = read.toolCalls;
    if (!read.aborted && toolCalls && request.tools) {
      const originalByWire = new Map(
        toolWireNames(request.tools).map(({ wire, tool }) => [wire, tool.name]),
      );
      toolCalls = toolCalls.map((call) => ({
        ...call,
        name: originalByWire.get(call.name) ?? call.name,
      }));
    }

    const usage = syntheticUsage(read, request, model);
    return {
      text: read.text,
      model,
      selection,
      usage: {
        input: usage.input,
        output: usage.output,
        cost: { total: usage.cost },
        cacheRead: 0,
        cacheWrite: 0,
      },
      stopReason: stopReasonWithAbort(
        read.aborted,
        normaliseSyntheticStopReason(read.reason),
      ),
      toolCalls: read.aborted ? undefined : toolCalls,
      timings: withTimePerOutputToken(read.timings, usage.output),
    };
  },
};
