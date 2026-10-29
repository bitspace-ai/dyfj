import process from "node:process";
import {
  compareResponseModes,
  type ResponseModeReport,
} from "../diagnostics/model-response-modes.ts";
import { defaultLocalWorkbenchModels } from "../src/providers/mod.ts";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "usage: npm run model-response-modes -- [prompt] [--model <slug>] [--base-url <url>]\n\nCompares streamed and non-streamed responses from a local OpenAI-compatible\nllama.cpp endpoint. --model and --base-url default to DYFJ_WORKBENCH_MODEL and\nDYFJ_WORKBENCH_BASE_URL, then\nllama-cpp/qwen3.6-35b-a3b at http://localhost:8080/v1.",
  );
  process.exit(0);
}

const prompt = firstPrompt(args) ??
  "Return exactly this text and nothing else: streaming changes response shape.";
const modelSlug = getArg(args, "--model") ??
  process.env.DYFJ_WORKBENCH_MODEL ??
  "llama-cpp/qwen3.6-35b-a3b";
const baseUrl = getArg(args, "--base-url") ??
  process.env.DYFJ_WORKBENCH_BASE_URL ??
  "http://localhost:8080/v1";
// The built-in local default (llama.cpp), so the provider matches the loopback
// base URL. The catalog's Ollama rows were removed, so there is no Ollama row
// to look up; --model and --base-url still override the endpoint.
const model = {
  ...defaultLocalWorkbenchModels()[0],
  slug: modelSlug,
  displayName: modelSlug,
  baseUrl,
};

console.log("Workbench response mode diagnostic");
console.log(`Provider: ${model.provider} / ${model.api}`);
console.log(`Model:    ${model.slug}`);
console.log(`Base URL: ${model.baseUrl}`);
console.log("");

try {
  const reports = await compareResponseModes({
    systemPrompt:
      "You are running a local diagnostic. Answer plainly and briefly.",
    prompt,
    routing: { modelId: model.slug },
    models: [model],
  });

  for (const report of reports) {
    console.log(formatReport(report));
    console.log("");
  }

  const streaming = reports.find((report) => report.streamed);
  const nonStreaming = reports.find((report) => !report.streamed);
  console.log("Observation");
  console.log(
    `Streaming exposed first text at ${
      streaming?.time_to_first_token_ms ?? "n/a"
    }ms; non-streaming exposed text only after ${
      nonStreaming?.total_latency_ms ?? "n/a"
    }ms.`,
  );
  console.log(
    "Compare total latency separately: streaming changes when output becomes usable, not a promise that total generation is faster.",
  );
  if (streaming?.output_tokens !== nonStreaming?.output_tokens) {
    console.log(
      "Output token counts differed in this run, so total latency is not a controlled model-speed comparison.",
    );
  }
} catch (err) {
  console.error("Diagnostic failed.");
  console.error(
    "Requires the local OpenAI-compatible llama-server, for example: llama-server --alias llama-cpp/qwen3.6-35b-a3b.",
  );
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
}

function formatReport(report: ResponseModeReport): string {
  return JSON.stringify(
    {
      mode: report.mode,
      provider: report.provider,
      api: report.api,
      model: report.model,
      routing_reason: report.routing_reason,
      streamed: report.streamed,
      total_latency_ms: report.total_latency_ms,
      time_to_first_token_ms: report.time_to_first_token_ms,
      input_tokens: report.input_tokens,
      output_tokens: report.output_tokens,
      cost_total_usd: report.cost_total_usd,
    },
    null,
    2,
  );
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function firstPrompt(args: string[]): string | undefined {
  return args.find((arg, idx) =>
    !arg.startsWith("--") && (idx === 0 || !args[idx - 1]?.startsWith("--"))
  );
}
