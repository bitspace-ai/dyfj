import type {
  ConfirmBudgetCeiling,
  ConfirmRunawayAnomaly,
  SpendBaselines,
} from "./budget";
import { BudgetCeilingDeclinedError } from "./budget";
import type { WorkbenchRoutingOptions } from "./provider";
import type { WorkbenchCallTimings } from "./provider";
import type { WorkbenchMessage, WorkbenchToolCall } from "./provider";
import type { PackedContextSummary } from "./repo-context";
import type { AskContextProfile } from "./repo-context";
import type { ConfirmToolApproval } from "./commands";
import type { PermissionLevel } from "./config";
import {
  ANOMALY_DEFAULTS,
  BUDGET_DEFAULTS,
  resolveAnomalyDefaultsFromEnv,
  resolveBudgetDefaultsFromEnv,
  resolvePrincipalId,
} from "./config";
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
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
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
  mode: "ask" | "next-work" | "turn" | "shell";
  prompt: string;
  routingOptions: WorkbenchRoutingOptions;
}

/**
 * How the caller of a runtime turn was identified and why the call was
 * permitted. Populated by transport layers (HTTP bearer auth); absent for
 * direct CLI invocation, which is authenticated by the local OS session.
 */
export interface WorkbenchAuthContext {
  transport: "loopback" | "remote";
  authnStatus: "authenticated" | "unauthenticated";
  authnMechanism: "local_user" | "api_key";
  authnIssuerRef: string;
  authzBasis: string;
}

export interface WorkbenchRuntimeInput {
  mode: Exclude<WorkbenchInvocation["mode"], "shell">;
  prompt: string;
  routingOptions: WorkbenchRoutingOptions;
  authContext?: WorkbenchAuthContext;
  /**
   * Client-requested workspace root for the read-only file tools (e.g. the
   * directory the `dyfj` CLI was invoked in). Honored only for a loopback
   * operator — see workspaceRootForTransport. Absent => the server default
   * (DYFJ_ROOT or the server's cwd).
   */
  workspaceRoot?: string;
  /**
   * Resume an existing session: events append to this id and the session
   * row is updated rather than created. Omit for a fresh session.
   */
  sessionId?: string;
  /**
   * Earlier turns in the session as real conversation messages, assembled by
   * the caller (e.g. from session_start/model_response events). Seeded into the
   * agent loop ahead of the current user message so resumed conversations carry
   * their history as structured user/assistant turns — not a flattened string.
   * Companion turn mode only; ignored for one-shot ask/next-work modes.
   */
  conversationMessages?: WorkbenchMessage[];
  onTextDelta?: (delta: string) => void;
  onRuntimeEvent?: (event: WorkbenchRuntimeEvent) => void | Promise<void>;
  /**
   * Presentation sink for human-readable turn narration: context loading,
   * workspace/model/route lines, turn text, budget tally, and the receipt.
   * The direct CLI/shell path injects console output; transport servers leave
   * it unset so client presentation never renders on the server console.
   * Default: silent — the runtime core does not narrate.
   */
  log?: (...parts: unknown[]) => void;
  /**
   * Consent handler for paid-inference escalation. Returns a verdict
   * (approve | deny+reason | escalate), not void/throw — so a headless driver
   * can pre-approve or escalate. Drivers inject their own; the core defaults to
   * deny and makes no TTY assumption. The CLI supplies a TTY prompt.
   */
  confirmPaidEscalation?: (banner: string) => Promise<PaidEscalationVerdict>;
  /**
   * Warn-then-confirm handler when projected spend crosses a budget ceiling.
   * Without it the runtime fails closed at the ceiling (same posture as the
   * approval gate on non-interactive transports).
   */
  confirmBudgetCeiling?: ConfirmBudgetCeiling;
  /**
   * Confirm handler for a runaway-anomaly hard stop (actual spend past the
   * anomaly multiples). Unlike the ceiling handler, an approval admits the
   * next call only and never raises an envelope; without a handler the
   * runtime fails closed at the halt.
   */
  confirmRunawayAnomaly?: ConfirmRunawayAnomaly;
  /**
   * Approval handler for mutating tools. When a tool's policy is
   * "ask", the runtime calls this for an approve/deny verdict; the default (no
   * handler) denies, fail-closed. The UDS transport asks the operator over the
   * duplex channel; HTTP has no such channel and so denies.
   */
  confirmToolApproval?: ConfirmToolApproval;
  /**
   * Principal identity recorded on this turn's events. Lifted to the boundary
   * : entrypoints resolve it from DYFJ_PRINCIPAL_ID / USER via
   * resolveRuntimeEnvDefaults(); the core reads only this field (default
   * "user"), never the environment. A headless driver supplies its own.
   */
  principalId?: string;
  /**
   * Server/workspace root the read-only file tools fall back to when no loopback
   * workspace is bound. Lifted to the boundary: entrypoints pass
   * DYFJ_ROOT; the core falls back to Deno.cwd() when this is absent.
   */
  rootOverride?: string;
  /**
   * Whether to print the end-of-turn budget tally — a presentation/driver
   * concern. Lifted to the boundary: entrypoints resolve it from
   * DYFJ_BUDGET_TALLY; the core reads only this field (default "paid").
   */
  budgetTallyMode?: BudgetTallyMode;
  /**
   * Default companion model slug, used when a turn specifies no model, tier, or
   * hint (the "bare turn" default). Lifted to the boundary: entrypoints resolve
   * it from config (~/.dyfj/config.toml) / DYFJ_WORKBENCH_MODEL via loadConfig();
   * the core reads only this field and falls through to the registry local
   * default when absent. A headless driver supplies its own.
   */
  defaultCompanionModel?: string | null;
  /**
   * Operator permission posture from config ("strict" | "operator"), resolved at
   * the boundary. The core reads only this field (default "strict"); the command
   * policy uses it together with the loopback transport to decide whether
   * contained mutating tools auto-approve or prompt. A headless driver supplies
   * its own.
   */
  permissionLevel?: PermissionLevel;
  /**
   * Default budget limits (the engine's startup posture), resolved once at the
   * boundary from the declared config surface (DYFJ_BUDGET_* via
   * resolveBudgetDefaultsFromEnv) so the core reads no env. The core uses these
   * as the per-session defaults; the per-turn overrides below take precedence,
   * and the declared BUDGET_DEFAULTS are the final fallback. A headless driver
   * supplies its own.
   */
  defaultSessionBudgetUsd?: number;
  defaultPerCallBudgetUsd?: number;
  defaultDailyBudgetUsd?: number;
  /**
   * Runaway-anomaly hard-stop multiples (startup posture), resolved at the
   * boundary like the budget defaults. Deliberately config-only — no per-turn
   * override field, so a request can never loosen the hard stop.
   */
  anomalyTurnMultiple?: number;
  anomalyScopeMultiple?: number;
  /**
   * Per-turn budget-limit overrides. Absent → the default limits above
   * apply. The HTTP boundary only sets these from a request on the LOOPBACK
   * transport, so a remote caller can never raise the spend cap. The core just
   * reads the fields; a headless driver supplies its own.
   */
  sessionLimitUsd?: number;
  perCallLimitUsd?: number;
  dailyLimitUsd?: number;
  /**
   * Test seam for the events-table spend rollup that seeds the session/daily
   * envelopes; the default queries Dolt (fetchSpendBaselines).
   */
  fetchSpendBaselines?: (sessionId: string) => Promise<SpendBaselines>;
}

