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
 * The system prompt for a step's forced conclusion: the handoff instruction at
 * the step limit, or the shorter no-more-tools instruction when tool use ended
 * because the model repeated itself or a call was not approved.
 */
export function forcedConclusionSystemPrompt(
  baseSystemPrompt: string,
  reason: "limit" | "repeated_tool_calls" | "approval_denied",
  maxToolSteps: number,
): string {
  if (reason === "limit") {
    return handoffSystemPrompt(
      baseSystemPrompt,
      `this turn reached its ${maxToolSteps}-step tool limit`,
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
export function handoffRequest(maxToolSteps: number): {
  role: "user";
  content: string;
} {
  return {
    role: "user",
    content: handoffInstruction(
      `this turn reached its ${maxToolSteps}-step tool limit`,
    ),
  };
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
): string {
  const lines = [
    `Tool-step limit reached (${toolSteps}/${maxToolSteps}). The handoff ` +
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

/** The error's fixed class label; never `.name`, a shadowable property. */
function summarizeErrorClass(failure: unknown): string {
  return classifyErrorKind(failure);
}
