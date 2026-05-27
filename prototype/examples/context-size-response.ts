import {
  compareContextPayloads,
  type ContextPayloadReport,
} from "../src/context-size-response";
import { defaultLocalWorkbenchModels } from "../src/provider";

const prompt = firstPrompt(Deno.args) ??
  "Return exactly this text and nothing else: context changes model work.";
const modelSlug = getArg(Deno.args, "--model") ??
  Deno.env.get("DYFJ_WORKBENCH_MODEL") ??
  "gemma4:e2b";
const baseUrl = getArg(Deno.args, "--base-url") ??
  Deno.env.get("DYFJ_WORKBENCH_BASE_URL") ??
  "http://localhost:11434/v1";
const largeRepeats = Number(getArg(Deno.args, "--large-repeats") ?? "180");
const model = {
  ...defaultLocalWorkbenchModels()[0],
  slug: modelSlug,
  displayName: modelSlug,
  baseUrl,
};

console.log("Workbench context-size diagnostic");
console.log(`Provider: ${model.provider} / ${model.api}`);
console.log(`Model:    ${model.slug}`);
console.log(`Base URL: ${model.baseUrl}`);
console.log("");

try {
  await compareContextPayloads({
    prompt: "Return ok.",
    routing: { modelId: model.slug },
    models: [model],
    payloads: [{
      label: "warmup",
      systemPrompt: "Warm the local model before measuring.",
    }],
  });

  const reports = await compareContextPayloads({
    prompt,
    routing: { modelId: model.slug },
    models: [model],
    payloads: [
      {
        label: "small",
        systemPrompt:
          "You are running a local diagnostic. Follow the user instruction exactly.",
      },
      {
        label: "large",
        systemPrompt: [
          "You are running a local diagnostic. Follow the user instruction exactly.",
          "Additional inert context follows. It is deliberately repetitive so the diagnostic can observe input-size effects.",
          "context ballast ".repeat(largeRepeats),
        ].join("\n"),
      },
    ],
  });

  for (const report of reports) {
    console.log(formatReport(report));
    console.log("");
  }

  const small = reports.find((report) => report.label === "small");
  const large = reports.find((report) => report.label === "large");
  console.log("Observation");
  console.log(
    `Small context used about ${
      small?.estimated_input_tokens ?? "n/a"
    } input tokens; large context used about ${
      large?.estimated_input_tokens ?? "n/a"
    }.`,
  );
  console.log(
    `TTFT changed from ${small?.time_to_first_token_ms ?? "n/a"}ms to ${
      large?.time_to_first_token_ms ?? "n/a"
    }ms; total latency changed from ${small?.total_latency_ms ?? "n/a"}ms to ${
      large?.total_latency_ms ?? "n/a"
    }ms.`,
  );
  console.log(
    "Treat one live run as a signal, not a benchmark: output length, model cache state, and scheduler noise can move these numbers.",
  );
} catch (err) {
  console.error("Diagnostic failed.");
  console.error(
    "Requires a local OpenAI-compatible Ollama endpoint, for example: ollama serve and ollama pull gemma4:e2b.",
  );
  console.error((err as Error)?.message ?? String(err));
  Deno.exit(1);
}

function formatReport(report: ContextPayloadReport): string {
  return JSON.stringify(
    {
      label: report.label,
      provider: report.provider,
      api: report.api,
      model: report.model,
      routing_reason: report.routing_reason,
      streamed: report.streamed,
      estimated_input_tokens: report.estimated_input_tokens,
      actual_input_tokens: report.actual_input_tokens,
      output_tokens: report.output_tokens,
      total_latency_ms: report.total_latency_ms,
      time_to_first_token_ms: report.time_to_first_token_ms,
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
