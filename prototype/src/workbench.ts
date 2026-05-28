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
  provider?: string;
  api?: string;
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
  workletId?: string;
  totalElapsedMs?: number;
  validation?: WorkbenchValidationSummary;
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
  mode: "ask" | "next-work" | "turn";
  prompt: string;
  routingOptions: WorkbenchRoutingOptions;
}

export interface WorkbenchValidationSummary {
  ok: boolean;
  errors: string[];
}

export interface NextWorkBriefInput {
  workletId: string;
  contextProfile: AskContextProfile;
  prompt: string;
}

export interface NextWorkResult {
  worklet_id: string;
  context_profile: AskContextProfile;
  recommendation: string;
  rationale: string;
  evidence: string[];
  risks: string[];
  next_commands: string[];
  confidence: "low" | "medium" | "high";
}

export type NextWorkValidationResult =
  | { ok: true; value: NextWorkResult; errors: [] }
  | { ok: false; value?: undefined; errors: string[] };

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

export function buildNextWorkBrief(input: NextWorkBriefInput): string {
  return [
    "Next-work worklet brief",
    `worklet_id: ${input.workletId}`,
    `context_profile: ${input.contextProfile}`,
    `operator_prompt: ${input.prompt}`,
    "",
    "Return strict JSON only. Do not wrap it in Markdown. Do not include prose before or after the JSON.",
    "Use only the supplied repo-local context. Do not infer from private operator, cockpit, or cross-repo strategy context.",
    "",
    "Required JSON shape:",
    "{",
    '  "worklet_id": "next-work.v0",',
    '  "context_profile": "beads-first",',
    '  "recommendation": "one concrete next work item",',
    '  "rationale": "why this is next from the supplied context",',
    '  "evidence": ["specific context source or bead evidence"],',
    '  "risks": ["what could make this recommendation wrong"],',
    '  "next_commands": ["small commands the operator can run"],',
    '  "confidence": "low|medium|high"',
    "}",
  ].join("\n");
}

export function validateNextWorkJson(text: string): NextWorkValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["model output was not strict JSON"] };
  }

  if (!isRecord(parsed)) {
    return { ok: false, errors: ["model output JSON was not an object"] };
  }

  const errors: string[] = [];
  for (
    const field of [
      "worklet_id",
      "context_profile",
      "recommendation",
      "rationale",
      "evidence",
      "risks",
      "next_commands",
      "confidence",
    ]
  ) {
    if (!(field in parsed)) errors.push(`missing required field: ${field}`);
  }

  if (
    "context_profile" in parsed &&
    parsed.context_profile !== "beads-first" &&
    parsed.context_profile !== "full"
  ) {
    errors.push("context_profile must be beads-first or full");
  }
  for (const field of ["worklet_id", "recommendation", "rationale"] as const) {
    if (field in parsed && typeof parsed[field] !== "string") {
      errors.push(`${field} must be a string`);
    }
  }
  for (const field of ["evidence", "risks", "next_commands"] as const) {
    if (field in parsed && !isStringArray(parsed[field])) {
      errors.push(`${field} must be an array of strings`);
    }
  }
  if (
    "confidence" in parsed &&
    parsed.confidence !== "low" &&
    parsed.confidence !== "medium" &&
    parsed.confidence !== "high"
  ) {
    errors.push("confidence must be low, medium, or high");
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      worklet_id: parsed.worklet_id as string,
      context_profile: parsed.context_profile as AskContextProfile,
      recommendation: parsed.recommendation as string,
      rationale: parsed.rationale as string,
      evidence: parsed.evidence as string[],
      risks: parsed.risks as string[],
      next_commands: parsed.next_commands as string[],
      confidence: parsed.confidence as "low" | "medium" | "high",
    },
    errors: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string");
}

