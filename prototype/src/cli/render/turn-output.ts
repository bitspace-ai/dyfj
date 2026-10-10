/**
 * A streaming turn's terminal output: markdown-rendered text on stdout and
 * runtime events as status lines on stderr.
 */

import { isSupersedingRetryStarted } from "../../contract/mod.ts";
import type { CliConfig } from "../args.ts";
import type { Io } from "../io.ts";
import { createStreamingMarkdownRenderer } from "./streaming-markdown.ts";

function terminalColumns(): number {
  try {
    return Math.min(Deno.consoleSize()?.columns ?? 80, 100);
  } catch {
    return 80;
  }
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
} {
  let sawDelta = false;
  const renderer = createStreamingMarkdownRenderer({
    out: (text) => io.out(text),
    color: config.color,
    columns: terminalColumns(),
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
  const line = formatRuntimeEvent(runtimeEvent);
  if (line !== null) io.err(line);
}

export function formatRuntimeEvent(
  event: Record<string, unknown>,
): string | null {
  if (event.type === "turnAborted") return "[interrupted]";
  if (event.type === "toolStepStarted") {
    const step = typeof event.step === "number" ? event.step : "?";
    const count = typeof event.toolCallCount === "number"
      ? event.toolCallCount
      : "?";
    return `tool: step ${step} running ${count} call(s)`;
  }
  if (event.type === "toolStepLimitReached") {
    const maxSteps = typeof event.maxSteps === "number" ? event.maxSteps : "?";
    return `tool: reached ${maxSteps}-step limit; concluding now`;
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
    const commandId = typeof event.commandId === "string"
      ? event.commandId
      : "tool";
    return `tool: ${commandId} started`;
  }
  if (event.type === "toolCallCompleted") {
    const commandId = typeof event.commandId === "string"
      ? event.commandId
      : "tool";
    const duration = typeof event.durationMs === "number"
      ? ` (${event.durationMs}ms)`
      : "";
    const reconciliation = event.isError === true &&
        /^mcp\.[A-Za-z0-9_-]+\.create_issue$/.test(commandId)
      ? "\nCreation not confirmed. If you approved this call, reconcile in Linear before retrying; the issue may already exist."
      : "";
    return `tool: ${commandId} ${
      event.isError === true ? "failed" : "finished"
    }${duration}${reconciliation}`;
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
  return null;
}