export type WorkbenchRuntimeEvent =
  | { type: "sessionStart"; sessionId: string; traceId: string; mode: string }
  | { type: "inputReceived"; sessionId: string; promptLength: number }
  | {
    type: "contextBuilt";
    sessionId: string;
    sourceCount: number;
    profile?: unknown;
  }
  | {
    type: "modelSelected";
    sessionId: string;
    modelSlug: string;
    tier: 0 | 1 | 2;
    reason: string;
  }
  | {
    type: "beforeProviderRequest";
    sessionId: string;
    modelSlug: string;
    estimatedInputCount: number;
  }
  | {
    type: "afterProviderResponse";
    sessionId: string;
    modelSlug: string;
    inputCount: number;
    outputCount: number;
    totalMs?: number;
  }
  | {
    type: "toolStepStarted";
    sessionId: string;
    step: number;
    toolCallCount: number;
  }
  | {
    type: "toolCallStarted";
    sessionId: string;
    commandId: string;
    callId: string;
  }
  | {
    type: "toolCallCompleted";
    sessionId: string;
    commandId: string;
    callId: string;
    isError: boolean;
    durationMs: number;
    errorName?: string;
    errorMessage?: string;
  }
  | { type: "turnCompleted"; sessionId: string; traceId: string }
  | {
    type: "turnFailed";
    sessionId: string;
    traceId: string;
    errorName?: string;
    errorMessage: string;
  };

export interface WorkbenchRuntimeResult {
  sessionId: string;
  traceId: string;
  text: string;
  receipt: string;
  model: {
    displayName: string;
    slug: string;
    provider?: string;
    api?: string;
    tier: 0 | 1 | 2;
  };
  route: {
    reason: string;
  };
  cost: {
    estimatedUsd: number;
    totalUsd: number;
    paidInferenceUsed: boolean;
  };
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalCalls: number;
  };
  context: {
    profile?: AskContextProfile;
    sources: string[];
    budget?: PackedContextSummary;
  };
  validation?: WorkbenchValidationSummary;
}

export type WorkbenchRunResult = WorkbenchRuntimeResult;

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

export interface ToolResultSummary {
  commandId: string;
  callId: string;
  isError: boolean;
  result: string;
}

/**
 * Verdict returned by a paid-inference consent handler. A structured
 * value, not a throw, so a driver can express the third state — escalate — that
 * void/throw could not: the driver can't decide and an out-of-band operator
 * must. `approve` proceeds; `deny` and `escalate` both stop the turn.
 */
export type PaidEscalationVerdict =
  | { decision: "approve" }
  | { decision: "deny"; reason?: string }
  | { decision: "escalate"; reason?: string };

export class PaidEscalationDeclinedError extends Error {
  constructor(
    public readonly verdict: Exclude<
      PaidEscalationVerdict,
      { decision: "approve" }
    >,
  ) {
    super(
      verdict.decision === "escalate"
        ? `Paid inference escalation required${
          verdict.reason ? `: ${verdict.reason}` : ""
        }`
        : `Paid inference consent declined${
          verdict.reason ? `: ${verdict.reason}` : ""
        }`,
    );
    this.name = "PaidEscalationDeclinedError";
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
    '  "context_profile": "compact",',
    '  "recommendation": "one concrete next work item",',
    '  "rationale": "why this is next from the supplied context",',
    '  "evidence": ["specific context source or evidence"],',
    '  "risks": ["what could make this recommendation wrong"],',
    '  "next_commands": ["small commands the operator can run"],',
    '  "confidence": "low|medium|high"',
    "}",
  ].join("\n");
}

// Upper bound on model<->tool iterations in a single turn. Bounds cost and
// guarantees termination if a model keeps requesting tools; on the final
// permitted step the runtime drops tools to force a concluding answer.
export const MAX_TOOL_STEPS = 8;

/**
 * Turn one agent-loop step into transcript messages: the assistant turn that
 * requested the tools (its text plus the tool-call intentions) followed by one
 * `tool` message per result, each linked back to its call by id. Appending these
 * to the running history is what lets the next step see the model's own prior
 * reasoning and the matching results — instead of a flattened summary string
 * that drops the trail and invites confabulation.
 */
export function toolStepToMessages(
  assistantText: string,
  toolCalls: WorkbenchToolCall[] | undefined,
  stepResults: ToolResultSummary[],
): WorkbenchMessage[] {
  const messages: WorkbenchMessage[] = [
    { role: "assistant", content: assistantText, toolCalls },
  ];
  for (const result of stepResults) {
    messages.push({
      role: "tool",
      toolCallId: result.callId,
      name: result.commandId,
      content: result.result,
    });
  }
  return messages;
}

/**
 * Decide whether to honor a client-requested workspace root for the read-only
 * file tools. Only a loopback operator — who already has full local file access,
 * since the server runs as them — may steer the root to their own working
 * directory. A remote or shared consumer (even with the bearer key) is pinned to
 * the server default, so a crafted `workspace` can never aim the file tools at
 * arbitrary host paths. Returns the requested root for a loopback caller (or
 * undefined when none was sent), and undefined for any non-loopback transport.
 */
export function workspaceRootForTransport(
  requested: string | undefined,
  transport: WorkbenchAuthContext["transport"],
): string | undefined {
  return transport === "loopback" ? requested : undefined;
}

/** Concatenated text of a transcript, for the fallback input-token estimate. */
function transcriptEstimateText(
  systemPrompt: string,
  messages: WorkbenchMessage[],
): string {
  const body = messages
    .map((m) =>
      m.role === "assistant"
        ? m.content + (m.toolCalls ? JSON.stringify(m.toolCalls) : "")
        : m.content
    )
    .join("\n");
  return `${systemPrompt}\n${body}`;
}

