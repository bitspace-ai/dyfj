/**
 * The REPL's `/steps` command: show or set the session's tool-step limit.
 */
import { connectUnixClient } from "../../transport/mod.ts";
import { type CliConfig, parseToolSteps, TOOL_STEPS_BOUND } from "../args.ts";
import type { ConnectFn, Io } from "../io.ts";
import { fetchSessionPosture, formatPostureLine } from "../posture.ts";

/**
 * `/steps` shows the session's tool-step limit; `/steps N` sets it for the
 * rest of the session. A value above the runtime's ceiling is refused and the
 * limit stays as it was. The runtime checks every turn again, because its
 * ceiling can change when it restarts.
 */
export async function handleReplStepsCommand(
  line: string,
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
): Promise<boolean> {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== "/steps") return false;
  if (parts.length > 2) {
    io.err("usage: /steps [N]");
    return true;
  }
  if (config.runner !== undefined) {
    io.err("dyfj: the tool-step limit does not apply to an external runner");
    return true;
  }
  const posture = await fetchSessionPosture(config, connect);
  if ("error" in posture) {
    io.err(posture.error);
    return true;
  }
  const ceiling = posture.maxToolStepsCeiling;
  const current = posture.maxToolSteps;
  const show = (steps: number | undefined) =>
    `tool-step limit: ${steps ?? "unknown"}` +
    (ceiling === undefined ? "" : ` (ceiling ${ceiling})`);
  if (parts.length === 1) {
    io.err(show(current));
    return true;
  }
  const steps = parseToolSteps(parts[1]);
  if (steps === undefined) {
    io.err(
      `usage: /steps [N], with N an integer from 1 through ${TOOL_STEPS_BOUND}`,
    );
    return true;
  }
  if (ceiling !== undefined && steps > ceiling) {
    io.err(
      `refused: ${steps} is above the tool-step ceiling of ${ceiling}; ` +
        `the limit stays ${current ?? "unchanged"}`,
    );
    return true;
  }
  config.toolSteps = steps;
  io.err(show(steps));
  io.err(formatPostureLine({ ...posture, maxToolSteps: steps }));
  return true;
}
