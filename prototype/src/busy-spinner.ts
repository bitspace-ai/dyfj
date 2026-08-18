/**
 * Turn-in-flight indicator for the dyfj CLI: a braille-frame spinner rewritten
 * in place on stderr between submitting a turn and its first output.
 *
 * Deliberately the lightest mechanism that delivers the affordance: `\r` plus
 * erase-line on an interactive terminal — no alternate screen, no raw mode, no
 * cursor addressing. When stderr is not a TTY every call is a complete no-op,
 * so a pipe never sees control bytes.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ERASE_LINE = "\r\x1b[2K";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export interface BusySpinnerOptions {
  /** Raw writer with no implicit newline; stderr in the real CLI. */
  write: (text: string) => void;
  /** Animate only on an interactive terminal; false makes every call a no-op. */
  enabled: boolean;
  /** Dim the spinner line; NO_COLOR renders the same frames unstyled. */
  color: boolean;
  label?: string;
  intervalMs?: number;
  /** Timer injection for tests; defaults to the global interval timers. */
  setIntervalFn?: (callback: () => void, ms: number) => unknown;
  clearIntervalFn?: (id: unknown) => void;
  /** Clock injection for the elapsed-seconds suffix; defaults to Date.now. */
  nowMs?: () => number;
}

export interface BusySpinner {
  /** Paint the first frame and begin animating. No-op when disabled, already
   * spinning, or already stopped. */
  start(): void;
  /**
   * Erase the spinner line and retire the spinner — a later start() stays a
   * no-op, so the first real output permanently ends the "in flight" phase.
   * Idempotent, and safe (and disabling) before start().
   */
  stop(): void;
  /**
   * Change the in-flight label without stopping the spinner or restarting
   * the elapsed-time counter. Repaints immediately when already spinning.
   */
  updateLabel(newLabel: string): void;
}

export function createBusySpinner(options: BusySpinnerOptions): BusySpinner {
  const intervalMs = options.intervalMs ?? 80;
  const setIntervalFn = options.setIntervalFn ??
    ((callback: () => void, ms: number) => setInterval(callback, ms));
  const clearIntervalFn = options.clearIntervalFn ??
    ((id: unknown) => clearInterval(id as number));
  const nowMs = options.nowMs ?? (() => Date.now());
  let label = options.label ?? "working…";
  let timer: unknown = null;
  let frame = 0;
  let stopped = false;
  let startedAtMs: number | null = null;

  function paint(): void {
    const elapsedSec = startedAtMs === null
      ? 0
      : Math.floor((nowMs() - startedAtMs) / 1000);
    const text = `${FRAMES[frame % FRAMES.length]} ${label} ${elapsedSec}s`;
    frame++;
    options.write(
      `${ERASE_LINE}${options.color ? `${DIM}${text}${RESET}` : text}`,
    );
  }

  return {
    start(): void {
      if (!options.enabled || stopped || timer !== null) return;
      startedAtMs = nowMs();
      paint();
      timer = setIntervalFn(paint, intervalMs);
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer !== null) {
        clearIntervalFn(timer);
        timer = null;
        options.write(ERASE_LINE);
      }
    },
    updateLabel(newLabel: string): void {
      if (stopped || !options.enabled) return;
      label = newLabel;
      if (timer !== null) {
        paint();
      }
    },
  };
}
