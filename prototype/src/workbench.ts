import type { WorkbenchRoutingOptions } from "./provider";
import process from "node:process";
import { createInterface } from "node:readline/promises";

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

export interface PaidEscalationPreflightInput {
  modelName: string;
  modelSlug: string;
  tier: 0 | 1 | 2;
  routingReason: string;
  estimatedCostUsd: number;
  sessionCostSoFarUsd: number;
  sessionLimitUsd: number;
  perCallLimitUsd: number;
}

export class ConsentDeclinedError extends Error {
  constructor() {
    super("Paid inference consent declined");
    this.name = "ConsentDeclinedError";
  }
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

export function buildPaidEscalationPreflightBanner(input: PaidEscalationPreflightInput): string {
  const sessionHeadroom = Math.max(0, input.sessionLimitUsd - input.sessionCostSoFarUsd);
  return [
    "Paid inference preflight",
    `Model:           ${input.modelName} (${input.modelSlug})`,
    `Tier:            ${input.tier}`,
    `Route:           ${input.routingReason}`,
    `Estimated cost:  ${formatMoney(input.estimatedCostUsd)}`,
    `Session spent:   ${formatMoney(input.sessionCostSoFarUsd)} / ${formatMoney(input.sessionLimitUsd)}`,
    `Session headroom: ${formatMoney(sessionHeadroom)}`,
    `Per-call limit:  ${formatMoney(input.perCallLimitUsd)}`,
  ].join("\n");
}

export function maybeBuildPaidEscalationPreflightBanner(input: PaidEscalationPreflightInput): string | null {
  if (input.tier === 0) return null;
  return buildPaidEscalationPreflightBanner(input);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

async function confirmPaidEscalation(banner: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${banner}\nContinue with paid inference? Type yes to run: `);
    if (answer.trim().toLowerCase() !== "yes") {
      throw new ConsentDeclinedError();
    }
  } finally {
    rl.close();
  }
}

export async function runWorkbench(args = process.argv.slice(2)): Promise<void> {
  const {
    generateULID,
    generateTraceId,
    generateSpanId,
    writeEvent,
    writeModelSelectedEvent,
    closeDoltPool,
  } = await import("./utils");
  const {
    estimateTextTokens,
    loadWorkbenchModels,
    runWorkbenchTurn,
    selectWorkbenchModel,
  } = await import("./provider");
  const { BudgetExceededError, BudgetTracker } = await import("./budget");
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
  let selectedForEvents: { slug: string; provider: string; api: string } | null = null;
  let routingReason = "not_selected";

  try {
    const models = await loadWorkbenchModels();
    const selection = selectWorkbenchModel(models, routingOptions);
    const selected = selection.selected;
    selectedForEvents = {
      slug: selected.slug,
      provider: selected.provider,
      api: selected.api,
    };
    const estimatedInputTokens = estimateTextTokens(`${systemPrompt}\n${cliPrompt}`);
    const preCall = budget.checkPreCall(selected.tier, selected.costInput, estimatedInputTokens);

    if (!preCall.allowed) {
      const limit = preCall.reason === "per_call_limit"
        ? preCall.perCallLimitUsd
        : preCall.sessionLimitUsd;
      throw new BudgetExceededError(
        preCall.reason ?? "session_limit",
        preCall.estimatedCost,
        limit,
        preCall.sessionCostSoFar,
      );
    }

    const preflightBanner = maybeBuildPaidEscalationPreflightBanner({
      modelName: selected.displayName,
      modelSlug: selected.slug,
      tier: selected.tier,
      routingReason: selection.reason,
      estimatedCostUsd: preCall.estimatedCost,
      sessionCostSoFarUsd: preCall.sessionCostSoFar,
      sessionLimitUsd: preCall.sessionLimitUsd,
      perCallLimitUsd: preCall.perCallLimitUsd,
    });
    if (preflightBanner !== null) {
      await confirmPaidEscalation(preflightBanner);
    }

    await writeModelSelectedEvent({
      selected: selected.slug,
      considered: selection.considered,
      reason: selection.reason,
      sessionId,
      traceId,
      provider: selected.provider,
      api: selected.api,
      durationMs: Date.now() - sessionStart,
    });

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
      await writeEvent({
        event_id: generateULID(),
        session_id: sessionId,
        event_type: "error",
        trace_id: traceId,
        span_id: generateSpanId(),
        principal_id: principalId,
        principal_type: "agent",
        action: "invoke",
        resource: selectedForEvents?.slug ?? "workbench_model",
        authz_basis: "policy:local-default",
        model_id: selectedForEvents?.slug ?? null,
        provider: selectedForEvents?.provider ?? null,
        api: selectedForEvents?.api ?? null,
        content: (err as Error).message,
        stop_reason: "error",
        duration_ms: Date.now() - sessionStart,
      });
      console.log(`\nBudget exceeded: ${(err as Error).message}`);
    } else {
      await writeEvent({
        event_id: generateULID(),
        session_id: sessionId,
        event_type: "error",
        trace_id: traceId,
        span_id: generateSpanId(),
        principal_id: principalId,
        principal_type: "agent",
        action: "invoke",
        resource: selectedForEvents?.slug ?? "workbench_model",
        authz_basis: "policy:local-default",
        model_id: selectedForEvents?.slug ?? null,
        provider: selectedForEvents?.provider ?? null,
        api: selectedForEvents?.api ?? null,
        content: (err as Error)?.message ?? String(err),
        stop_reason: "error",
        duration_ms: Date.now() - sessionStart,
      });
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
