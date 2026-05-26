import type { WorkbenchRoutingOptions } from "./provider";
import type { WorkbenchCallTimings } from "./provider";
import type { PackedContextSummary } from "./repo-context";
import type { AskContextProfile } from "./repo-context";
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
  contextBudget?: PackedContextSummary;
  contextProfile?: AskContextProfile;
  timings?: WorkbenchCallTimings;
  contextSources?: string[];
  paidInferenceUsed?: boolean;
  estimatedCostUsd?: number;
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

export type BudgetTallyMode = "on" | "paid" | "off";

export interface WorkbenchInvocation {
  mode: "ask" | "turn";
  prompt: string;
  routingOptions: WorkbenchRoutingOptions;
}

export interface BudgetTallyInput {
  turn: {
    tokensInput: number;
    tokensOutput: number;
    costUsd: number;
    tier: 0 | 1 | 2;
  };
  session: {
    totalCostUsd: number;
    totalTokensInput: number;
    totalTokensOutput: number;
    paidCalls: number;
    sessionLimitUsd: number;
  };
}

export class ConsentDeclinedError extends Error {
  constructor() {
    super("Paid inference consent declined");
    this.name = "ConsentDeclinedError";
  }
}

export class PaidInferenceRequiresTtyError extends Error {
  constructor() {
    super("Paid inference requires an interactive TTY consent prompt");
    this.name = "PaidInferenceRequiresTtyError";
  }
}

export function formatMoney(value: number): string {
  return `$${value.toFixed(6)}`;
}

export function buildWorkbenchReceipt(input: WorkbenchReceiptInput): string {
  const lines = [
    "Workbench receipt",
    `Session: ${input.sessionId}`,
    `Trace:   ${input.traceId}`,
    `Model:   ${input.modelName} (${input.modelSlug}, tier ${input.tier})`,
    `Route:   ${input.routingReason}`,
    `Paid inference used: ${input.paidInferenceUsed ? "yes" : "no"}`,
    `Estimated cost: ${formatMoney(input.estimatedCostUsd ?? 0)}`,
    `Actual cost:    ${formatMoney(input.totalCostUsd)}`,
    `Tokens:  ${input.totalTokensInput} in, ${input.totalTokensOutput} out`,
    `Calls:   ${input.totalCalls}`,
  ];
  if (input.timings) {
    lines.push(formatTimingLine(input.timings));
  }
  if (input.contextBudget) {
    if (input.contextProfile) {
      lines.push(`Context profile: ${input.contextProfile}`);
    }
    lines.push(formatContextBudgetLine(input.contextBudget));
  }
  if (input.contextSources && input.contextSources.length > 0) {
    lines.push("Context sources:");
    for (const source of input.contextSources) {
      lines.push(`- ${source}`);
    }
  }
  return lines.join("\n");
}

export function formatTimingLine(timings: WorkbenchCallTimings): string {
  const parts = [
    `headers ${timings.responseHeadersMs}ms`,
  ];
  if (timings.timeToFirstTokenMs !== undefined) {
    parts.push(`TTFT ${timings.timeToFirstTokenMs}ms`);
  }
  if (timings.generationMs !== undefined) {
    parts.push(`generation ${timings.generationMs}ms`);
  }
  parts.push(`total ${timings.totalMs}ms`);
  return `Timings: ${parts.join(", ")}`;
}

export function formatContextBudgetLine(budget: PackedContextSummary): string {
  return "Context budget: " +
    `${budget.usedTokens}/${budget.totalTokens} tokens; ` +
    `system ${budget.byBucket.system.usedTokens}/${budget.byBucket.system.limitTokens}, ` +
    `active ${budget.byBucket.active_repo.usedTokens}/${budget.byBucket.active_repo.limitTokens}, ` +
    `Beads ${budget.byBucket.derived_memory.usedTokens}/${budget.byBucket.derived_memory.limitTokens}, ` +
    `headroom ${budget.headroomTokens}`;
}

