/**
 * The REPL's `/effort` command: show or set the session's reasoning effort.
 *
 * The levels a model accepts come from the runtime's `models/list` row
 * (`reasoningEfforts`), so this client never hardcodes a slug prefix to
 * decide whether effort control applies: a model whose row omits the field
 * takes no effort at all.
 */
import { isCodexReasoningEffort } from "../../config/mod.ts";
import { connectUnixClient } from "../../transport/mod.ts";
import type { CliConfig } from "../args.ts";
import type { ModelRow } from "./models.ts";
import type { ConnectFn, Io } from "../io.ts";
import { fetchSessionPosture, formatPostureLine } from "../posture.ts";

const USAGE = "usage: /effort [low|medium|high|xhigh|default]";

/** The levels a model row advertises, or `undefined` when it takes none. */
export function rowReasoningEfforts(
  row: ModelRow | undefined,
): readonly string[] | undefined {
  const levels = (row as { reasoningEfforts?: unknown } | undefined)
    ?.reasoningEfforts;
  return Array.isArray(levels) && levels.every((l) => typeof l === "string")
    ? levels as string[]
    : undefined;
}

/**
 * Why `slug` cannot run at `level`, or `undefined` when it can. The runtime
 * holds the final verdict; this says so early, before a turn is refused.
 */
export function effortRefusal(
  slug: string,
  row: ModelRow | undefined,
  level: string,
): string | undefined {
  const levels = rowReasoningEfforts(row);
  if (levels === undefined) {
    return `dyfj: "${slug}" takes no reasoning effort (its catalog row does ` +
      "not support effort control)";
  }
  if (!levels.includes(level)) {
    return `dyfj: "${slug}" does not accept reasoning effort "${level}"; it ` +
      `accepts ${levels.join(", ")}`;
  }
  return undefined;
}

/**
 * `/effort` shows the effort the next turn runs at; `/effort <level>` sets it
 * for the rest of the session, and `/effort default` returns to the runtime's
 * configured default. The Codex profile carries the effort, so a turn at
 * another effort than the last does not reuse that turn's warm session.
 */
export async function handleReplEffortCommand(
  line: string,
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
): Promise<boolean> {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== "/effort") return false;
  if (parts.length > 2) {
    io.err(USAGE);
    return true;
  }
  const target = parts[1];
  if (
    target !== undefined && target !== "default" &&
    !isCodexReasoningEffort(target)
  ) {
    io.err(USAGE);
    return true;
  }
  // Clearing comes before any runtime read and needs no catalog: it is how an
  // effort the current route refuses is dropped.
  const previous = config.effort;
  if (target === "default") config.effort = undefined;
  const cleared = "reasoning effort cleared; turns name none";
  const posture = await fetchSessionPosture(config, connect);
  if ("error" in posture) {
    if (target === "default") io.err(cleared);
    io.err(posture.error);
    return true;
  }
  if (posture.effort === undefined) {
    io.err(
      target === "default"
        ? cleared
        : `dyfj: "${posture.slug}" takes no reasoning effort (its catalog ` +
          "row does not support effort control)",
    );
    return true;
  }
  if (target === undefined) {
    const accepted = posture.effortLevels === undefined
      ? ""
      : ` (accepts ${posture.effortLevels.join(", ")})`;
    io.err(
      `reasoning effort: ${posture.effort}` +
        (config.effort === undefined ? " (runtime default)" : "") +
        accepted,
    );
    return true;
  }
  if (target !== "default" && posture.effortLevels !== undefined &&
    !posture.effortLevels.includes(target)) {
    io.err(
      `dyfj: "${posture.slug}" does not accept reasoning effort "${target}"; ` +
        `it accepts ${posture.effortLevels.join(", ")}`,
    );
    return true;
  }
  // One read gives both sides: the runtime's default does not change here.
  const before = previous ?? posture.effort;
  if (target !== "default") config.effort = target;
  const after = config.effort ?? posture.effort;
  io.err(
    after === before
      ? `reasoning effort stays ${before}`
      : `reasoning effort ${after} from the next turn; a warm Codex session opened at another effort is not reused for it`,
  );
  io.err(formatPostureLine({ ...posture, effort: after }));
  return true;
}

/**
 * Drop the session's effort on a switch to `slug` when that model takes none
 * (its `models/list` row advertises no levels) or does not accept the level
 * the session set: carried over, the effort would be refused on every turn.
 * `row` is the target's catalog row, or `undefined` when the catalog could not
 * name it — then nothing is dropped, and the runtime refuses what it refuses.
 */
export function clearEffortOffUnsupported(
  config: CliConfig,
  slug: string,
  io: Io,
  row?: ModelRow,
): void {
  if (config.effort === undefined || row === undefined) return;
  const levels = rowReasoningEfforts(row);
  if (levels !== undefined && levels.includes(config.effort)) return;
  const dropped = config.effort;
  config.effort = undefined;
  io.err(
    levels === undefined
      ? `dyfj: reasoning effort cleared for "${slug}" (its catalog row does not support effort control)`
      : `dyfj: reasoning effort cleared for "${slug}" (it does not accept ` +
        `"${dropped}"; it accepts ${levels.join(", ")})`,
  );
}
