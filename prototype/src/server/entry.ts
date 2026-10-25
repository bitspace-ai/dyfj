/**
 * server/ (L5): the runtime process's entry guard.
 *
 * A misconfigured runtime refuses to boot, and the operator needs the reason,
 * not a Node stack trace. The guard recognises an `Error` whose message starts
 * with `config:`, the prefix most config validators write (the tool-step
 * ceiling check is the one tested end to end), and reports it as one stderr
 * line and a non-zero exit status. Any error it does not recognise is
 * rethrown unchanged, with its stack.
 *
 * The guard sets the exit status and returns; it never calls `process.exit`,
 * which can cut off a stderr line still buffered on a pipe. Node exits on its
 * own once stderr has drained and nothing else keeps the event loop alive.
 */

/** Exit status of a runtime that refused to start over its configuration. */
export const CONFIG_ERROR_EXIT_CODE = 1;

const CONFIG_ERROR_PREFIX = "config:";

/**
 * The single stderr line for a config error, or `undefined` when `error` is
 * not one. Any line breaks inside the message collapse to single spaces so
 * the report stays one line.
 */
export function configErrorLine(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (!error.message.startsWith(CONFIG_ERROR_PREFIX)) return undefined;
  return `dyfj runtime: ${error.message.replace(/\s*[\r\n]+\s*/g, " ").trim()}`;
}

export interface RuntimeEntryPorts {
  /** Writes one line to stderr. */
  say: (line: string) => void;
  /** Records the exit status the process ends with (`process.exitCode`). */
  setExitCode: (code: number) => void;
}

/**
 * Runs the runtime's boot. A config error becomes one stderr line and a
 * non-zero exit status, set without exiting; anything else is rethrown with
 * its stack.
 */
export async function runRuntimeEntry(
  boot: () => Promise<void>,
  ports: RuntimeEntryPorts,
): Promise<void> {
  try {
    await boot();
  } catch (error) {
    const line = configErrorLine(error);
    if (line === undefined) throw error;
    ports.say(line);
    ports.setExitCode(CONFIG_ERROR_EXIT_CODE);
  }
}
