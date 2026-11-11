/**
 * The interactive answer to a mid-turn approval request: an ACP permission
 * option, a mutating-tool approval, or a spend check. Shared by `exec` and
 * the REPL.
 */

import type { ToolApprovalVerdict } from "../transport/mod.ts";
import { flagForLimitReason, LIMIT_REASON_FLAGS } from "./budget.ts";
import type { Io } from "./io.ts";

const MAX_ACP_PERMISSION_OPTIONS = 16;
const MAX_ACP_PERMISSION_SELECTION_ATTEMPTS = 3;
const MAX_ACP_PERMISSION_SELECTION_CODE_UNITS = 64;

/**
 * Prompt the operator for a mid-turn decision over the UDS seam: an exact ACP
 * permission option, mutating-tool approval, or a budget gate. Non-interactive
 * use fails closed. The prompt goes to stderr so a `--json` turn's stdout stays
 * clean.
 */
export async function promptMidTurnApproval(
  io: Io,
  request: unknown,
  interactive: boolean,
  abortSignal?: AbortSignal,
): Promise<ToolApprovalVerdict> {
  const r = (typeof request === "object" && request !== null)
    ? request as Record<string, unknown>
    : {};
  if (r.kind === "external_agent_permission") {
    const rawOptions = Array.isArray(r.options) && r.options.length > 0 &&
        r.options.length <= MAX_ACP_PERMISSION_OPTIONS
      ? r.options
      : null;
    const parsedOptions = (rawOptions ?? []).flatMap((value) => {
      if (typeof value !== "object" || value === null) return [];
      const option = value as Record<string, unknown>;
      if (
        typeof option.optionId !== "string" || option.optionId.length === 0 ||
        typeof option.name !== "string" ||
        (option.kind !== "allow_once" &&
          option.kind !== "allow_always" &&
          option.kind !== "reject_once" &&
          option.kind !== "reject_always")
      ) return [];
      return [{
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      }];
    });
    const optionIds = new Set(parsedOptions.map((option) => option.optionId));
    const optionsValid = rawOptions !== null &&
      parsedOptions.length === rawOptions.length &&
      optionIds.size === parsedOptions.length;
    const options = optionsValid ? parsedOptions : [];
    const rejection = options.find((option) => option.kind === "reject_once") ??
      options.find((option) => option.kind === "reject_always");
    const reject = (): ToolApprovalVerdict =>
      rejection === undefined
        ? { decision: "deny", reason: "ACP rejection option unavailable" }
        : { decision: "select", optionId: rejection.optionId };
    const policyReject = (): ToolApprovalVerdict => ({
      decision: "deny",
      reason: "ACP permission selection unavailable",
    });
    if (!optionsValid) {
      io.err("   ACP permission options were invalid; request rejected.");
      return reject();
    }
    if (!interactive) return policyReject();

    const title = typeof r.title === "string"
      ? r.title
      : "External agent action";
    io.err(`\n⚠  ${title}`);
    io.err(formatApprovalArgs(r.arguments));
    for (const [index, option] of options.entries()) {
      io.err(`   ${index + 1}. ${option.name}`);
    }

    for (
      let attempt = 0;
      attempt < MAX_ACP_PERMISSION_SELECTION_ATTEMPTS;
      attempt += 1
    ) {
      const answer = await io.readLine(
        `   select [1-${options.length}] (default reject): `,
        abortSignal,
      );
      if (abortSignal?.aborted) return { decision: "abort" };
      if (answer === null) return policyReject();
      if (answer.length > MAX_ACP_PERMISSION_SELECTION_CODE_UNITS) {
        io.err(`   Enter a number from 1 to ${options.length}.`);
        continue;
      }
      const selection = answer.trim();
      if (selection === "") return reject();
      const selected = /^\d+$/u.test(selection) ? Number(selection) : 0;
      if (selected >= 1 && selected <= options.length) {
        return {
          decision: "select",
          optionId: options[selected - 1].optionId,
        };
      }
      io.err(`   Enter a number from 1 to ${options.length}.`);
    }
    return policyReject();
  }
  if (!interactive) {
    return {
      decision: "deny",
      reason: r.kind === "budget_ceiling" || r.kind === "runaway_anomaly"
        ? spendApprovalUnavailable(r.crossedScopes)
        : "approval needs an interactive terminal",
    };
  }
  // A runtime from before BIT-785 may still send `runaway_anomaly`; it is a
  // spend approval too, so it never falls through to the tool prompt below.
  if (r.kind === "budget_ceiling" || r.kind === "runaway_anomaly") {
    const message = typeof r.message === "string"
      ? r.message
      : "Projected spend crosses a configured spend limit.";
    io.err(`\n⚠  ${message}`);
    const answer = await io.readLine(
      "   continue past this limit? [y/N] ",
      abortSignal,
    );
    if (abortSignal?.aborted) return { decision: "abort" };
    if (answer !== null && /^y(es)?$/i.test(answer.trim())) {
      return { decision: "approve" };
    }
    return { decision: "deny", reason: "operator declined" };
  }
  const title = typeof r.title === "string"
    ? r.title
    : String(r.commandId ?? "tool");
  io.err(`\n⚠  approve ${escapeApprovalText(title)}?`);
  io.err(
    formatApprovalArgs(
      r.arguments,
      r.commandId === "dispatch/start" ? 400 : 200,
    ),
  );
  // Only a request the runtime marks grantable offers "allow for the rest of
  // the session"; elsewhere `s` is not consent and denies like any other line.
  const grantable = r.grantable === true;
  if (grantable) {
    io.err(
      "   s = yes, and allow this exact command for the rest of this session",
    );
  }
  const answer = await io.readLine(
    grantable ? "   approve? [y/N/s] " : "   approve? [y/N] ",
    abortSignal,
  );
  if (abortSignal?.aborted) return { decision: "abort" };
  if (answer !== null && /^y(es)?$/i.test(answer.trim())) {
    return { decision: "approve" };
  }
  if (grantable && answer !== null && /^s(ession)?$/i.test(answer.trim())) {
    return { decision: "approve", scope: "session" };
  }
  return { decision: "deny", reason: "operator declined" };
}