/**
 * Grounding appended to the companion system prompt when read-only file tools
 * are registered. Tells the model the tools are root-scoped and paths are
 * relative, so it explores with the tools instead of guessing stale paths from
 * the loaded personal corpus. Deliberately does NOT name the absolute workspace
 * root — that would leak host/user path metadata into model-visible text (and to
 * a hosted provider on escalation); the model only needs root-relative paths.
 */
export function buildWorkspaceGrounding(): string {
  return [
    "",
    "",
    `Workspace: you have file tools scoped to the project's workspace root — ` +
    `list_files, read_file, write_file, and edit_file. Their paths are relative ` +
    `to that root and cannot escape it. When asked about files, directories, or ` +
    `the project, use them instead of guessing from memory; start with ` +
    `list_files on \`.\` to see what is actually here. write_file creates or ` +
    `overwrites a file; edit_file replaces an exact fragment in one. You also ` +
    `have bash, which runs a real shell command with its working directory set ` +
    `to the workspace root — but bash is NOT sandboxed: it can read and write ` +
    `anywhere on the machine and reach the network, exactly as if the operator ` +
    `ran the command themselves. When a request calls for changing a file or ` +
    `running a command, do it with these tools rather than only describing the ` +
    `steps — the operator approves every mutation before it runs (bash always ` +
    `prompts), so propose the concrete action.`,
  ].join("\n");
}

