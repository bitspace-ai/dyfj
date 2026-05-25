import type { WorkbenchRoutingOptions } from "./provider";
import process from "node:process";

export interface WorkbenchReceiptInput {
  sessionId: string;
  traceId: string;
  modelName: string;
  modelSlug: string;
  tier: 0 | 1 | 2;
  routingReason: string;
  totalCostUsd: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCalls: number;
}

export function formatMoney(value: number): string {
  return `$${value.toFixed(6)}`;
}

export function buildWorkbenchReceipt(input: WorkbenchReceiptInput): string {
  return [
    "Workbench receipt",
    `Session: ${input.sessionId}`,
    `Trace:   ${input.traceId}`,
    `Model:   ${input.modelName} (${input.modelSlug}, tier ${input.tier})`,
    `Route:   ${input.routingReason}`,
    `Cost:    ${formatMoney(input.totalCostUsd)}`,
    `Tokens:  ${input.totalTokensInput} in, ${input.totalTokensOutput} out`,
    `Calls:   ${input.totalCalls}`,
  ].join("\n");
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

export async function runWorkbench(args = process.argv.slice(2)): Promise<void> {
  const {
    generateULID,
    generateTraceId,
    generateSpanId,
    writeEvent,
    closeDoltPool,
  } = await import("./utils");
  const { runWorkbenchTurn } = await import("./provider");
  const { BudgetTracker } = await import("./budget");
  const {
    loadMemoriesByType,
    loadMemoryIndex,
    buildSystemPrompt,
  } = await import("./memory");

  const cliModel = getArg(args, "--model");
  const cliTier = getArg(args, "--tier");
  const cliHint = getArg(args, "--hint") as "code" | "chat" | "reasoning" | undefined;
  const cliPrompt = getArg(args, "--prompt") ?? "What is the next useful DYFJ workbench step?";

  const routingOptions: WorkbenchRoutingOptions = {
    modelId: cliModel,
    hint: cliHint,
    tier: cliTier === undefined ? undefined : Number(cliTier) as 0 | 1 | 2,
  };

  const sessionId = generateULID();
  const traceId = generateTraceId();
  const sessionStart = Date.now();
  const budget = new BudgetTracker(sessionId, traceId);
  const principalId = process.env.DYFJ_PRINCIPAL_ID ?? process.env.USER ?? "user";

  console.log("DYFJ Workbench\n");

  await writeEvent({
    event_id: generateULID(),
    session_id: sessionId,
    event_type: "session_start",
    trace_id: traceId,
    span_id: generateSpanId(),
    principal_id: principalId,
    principal_type: "human",
    action: "start",
    resource: "workbench_session",
    authz_basis: "user_consent",
  });

  console.log("Loading context...");
  const coreMemories = await loadMemoriesByType(["user", "feedback"]);
  const memoryIndex = await loadMemoryIndex(["project", "reference"]);
  console.log(`Loaded ${coreMemories.length} core memories, ${memoryIndex.length} index entries\n`);

  const systemPrompt = buildSystemPrompt(coreMemories, memoryIndex);
  let spanId: string | null = null;
  let selectedForReceipt: { displayName: string; slug: string; tier: 0 | 1 | 2 } | null = null;
  let routingReason = "not_selected";

  try {
    const turn = await runWorkbenchTurn({
      systemPrompt,
      prompt: cliPrompt,
      routing: routingOptions,
    });

    selectedForReceipt = {
      displayName: turn.model.displayName,
      slug: turn.model.slug,
      tier: turn.model.tier,
    };
    routingReason = turn.selection.reason;

    console.log(`Model:  ${turn.model.displayName} (tier ${turn.model.tier})`);
    console.log(`Route:  ${turn.selection.reason}\n`);
    console.log(turn.text);

    spanId = generateSpanId();
    budget.record(turn.usage, turn.model.tier);

    await writeEvent({
      event_id: generateULID(),
      session_id: sessionId,
      event_type: "model_response",
      trace_id: traceId,
      span_id: spanId,
      principal_id: principalId,
      principal_type: "agent",
      action: "invoke",
      resource: turn.model.slug,
      authz_basis: "policy:local-default",
      model_id: turn.model.slug,
      provider: turn.model.provider,
      api: turn.model.api,
      tokens_input: turn.usage.input,
      tokens_output: turn.usage.output,
      tokens_cache_read: turn.usage.cacheRead,
      tokens_cache_write: turn.usage.cacheWrite,
      cost_total: turn.usage.cost.total,
      content: turn.text,
      stop_reason: turn.stopReason,
      duration_ms: Date.now() - sessionStart,
    });
  } catch (err: unknown) {
    const name = (err as Error)?.name ?? "Error";
    if (name === "ConsentDeclinedError") {
      console.log("\nConsent declined - no model call made.");
    } else if (name === "BudgetExceededError") {
      console.log(`\nBudget exceeded: ${(err as Error).message}`);
    } else {
      console.error("\nUnexpected error:", err);
    }
  } finally {
    await writeEvent({
      event_id: generateULID(),
      session_id: sessionId,
      event_type: "session_end",
      trace_id: traceId,
      span_id: generateSpanId(),
      principal_id: principalId,
      principal_type: "human",
      action: "end",
      resource: "workbench_session",
      authz_basis: "user_consent",
      duration_ms: Date.now() - sessionStart,
    });

    await budget.writeSummaryEvent();

    const summary = budget.getSummary();
    console.log("");
    console.log(buildWorkbenchReceipt({
      sessionId,
      traceId,
      modelName: selectedForReceipt?.displayName ?? "none",
      modelSlug: selectedForReceipt?.slug ?? "none",
      tier: selectedForReceipt?.tier ?? 0,
      routingReason,
      totalCostUsd: summary.totalCostUsd,
      totalTokensInput: summary.totalTokensInput,
      totalTokensOutput: summary.totalTokensOutput,
      totalCalls: summary.totalCalls,
    }));
    await closeDoltPool();
  }
}

if (import.meta.main) {
  await runWorkbench();
}
