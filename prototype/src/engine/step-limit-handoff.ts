/**
 * The step-limit handoff's text (specs/01-architecture.md §5.1): the
 * instruction that ends tool use, and the runtime notice written when the
 * handoff call cannot answer.
 *
 * Kept apart from the agent loop because it is text and classification only:
 * the loop decides *when* to hand off, this module decides what the model and
 * the operator read.
 */
import { sanitizeBoundaryText } from "../kernel/mod.ts";
import { classifyErrorKind } from "./errors.ts";
import type { StepStopReason } from "./step-budget.ts";
import type { RecentToolCall } from "./turn-state.ts";

/** The handoff call's output cap; the catalog cap applies when it is lower. */
export const HANDOFF_OUTPUT_TOKENS = 2048;

/** How many of the turn's latest tool calls the fallback notice names. */
export const HANDOFF_NOTICE_CALLS = 5;

/** The handoff instruction appended to the system prompt. */
export function handoffSystemPrompt(
  baseSystemPrompt: string,
  reasonText: string,
): string {
  return baseSystemPrompt + "\n\n" + handoffInstruction(reasonText);
}

/**
 * The handoff instruction: why tool use ended, then a short handoff for the
 * operator's next prompt. The request that carries it offers no tools.
 */
export function handoffInstruction(reasonText: string): string {
  return `Workbench instruction: tool use ended because ${reasonText}. ` +
    "Do not call tools. Write a handoff for the operator's next prompt, " +
    "under 200 words, in three parts. Start each part on its own line with " +
    "its label and a colon. Done: what this turn completed, with file " +
    "paths. Next: the next concrete step. Uncommitted state: files changed " +
    'but not committed, commands started but not verified, or "none known". ' +
    "State only what the transcript shows, and " +
    "mark anything you infer as inferred.";
}

/**
 * Why tool use ended, as both the model and the operator read it. A turn that
 * reached a limit it could not pass says so; a turn the step budget stopped
 * early says what actually happened, because a stall at 3 of 12 steps is not a
 * limit being reached and a handoff written as if it were misleads the next
 * prompt.
 */
export function toolUseEndedText(
  reason: StepStopReason | undefined,
  limit: number,
): string {
  switch (reason) {
    case "stall":
      return "this turn stopped making progress: two consecutive tool steps " +
        "added nothing new, so tool use ended at " + `${limit} steps`;
    case "ceiling":
      return `this turn reached its ${limit}-step safety ceiling`;
    case "budget":
      return "this turn's spend limits left no room for another tool call";
    default:
      return `this turn reached its ${limit}-step tool limit`;
  }
}

/** Whether tool use ended because the step budget stopped the turn. */
export function isBudgetStop(reason: StepStopReason | undefined): boolean {
  return reason !== undefined;
}

/**
 * The system prompt for a step's forced conclusion: the handoff instruction at
 * the step limit (or at a stop the step budget made), or the shorter
 * no-more-tools instruction when tool use ended because the model repeated
 * itself or a call was not approved.
 */
export function forcedConclusionSystemPrompt(
  baseSystemPrompt: string,
  reason:
    | StepStopReason
    | "limit"
    | "repeated_tool_calls"
    | "approval_denied",
  maxToolSteps: number,
): string {
  if (
    reason === "limit" || reason === "stall" || reason === "ceiling" ||
    reason === "budget"
  ) {
    return handoffSystemPrompt(
      baseSystemPrompt,
      toolUseEndedText(reason === "limit" ? undefined : reason, maxToolSteps),
    );
  }
  const reasonText = reason === "approval_denied"
    ? "tool use ended because a tool call was not approved"
    : "tool use ended because the model repeated prior tool calls";
  return baseSystemPrompt + "\n\n" +
    `Workbench instruction: ${reasonText}. Answer the original operator prompt ` +
    "from the transcript above. Do not request or call more tools.";
}

/** The handoff request as the turn's last user message. */
export function handoffRequest(
  maxToolSteps: number,
  reason?: StepStopReason,
): {
  role: "user";
  content: string;
} {
  return {
    role: "user",
    content: handoffInstruction(toolUseEndedText(reason, maxToolSteps)),
  };
}

/**
 * The handoff request for a turn the step budget ended: the same instruction,
 * naming the limit the turn actually ran under and what stopped it.
 */
export function budgetHandoffRequest(budget: {
  effectiveLimit: number;
  stopReason: StepStopReason | undefined;
}): { role: "user"; content: string } {
  return handoffRequest(budget.effectiveLimit, budget.stopReason);
}

const HANDOFF_LABELS = ["done", "next", "uncommitted state"] as const;

/**
 * Whether a reply is a handoff: each of the Done, Next and Uncommitted state
 * labels starts a line, followed by a colon or alone on it (a heading).
 * Markdown emphasis, heading marks and list markers around a label are
 * ignored, and "Next steps" counts as Next; no other label takes a suffix.
 */
export function hasHandoffLabels(text: string): boolean {
  const lines = text.split("\n").map((line) =>
    line.replace(/[*_`]/g, "")
      .replace(/^\s*(?:(?:[-+>#]+|\d+[.)])\s*)*/, "")
      .trim()
      .toLowerCase()
  );
  return HANDOFF_LABELS.every((label) =>
    lines.some((line) => {
      if (!line.startsWith(label)) return false;
      const rest = line.slice(label.length).trim();
      const body = label === "next" ? rest.replace(/^steps\b\s*/, "") : rest;
      return body === "" || body.startsWith(":");
    })
  );
}

/**
 * The runtime's notice when the handoff call fails: the limit, the failure's
 * class, and the turn's last tool calls by command and outcome. It carries no
 * tool arguments, no results and no model text.
 */
export function stepLimitNotice(
  toolSteps: number,
  maxToolSteps: number,
  failure: unknown,
  calls: readonly RecentToolCall[],
  reason?: StepStopReason,
): string {
  const lines = [
    `${stepLimitNoticeLead(toolSteps, maxToolSteps, reason)} The handoff ` +
    `call did not produce a handoff (${summarizeErrorClass(failure)}), so ` +
    "this notice lists the turn's last tool calls instead.",
    "",
    "Last tool calls:",
    ...(calls.length === 0 ? ["- none recorded"] : calls.map((call) =>
      `- step ${call.step}: ${sanitizeBoundaryText(call.commandId, 128)} (${call.outcome})`
    )),
    "",
    "Uncommitted state is unknown. Check `git status` before the next prompt.",
  ];
  return lines.join("\n");
}

/**
 * The notice's first clause. A fixed-limit turn reads the line it always did; a
 * turn the step budget stopped names what stopped it, at the step count it
 * stopped at.
 */
function stepLimitNoticeLead(
  toolSteps: number,
  maxToolSteps: number,
  reason: StepStopReason | undefined,
): string {
  switch (reason) {
    case "stall":
      return `Tool use stopped at ${toolSteps}/${maxToolSteps} steps: two ` +
        "consecutive steps added nothing new.";
    case "ceiling":
      return `Tool-step ceiling reached (${toolSteps}/${maxToolSteps}).`;
    case "budget":
      return `Spend limits stopped tool use at ${toolSteps}/${maxToolSteps} steps.`;
    default:
      return `Tool-step limit reached (${toolSteps}/${maxToolSteps}).`;
  }
}

/** The error's fixed class label; never `.name`, a shadowable property. */
function summarizeErrorClass(failure: unknown): string {
  return classifyErrorKind(failure);
}
