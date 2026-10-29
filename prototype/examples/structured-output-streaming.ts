import process from "node:process";
import {
  compareStreamingStructuredOutputModes,
  type StreamingStructuredOutputReport,
} from "../diagnostics/structured-output.ts";
import { defaultLocalWorkbenchModels } from "../src/providers/mod.ts";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "usage: npm run structured-output-streaming -- [--model <slug>] [--base-url <url>] [--samples <n>]\n\nCompares streamed structured-output modes against a local OpenAI-compatible\nllama.cpp endpoint. --model and --base-url default to DYFJ_WORKBENCH_MODEL and\nDYFJ_WORKBENCH_BASE_URL, then\nllama-cpp/qwen3.6-35b-a3b at http://localhost:8080/v1.",
  );
  process.exit(0);
}

const modelSlug = getArg(args, "--model") ??
  process.env.DYFJ_WORKBENCH_MODEL ??
  "llama-cpp/qwen3.6-35b-a3b";
const baseUrl = getArg(args, "--base-url") ??
  process.env.DYFJ_WORKBENCH_BASE_URL ??
  "http://localhost:8080/v1";
const samples = parsePositiveInt(getArg(args, "--samples") ?? "1");
// The built-in local default (llama.cpp), so the provider matches the loopback
// base URL. The catalog's Ollama rows were removed, so there is no Ollama row
// to look up; --model and --base-url still override the endpoint.
const model = {
  ...defaultLocalWorkbenchModels()[0],
  slug: modelSlug,
  displayName: modelSlug,
  baseUrl,
};

console.log("Workbench streaming structured-output diagnostic");
console.log(`Provider: ${model.provider} / ${model.api}`);
console.log(`Model:    ${model.slug}`);
console.log(`Base URL: ${model.baseUrl}`);
console.log(`Samples:  ${samples}`);
console.log("");

try {
  const allReports: StreamingStructuredOutputReport[] = [];
  for (let sample = 1; sample <= samples; sample += 1) {
    const reports = await compareStreamingStructuredOutputModes({
      systemPrompt:
        "You are running a local diagnostic. Keep answers short. The rigid shape, when requested, is a JSON object with string answer and confidence low, medium, or high.",
      loosePrompt:
        "Answer in one short sentence: say ok and state high confidence.",
      rigidPrompt:
        'Return exactly this JSON object and no other text: {"answer":"ok","confidence":"high"}',
      routing: { modelId: model.slug },
      models: [model],
    });

    for (const report of reports) {
      allReports.push(report);
      console.log(formatReport(report, sample));
      console.log("");
    }
  }

  console.log("Observation");
  console.log(formatSummary("loose-streaming", allReports));
  console.log(formatSummary("rigid-streaming", allReports));
  console.log(
    "Rigid structure can improve machine-readability, but TPOT and generation time should be read as live-run signals, not a benchmark.",
  );
} catch (err) {
  console.error("Diagnostic failed.");
  console.error(
    "Requires the local OpenAI-compatible llama-server, for example: llama-server --alias llama-cpp/qwen3.6-35b-a3b.",
  );
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
}

function formatReport(
  report: StreamingStructuredOutputReport,
  sample: number,
): string {
  return JSON.stringify(
    {
      sample,
      mode: report.mode,
      provider: report.provider,
      api: report.api,
      model: report.model,
      routing_reason: report.routing_reason,
      streamed: report.streamed,
      total_latency_ms: report.total_latency_ms,
      time_to_first_token_ms: report.time_to_first_token_ms,
      generation_ms: report.generation_ms,
      time_per_output_token_ms: report.time_per_output_token_ms,
      input_tokens: report.input_tokens,
      output_tokens: report.output_tokens,
      cost_total_usd: report.cost_total_usd,
      validation_ok: report.validation.ok,
      validation_errors: report.validation.errors,
      parsed: report.parsed,
    },
    null,
    2,
  );
}

function formatSummary(
  mode: StreamingStructuredOutputReport["mode"],
  reports: StreamingStructuredOutputReport[],
): string {
  const matching = reports.filter((report) => report.mode === mode);
  const tpot = matching
    .map((report) => report.time_per_output_token_ms)
    .filter((value): value is number => value !== null);
  const validationPasses = matching.filter((report) => report.validation.ok)
    .length;

  if (tpot.length === 0) {
    return `${mode}: no TPOT samples; validation ${validationPasses}/${matching.length} passed.`;
  }

  const min = Math.min(...tpot);
  const max = Math.max(...tpot);
  const avg = Math.round(
    tpot.reduce((sum, value) => sum + value, 0) / tpot.length,
  );
  return `${mode}: TPOT avg ${avg}ms/token, min ${min}, max ${max}; validation ${validationPasses}/${matching.length} passed.`;
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--samples must be a positive integer, got: ${value}`);
  }
  return parsed;
}
