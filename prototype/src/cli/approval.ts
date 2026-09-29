/**
 * The interactive answer to a mid-turn approval request: an ACP permission
 * option, a mutating-tool approval, a budget ceiling or a runaway-anomaly
 * stop. Shared by `exec` and the REPL.
 */

import type { ToolApprovalVerdict } from "../transport/mod.ts";
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
      reason: "approval needs an interactive terminal",
    };
  }
  if (r.kind === "budget_ceiling") {
    const message = typeof r.message === "string"
      ? r.message
      : "Projected spend crosses the configured budget ceiling.";
    io.err(`\n⚠  ${message}`);
    const answer = await io.readLine(
      "   exceed budget ceiling? [y/N] ",
      abortSignal,
    );
    if (abortSignal?.aborted) return { decision: "abort" };
    if (answer !== null && /^y(es)?$/i.test(answer.trim())) {
      return { decision: "approve" };
    }
    return { decision: "deny", reason: "operator declined" };
  }
  if (r.kind === "runaway_anomaly") {
    const message = typeof r.message === "string"
      ? r.message
      : "Actual spend crossed a runaway-anomaly hard stop.";
    io.err(`\n🛑 ${message}`);
    const answer = await io.readLine(
      "   allow the next call anyway? [y/N] ",
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
  io.err(`\n⚠  approve ${title}?`);
  io.err(formatApprovalArgs(r.arguments));
  const answer = await io.readLine("   approve? [y/N] ", abortSignal);
  if (abortSignal?.aborted) return { decision: "abort" };
  if (answer !== null && /^y(es)?$/i.test(answer.trim())) {
    return { decision: "approve" };
  }
  return { decision: "deny", reason: "operator declined" };
}

function formatApprovalArgs(args: unknown): string {
  if (typeof args !== "object" || args === null) return `   ${String(args)}`;
  const lines: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    const preview = raw.length > 200
      ? `${raw.slice(0, 200)}… (${raw.length} chars)`
      : raw;
    lines.push(`   ${key}: ${preview.replace(/\n/g, "\n     ")}`);
  }
  return lines.join("\n");
}