export function buildPaidEscalationPreflightBanner(
  input: PaidEscalationPreflightInput,
): string {
  const sessionHeadroom = Math.max(
    0,
    input.sessionLimitUsd - input.sessionCostSoFarUsd,
  );
  return [
    "Paid inference preflight",
    `Model:           ${input.modelName} (${input.modelSlug})`,
    `Tier:            ${input.tier}`,
    `Route:           ${input.routingReason}`,
    `Estimated cost:  ${formatMoney(input.estimatedCostUsd)}`,
    `Session spent:   ${formatMoney(input.sessionCostSoFarUsd)} / ${
      formatMoney(input.sessionLimitUsd)
    }`,
    `Session headroom: ${formatMoney(sessionHeadroom)}`,
    `Per-call limit:  ${formatMoney(input.perCallLimitUsd)}`,
  ].join("\n");
}

export function maybeBuildPaidEscalationPreflightBanner(
  input: PaidEscalationPreflightInput,
): string | null {
  if (input.tier === 0) return null;
  return buildPaidEscalationPreflightBanner(input);
}

export function parseBudgetTallyMode(
  value: string | undefined,
): BudgetTallyMode {
  if (value === "on" || value === "off" || value === "paid") return value;
  return "paid";
}

export function shouldPrintBudgetTally(
  mode: BudgetTallyMode,
  session: { paidCalls: number },
): boolean {
  if (mode === "off") return false;
  if (mode === "on") return true;
  return session.paidCalls > 0;
}

export function buildBudgetTallyLine(input: BudgetTallyInput): string {
  const percentUsed = input.session.sessionLimitUsd > 0
    ? (input.session.totalCostUsd / input.session.sessionLimitUsd) * 100
    : 0;
  return [
    "Budget tally:",
    `${
      formatMoney(input.turn.costUsd)
    } this turn (${input.turn.tokensInput} in, ${input.turn.tokensOutput} out)`,
    "·",
    `${formatMoney(input.session.totalCostUsd)} session ` +
    `(${input.session.totalTokensInput} in, ${input.session.totalTokensOutput} out, ` +
    `${percentUsed.toFixed(1)}% of ${
      formatMoney(input.session.sessionLimitUsd)
    })`,
  ].join(" ");
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function firstPositional(args: string[]): string | undefined {
  return args.find((arg, idx) =>
    !arg.startsWith("--") && (idx === 0 || !args[idx - 1]?.startsWith("--"))
  );
}

function parseTier(value: string | undefined): 0 | 1 | 2 | undefined {
  if (value === undefined) return undefined;
  const tier = Number(value);
  return tier === 0 || tier === 1 || tier === 2 ? tier : undefined;
}

function parseHint(
  value: string | undefined,
): "code" | "chat" | "reasoning" | undefined {
  return value === "code" || value === "chat" || value === "reasoning"
    ? value
    : undefined;
}

export function resolveWorkbenchInvocation(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): WorkbenchInvocation {
  const mode = args[0] === "ask" ? "ask" : "turn";
  const effectiveArgs = mode === "ask" ? args.slice(1) : args;
  const cliModel = getArg(effectiveArgs, "--model");
  const cliTier = getArg(effectiveArgs, "--tier");
  const cliHint = getArg(effectiveArgs, "--hint");
  const prompt = mode === "ask"
    ? firstPositional(effectiveArgs) ?? "what should I work on next here?"
    : getArg(effectiveArgs, "--prompt") ??
      "What is the next useful DYFJ workbench step?";

  return {
    mode,
    prompt,
    routingOptions: {
      modelId: cliModel ?? env.DYFJ_WORKBENCH_MODEL,
      hint: parseHint(cliHint ?? env.DYFJ_WORKBENCH_HINT),
      tier: parseTier(cliTier ?? env.DYFJ_WORKBENCH_TIER),
    },
  };
}

export function assertPaidEscalationCanPrompt(
  isTty: boolean | undefined,
): void {
  if (!isTty) {
    throw new PaidInferenceRequiresTtyError();
  }
}

async function confirmPaidEscalation(banner: string): Promise<void> {
  assertPaidEscalationCanPrompt(process.stdin.isTTY);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `${banner}\nContinue with paid inference? Type yes to run: `,
    );
    if (answer.trim().toLowerCase() !== "yes") {
      throw new ConsentDeclinedError();
    }
  } finally {
    rl.close();
  }
}

