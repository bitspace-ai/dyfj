/**
 * The REPL's slash-line routing: the unknown-command check, `/help`, the
 * `//word` escape, and the friction retry print-back. A line reaches this
 * after every command handler declined it.
 */

import type { Io } from "../io.ts";

/** The REPL's own commands, by word. `/exit` and `/quit` are handled first. */
const REPL_COMMAND_WORDS: ReadonlySet<string> = new Set([
  "exit",
  "quit",
  "help",
  "model",
  "fast",
  "steps",
  "budget",
  "receipt",
  "session",
  "friction",
  "idea",
  "packet",
]);

const SLASH_WORD = /^\/([A-Za-z0-9-]+)(?:\s|$)/;
const ESCAPED_SLASH_WORD = /^\/\/[A-Za-z0-9-]+(?:\s|$)/;

type SlashLine =
  | { kind: "text" }
  | { kind: "help" }
  | { kind: "unknown"; word: string }
  | { kind: "escaped"; text: string };

/**
 * What a line no command handler claimed is. Only a line that opens with one
 * `/word` token (letters, digits, hyphens, then a space or the end) can be an
 * unknown command: it is refused locally instead of becoming a paid turn.
 * `//word` is that escape, sent as the text `/word`. Any other slash line, a
 * path like `/usr/bin/env is what?`, is prompt text, and so is any multi-line
 * input: a paste is never a command, help request or escape.
 */
export function classifySlashLine(line: string): SlashLine {
  if (line.includes("\n")) return { kind: "text" };
  const escaped = ESCAPED_SLASH_WORD.test(line);
  if (escaped) return { kind: "escaped", text: line.slice(1) };
  const word = SLASH_WORD.exec(line)?.[1];
  if (word === undefined) return { kind: "text" };
  if (word === "help") return { kind: "help" };
  return REPL_COMMAND_WORDS.has(word) ? { kind: "text" } : {
    kind: "unknown",
    word,
  };
}

/**
 * The text the command handlers may claim: the trimmed line, or "" for a
 * multi-line paste, which no handler matches. A paste is prompt text: every
 * handler declines the empty candidate, so it falls through to the turn path
 * whatever its first line says.
 */
export function commandCandidate(line: string): string {
  return line.includes("\n") ? "" : line.trim();
}

function printReplHelp(io: Io): void {
  for (
    const line of [
      "commands (type them alone on a line):",
      "  /model [slug] [--approve-paid] [--fast|--no-fast]   show or switch the model",
      "  /fast [on|off]                                       toggle the fast speed tier",
      "  /steps [N]                                           show or set the tool-step limit",
      "  /budget [turn|session|day|per-call|runaway <usd>]    show or set the spend limits",
      "  /receipt steps                                       the last turn's usage, per provider call",
      "  /session | /session list | /session switch <id>     show, list or resume sessions",
      "  /friction <sev> [--escaped] <text...>                post a daily-driver friction",
      "  /idea mark <label...> | /idea list                   mark or list ideas",
      "  /packet draft|list|show ...                          work packets (/packet help)",
      "  /exit, /quit, Ctrl-D                                 leave",
      "  //word                                               send /word as text",
    ]
  ) io.err(line);
}

/**
 * Route a line no command handler claimed. Returns the text to send as a turn,
 * with a `//word` escape unwrapped, or `undefined` when the line was answered
 * locally (help or an unknown-command refusal) and sends no turn.
 */
export function routeSlashLine(line: string, io: Io): string | undefined {
  const slash = classifySlashLine(line);
  if (slash.kind === "help") {
    printReplHelp(io);
    return undefined;
  }
  if (slash.kind === "unknown") {
    io.err(`unknown command /${slash.word}; /help lists commands`);
    return undefined;
  }
  return slash.kind === "escaped" ? slash.text : line;
}

/** The text was typed once; print it back so one paste retries it. */
export function printFrictionRetry(
  io: Io,
  severity: string,
  escaped: boolean,
  text: string,
): void {
  io.err(`retry with: /friction ${severity}${escaped ? " --escaped" : ""} ${text}`);
}
