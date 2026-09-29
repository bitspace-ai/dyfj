/**
 * The turn-in-flight spinner: its label sanitizing and the handler wrapper
 * that yields the terminal around visible output.
 */

import { takeCodePointPrefix } from "../../kernel/mod.ts";
import { isSupersedingRetryStarted } from "../../contract/mod.ts";
import type { ToolApprovalVerdict } from "../../transport/mod.ts";
import type { CliConfig } from "../args.ts";
import type { Io } from "../io.ts";
import { type BusySpinner, createBusySpinner } from "./busy-spinner.ts";
import {
  type createTurnOutputHandlers,
  formatRuntimeEvent,
  handleTurnRuntimeEvent,
} from "./turn-output.ts";

/** Cheap scan budget before any label normalization. */
export const SPINNER_LABEL_SCAN_LIMIT = 256;
/** Visible code-point budget after control sequences are dropped. */
export const SPINNER_LABEL_DISPLAY_LIMIT = 40;

/**
 * Bound and neutralize a spinner label candidate.
 *
 * The first 256 code points are inspected; nothing past that budget is
 * normalized. Complete and incomplete ANSI / OSC / C0 / C1 sequences are
 * treated as control and dropped — the scan never slices a terminator off
 * a sequence and then keeps the payload.
 */
export function sanitizeSpinnerLabel(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const chars = takeCodePointPrefix(value, SPINNER_LABEL_SCAN_LIMIT);
  const limit = chars.length;
  const visible: string[] = [];
  let pendingSpace = false;
  let overflow = false;
  let index = 0;

  const emitVisible = (ch: string): void => {
    if (visible.length >= SPINNER_LABEL_DISPLAY_LIMIT) {
      overflow = true;
      return;
    }
    if (pendingSpace && visible.length > 0) {
      if (visible.length + 1 >= SPINNER_LABEL_DISPLAY_LIMIT) {
        overflow = true;
        return;
      }
      visible.push(" ");
    }
    pendingSpace = false;
    visible.push(ch);
  };

  while (index < limit && !overflow) {
    const code = chars[index].codePointAt(0) ?? 0;
    if (code === 0x1b) {
      index = skipEscSequence(chars, index, limit);
      continue;
    }
    if (code === 0x9b) {
      index = skipCsiBody(chars, index + 1, limit);
      continue;
    }
    if (code === 0x9d) {
      index = skipOscBody(chars, index + 1, limit);
      continue;
    }
    if (
      code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f
    ) {
      index = skipStringTerminator(chars, index + 1, limit);
      continue;
    }
    if (
      code === 0x20 ||
      code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)
    ) {
      if (visible.length > 0) pendingSpace = true;
      index += 1;
      continue;
    }
    emitVisible(chars[index]);
    index += 1;
  }

  if (visible.length === 0) return null;
  if (overflow) {
    return `${visible.slice(0, SPINNER_LABEL_DISPLAY_LIMIT - 1).join("")}…`;
  }
  return visible.join("");
}

function skipEscSequence(
  chars: string[],
  start: number,
  limit: number,
): number {
  const next = start + 1;
  if (next >= limit) return limit;
  const introducer = chars[next];
  if (introducer === "[") return skipCsiBody(chars, next + 1, limit);
  if (introducer === "]") return skipOscBody(chars, next + 1, limit);
  if (
    introducer === "P" || introducer === "X" || introducer === "^" ||
    introducer === "_"
  ) {
    return skipStringTerminator(chars, next + 1, limit);
  }
  return next + 1;
}

function skipCsiBody(chars: string[], start: number, limit: number): number {
  let index = start;
  while (index < limit) {
    const code = chars[index].codePointAt(0) ?? 0;
    if (code >= 0x40 && code <= 0x7e) return index + 1;
    if (code < 0x20 || code > 0x3f) return index + 1;
    index += 1;
  }
  return limit;
}

