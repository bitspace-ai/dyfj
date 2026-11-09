/**
 * The REPL's `/effort` command: show or set the session's reasoning effort on
 * the Codex ChatGPT route.
 */
import { isCodexReasoningEffort } from "../../config/mod.ts";
import { connectUnixClient } from "../../transport/mod.ts";
import { CODEX_MODEL_PREFIX, type CliConfig } from "../args.ts";
import type { ConnectFn, Io } from "../io.ts";
import { fetchSessionPosture, formatPostureLine } from "../posture.ts";

const USAGE = "usage: /effort [low|medium|high|xhigh|default]";

/**
 * `/effort` shows the effort the next Codex turn runs at; `/effort <level>`
 * sets it for the rest of the session, and `/effort default` returns to the
 * runtime's configured one. A changed effort starts a new Codex session on
 * the next turn, which is given this session's transcript.
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
  // Clearing comes before any runtime read and needs no Codex model: it is
  // how an effort the current route refuses is dropped.
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
        : `dyfj: reasoning effort applies only to codex-chatgpt models; ` +
          `"${posture.slug}" is not one`,
    );
    return true;
  }
  if (target === undefined) {
    io.err(
      `reasoning effort: ${posture.effort}` +
        (config.effort === undefined ? " (runtime default)" : ""),
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
      : `reasoning effort ${after} from the next turn; a session with ` +
        "earlier turns continues in a new Codex session, which is given " +
        "this session's transcript",
  );
  io.err(formatPostureLine({ ...posture, effort: after }));
  return true;
}

/**
 * Drop the session's effort on a switch to `slug` when it is not a Codex
 * model: carried over, the effort would be refused on every turn.
 */
export function clearEffortOffCodex(
  config: CliConfig,
  slug: string,
  io: Io,
): void {
  if (config.effort === undefined || slug.startsWith(CODEX_MODEL_PREFIX)) {
    return;
  }
  config.effort = undefined;
  io.err(
    `dyfj: reasoning effort cleared for "${slug}" (codex-chatgpt models only)`,
  );
}
