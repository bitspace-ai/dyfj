/**
 * server/ (L5): the runtime process's entry guard.
 *
 * A misconfigured runtime refuses to boot, and the operator needs the reason,
 * not a Node stack trace. The guard recognises an `Error` whose message starts
 * with `config:`, the prefix most config validators write (the tool-step
 * ceiling check is the one tested end to end), and reports it as one stderr
 * line and a non-zero exit status. A `DomainError` (a store, socket or other
 * failure whose message Workbench wrote) is reported the same way, as
 * `dyfj runtime: failed to start: <message>`. Any other error gets a
 * `failed to start` line carrying only its summarized label, so the launcher
 * and the REPL can relay one line, and is then rethrown unchanged, with its
 * stack.
 *
 * The guard sets the exit status and returns; it never calls `process.exit`,
 * which can cut off a stderr line still buffered on a pipe. Node exits on its
 * own once stderr has drained and nothing else keeps the event loop alive.
 */

import { configErrorText } from "../config/mod.ts";
import { DomainError, summarizeError } from "../contract/mod.ts";

/** Exit status of a runtime that refused to start over its configuration. */
export const CONFIG_ERROR_EXIT_CODE = 1;

/** What every failed-boot line after a config error starts with. */
export const FAILED_TO_START_PREFIX = "dyfj runtime: failed to start: ";

/** `text` on one line: line breaks collapse to single spaces. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/**
 * The single stderr line for a config error, or `undefined` when `error` is
 * not one. Any line breaks inside the message collapse to single spaces so
 * the report stays one line.
 */
export function configErrorLine(error: unknown): string | undefined {
  const text = configErrorText(error);
  return text === undefined ? undefined : `dyfj runtime: ${text}`;
}

export interface RuntimeEntryPorts {
  /** Writes one line to stderr. */
  say: (line: string) => void;
  /** Records the exit status the process ends with (`process.exitCode`). */
  setExitCode: (code: number) => void;
}

/**
 * Runs the runtime's boot. A config error or a `DomainError` becomes one
 * stderr line and a non-zero exit status, set without exiting; anything else
 * is named on one line and rethrown with its stack.
 */
export async function runRuntimeEntry(
  boot: () => Promise<void>,
  ports: RuntimeEntryPorts,
): Promise<void> {
  try {
    await boot();
  } catch (error) {
    const line = configErrorLine(error);
    if (line !== undefined) {
      ports.say(line);
      ports.setExitCode(CONFIG_ERROR_EXIT_CODE);
      return;
    }
    if (error instanceof DomainError) {
      ports.say(FAILED_TO_START_PREFIX + oneLine(summarizeError(error)));
      ports.setExitCode(CONFIG_ERROR_EXIT_CODE);
      return;
    }
    ports.say(
      `${FAILED_TO_START_PREFIX}${summarizeError(error)}; its stack trace follows`,
    );
    throw error;
  }
}
