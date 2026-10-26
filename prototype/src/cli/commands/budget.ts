/**
 * The REPL's `/budget` command: show the session's spend limits, or set one
 * for the rest of the session (BIT-785).
 */
import { connectUnixClient } from "../../transport/mod.ts";
import type { CliConfig } from "../args.ts";
import {
  type BudgetLimitName,
  formatBudgetLine,
  MAX_BUDGET_USD,
  parseBudgetUsd,
} from "../budget.ts";
import type { ConnectFn, Io } from "../io.ts";
import { fetchSessionPosture } from "../posture.ts";

/** The `/budget` word for each limit. */
const BUDGET_WORDS: Record<string, BudgetLimitName> = {
  turn: "turn",
  session: "session",
  day: "day",
  "per-call": "perCall",
  runaway: "runaway",
};

/**
 * `/budget` shows the session's limits; `/budget <limit> <usd>` sets one for
 * the rest of the session, where <limit> is turn, session, day, per-call or
 * runaway.
 */
export async function handleReplBudgetCommand(
  line: string,
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
): Promise<boolean> {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== "/budget") return false;
  const usage = "usage: /budget [turn|session|day|per-call|runaway <usd>]";
  if (parts.length !== 1 && parts.length !== 3) {
    io.err(usage);
    return true;
  }
  if (config.runner !== undefined) {
    io.err("dyfj: spend limits do not apply to an external runner");
    return true;
  }
  if (parts.length === 3) {
    const name = Object.hasOwn(BUDGET_WORDS, parts[1])
      ? BUDGET_WORDS[parts[1]]
      : undefined;
    const value = parseBudgetUsd(parts[2]);
    if (name === undefined || value === undefined) {
      io.err(`${usage}, with <usd> above 0 and at most ${MAX_BUDGET_USD}`);
      return true;
    }
    config.budget = { ...config.budget, [name]: value };
  }
  const posture = await fetchSessionPosture(config, connect);
  if ("error" in posture) {
    io.err(posture.error);
    return true;
  }
  io.err(formatBudgetLine(posture.budget ?? {}));
  return true;
}
