/**
 * The shared redactor: the one place a tool call is reduced to what may be
 * persisted in its durable `tool_call` event (`specs/01-architecture.md`
 * section 5.4). It applies only what the command's definition declares:
 *
 * - `redact: true` on an input-schema property replaces that argument;
 * - `redactArguments: true` replaces every schema-declared argument and drops
 *   undeclared keys;
 * - `redactResult: true` replaces a successful result.
 *
 * The model still receives the unredacted call and result within the turn.
 * What is redacted is policy, and policy changes are behavior changes: this
 * module applies the declarations, it does not decide them.
 */

import type {
  CommandCall,
  CommandDefinition,
  CommandInvocationResult,
} from "./definition.ts";

// Constant redaction sentinel — no length or content-derived hash, so a
// sensitive value's size and a guess-confirming fingerprint never reach the log.
export const REDACTED = "[redacted]";

/** A tool call as it may be persisted: its logged arguments and result text. */
export interface RedactedToolCall {
  arguments: Record<string, unknown>;
  result: string;
}

/**
 * Redact one invocation for its durable event. `command` is undefined for an
 * unknown command id, whose call is logged as received (it never ran, and its
 * result is the deny reason).
 */
export function redactToolCall(
  command: CommandDefinition | undefined,
  call: CommandCall,
  result: CommandInvocationResult,
): RedactedToolCall {
  return {
    arguments: redactCommandArguments(command, call.arguments),
    result: redactCommandResult(command, result),
  };
}

/**
 * Replace each argument marked `redact` in the command's input schema with a
 * constant sentinel — REGARDLESS of the runtime value's type — so payload-bearing
 * values (write_file content) never reach the durable event log or session replay
 * (CWE-532), including for malformed (non-string) values and denied
 * calls (which are still logged). Whole-call redaction retains only schema-declared
 * keys, because an undeclared caller-controlled key can itself carry sensitive
 * content. Returns the original object untouched when nothing is redacted, so
 * non-mutating tools are unaffected. Centralized here so tools that opt into
 * either redaction mode share one durable-event boundary.
 */
export function redactCommandArguments(
  command: CommandDefinition | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (command?.redactArguments === true) {
    const properties = command.inputSchema.properties ?? {};
    return Object.fromEntries(
      Object.keys(args)
        .filter((key) => Object.hasOwn(properties, key))
        .map((key) => [key, REDACTED]),
    );
  }
  const properties = command?.inputSchema.properties ?? {};
  let redactedAny = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (properties[key]?.redact) {
      out[key] = REDACTED;
      redactedAny = true;
    } else {
      out[key] = value;
    }
  }
  return redactedAny ? out : args;
}

/**
 * The persisted result text. An error reason is our own message (safe); a
 * success result may carry the command's raw output, which for `redactResult`
 * tools (bash) is replaced with the sentinel so secrets never reach the
 * durable log (CWE-532).
 */
export function redactCommandResult(
  command: CommandDefinition | undefined,
  result: CommandInvocationResult,
): string {
  return result.isError
    ? result.reason
    : command?.redactResult
    ? REDACTED
    : formatCommandResult(result.result);
}

function formatCommandResult(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