export function buildWorkbenchReceipt(input: WorkbenchReceiptInput): string {
  const lines = [
    "Workbench receipt",
    `Session: ${input.sessionId}`,
    `Trace:   ${input.traceId}`,
  ];
  if (input.workletId) {
    lines.push(`Worklet: ${input.workletId}`);
  }
  if (input.provider || input.api) {
    lines.push(
      `Provider: ${input.provider ?? "unknown"} / ${input.api ?? "unknown"}`,
    );
  }
  lines.push(
    `Model:   ${input.modelName} (${input.modelSlug}, tier ${input.tier})`,
    `Route:   ${input.routingReason}`,
    `Paid inference used: ${input.paidInferenceUsed ? "yes" : "no"}`,
    `Estimated cost: ${formatMoney(input.estimatedCostUsd ?? 0)}`,
    `Actual cost:    ${formatMoney(input.totalCostUsd)}`,
    `Tokens:  ${input.totalTokensInput} in, ${input.totalTokensOutput} out`,
    `Calls:   ${input.totalCalls}`,
  );
  if (input.totalElapsedMs !== undefined) {
    lines.push(`Total elapsed: ${input.totalElapsedMs}ms`);
  }
  if (input.validation) {
    lines.push(`Validation: ${input.validation.ok ? "passed" : "failed"}`);
    for (const error of input.validation.errors) {
      lines.push(`- ${error}`);
    }
  }
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
  if (timings.timePerOutputTokenMs !== undefined) {
    parts.push(`TPOT ${timings.timePerOutputTokenMs}ms/token`);
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

function routeReasonForMode(
  reason: string,
  tier: 0 | 1 | 2,
  isNextWork: boolean,
): string {
  if (isNextWork && tier === 0 && reason === "default") {
    return "default_local_next_work";
  }
  return reason;
}

export function isNextWorkMode(mode: WorkbenchInvocation["mode"]): boolean {
  return mode === "next-work";
}

function printNextWorkResult(
  result: NextWorkValidationResult,
  rawText: string,
): void {
  if (!result.ok) {
    console.log("Next-work validation failed");
    for (const error of result.errors) {
      console.log(`- ${error}`);
    }
    console.log("");
    console.log("Raw model output:");
    console.log(rawText);
    return;
  }

  console.log("Next work");
  console.log(`Recommendation: ${result.value.recommendation}`);
  console.log(`Rationale: ${result.value.rationale}`);
  console.log(`Confidence: ${result.value.confidence}`);
  if (result.value.evidence.length > 0) {
    console.log("Evidence:");
    for (const item of result.value.evidence) {
      console.log(`- ${item}`);
    }
  }
  if (result.value.risks.length > 0) {
    console.log("Risks:");
    for (const item of result.value.risks) {
      console.log(`- ${item}`);
    }
  }
  if (result.value.next_commands.length > 0) {
    console.log("Next commands:");
    for (const command of result.value.next_commands) {
      console.log(`- ${command}`);
    }
  }
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
  const mode = args[0] === "ask" || args[0] === "next-work" ? args[0] : "turn";
  const effectiveArgs = mode === "ask" || mode === "next-work"
    ? args.slice(1)
    : args;
  const cliModel = getArg(effectiveArgs, "--model");
  const cliTier = getArg(effectiveArgs, "--tier");
  const cliHint = getArg(effectiveArgs, "--hint");
  const prompt = mode === "ask" || mode === "next-work"
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
  const isNextWork = isNextWorkMode(mode);
  const usesRepoAskContext = mode === "ask" || isNextWork;
  const bestEffortEvents = usesRepoAskContext;
  const workletId = isNextWork ? "next-work.v0" : undefined;
  let modelPrompt = cliPrompt;

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
    | {
      displayName: string;
      slug: string;
      tier: 0 | 1 | 2;
      provider?: string;
      api?: string;
    }
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
  let validation: WorkbenchValidationSummary | undefined;

  try {
    let systemPrompt: string;
    if (usesRepoAskContext) {
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
      if (isNextWork) {
        modelPrompt = buildNextWorkBrief({
          workletId: workletId!,
          contextProfile,
          prompt: cliPrompt,
        });
      }
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
      if (usesRepoAskContext) {
        models = withDefaultLocalWorkbenchModels(models);
      }
    } catch (err) {
      if (!usesRepoAskContext) throw err;
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
      provider: selected.provider,
      api: selected.api,
    };
    routingReason = routeReasonForMode(
      selection.reason,
      selected.tier,
      isNextWork,
    );
    selectedForEvents = {
      slug: selected.slug,
      provider: selected.provider,
      api: selected.api,
    };
    const estimatedInputTokens = estimateTextTokens(
      `${systemPrompt}\n${modelPrompt}`,
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
      routingReason,
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
        reason: routingReason,
        sessionId,
        traceId,
        provider: selected.provider,
        api: selected.api,
        durationMs: Date.now() - sessionStart,
      }), bestEffortEvents);

    console.log(`Model:  ${selected.displayName} (tier ${selected.tier})`);
    console.log(`Route:  ${routingReason}\n`);
    let streamedText = false;
    const turn = await runWorkbenchTurn({
      systemPrompt,
      prompt: modelPrompt,
      routing: routingOptions,
      models,
      jsonObject: isNextWork,
      onTextDelta: isNextWork ? undefined : (delta) => {
        streamedText = true;
        process.stdout.write(delta);
      },
    });
    if (isNextWork) {
      const result = validateNextWorkJson(turn.text);
      validation = { ok: result.ok, errors: result.errors };
      printNextWorkResult(result, turn.text);
    } else if (streamedText) {
      console.log("");
    } else {
      console.log(turn.text);
    }

    selectedForReceipt = {
      displayName: turn.model.displayName,
      slug: turn.model.slug,
      tier: turn.model.tier,
      provider: turn.model.provider,
      api: turn.model.api,
    };
    routingReason = routeReasonForMode(
      turn.selection.reason,
      turn.model.tier,
      isNextWork,
    );
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
        content: isNextWork
          ? JSON.stringify({
            worklet_id: workletId,
            validation,
            raw: turn.text,
          })
          : turn.text,
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
      provider: selectedForReceipt?.provider,
      api: selectedForReceipt?.api,
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
      workletId,
      totalElapsedMs: Date.now() - sessionStart,
      validation,
    }));
    await closeDoltPool();
  }
}

if (import.meta.main) {
  await runWorkbench();
}