async function writeMaybe(
  operation: () => Promise<void>,
  bestEffort: boolean,
): Promise<void> {
  try {
    await operation();
  } catch (err) {
    if (!bestEffort) throw err;
    const message = (err as Error)?.message ?? String(err);
    console.warn(`Event write skipped: ${message}`);
  }
}

export async function runWorkbench(
  args = process.argv.slice(2),
): Promise<void> {
  const {
    generateULID,
    generateTraceId,
    generateSpanId,
    writeEvent,
    writeModelSelectedEvent,
    closeDoltPool,
  } = await import("./utils");
  const {
    defaultLocalWorkbenchModels,
    estimateTextTokens,
    loadWorkbenchModels,
    runWorkbenchTurn,
    selectWorkbenchModel,
    withDefaultLocalWorkbenchModels,
  } = await import("./provider");
  const { BudgetExceededError, BudgetTracker } = await import("./budget");
  const {
    buildAskSystemPrompt,
    buildContextSourceLines,
    loadAskRepoContext,
  } = await import("./repo-context");
  const {
    loadMemoriesByType,
    loadMemoryIndex,
    buildSystemPrompt,
  } = await import("./memory");

  const { mode, prompt: cliPrompt, routingOptions } =
    resolveWorkbenchInvocation(args);

  const sessionId = generateULID();
  const traceId = generateTraceId();
  const sessionStart = Date.now();
  const budget = new BudgetTracker(sessionId, traceId);
  const principalId = process.env.DYFJ_PRINCIPAL_ID ?? process.env.USER ??
    "user";
  const bestEffortEvents = mode === "ask";

  console.log("DYFJ Workbench\n");

  await writeMaybe(() =>
    writeEvent({
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
    }), bestEffortEvents);

  let spanId: string | null = null;
  let selectedForReceipt:
    | { displayName: string; slug: string; tier: 0 | 1 | 2 }
    | null = null;
  let selectedForEvents:
    | { slug: string; provider: string; api: string }
    | null = null;
  let routingReason = "not_selected";
  let estimatedCostUsd = 0;
  let contextSourceLines: string[] = [];
  let callTimings: WorkbenchCallTimings | undefined;
  let contextBudget: PackedContextSummary | undefined;
  let contextProfile: AskContextProfile | undefined;

  try {
    let systemPrompt: string;
    if (mode === "ask") {
      console.log("Loading repo-local context...");
      const repoContext = await loadAskRepoContext();
      contextSourceLines = buildContextSourceLines(repoContext.sources);
      contextBudget = repoContext.budget;
      contextProfile = repoContext.profile;
      console.log(`Loaded ${repoContext.sources.length} context sources\n`);

      await writeMaybe(() =>
        writeEvent({
          event_id: generateULID(),
          session_id: sessionId,
          event_type: "tool_call",
          trace_id: traceId,
          span_id: generateSpanId(),
          principal_id: principalId,
          principal_type: "agent",
          action: "read",
          resource: "repo_context",
          authz_basis: "policy:repo-local-public",
          tool_name: "repo_context.load",
          tool_call_id: generateULID(),
          tool_arguments: JSON.stringify({ mode, sources: contextSourceLines }),
          tool_result: JSON.stringify({
            sourceCount: contextSourceLines.length,
          }),
          tool_is_error: false,
          content: JSON.stringify({ sources: contextSourceLines }),
          duration_ms: Date.now() - sessionStart,
        }), bestEffortEvents);

      systemPrompt = buildAskSystemPrompt(repoContext);
    } else {
      console.log("Loading context...");
      const coreMemories = await loadMemoriesByType(["user", "feedback"]);
      const memoryIndex = await loadMemoryIndex(["project", "reference"]);
      console.log(
        `Loaded ${coreMemories.length} core memories, ${memoryIndex.length} index entries\n`,
      );
      systemPrompt = buildSystemPrompt(coreMemories, memoryIndex);
    }

    let models;
    try {
      models = await loadWorkbenchModels();
      if (mode === "ask") {
        models = withDefaultLocalWorkbenchModels(models);
      }
    } catch (err) {
      if (mode !== "ask") throw err;
      const message = (err as Error)?.message ?? String(err);
      console.warn(
        `Model registry unavailable; using static local Tier 0 default: ${message}`,
      );
      models = defaultLocalWorkbenchModels();
    }
    const selection = selectWorkbenchModel(models, routingOptions);
    const selected = selection.selected;
    selectedForReceipt = {
      displayName: selected.displayName,
      slug: selected.slug,
      tier: selected.tier,
    };
    routingReason = selection.reason;
    selectedForEvents = {
      slug: selected.slug,
      provider: selected.provider,
      api: selected.api,
    };
    const estimatedInputTokens = estimateTextTokens(
      `${systemPrompt}\n${cliPrompt}`,
    );
    const preCall = budget.checkPreCall(
      selected.tier,
      selected.costInput,
      estimatedInputTokens,
    );

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
    estimatedCostUsd = preCall.estimatedCost;

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

    await writeMaybe(() =>
      writeModelSelectedEvent({
        selected: selected.slug,
        considered: selection.considered,
        reason: selection.reason,
        sessionId,
        traceId,
        provider: selected.provider,
        api: selected.api,
        durationMs: Date.now() - sessionStart,
      }), bestEffortEvents);

    console.log(`Model:  ${selected.displayName} (tier ${selected.tier})`);
    console.log(`Route:  ${selection.reason}\n`);
    let streamedText = false;
    const turn = await runWorkbenchTurn({
      systemPrompt,
      prompt: cliPrompt,
      routing: routingOptions,
      models,
      onTextDelta: (delta) => {
        streamedText = true;
        process.stdout.write(delta);
      },
    });
    if (streamedText) {
      console.log("");
    } else {
      console.log(turn.text);
    }

    selectedForReceipt = {
      displayName: turn.model.displayName,
      slug: turn.model.slug,
      tier: turn.model.tier,
    };
    routingReason = turn.selection.reason;
    callTimings = turn.timings;

    spanId = generateSpanId();
    budget.record(turn.usage, turn.model.tier);
    const summary = budget.getSummary();
    const paidCalls = (summary.byTier["1"]?.calls ?? 0) +
      (summary.byTier["2"]?.calls ?? 0);
    if (
      shouldPrintBudgetTally(
        parseBudgetTallyMode(process.env.DYFJ_BUDGET_TALLY),
        {
          paidCalls,
        },
      )
    ) {
      console.log("");
      console.log(buildBudgetTallyLine({
        turn: {
          tokensInput: turn.usage.input,
          tokensOutput: turn.usage.output,
          costUsd: turn.usage.cost.total,
          tier: turn.model.tier,
        },
        session: {
          totalCostUsd: summary.totalCostUsd,
          totalTokensInput: summary.totalTokensInput,
          totalTokensOutput: summary.totalTokensOutput,
          paidCalls,
          sessionLimitUsd: summary.config.sessionLimitUsd,
        },
      }));
    }

    await writeMaybe(() =>
      writeEvent({
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
        duration_ms: turn.timings.totalMs,
      }), bestEffortEvents);
  } catch (err: unknown) {
    const name = (err as Error)?.name ?? "Error";
    if (name === "ConsentDeclinedError") {
      console.log("\nConsent declined - no model call made.");
    } else if (name === "PaidInferenceRequiresTtyError") {
      console.log(
        "\nPaid inference blocked: non-TTY sessions cannot grant consent.",
      );
    } else if (name === "BudgetExceededError") {
      await writeMaybe(() =>
        writeEvent({
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
        }), bestEffortEvents);
      console.log(`\nBudget exceeded: ${(err as Error).message}`);
    } else {
      await writeMaybe(() =>
        writeEvent({
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
        }), bestEffortEvents);
      console.error("\nUnexpected error:", err);
    }
  } finally {
    await writeMaybe(() =>
      writeEvent({
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
      }), bestEffortEvents);

    await writeMaybe(() => budget.writeSummaryEvent(), bestEffortEvents);

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
      contextBudget,
      contextProfile,
      timings: callTimings,
      contextSources: contextSourceLines,
      paidInferenceUsed: ((summary.byTier["1"]?.calls ?? 0) +
        (summary.byTier["2"]?.calls ?? 0)) > 0,
      estimatedCostUsd,
    }));
    await closeDoltPool();
  }
}

if (import.meta.main) {
  await runWorkbench();
}
