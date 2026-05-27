import {
  compareResponseModes,
  type ResponseModeReport,
} from "../src/model-response-modes";
import { defaultLocalWorkbenchModels } from "../src/provider";

const prompt = firstPrompt(Deno.args) ??
  "Return exactly this text and nothing else: streaming changes response shape.";
const modelSlug = getArg(Deno.args, "--model") ??
  Deno.env.get("DYFJ_WORKBENCH_MODEL") ??
  "gemma4:e2b";
const baseUrl = getArg(Deno.args, "--base-url") ??
  Deno.env.get("DYFJ_WORKBENCH_BASE_URL") ??
  "http://localhost:11434/v1";
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
    "Requires a local OpenAI-compatible Ollama endpoint, for example: ollama serve and ollama pull gemma4:e2b.",
  );
  console.error((err as Error)?.message ?? String(err));
  Deno.exit(1);
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
