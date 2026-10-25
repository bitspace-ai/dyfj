/**
 * server/ (L5): the runtime process's entry guard.
 *
 * A misconfigured runtime refuses to boot, and the operator needs the reason,
 * not a Node stack trace. Config errors carry the `config:` prefix every
 * config validator already writes, so the guard reports those as one stderr
 * line and a non-zero exit. Any other failure is a bug, not an operator
 * mistake, and keeps its stack: it is rethrown untouched.
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
  exit: (code: number) => void;
}

/**
 * Runs the runtime's boot. A config error becomes one stderr line and a
 * non-zero exit; anything else is rethrown with its stack.
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
    ports.exit(CONFIG_ERROR_EXIT_CODE);
  }
}