/** How many distinct unknown limit names are counted before "9+". */
const MAX_COUNTED_UNKNOWN_LIMITS = 9;

/**
 * Why a spend approval was declined without a terminal, and how to proceed:
 * answer it from one, or raise every limit it crosses. Each known limit name
 * on the wire becomes its flag, once, in a fixed order; the distinct names
 * this client does not know are counted (up to 9, then "9+"). The list is
 * only scanned, plus a set of at most ten unknown names. The runtime caps
 * this reason at MAX_REASON_FIELD_BYTES (200); the longest form, all five
 * flags and "9+ more are unknown", is 195 bytes.
 */
function spendApprovalUnavailable(crossedScopes: unknown): string {
  const scopes: readonly unknown[] = Array.isArray(crossedScopes)
    ? crossedScopes
    : [];
  const flags = LIMIT_REASON_FLAGS
    .filter(([reason]) => scopes.includes(reason))
    .map(([, flag]) => flag);
  const unknown = new Set<unknown>();
  for (const scope of scopes) {
    if (unknown.size > MAX_COUNTED_UNKNOWN_LIMITS) break;
    if (flagForLimitReason(scope) === undefined) unknown.add(scope);
  }
  const count = unknown.size > MAX_COUNTED_UNKNOWN_LIMITS
    ? `${MAX_COUNTED_UNKNOWN_LIMITS}+`
    : String(unknown.size);
  const verb = unknown.size === 1 ? "is" : "are";
  const terminal = "approval needs an interactive terminal; run the turn " +
    "from one";
  if (flags.length === 0) {
    return `${terminal} to answer it, or raise the limit with its ` +
      "--budget-* flag" +
      (unknown.size === 0 ? "" : `; ${count} ${verb} unknown to this client`);
  }
  if (flags.length === 1 && unknown.size === 0) {
    return `${terminal} to answer it, or raise the limit with ${flags[0]} <usd>`;
  }
  return `${terminal}, or raise each crossed limit: ${flags.join(", ")}` +
    (unknown.size === 0 ? "" : `; ${count} more ${verb} unknown`);
}

/**
 * `text` with every C0/C1 control character except newline shown as a visible
 * `\xNN` escape, so model-influenced approval text (a task preview, a command)
 * cannot clear the screen or move the cursor over the prompt the operator is
 * answering. Newlines stay literal (indented), so a long multi-line value can
 * still push earlier prompt lines up the screen.
 */
export function escapeApprovalText(text: string): string {
  return text.replace(
    /[\x00-\x09\x0B-\x1F\x7F-\x9F]/g,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

function formatApprovalArgs(args: unknown, previewChars = 200): string {
  if (typeof args !== "object" || args === null) {
    return `   ${escapeApprovalText(String(args))}`;
  }
  const lines: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    const preview = raw.length > previewChars
      ? `${raw.slice(0, previewChars)}… (${raw.length} chars)`
      : raw;
    lines.push(
      `   ${escapeApprovalText(key)}: ${
        escapeApprovalText(preview).replace(/\n/g, "\n     ")
      }`,
    );
  }
  return lines.join("\n");
}
