import {
  compareStructuredOutputModes,
  type StructuredOutputReport,
} from "../src/structured-output";
import { defaultLocalWorkbenchModels } from "../src/provider";

const prompt = firstPrompt(Deno.args) ??
  'Return {"answer":"ok","confidence":"high"} and no other text.';
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

console.log("Workbench structured-output diagnostic");
console.log(`Provider: ${model.provider} / ${model.api}`);
console.log(`Model:    ${model.slug}`);
console.log(`Base URL: ${model.baseUrl}`);
console.log("");

try {
  const reports = await compareStructuredOutputModes({
    systemPrompt:
      "You are running a local diagnostic. The required shape is a JSON object with string answer and confidence low, medium, or high.",
    prompt,
    routing: { modelId: model.slug },
    models: [model],
  });

  for (const report of reports) {
    console.log(formatReport(report));
    console.log("");
  }

  const promptOnly = reports.find((report) => report.mode === "prompt-only");
  const jsonObject = reports.find((report) => report.mode === "json-object");
  console.log("Observation");
  console.log(
    `Prompt-only validation: ${
      promptOnly?.validation.ok ? "passed" : "failed"
    }; JSON-object validation: ${
      jsonObject?.validation.ok ? "passed" : "failed"
    }.`,
  );
  console.log(
    "JSON-object mode can improve the interaction shape, but Workbench still validates before trusting model output.",
  );
} catch (err) {
  console.error("Diagnostic failed.");
  console.error(
    "Requires a local OpenAI-compatible Ollama endpoint, for example: ollama serve and ollama pull gemma4:e2b.",
  );
  console.error((err as Error)?.message ?? String(err));
  Deno.exit(1);
}

function formatReport(report: StructuredOutputReport): string {
  return JSON.stringify(
    {
      mode: report.mode,
      provider: report.provider,
      api: report.api,
      model: report.model,
      routing_reason: report.routing_reason,
      json_object_requested: report.json_object_requested,
      total_latency_ms: report.total_latency_ms,
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

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function firstPrompt(args: string[]): string | undefined {
  return args.find((arg, idx) =>
    !arg.startsWith("--") && (idx === 0 || !args[idx - 1]?.startsWith("--"))
  );
}
