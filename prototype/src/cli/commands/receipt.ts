/**
 * The REPL's `/receipt steps` command: the last turn's usage, one line per
 * provider call (BIT-717).
 */
import type { TurnStepUsage } from "../../contract/mod.ts";
import type { Io } from "../io.ts";
import { formatStepLines } from "../render/receipt.ts";
import type { TurnResult } from "../turn-client.ts";

/**
 * `/receipt steps` prints the last turn's per-call lines. There are none
 * before the first turn, after an external-runner turn, and from a runtime
 * that predates per-call usage.
 */
export function handleReplReceiptCommand(
  line: string,
  io: Io,
  last: TurnResult | undefined,
): boolean {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== "/receipt") return false;
  if (parts.length !== 2 || parts[1] !== "steps") {
    io.err("usage: /receipt steps");
    return true;
  }
  const steps: readonly TurnStepUsage[] | undefined =
    last === undefined || "runner" in last ? undefined : last.tokens.steps;
  if (steps === undefined || steps.length === 0) {
    io.err("no per-step usage for the last turn");
    return true;
  }
  io.err(`last turn, ${steps.length} provider call${steps.length === 1 ? "" : "s"}:`);
  for (const stepLine of formatStepLines(steps)) io.err(stepLine);
  return true;
}