function commandResultText(
  result: { isError: boolean; reason?: string; result?: unknown },
): string {
  if (result.isError) return result.reason ?? "command failed";
  return typeof result.result === "string"
    ? result.result
    : JSON.stringify(result.result);
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
    parsed.context_profile !== "compact" &&
    parsed.context_profile !== "full"
  ) {
    errors.push("context_profile must be compact or full");
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
    `Cache:   ${input.totalCacheReadTokens ?? 0} read, ${
      input.totalCacheWriteTokens ?? 0
    } written`,
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
    `memory ${budget.byBucket.derived_memory.usedTokens}/${budget.byBucket.derived_memory.limitTokens}, ` +
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

/**
 * Resolve the env-derived runtime defaults at the process boundary,
 * so the core runtime reads no environment variables. Entrypoints (the CLI
 * one-shot and the HTTP server) spread this into the runtime input; a headless
 * driver supplies these explicitly instead. `rootOverride` stays undefined when
 * DYFJ_ROOT is unset, so the core falls back to the process cwd.
 */
export function resolveRuntimeEnvDefaults(): Pick<
  WorkbenchRuntimeInput,
  | "principalId"
  | "rootOverride"
  | "budgetTallyMode"
  | "defaultSessionBudgetUsd"
  | "defaultPerCallBudgetUsd"
  | "defaultDailyBudgetUsd"
  | "anomalyTurnMultiple"
  | "anomalyScopeMultiple"
> {
  // process.env adapter so the declared resolvers (config.ts) read the same
  // environment as the rest of this boundary.
  const env = { get: (key: string): string | undefined => process.env[key] };
  const budget = resolveBudgetDefaultsFromEnv(env);
  const anomaly = resolveAnomalyDefaultsFromEnv(env);
  return {
    principalId: resolvePrincipalId(env),
    rootOverride: Deno.env.get("DYFJ_ROOT") ?? undefined,
    budgetTallyMode: parseBudgetTallyMode(process.env.DYFJ_BUDGET_TALLY),
    defaultSessionBudgetUsd: budget.sessionLimitUsd,
    defaultPerCallBudgetUsd: budget.perCallLimitUsd,
    defaultDailyBudgetUsd: budget.dailyLimitUsd,
    anomalyTurnMultiple: anomaly.turnMultiple,
    anomalyScopeMultiple: anomaly.scopeMultiple,
  };
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

export function isWorkbenchShellExitCommand(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === ":quit" || normalized === ":q" ||
    normalized === "exit";
}

export function isWorkbenchShellSessionCommand(value: string): boolean {
  return value.trim().toLowerCase() === ":session";
}

export function buildWorkbenchShellBanner(): string {
  return [
    "DYFJ Workbench Shell",
    "Enter a prompt to run one Workbench turn.",
    ":session shows the last session pointer; :quit exits.",
  ].join("\n");
}

function printNextWorkResult(
  result: NextWorkValidationResult,
  rawText: string,
  log: (...parts: unknown[]) => void,
): void {
  if (!result.ok) {
    log("Next-work validation failed");
    for (const error of result.errors) {
      log(`- ${error}`);
    }
    log("");
    log("Raw model output:");
    log(rawText);
    return;
  }

  log("Next work");
  log(`Recommendation: ${result.value.recommendation}`);
  log(`Rationale: ${result.value.rationale}`);
  log(`Confidence: ${result.value.confidence}`);
  if (result.value.evidence.length > 0) {
    log("Evidence:");
    for (const item of result.value.evidence) {
      log(`- ${item}`);
    }
  }
  if (result.value.risks.length > 0) {
    log("Risks:");
    for (const item of result.value.risks) {
      log(`- ${item}`);
    }
  }
  if (result.value.next_commands.length > 0) {
    log("Next commands:");
    for (const command of result.value.next_commands) {
      log(`- ${command}`);
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
  const mode =
    args[0] === "ask" || args[0] === "next-work" || args[0] === "shell"
      ? args[0]
      : "turn";
  const effectiveArgs = mode === "ask" || mode === "next-work" ||
      mode === "shell"
    ? args.slice(1)
    : args;
  const cliModel = getArg(effectiveArgs, "--model");
  const cliTier = getArg(effectiveArgs, "--tier");
  const cliHint = getArg(effectiveArgs, "--hint");
  const prompt = mode === "shell"
    ? ""
    : mode === "ask" || mode === "next-work"
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

export function buildWorkbenchRuntimeInput(
  invocation: WorkbenchInvocation,
): WorkbenchRuntimeInput | null {
  if (invocation.mode === "shell") return null;
  return {
    mode: invocation.mode,
    prompt: invocation.prompt,
    routingOptions: invocation.routingOptions,
  };
}

/**
 * Default consent handler: deny. The core makes no TTY assumption —
 * drivers inject their own. A headless Workshop driver pre-approves or escalates
 * to an out-of-band operator; the CLI uses promptPaidEscalationTty.
 */
function denyPaidEscalation(): Promise<PaidEscalationVerdict> {
  return Promise.resolve({
    decision: "deny",
    reason: "no consent handler configured",
  });
}

/**
 * CLI consent driver: prompt the operator on an interactive TTY. A
 * non-interactive CLI session escalates (operator must approve out of band)
 * rather than guessing or blocking.
 */
export async function promptPaidEscalationTty(
  banner: string,
): Promise<PaidEscalationVerdict> {
  if (!process.stdin.isTTY) {
    return {
      decision: "escalate",
      reason: "non-interactive session cannot grant paid-inference consent",
    };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `${banner}\nContinue with paid inference? Type yes to run: `,
    );
    return answer.trim().toLowerCase() === "yes"
      ? { decision: "approve" }
      : { decision: "deny", reason: "operator declined" };
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

async function emitRuntimeEvent(
  handler: WorkbenchRuntimeInput["onRuntimeEvent"],
  event: WorkbenchRuntimeEvent,
): Promise<void> {
  if (!handler) return;
  try {
    await handler(event);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.warn(`Runtime observer skipped: ${message}`);
  }
}

function estimateRuntimeInputCount(text: string): number {
  return Math.ceil(text.length / 4);
}

async function runWorkbenchShell(baseArgs: string[]): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let lastSession: WorkbenchRunResult | null = null;
  console.log(buildWorkbenchShellBanner());
  try {
    while (true) {
      const answer = await rl.question("\nworkbench> ");
      const prompt = answer.trim();
      if (prompt.length === 0) continue;
      if (isWorkbenchShellExitCommand(prompt)) {
        console.log("bye");
        return;
      }
      if (isWorkbenchShellSessionCommand(prompt)) {
        if (lastSession === null) {
          console.log("No session yet.");
        } else {
          console.log(`Session: ${lastSession.sessionId}`);
          console.log(`Trace:   ${lastSession.traceId}`);
        }
        continue;
      }

      const result = await runWorkbench([...baseArgs, "--prompt", prompt]);
      if (result) lastSession = result;
    }
  } finally {
    rl.close();
  }
}

export async function runWorkbench(
  args = process.argv.slice(2),
): Promise<WorkbenchRunResult | void> {
  const invocation = resolveWorkbenchInvocation(args);
  if (invocation.mode === "shell") {
    await runWorkbenchShell(args.slice(1));
    return;
  }

  const runtimeInput = buildWorkbenchRuntimeInput(invocation);
  if (runtimeInput === null) return;
  // This in-process one-shot path owns the Dolt pool lifecycle: the
  // runtime no longer closes it, so close here after the single turn so the
  // process exits cleanly. (The REPL drives this per turn; the HTTP server
  // bypasses runWorkbench and keeps the pool for the process lifetime.)
  const { closeDoltPool } = await import("./utils");
  try {
    return await runWorkbenchRuntime({
      ...runtimeInput,
      ...resolveRuntimeEnvDefaults(),
      // The in-process CLI/shell is its own presenter.
      log: console.log,
      onTextDelta: (delta) => {
        process.stdout.write(delta);
      },
      confirmPaidEscalation: promptPaidEscalationTty,
    });
  } finally {
    await closeDoltPool();
  }
}

export async function runWorkbenchRuntime(
  runtimeInput: WorkbenchRuntimeInput,
): Promise<WorkbenchRuntimeResult> {
  const {
    generateULID,
    generateTraceId,
    generateSpanId,
    writeEvent,
    writeModelSelectedEvent,
  } = await import("./utils");
  const {
    defaultLocalWorkbenchModels,
    estimateTextTokens,
    loadWorkbenchModels,
    modelStreamsToolCalls,
    runWorkbenchTurn,
    selectWorkbenchModel,
    withDefaultLocalWorkbenchModels,
  } = await import("./provider");
  const {
    BudgetTracker,
    ceilingConfirmationStoreFor,
    createRunawayAnomalyGate,
    createTurnBudgetCeilingGate,
    fetchSpendBaselines,
  } = await import("./budget");
  const {
    buildAskSystemPrompt,
    buildContextSourceLines,
    loadAskRepoContext,
  } = await import("./repo-context");
  const { loadCompanionBasePrompt } = await import("./prompts");
  const {
    buildMemoryContextSourceLines,
    loadInjectedMemories,
    loadIndexedMemories,
    buildSystemPrompt,
    memoryClearanceFor,
  } = await import("./memory");
  const {
    createCommandRegistry,
    invokeCommandWithEvent,
    registerCoreCommands,
  } = await import("./commands");
  const { memorySearchConfigFromEnv, buildMemorySearch } = await import(
    "./memory-search"
  );
  const {
    buildWorkbenchSessionContent,
    buildWorkbenchSessionSlug,
    createWorkbenchSession,
    fetchWorkbenchSessionWorkspace,
    updateWorkbenchSession,
  } = await import("./sessions");

  const {
    mode,
    prompt: cliPrompt,
    routingOptions,
    defaultCompanionModel,
    permissionLevel,
  } = runtimeInput;
  // Silent by default: narration renders only where a presenter is injected.
  const log = runtimeInput.log ?? (() => {});
  const commandRegistry = createCommandRegistry();
  let commandTools: ReturnType<typeof commandRegistry.projectTools> = [];

  const resumingSession = runtimeInput.sessionId !== undefined;
  const sessionId = runtimeInput.sessionId ?? generateULID();
  const sessionSlug = buildWorkbenchSessionSlug(sessionId);
  const traceId = generateTraceId();
  const sessionStart = Date.now();
  // env coupling lives at the boundary (resolveRuntimeEnvDefaults);
  // the core reads only the input field. Resolved before the BudgetTracker so
  // its budget_summary event is attributed to the same principal.
  const principalId = runtimeInput.principalId ?? "user";
  // Precedence: per-turn override → boundary-resolved default (from the declared
  // config surface) → the declared BUDGET_DEFAULTS. The core reads no env; the
  // boundary (resolveRuntimeEnvDefaults) resolves DYFJ_BUDGET_* once. The HTTP
  // boundary only populates the per-turn overrides for loopback callers.
  const budgetConfig = {
    sessionLimitUsd: runtimeInput.sessionLimitUsd ??
      runtimeInput.defaultSessionBudgetUsd ?? BUDGET_DEFAULTS.sessionLimitUsd,
    perCallLimitUsd: runtimeInput.perCallLimitUsd ??
      runtimeInput.defaultPerCallBudgetUsd ?? BUDGET_DEFAULTS.perCallLimitUsd,
    dailyLimitUsd: runtimeInput.dailyLimitUsd ??
      runtimeInput.defaultDailyBudgetUsd ?? BUDGET_DEFAULTS.dailyLimitUsd,
  };
  // Anomaly multiples have no per-turn override lane: boundary-resolved config
  // or the declared defaults only, so a request can never loosen the hard stop.
  const anomalyConfig = {
    turnMultiple: runtimeInput.anomalyTurnMultiple ??
      ANOMALY_DEFAULTS.turnMultiple,
    scopeMultiple: runtimeInput.anomalyScopeMultiple ??
      ANOMALY_DEFAULTS.scopeMultiple,
  };
  // Seed the envelopes with spend already on the books: this session's prior
  // turns and today's spend across all sessions. Injectable for tests.
  const fetchBaselines = runtimeInput.fetchSpendBaselines ??
    fetchSpendBaselines;
  const spendBaselines = await fetchBaselines(sessionId);
  const budget = new BudgetTracker(
    sessionId,
    traceId,
    budgetConfig,
    principalId,
    spendBaselines,
  );
  // Direct CLI invocation is authenticated by the local OS session; transport
  // layers (HTTP bearer auth) override this with the caller's real context.
  const authContext: WorkbenchAuthContext = runtimeInput.authContext ?? {
    transport: "loopback",
    authnStatus: "authenticated",
    authnMechanism: "local_user",
    authnIssuerRef: "local_os",
    authzBasis: "user_consent",
  };
  const authnEventFields = {
    authn_status: authContext.authnStatus,
    authn_mechanism: authContext.authnMechanism,
    authn_issuer_ref: authContext.authnIssuerRef,
  };

  // Resolve the workspace root once for this turn. The file tools follow the
  // operator: the `dyfj` client sends its cwd only when CREATING a session; it
  // is persisted on the session row and read back here on resume, so the client
  // never re-sends cwd every turn. A loopback operator may steer the root (they
  // already have full local file access); remote/shared callers are pinned to
  // the server default so a crafted workspace can never aim the file tools at
  // arbitrary host paths. `honoredWorkspace` is the gated request (a string when
  // a loopback caller bound a root, undefined otherwise): it is both persisted
  // at creation and canonicalized into the actual root where the tools mount.
  // DYFJ_ROOT is resolved at the boundary; the core only falls back to
  // the process cwd when no root was supplied.
  const fallbackRoot = runtimeInput.rootOverride ?? Deno.cwd();
  let requestedWorkspace = runtimeInput.workspaceRoot;
  if (resumingSession && requestedWorkspace === undefined) {
    try {
      requestedWorkspace =
        (await fetchWorkbenchSessionWorkspace({ sessionId })) ?? undefined;
    } catch {
      // Session row unreadable — fall back to the default root.
    }
  }
  const honoredWorkspace = workspaceRootForTransport(
    requestedWorkspace,
    authContext.transport,
  );
  const isNextWork = isNextWorkMode(mode);
  const usesRepoAskContext = mode === "ask" || isNextWork;
  // Event-write integrity policy, decoupled from mode. INTEGRITY
  // events are the recomputable audit log + session-existence record, so a
  // failed write fails the turn rather than silently dropping. BEST_EFFORT
  // events (telemetry, denormalized projections derivable from events, and
  // error notifications that must not mask the real error) are logged-and-
  // skipped on failure. Replaces the old `bestEffortEvents = usesRepoAskContext`,
  // which silently dropped integrity events on write failure in ask/next-work
  // mode. These are the `bestEffort` argument to writeMaybe().
  const INTEGRITY = false;
  const BEST_EFFORT = true;
  // Integrity writes that run inside the broad runtime try below would otherwise
  // throw, be caught by the catch, and then be masked by the `finally` returning
  // a normal receipt — so a successful turn could be handed back with a missing
  // audit/transcript event (review finding). Remember the first such
  // failure; the `finally` rethrows it instead of returning a result.
  let fatalEventError: unknown = null;
  // Capture an unexpected turn error (e.g. a missing hosted credential) so the
  // finally can re-throw it after the receipt. Without this the catch's else
  // branch logs only to server stderr and the turn looks like a benign empty
  // ($0 / 0-token) success to the client.
  let turnError: unknown = null;
  const writeIntegrity = async (
    operation: () => Promise<void>,
  ): Promise<void> => {
    try {
      await operation();
    } catch (err) {
      fatalEventError ??= err;
      throw err;
    }
  };
  const workletId = isNextWork ? "next-work.v0" : undefined;
  // Prior conversation now rides in the transcript as real messages (see the
  // seed below), so the prompt is just the current message — no flattened
  // "Conversation so far:" prepend.
  let modelPrompt = cliPrompt;

  log("DYFJ Workbench\n");

  await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
    type: "sessionStart",
    sessionId,
    traceId,
    mode,
  });
  await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
    type: "inputReceived",
    sessionId,
    promptLength: cliPrompt.length,
  });

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
      authz_basis: authContext.authzBasis,
      ...authnEventFields,
      // The operator's prompt rides on session_start so a conversation
      // transcript can be rebuilt from events alone (resume, inspector).
      content: cliPrompt,
    }), INTEGRITY);

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
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  // Per-turn aggregates across every provider call the agent loop makes, so
  // receipts/events count the whole turn, not just the final call.
  let turnInputTokens = 0;
  let turnOutputTokens = 0;
  let turnCostUsd = 0;
  let contextSourceLines: string[] = [];
  let callTimings: WorkbenchCallTimings | undefined;
  let contextBudget: PackedContextSummary | undefined;
  let contextProfile: AskContextProfile | undefined;
  let validation: WorkbenchValidationSummary | undefined;
  let finalText = "";

  try {
    let systemPrompt: string;
    if (usesRepoAskContext) {
      log("Loading repo-local context...");
      const repoContext = await loadAskRepoContext();
      contextSourceLines = buildContextSourceLines(repoContext.sources);
      contextBudget = repoContext.budget;
      contextProfile = repoContext.profile;
      log(`Loaded ${repoContext.sources.length} context sources\n`);

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
          ...authnEventFields,
          tool_name: "repo_context.load",
          tool_call_id: generateULID(),
          tool_arguments: JSON.stringify({ mode, sources: contextSourceLines }),
          tool_result: JSON.stringify({
            sourceCount: contextSourceLines.length,
          }),
          tool_is_error: false,
          content: JSON.stringify({ sources: contextSourceLines }),
          duration_ms: Date.now() - sessionStart,
        }), BEST_EFFORT);

      const companionBasePrompt = await loadCompanionBasePrompt();
      systemPrompt = buildAskSystemPrompt(companionBasePrompt, repoContext);
      if (isNextWork) {
        modelPrompt = buildNextWorkBrief({
          workletId: workletId!,
          contextProfile,
          prompt: cliPrompt,
        });
      }
      await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
        type: "contextBuilt",
        sessionId,
        sourceCount: repoContext.sources.length,
        profile: repoContext.profile,
      });
    } else {
      log("Loading context...");
      // Scope memory injection two ways (024 + 019): by the inject
      // classification — only the curated 'always' worldview loads as content;
      // everything else is index-only, pulled on demand via read_memory — and by
      // clearance: a loopback/in-process operator gets the full corpus; a
      // non-loopback consumer gets only client-safe + public, so the personal
      // corpus never leaks to a remote or shared surface.
      const clearance = memoryClearanceFor(authContext.transport);
      const coreMemories = await loadInjectedMemories(clearance);
      const memoryIndex = await loadIndexedMemories(clearance);
      // Record the memory layer as context sources so turn-mode receipts and the
      // inspector reflect what was loaded (previously [] — the bug this fixes).
      contextSourceLines = buildMemoryContextSourceLines(
        coreMemories,
        memoryIndex,
      );
      log(
        `Loaded ${coreMemories.length} core memories, ${memoryIndex.length} index entries ` +
          `(${authContext.transport} clearance)\n`,
      );
      // Mount the file tools at the resolved workspace (see honoredWorkspace
      // above): canonicalize the honored root and verify it is a real directory,
      // else fall back to the server default. Containment within the root is
      // enforced per call by the file tools regardless of which root wins here.
      let workspaceRoot = fallbackRoot;
      if (honoredWorkspace) {
        try {
          const real = await Deno.realPath(honoredWorkspace);
          if ((await Deno.stat(real)).isDirectory) {
            workspaceRoot = real;
          } else {
            log(
              "Requested workspace is not a directory; using default.",
            );
          }
        } catch {
          log("Requested workspace not accessible; using default.");
        }
      }
      log(`Workspace: ${workspaceRoot}\n`);
      // External-memory recall: offered only on a loopback/operator turn with an
      // endpoint configured (DYFJ_MEMORY_MCP_URL). A non-loopback consumer never
      // receives the tool, so the private external memory is unreachable off-box.
      const recallConfig = authContext.transport === "loopback"
        ? memorySearchConfigFromEnv()
        : null;
      registerCoreCommands(commandRegistry, {
        allowedMemorySlugs: memoryIndex.map((entry) => entry.slug),
        searchMemory: recallConfig
          ? buildMemorySearch(recallConfig)
          : undefined,
        // Read-only workspace file tools, scoped to the resolved root.
        workspaceRoot,
      });
      commandTools = commandRegistry.projectTools();
      systemPrompt = buildSystemPrompt(coreMemories, memoryIndex);
      if (commandTools.length > 0) {
        systemPrompt += buildWorkspaceGrounding();
      }
      await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
        type: "contextBuilt",
        sessionId,
        sourceCount: coreMemories.length + memoryIndex.length,
      });
    }

    if (!resumingSession) {
      await writeIntegrity(() =>
        createWorkbenchSession({
          sessionId,
          slug: sessionSlug,
          taskDescription: cliPrompt,
          // Bind the session to its workspace (honored only for loopback);
          // resumes read it back instead of the client re-sending cwd.
          workspace: honoredWorkspace,
          content: buildWorkbenchSessionContent({
            mode,
            prompt: cliPrompt,
            traceId,
            contextSources: contextSourceLines,
          }),
        })
      );
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
    const selection = selectWorkbenchModel(
      models,
      routingOptions,
      defaultCompanionModel,
    );
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
    // Scope-persistent store: a confirmed overrun raises the envelope for its
    // scope (session marks per session id, the daily mark per local day)
    // instead of re-prompting next turn.
    const budgetCeilingGate = createTurnBudgetCeilingGate(
      runtimeInput.confirmBudgetCeiling,
      ceilingConfirmationStoreFor(sessionId),
    );
    // Turn-scoped: an approval covers the spend level it was shown (the entry
    // check and the first call's check see identical actuals); any recorded
    // increment re-prompts, and nothing survives the turn.
    const anomalyGate = createRunawayAnomalyGate(
      runtimeInput.confirmRunawayAnomaly,
    );

    // Hard stop BEFORE the soft ceiling confirm: a turn entered in an
    // anomalous state must halt first — otherwise the ceiling prompt records
    // its scope-period confirmation before the operator ever sees the halt,
    // and an aborted turn leaves that confirmation behind.
    await anomalyGate.ensureAllowed(
      budget.checkAnomaly(selected.tier, anomalyConfig),
    );
    await budgetCeilingGate.ensureAllowed(preCall);
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
      const verdict =
        await (runtimeInput.confirmPaidEscalation ?? denyPaidEscalation)(
          preflightBanner,
        );
      if (verdict.decision !== "approve") {
        throw new PaidEscalationDeclinedError(verdict);
      }
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
        authnFields: authnEventFields,
      }), BEST_EFFORT);
    await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
      type: "modelSelected",
      sessionId,
      modelSlug: selected.slug,
      tier: selected.tier,
      reason: routingReason,
    });

    log(`Model:  ${selected.displayName} (tier ${selected.tier})`);
    log(`Route:  ${routingReason}\n`);
    const runObservedTurn = async (
      params: Parameters<typeof runWorkbenchTurn>[0],
      request: { modelSlug: string; estimatedInputCount: number },
    ) => {
      // Budget-gate and record EVERY provider call: the agent loop can make
      // several calls in one turn, so per-call and session limits must be
      // enforced before each one and usage recorded after each one (paid
      // consent and ceiling confirmation are granted once per turn above;
      // per-call + session limits and MAX_TOOL_STEPS bound loop spend).
      if (selected.tier > 0) {
        // Fresh cross-session daily figure before every paid call, so
        // concurrent sessions see each other's completed spend (in-flight
        // calls remain invisible; the overshoot shows in receipts).
        const fresh = await fetchBaselines(sessionId);
        budget.refreshDailyOtherSessions(fresh.dailyOtherSessionsUsd);
      }
      // Runaway-anomaly hard stop FIRST, on actual recorded spend — it holds
      // where the estimate-based ceiling below is blind (multi-call turn
      // accumulation, spend a scope confirmation already covered). An approval
      // admits the spend level it was shown; recorded spend past it re-prompts.
      await anomalyGate.ensureAllowed(
        budget.checkAnomaly(selected.tier, anomalyConfig),
      );
      const callPre = budget.checkPreCall(
        selected.tier,
        selected.costInput,
        request.estimatedInputCount,
      );
      await budgetCeilingGate.ensureAllowed(callPre);
      await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
        type: "beforeProviderRequest",
        sessionId,
        modelSlug: request.modelSlug,
        estimatedInputCount: request.estimatedInputCount,
      });
      const turn = await runWorkbenchTurn(params);
      cacheReadTokens += turn.usage.cacheRead;
      cacheWriteTokens += turn.usage.cacheWrite;
      turnInputTokens += turn.usage.input;
      turnOutputTokens += turn.usage.output;
      turnCostUsd += turn.usage.cost.total;
      budget.record(turn.usage, turn.model.tier);
      await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
        type: "afterProviderResponse",
        sessionId,
        modelSlug: turn.model.slug,
        inputCount: turn.usage.input,
        outputCount: turn.usage.output,
        totalMs: turn.timings.totalMs,
      });
      return turn;
    };
    let streamedText = false;
    // The OpenAI-compatible wire path streams text AND captures tool calls from
    // the same SSE stream, so tool-offering calls can stream live there; the
    // Anthropic/Google readers cannot, so tool-offering calls stay buffered for
    // them (tool calls are then captured from the buffered JSON instead).
    const streamsToolCalls = modelStreamsToolCalls(selected);
    const liveDelta = runtimeInput.onTextDelta === undefined
      ? undefined
      : (delta: string) => {
        streamedText = true;
        runtimeInput.onTextDelta?.(delta);
      };
    // Seed the conversation transcript: prior turns (companion mode only;
    // one-shot ask/next-work carry no history) followed by the current user
    // message. This is passed to the FIRST turn so resumed conversations carry
    // their history as structured messages, and the agent loop appends to it.
    const messages: WorkbenchMessage[] = [
      ...(!usesRepoAskContext ? runtimeInput.conversationMessages ?? [] : []),
      { role: "user", content: modelPrompt },
    ];
    let turn = await runObservedTurn({
      systemPrompt,
      prompt: modelPrompt,
      messages,
      routing: routingOptions,
      defaultModelId: defaultCompanionModel,
      models,
      jsonObject: isNextWork,
      tools: commandTools,
      // Stream when not producing JSON and either no tools are offered or the
      // provider can stream tool calls — this also restores live token
      // streaming for ordinary companion replies (tools registered, none used).
      onTextDelta: isNextWork
        ? undefined
        : (commandTools.length === 0 || streamsToolCalls)
        ? liveDelta
        : undefined,
    }, {
      modelSlug: selected.slug,
      estimatedInputCount: estimateRuntimeInputCount(
        transcriptEstimateText(systemPrompt, messages),
      ),
    });
    // Agent loop: iterate model<->tools until the model stops requesting tools,
    // repeats itself, or hits the step cap. On the OpenAI-compatible path each
    // gather step streams live (text deltas + captured tool calls); elsewhere
    // gather steps buffer and only the forced conclusion streams. Momentum is
    // also surfaced via the per-step log and the tool_call events. Tools are
    // dropped to force a concluding answer at the cap or when the model thrashes
    // (a whole step of calls it already made this turn).
    // `messages` (seeded above with prior conversation + the current user
    // message, and passed to the first turn) now grows as the loop iterates:
    // the model's own assistant turns (with tool-call intentions) and the
    // matching tool results are appended each step and replayed on the next
    // call, so multi-step turns stay coherent.
    const seenToolCalls = new Set<string>();
    let toolSteps = 0;
    while (
      !isNextWork &&
      turn.toolCalls &&
      turn.toolCalls.length > 0 &&
      toolSteps < MAX_TOOL_STEPS
    ) {
      toolSteps++;
      log(
        `Step ${toolSteps}: running ${turn.toolCalls.length} tool call(s)...`,
      );
      await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
        type: "toolStepStarted",
        sessionId,
        step: toolSteps,
        toolCallCount: turn.toolCalls.length,
      });
      const stepSignatures = turn.toolCalls.map(
        (toolCall) => `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`,
      );
      const allRepeats = stepSignatures.every((sig) => seenToolCalls.has(sig));
      for (const sig of stepSignatures) seenToolCalls.add(sig);
      const requestedToolCalls = turn.toolCalls;
      const stepResults: ToolResultSummary[] = [];
      for (const toolCall of requestedToolCalls) {
        const toolStartedAt = Date.now();
        await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
          type: "toolCallStarted",
          sessionId,
          commandId: toolCall.name,
          callId: toolCall.id,
        });
        let commandResult: Awaited<ReturnType<typeof invokeCommandWithEvent>>;
        try {
          commandResult = await invokeCommandWithEvent(
            commandRegistry,
            {
              commandId: toolCall.name,
              callId: toolCall.id,
              caller: {
                principalId: "workbench",
                principalType: "agent",
              },
              arguments: toolCall.arguments,
            },
            {
              sessionId,
              traceId,
              // Agent-loop tool calls (call + result) are the conversation's audit
              // backbone — integrity-required in every mode.
              writeEvent: (event) => writeIntegrity(() => writeEvent(event)),
            },
            runtimeInput.confirmToolApproval,
            {
              // Operator permission profile: on a loopback turn with permissionLevel
              // "operator", contained mutating tools auto-approve instead of prompting.
              permissionLevel: permissionLevel ?? "strict",
              loopback: authContext.transport === "loopback",
            },
          );
          await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
            type: "toolCallCompleted",
            sessionId,
            commandId: toolCall.name,
            callId: toolCall.id,
            isError: commandResult.isError,
            durationMs: Date.now() - toolStartedAt,
          });
        } catch (err) {
          await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
            type: "toolCallCompleted",
            sessionId,
            commandId: toolCall.name,
            callId: toolCall.id,
            isError: true,
            durationMs: Date.now() - toolStartedAt,
            errorName: err instanceof Error ? err.name : undefined,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
        stepResults.push({
          commandId: toolCall.name,
          callId: toolCall.id,
          isError: commandResult.isError,
          result: commandResultText(commandResult),
        });
      }

      const atCap = toolSteps >= MAX_TOOL_STEPS;
      const forceConclude = atCap || allRepeats;
      if (forceConclude) {
        log(
          atCap
            ? `Reached the ${MAX_TOOL_STEPS}-step tool limit; forcing a concluding answer.`
            : "Model repeated prior tool calls; forcing a concluding answer.",
        );
      }
      // Append this step to the transcript: the assistant turn that requested
      // the tools (text + tool-call intentions) and one tool message per result.
      messages.push(
        ...toolStepToMessages(turn.text, requestedToolCalls, stepResults),
      );
      // When forcing a conclusion (step cap or thrash), drop tools and nudge a
      // final answer; otherwise the model continues naturally from the results.
      if (forceConclude) {
        messages.push({
          role: "user",
          content:
            "Use the tool results above to answer the original prompt now. Do not call any more tools.",
        });
      }
      const followUpInputCount = estimateRuntimeInputCount(
        transcriptEstimateText(systemPrompt, messages),
      );
      streamedText = false;
      turn = await runObservedTurn({
        systemPrompt,
        prompt: modelPrompt,
        messages,
        routing: routingOptions,
        defaultModelId: defaultCompanionModel,
        models,
        tools: forceConclude ? undefined : commandTools,
        // Stream the gather step when the provider streams tool calls, and
        // always stream the forced no-tools conclusion.
        onTextDelta: streamsToolCalls || forceConclude ? liveDelta : undefined,
      }, {
        modelSlug: selected.slug,
        estimatedInputCount: followUpInputCount,
      });
    }
    if (isNextWork) {
      const result = validateNextWorkJson(turn.text);
      validation = { ok: result.ok, errors: result.errors };
      printNextWorkResult(result, turn.text, log);
    } else if (streamedText) {
      log("");
    } else {
      log(turn.text);
    }
    finalText = turn.text;

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
    // Per-call budget.record() now happens inside runObservedTurn, so the
    // session summary already aggregates every call in this (and prior) turns.
    const summary = budget.getSummary();
    const paidCalls = (summary.byTier["1"]?.calls ?? 0) +
      (summary.byTier["2"]?.calls ?? 0);
    if (
      shouldPrintBudgetTally(
        // DYFJ_BUDGET_TALLY is parsed at the boundary; the core reads
        // only the input field.
        runtimeInput.budgetTallyMode ?? "paid",
        {
          paidCalls,
        },
      )
    ) {
      log("");
      log(buildBudgetTallyLine({
        turn: {
          tokensInput: turnInputTokens,
          tokensOutput: turnOutputTokens,
          costUsd: turnCostUsd,
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

    await writeIntegrity(() =>
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
        // Aggregate across every provider call in this turn (the agent loop may
        // make several) so the audit event counts the whole turn, not just the
        // final call.
        tokens_input: turnInputTokens,
        tokens_output: turnOutputTokens,
        tokens_cache_read: cacheReadTokens,
        tokens_cache_write: cacheWriteTokens,
        cost_total: turnCostUsd,
        ...authnEventFields,
        content: isNextWork
          ? JSON.stringify({
            worklet_id: workletId,
            validation,
            raw: turn.text,
          })
          : turn.text,
        stop_reason: turn.stopReason,
        duration_ms: turn.timings.totalMs,
      })
    );
    await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
      type: "turnCompleted",
      sessionId,
      traceId,
    });
  } catch (err: unknown) {
    const name = (err as Error)?.name ?? "Error";
    await emitRuntimeEvent(runtimeInput.onRuntimeEvent, {
      type: "turnFailed",
      sessionId,
      traceId,
      errorName: name,
      errorMessage: (err as Error)?.message ?? String(err),
    });
    if (name === "PaidEscalationDeclinedError") {
      const verdict = (err as PaidEscalationDeclinedError).verdict;
      const detail = verdict.reason ? ` (${verdict.reason})` : "";
      log(
        verdict.decision === "escalate"
          ? `\nPaid inference escalation required - no model call made${detail}.`
          : `\nPaid inference declined - no model call made${detail}.`,
      );
      turnError = err;
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
          ...authnEventFields,
          content: (err as Error).message,
          stop_reason: "error",
          duration_ms: Date.now() - sessionStart,
        }), BEST_EFFORT);
      log(`\nBudget exceeded: ${(err as Error).message}`);
    } else if (name === "BudgetCeilingDeclinedError") {
      const detail = (err as BudgetCeilingDeclinedError).reason;
      log(
        `\nBudget ceiling confirmation declined${
          detail ? `: ${detail}` : ""
        } — the over-budget call was not made.`,
      );
      turnError = err;
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
          ...authnEventFields,
          content: (err as Error)?.message ?? String(err),
          stop_reason: "error",
          duration_ms: Date.now() - sessionStart,
        }), BEST_EFFORT);
      // Full detail is already on the audit log (the error event above) and
      // goes to the injected presenter; the server console gets the error
      // class only, so an exception message that quotes turn content cannot
      // leak there.
      log("\nUnexpected error:", err);
      console.error(
        `[turn-error] ${err instanceof Error ? err.constructor.name : typeof err}`,
      );
      turnError = err;
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
        authz_basis: authContext.authzBasis,
        ...authnEventFields,
        duration_ms: Date.now() - sessionStart,
      }), INTEGRITY);

    await writeMaybe(() => budget.writeSummaryEvent(), BEST_EFFORT);

    const summary = budget.getSummary();
    const paidInferenceUsed = ((summary.byTier["1"]?.calls ?? 0) +
      (summary.byTier["2"]?.calls ?? 0)) > 0;
    const receipt = buildWorkbenchReceipt({
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
      totalCacheReadTokens: cacheReadTokens,
      totalCacheWriteTokens: cacheWriteTokens,
      totalCalls: summary.totalCalls,
      contextBudget,
      contextProfile,
      timings: callTimings,
      contextSources: contextSourceLines,
      paidInferenceUsed,
      estimatedCostUsd,
      workletId,
      totalElapsedMs: Date.now() - sessionStart,
      validation,
    });
    await writeMaybe(() =>
      updateWorkbenchSession({
        sessionId,
        content: buildWorkbenchSessionContent({
          mode,
          prompt: cliPrompt,
          traceId,
          contextSources: contextSourceLines,
          receipt,
        }),
      }), BEST_EFFORT);
    log("");
    log(receipt);
    // the runtime no longer closes the shared Dolt pool. A long-running
    // host (HTTP server) runs many concurrent turns through this function; a
    // per-turn close would end the pool out from under an in-flight turn and
    // crash it. Pool lifecycle is owned by the entrypoint (one-shot `runWorkbench`
    // closes it in a finally; the server keeps it for the process lifetime).
    // review fix: if an integrity audit/transcript write failed inside
    // the try above, surface it to the caller instead of masking it behind a
    // normal receipt (session_end + best-effort cleanup above still ran).
    // An unexpected turn error (credential missing, provider failure) must reach
    // the caller — the receipt above still prints, but the turn is not a success.
    if (turnError !== null) throw turnError;
    if (fatalEventError !== null) throw fatalEventError;
    return {
      sessionId,
      traceId,
      text: finalText,
      receipt,
      model: {
        displayName: selectedForReceipt?.displayName ?? "none",
        slug: selectedForReceipt?.slug ?? "none",
        provider: selectedForReceipt?.provider,
        api: selectedForReceipt?.api,
        tier: selectedForReceipt?.tier ?? 0,
      },
      route: {
        reason: routingReason,
      },
      cost: {
        estimatedUsd: estimatedCostUsd,
        totalUsd: summary.totalCostUsd,
        paidInferenceUsed,
      },
      tokens: {
        input: summary.totalTokensInput,
        output: summary.totalTokensOutput,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens,
        totalCalls: summary.totalCalls,
      },
      context: {
        profile: contextProfile,
        sources: contextSourceLines,
        budget: contextBudget,
      },
      validation,
    };
  }
}

if (import.meta.main) {
  await runWorkbench();
}
