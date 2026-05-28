import {
  compareStreamingStructuredOutputModes,
  type StreamingStructuredOutputReport,
} from "../src/structured-output";
import { defaultLocalWorkbenchModels } from "../src/provider";

const modelSlug = getArg(Deno.args, "--model") ??
  Deno.env.get("DYFJ_WORKBENCH_MODEL") ??
  "gemma4:e2b";
const baseUrl = getArg(Deno.args, "--base-url") ??
  Deno.env.get("DYFJ_WORKBENCH_BASE_URL") ??
  "http://localhost:11434/v1";
const samples = parsePositiveInt(getArg(Deno.args, "--samples") ?? "1");
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
    "Requires a local OpenAI-compatible Ollama endpoint, for example: ollama serve and ollama pull gemma4:e2b.",
  );
  console.error((err as Error)?.message ?? String(err));
  Deno.exit(1);
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