function skipOscBody(chars: string[], start: number, limit: number): number {
  let index = start;
  while (index < limit) {
    const code = chars[index].codePointAt(0) ?? 0;
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && index + 1 < limit && chars[index + 1] === "\\") {
      return index + 2;
    }
    index += 1;
  }
  return limit;
}

function skipStringTerminator(
  chars: string[],
  start: number,
  limit: number,
): number {
  let index = start;
  while (index < limit) {
    const code = chars[index].codePointAt(0) ?? 0;
    if (code === 0x9c) return index + 1;
    if (code === 0x1b && index + 1 < limit && chars[index + 1] === "\\") {
      return index + 2;
    }
    index += 1;
  }
  return limit;
}

function progressSpinnerLabel(event: Record<string, unknown>): string | null {
  if (event.type !== "agentProgress") return null;
  const nested = typeof event.progress === "object" && event.progress !== null
    ? event.progress as Record<string, unknown>
    : null;
  const kind = nested?.kind ?? event.kind;
  if (kind === "thought") return "thinking…";
  return sanitizeSpinnerLabel(nested?.title ?? event.title) ??
    sanitizeSpinnerLabel(nested?.name ?? event.name) ??
    sanitizeSpinnerLabel(nested?.status ?? event.status);
}

/**
 * The turn-in-flight indicator: animates on stderr for the full turn, pausing
 * while output or an approval prompt owns the terminal. Enabled only when the
 * Io exposes a raw stderr writer AND stderr is an interactive terminal — piped
 * stderr gets no control bytes.
 */
export function createTurnSpinner(config: CliConfig, io: Io): BusySpinner {
  return createBusySpinner({
    write: (text) => io.errRaw?.(text),
    enabled: io.errRaw !== undefined && io.errIsTerminal === true,
    color: config.color,
  });
}

/**
 * True when routing this runtime event will actually put something on the
 * terminal — a superseding-retry marker (rendered to stdout) or a status line
 * (`formatRuntimeEvent` returns non-null). Invisible bookkeeping events (e.g.
 * `modelSelected`, emitted right before the long provider wait) render nothing,
 * so they must NOT retire the spinner — otherwise it vanishes before the wait
 * it exists to cover.
 */
export function runtimeEventIsVisible(event: unknown): boolean {
  if (isSupersedingRetryStarted(event)) return true;
  if (typeof event !== "object" || event === null) return false;
  return formatRuntimeEvent(event as Record<string, unknown>) !== null;
}

/**
 * Wrap streaming-turn handlers so the spinner yields the terminal around each
 * visible output, then resumes until the terminal turn result. Progress can
 * replace the generic label at any point. Invisible bookkeeping events leave
 * the current indicator alone.
 */
export function spinnerGuardedTurnHandlers(
  spinner: BusySpinner,
  output: ReturnType<typeof createTurnOutputHandlers>,
  io: Io,
  onApproval: (
    request: unknown,
  ) => Promise<ToolApprovalVerdict> | ToolApprovalVerdict,
): {
  onDelta: (text: string) => void;
  onEvent: (event: Record<string, unknown>) => void;
  onApproval: (
    request: unknown,
  ) => Promise<ToolApprovalVerdict> | ToolApprovalVerdict;
} {
  return {
    onDelta: (text) => {
      output.onDelta(text);
    },
    onEvent: (event) => {
      const progressLabel = progressSpinnerLabel(event);
      if (progressLabel !== null) {
        spinner.updateLabel(progressLabel);
        spinner.start();
        return;
      }
      // Keep spinning through invisible events; the wait isn't over yet.
      const visible = runtimeEventIsVisible(event);
      if (visible) spinner.pause();
      handleTurnRuntimeEvent(event, output, io);
      if (visible) {
        spinner.updateLabel("working…");
        spinner.start();
      }
    },
    onApproval: async (request) => {
      spinner.pause();
      try {
        return await onApproval(request);
      } finally {
        spinner.updateLabel("working…");
        spinner.start();
      }
    },
  };
}
