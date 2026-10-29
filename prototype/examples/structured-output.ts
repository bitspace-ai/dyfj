import process from "node:process";
import {
  compareStructuredOutputModes,
  type StructuredOutputReport,
} from "../diagnostics/structured-output.ts";
import { defaultLocalWorkbenchModels } from "../src/providers/mod.ts";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "usage: npm run structured-output -- [prompt] [--model <slug>] [--base-url <url>]\n\nCompares structured-output modes against a local OpenAI-compatible\nllama.cpp endpoint. --model and --base-url default to\nDYFJ_WORKBENCH_MODEL and DYFJ_WORKBENCH_BASE_URL, then\nllama-cpp/qwen3.6-35b-a3b at http://localhost:8080/v1.",
  );
  process.exit(0);
}

const prompt = firstPrompt(args) ??
  'Return {"answer":"ok","confidence":"high"} and no other text.';
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
    "Requires the local OpenAI-compatible llama-server, for example: llama-server --alias llama-cpp/qwen3.6-35b-a3b.",
  );
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
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
