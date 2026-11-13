/**
 * A streaming turn's terminal output: markdown-rendered text on stdout and
 * runtime events as status lines on stderr.
 */

import process from "node:process";
import {
  isSupersedingRetryStarted,
  SESSION_ID_SHAPE,
} from "../../contract/mod.ts";
import { sanitizeBoundaryText } from "../../kernel/mod.ts";
import type { CliConfig } from "../args.ts";
import type { Io } from "../io.ts";
import { createStreamingMarkdownRenderer } from "./streaming-markdown.ts";

/**
 * The markdown wrap width for a terminal `columns` reading, capped at 100. An
 * unknown width falls back to 80, and so does zero: a pty with no size set
 * reports 0 columns.
 */
export function wrapColumns(columns: number | undefined): number {
  return Math.min(columns || 80, 100);
}

/** Wrap streamed turn text with line-buffered markdown rendering. */
export function createTurnOutputHandlers(
  config: CliConfig,
  io: Io,
  writeLifecycle: {
    beforeWrite?: () => void;
    afterWrite?: () => void;
  } = {},
): {
  onDelta: (text: string) => void;
  emitBufferedText: (text: string) => void;
  finish: () => void;
  streamed: () => boolean;
  supersede: () => void;
  yieldToReceipt: () => void;
} {
  let sawDelta = false;
  const renderer = createStreamingMarkdownRenderer({
    out: (text) => io.out(text),
    color: config.color,
    columns: wrapColumns(process.stdout.columns),
    ...writeLifecycle,
  });
  return {
    onDelta: (text: string) => {
      sawDelta = true;
      renderer.push(text);
    },
    emitBufferedText: (text: string) => {
      renderer.push(text);
      renderer.flush();
    },
    finish: () => renderer.flush(),
    streamed: () => sawDelta,
    // The superseding-retry signal: text rendered so far is stale. Already-
    // printed lines may have scrolled beyond reach, so honest presentation is
    // a visible marker plus a clean renderer — never silently gluing the
    // replacement onto the stale text's parse state. sawDelta re-arms so a
    // retry that ends up buffered still gets its text emitted from the receipt.
    supersede: () => {
      renderer.reset();
      sawDelta = false;
      const marker = "⟲ retrying with recovered context — " +
        "the reply restarts below";
      io.out(`\n${config.color ? `\x1b[2m${marker}\x1b[0m` : marker}\n\n`);
    },
    // The reply is the receipt's text, whatever streamed before: a handoff
    // that failed part way is followed by the runtime's notice. What already
    // streamed stays on screen, and the status line says it was cut off.
    yieldToReceipt: () => {
      renderer.flush();
      sawDelta = false;
    },
  };
}

/**
 * Route one runtime event from a streaming turn: the superseding-retry signal
 * resets the renderer (the contract every streaming client must honor); other
 * events render as stderr status lines. The UDS stream frames carry the same
 * shapes the contract defines, so honoring it here covers the seam.
 */
export function handleTurnRuntimeEvent(
  event: unknown,
  output: ReturnType<typeof createTurnOutputHandlers>,
  io: Io,
): void {
  if (isSupersedingRetryStarted(event)) {
    output.supersede();
    return;
  }
  // Both clients decode the transport JSON but never schema-validate the frame,
  // so a malformed `event: null` or primitive must be dropped, not dereferenced.
  if (typeof event !== "object" || event === null) return;
  const runtimeEvent = event as Record<string, unknown>;
  // The renderer may still hold an incomplete final line. Make the terminal
  // marker follow all preserved partial text, rather than bisecting it.
  if (
    runtimeEvent.type === "turnAborted" ||
    runtimeEvent.type === "unparsedToolCallMarkupDetected"
  ) output.finish();
  if (
    runtimeEvent.type === "toolStepLimitHandoff" &&
    runtimeEvent.source === "notice"
  ) output.yieldToReceipt();
  const line = formatRuntimeEvent(runtimeEvent);
  if (line !== null) io.err(line);
}

/** The command id and, when the frame carries one, what the call acted on. */
function toolCallLabel(event: Record<string, unknown>): string {
  const commandId = typeof event.commandId === "string"
    ? event.commandId
    : "tool";
  const subject = typeof event.subject === "string"
    ? sanitizeBoundaryText(event.subject, 120).trim()
    : "";
  return subject === "" ? commandId : `${commandId} ${subject}`;
}

export function formatRuntimeEvent(
  event: Record<string, unknown>,
): string | null {
  if (event.type === "turnAborted") return "[interrupted]";
  if (event.type === "childApprovalParked") {
    const label = typeof event.label === "string" &&
        /^[a-z0-9][a-z0-9-]{0,31}$/.test(event.label)
      ? event.label
      : null;
    const childSessionId = typeof event.childSessionId === "string" &&
        SESSION_ID_SHAPE.test(event.childSessionId)
      ? event.childSessionId
      : null;
    if (label === null || childSessionId === null) return null;
    return `${label} (child) is waiting for approval: dyfj --session ${childSessionId}`;
  }
  if (event.type === "toolStepStarted") {
    const step = typeof event.step === "number" ? event.step : "?";
    const count = typeof event.toolCallCount === "number"
      ? event.toolCallCount
      : "?";
    return `tool: step ${step} running ${count} call(s)`;
  }
  if (event.type === "toolStepLimitReached") {
    const maxSteps = typeof event.maxSteps === "number" ? event.maxSteps : "?";
    return `tool: reached ${maxSteps}-step limit; asking the model for a handoff`;
  }
  // A handoff the model wrote is the reply itself; only the fallback needs
  // saying, because the reply is then the runtime's notice.
  if (event.type === "toolStepLimitHandoff" && event.source === "notice") {
    return "tool: the handoff call failed; the reply is the runtime's notice of the last tool calls";
  }
  if (event.type === "unparsedToolCallMarkupDetected") {
    const count = typeof event.count === "number" &&
        Number.isSafeInteger(event.count) && event.count > 0
      ? event.count
      : null;
    const amount = count === null
      ? "an unknown number of unrun tool calls"
      : `${
        event.countIsLowerBound === true ? "at least " : ""
      }${count} unrun tool call(s)`;
    return `WARNING: unparsed tool-call markup was present (${amount}); ` +
      "no tools were executed from it";
  }
  if (event.type === "toolCallStarted") {
    return `tool: ${toolCallLabel(event)} started`;
  }
  if (event.type === "toolCallCompleted") {
    const commandId = typeof event.commandId === "string"
      ? event.commandId
      : "tool";
    const label = toolCallLabel(event);
    // A refused call never ran: say so, and show no duration (the time on it
    // is the approval wait). This client may have no terminal, so nobody is
    // said to have declined.
    if (event.verdict === "approval_denied") {
      return `  ⊘ ${label} not approved`;
    }
    const duration = typeof event.durationMs === "number"
      ? ` (${event.durationMs}ms)`
      : "";
    const reconciliation = event.isError === true &&
        /^mcp\.[A-Za-z0-9_-]+\.create_issue$/.test(commandId)
      ? "\nCreation not confirmed. If you approved this call, reconcile in Linear before retrying; the issue may already exist."
      : "";
    // Why it failed, when the runtime says: one line, terminal-safe, bounded.
    const reason = event.isError === true &&
        typeof event.failureReason === "string" && event.failureReason !== ""
      ? `: ${sanitizeBoundaryText(event.failureReason, 160)}`
      : "";
    // A command's exit status, or a tool's error reply: output the model
    // reads, so the call finished, but not necessarily well.
    const status = event.isError !== true &&
        typeof event.resultStatus === "string" && event.resultStatus !== ""
      ? ` · ${sanitizeBoundaryText(event.resultStatus, 160)}`
      : "";
    return `tool: ${label} ${
      event.isError === true ? "failed" : "finished"
    }${duration}${reason}${status}${reconciliation}`;
  }
  if (event.type === "memoryRecallNegotiated") {
    const era = event.era === "modern" || event.era === "legacy"
      ? event.era
      : null;
    const identifier = (value: unknown): string | null =>
      typeof value === "string" &&
        value.length > 0 && value.length <= 64 &&
        /^[A-Za-z0-9._:/@+-]+$/.test(value)
        ? value
        : null;
    const revision = identifier(event.revision);
    const rawServer = typeof event.server === "object" &&
        event.server !== null && !Array.isArray(event.server)
      ? event.server as Record<string, unknown>
      : null;
    const serverName = rawServer === null ? null : identifier(rawServer.name);
    const serverVersion = rawServer === null
      ? null
      : identifier(rawServer.version);
    if (!Array.isArray(event.extensions) || event.extensions.length > 8) {
      return null;
    }
    const extensions = event.extensions.map(identifier);
    if (
      era === null || revision === null ||
      extensions.some((extension) => extension === null)
    ) return null;
    const server = serverName === null || serverVersion === null
      ? ""
      : ` server=${serverName}@${serverVersion}`;
    const extensionText = extensions.length === 0
      ? ""
      : ` extensions=${extensions.join(",")}`;
    return `Memory recall MCP: era=${era} revision=${revision}${server}${extensionText}`;
  }
  if (event.type === "toolResultTrimmed") {
    const commandId = typeof event.commandId === "string"
      ? event.commandId
      : "tool";
    const kept = typeof event.keptChars === "number" ? event.keptChars : "?";
    const total = typeof event.totalChars === "number" ? event.totalChars : "?";
    const window = typeof event.contextWindow === "number"
      ? `${event.contextWindow}-token`
      : "the";
    return `context: trimmed ${commandId} result to fit the ${window} ` +
      `window (${kept} of ${total} characters kept)`;
  }
  if (event.type === "contextFitted") {
    const window = typeof event.contextWindow === "number"
      ? `${event.contextWindow}-token`
      : "the";
    const before = typeof event.estimatedTokensBefore === "number"
      ? event.estimatedTokensBefore
      : "?";
    const after = typeof event.estimatedTokensAfter === "number"
      ? event.estimatedTokensAfter
      : "?";
    const trimmed = typeof event.trimmedToolResults === "number" &&
        event.trimmedToolResults > 0
      ? `, ${event.trimmedToolResults} tool result(s) trimmed`
      : "";
    const compressed = event.compressed === true
      ? ", elder turns compressed"
      : "";
    const cause = event.trigger === "provider_rejected"
      ? " after the provider rejected the request"
      : "";
    return `context: fitted to the ${window} window${cause} ` +
      `(~${before} → ~${after} tokens${trimmed}${compressed})`;
  }
  if (event.type === "contextCompressed") {
    const turns = typeof event.turnsCompressed === "number"
      ? event.turnsCompressed
      : "?";
    const before = typeof event.tokensBeforeEstimate === "number"
      ? event.tokensBeforeEstimate
      : "?";
    const after = typeof event.tokensAfterEstimate === "number"
      ? event.tokensAfterEstimate
      : "?";
    return `context: compressed ${turns} elder turn(s) ` +
      `(~${before} → ~${after} tokens)`;
  }
  if (event.type === "continuityReconstructing") {
    const projected = event.priorMessagesProjected;
    const leftOut = event.priorMessagesLeftOut;
    if (
      typeof projected !== "number" || !Number.isInteger(projected) ||
      projected < 0 ||
      typeof leftOut !== "number" || !Number.isInteger(leftOut) || leftOut < 0
    ) {
      return null;
    }
    const phrase = continuityReconstructionPhrase(event.reason);
    const noun = projected === 1 ? "earlier message" : "earlier messages";
    const tail = leftOut > 0 ? `, ${leftOut} left out.` : ".";
    return `· agent session replaced: ${phrase}. Sending ${projected} ${noun}${tail}`;
  }
  return null;
}

function continuityReconstructionPhrase(reason: unknown): string {
  switch (reason) {
    case "idle_limit":
      return "it was closed after the idle limit";
    case "capacity":
      return "it was closed to make room for another session";
    case "agent_settings_changed":
      return "the model, effort, workspace or another agent setting changed";
    case "agent_session_failed":
      return "it ended with an error";
    case "released":
      return "the runtime released it after a one-shot or dispatched turn";
    case "not_held":
      return "this runtime holds no agent session for it (for example after a restart)";
    default:
      return "reason not reported";
  }
}
