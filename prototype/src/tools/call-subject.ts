/**
 * What a live tool frame may say about the call it frames: its subject (the
 * file, pattern or command it acted on) and the status line of its result.
 *
 * Without these an operator watching a long turn sees `read_file` ten times
 * and cannot tell which files were read, and sees a `bash` call succeed when
 * the command it ran exited 1: a non-zero exit, like a file tool's
 * `error: … not found` reply, is output the model reads, not a failed call.
 * The model can then report work it did not do, and the operator has no
 * evidence on screen to check it against.
 *
 * Both values are derived from what the durable `tool_call` event already
 * records for the same call, so a frame never shows what the log withholds:
 * the subject comes from the redacted arguments, and a result that is
 * redacted contributes only the runtime-written exit status line. This module
 * applies the redaction declarations; it does not decide them.
 */

import { sanitizeBoundaryText, scrubSensitiveShapes } from "../kernel/mod.ts";
import type { CommandDefinition } from "./definition.ts";
import { durableFailureReason, REDACTED, redactCommandArguments } from "./redaction.ts";

/** The longest subject a frame carries, in UTF-8 bytes. */
export const TOOL_SUBJECT_MAX_BYTES = 120;

/** The longest result status a frame carries, in UTF-8 bytes. */
export const TOOL_STATUS_MAX_BYTES = 160;

/**
 * The call's subject: the first non-empty string argument that the durable
 * log keeps, in the order the input schema declares its properties. None for
 * a command that redacts every argument, or a call with no such value.
 */
export function toolCallSubject(
  command: CommandDefinition | undefined,
  args: Record<string, unknown>,
): string | undefined {
  if (command === undefined || command.redactArguments === true) return undefined;
  const logged = redactCommandArguments(command, args);
  const declared = Object.keys(command.inputSchema.properties ?? {});
  for (const key of declared) {
    const value = logged[key];
    if (typeof value !== "string" || value === REDACTED) continue;
    const subject = sanitizeBoundaryText(
      scrubSensitiveShapes(value.slice(0, 4 * TOOL_SUBJECT_MAX_BYTES)),
      TOOL_SUBJECT_MAX_BYTES,
    ).trim();
    if (subject !== "") return subject;
  }
  return undefined;
}

// The status lines `executeBash` writes ahead of a command's output: they are
// the runtime's words, not the command's, so they carry nothing the redacted
// result could have held.
const EXIT_STATUS = /^(exit -?\d+|exit by signal [A-Z0-9]+|timed out after \d+ms \(killed[^)]*\))$/;

/**
 * The status of a call that completed without a tool error: the exit status
 * of a command, or the `error: …` line a tool replied with. None for any
 * other result.
 *
 * For a command whose result the log redacts, only an exit status line
 * qualifies. Otherwise an `error:` line is reduced the way the log reduces a
 * failure reason, so a reply that echoes a redacted argument is withheld.
 */
export function toolResultStatus(
  command: CommandDefinition | undefined,
  args: Record<string, unknown>,
  result: unknown,
): string | undefined {
  if (command === undefined || typeof result !== "string") return undefined;
  const head = result.split("\n", 1)[0].trim();
  if (EXIT_STATUS.test(head)) return head;
  if (command.redactResult === true || !head.startsWith("error:")) {
    return undefined;
  }
  return sanitizeBoundaryText(
    durableFailureReason(command, args, head),
    TOOL_STATUS_MAX_BYTES,
  );
}

/** The frame field for `toolCallSubject`, empty when there is none. */
export function subjectField(
  command: CommandDefinition | undefined,
  args: Record<string, unknown>,
): { subject?: string } {
  const subject = toolCallSubject(command, args);
  return subject === undefined ? {} : { subject };
}

/**
 * The frame field for `toolResultStatus`, empty for a call that failed as a
 * tool (its failure reason says why) or has no status.
 */
export function resultStatusField(
  command: CommandDefinition | undefined,
  args: Record<string, unknown>,
  outcome: { isError: boolean; result?: unknown },
): { resultStatus?: string } {
  if (outcome.isError) return {};
  const resultStatus = toolResultStatus(command, args, outcome.result);
  return resultStatus === undefined ? {} : { resultStatus };
}
