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
 * A later turn rebuilds its history from these events, so the engine keeps
 * the model's copy of a redacted result in memory (`engine/tool-history.ts`)
 * and replays that, or a line saying the output is not available, in place
 * of the sentinel (BIT-812).
 * What is redacted is policy, and policy changes are behavior changes: this
 * module applies the declarations, it does not decide them.
 */

import { scrubSensitiveShapes } from "../kernel/mod.ts";
import type {
  CommandCall,
  CommandDefinition,
  CommandInvocationResult,
} from "./definition.ts";
import {
  ECHO_WINDOW_CHARS,
  findArgumentEchoes,
  operatorFailureReason,
} from "./failure-reason.ts";

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
    result: redactCommandResult(command, result, call.arguments),
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
 * The persisted result text. A success result may carry the command's raw
 * output, which for `redactResult` tools (bash) is replaced with the sentinel
 * so secrets never reach the durable log (CWE-532). An error reason is ours,
 * but it can quote what an upstream server said, and a server can echo the
 * arguments back: the executor's recorded reason, which never quotes upstream
 * text, is persisted when there is one; otherwise, for a command that redacts any
 * argument, the reason's first `ECHO_WINDOW_CHARS` characters are checked
 * for echoes of those values and kept, or withheld naming the arguments when
 * they echo one. Credential-shaped text is scrubbed either way.
 */
export function redactCommandResult(
  command: CommandDefinition | undefined,
  result: CommandInvocationResult,
  args: Record<string, unknown> = {},
): string {
  if (result.isError) {
    if ("recordedReason" in result && result.recordedReason !== undefined) {
      return result.recordedReason;
    }
    return durableFailureReason(command, args, result.reason);
  }
  return command?.redactResult
    ? REDACTED
    : formatCommandResult(result.result);
}

/**
 * The one durable form of a failure reason, which every durable sink records.
 * For a command that redacts any argument, the reason's checked window, or
 * the withheld line when that window echoes a redacted value; otherwise the
 * reason in full. Credential-shaped text is scrubbed either way.
 */
export function durableFailureReason(
  command: CommandDefinition | undefined,
  args: Record<string, unknown>,
  reason: string,
): string {
  const redacted = redactedArgumentValues(command, args);
  if (Object.keys(redacted).length === 0) {
    return scrubSensitiveShapes(reason);
  }
  // The checked window, not the 160-byte operator line: an audit copy
  // keeps what the check covered (an approval refusal stays whole).
  const echoes = findArgumentEchoes(reason, redacted);
  if (echoes === undefined || echoes.length > 0) {
    return operatorFailureReason(reason, redacted, {
      declared: Object.keys(command?.inputSchema.properties ?? {}),
    });
  }
  // When the text runs past the window, stop short of its edge: a value
  // starting in the last two characters would be under the tail rule's
  // three, so it is never stored.
  return scrubSensitiveShapes(
    reason.length > ECHO_WINDOW_CHARS
      ? reason.slice(0, ECHO_WINDOW_CHARS - 2)
      : reason,
  );
}

/**
 * Whether a command id belongs to a command that declares
 * `redactArguments` (BIT-818), decided from the id alone.
 *
 * A later turn rebuilds the model's history before that turn's registry
 * exists, so it cannot ask the command whether its arguments were redacted.
 * The persisted value cannot decide it either: `[redacted]` is also a literal
 * an ordinary command can legitimately receive. So the resume path keys on
 * this rule instead, which covers every command that currently declares
 * whole-call redaction: `web_search` and `web_fetch` from the web capability,
 * and every external MCP tool — the Linear extension's bounded create-issue
 * command included — which is registered as `mcp.<server>.<tool>`.
 *
 * It must stay equal to `redactArguments: true` across the catalog;
 * `redaction.test.ts` builds the real catalog and checks both directions, so a
 * new redacting command that this rule misses fails a test rather than
 * replaying the sentinel to the model.
 */
export function redactsArgumentsById(commandId: string): boolean {
  return commandId === "web_search" || commandId === "web_fetch" ||
    commandId.startsWith("mcp.");
}

/** The arguments whose values the event redacts, by name. */
function redactedArgumentValues(
  command: CommandDefinition | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (command?.redactArguments === true) return args;
  const properties = command?.inputSchema.properties ?? {};
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => properties[key]?.redact === true),
  );
}

function formatCommandResult(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
