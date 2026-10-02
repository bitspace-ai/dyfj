/**
 * Invoke a command: look it up, take the policy verdict, ask the approver when
 * the verdict is `ask`, run the executor, and (with `invokeCommandWithEvent`)
 * write exactly one `tool_call` event for the call, through the shared
 * redactor.
 */

import { generateSpanId, generateULID, utf8SafePrefix } from "../kernel/mod.ts";
import { type EventInsert, toolCallEvent } from "../store/mod.ts";
import {
  type CommandCall,
  type CommandDefinition,
  type CommandExecutionContext,
  CommandExecutionError,
  type CommandInvocationResult,
  type ConfirmToolApproval,
} from "./definition.ts";
import { type CommandPolicyContext, evaluateCommandPolicy } from "./policy.ts";
import { redactToolCall } from "./redaction.ts";
import type { CommandRegistry } from "./registry.ts";

export interface CommandEventContext {
  sessionId: string;
  traceId: string;
  eventId?: string;
  spanId?: string;
  parentSpanId?: string;
  durationMs?: number;
  /** Persists the tool_call event (the caller commits it to the journal). */
  writeEvent: (event: EventInsert) => Promise<void> | void;
}

const denyToolApproval: ConfirmToolApproval = () =>
  Promise.resolve({
    decision: "deny",
    reason: "tool approval is unavailable on this transport",
  });

export async function invokeCommand<TResult = unknown>(
  registry: CommandRegistry,
  call: CommandCall,
  confirmApproval: ConfirmToolApproval = denyToolApproval,
  policyContext: CommandPolicyContext = {},
  executionContext: Omit<CommandExecutionContext, "authzBasis"> = {},
): Promise<CommandInvocationResult<TResult>> {
  const command = registry.lookup(call.commandId) as
    | CommandDefinition<TResult>
    | undefined;
  if (!command) {
    return {
      decision: "deny",
      authzBasis: "policy:deny:unknown-command",
      isError: true,
      reason: `unknown command: ${call.commandId}`,
    };
  }

  const policy = evaluateCommandPolicy(command, call, policyContext);
  if (policy.decision === "deny") {
    return {
      decision: "deny",
      authzBasis: policy.authzBasis,
      reason: policy.reason ?? "command denied",
      isError: true,
    };
  }

  let authzBasis = policy.authzBasis;
  if (policy.decision === "ask") {
    // A mutation does not run until the operator approves it. The
    // verdict comes from the injected transport approver; the default denies, so
    // an unapproved or channel-less call never executes.
    const verdict = await confirmApproval({
      commandId: call.commandId,
      callId: call.callId,
      title: command.title,
      arguments: call.arguments,
    });
    if (verdict.decision !== "approve") {
      return {
        decision: "deny",
        authzBasis: "policy:deny:approval-denied",
        reason: verdict.reason ?? "operator denied the tool call",
        isError: true,
      };
    }
    authzBasis = "policy:allow:operator-approved";
  }

  let result: TResult;
  try {
    result = await command.executor(call, {
      authzBasis,
      ...executionContext,
    });
  } catch (error) {
    if (error instanceof CommandExecutionError) {
      return {
        decision: "allow",
        authzBasis,
        isError: true,
        reason: error.publicReason,
      };
    }
    throw error;
  }
  return {
    decision: "allow",
    authzBasis,
    isError: false,
    result,
  };
}

// events.tool_result is a Dolt/MySQL TEXT column: 65,535 BYTES, not
// characters. A tool result can run right up to the model-facing cap
// (builtin/file-access.ts's DEFAULT_MAX_BYTES, itself measured in characters), which
// overflows the column once multibyte UTF-8 characters are counted in bytes —
// before even accounting for the fact that char-count and byte-count aren't
// the same limit. The event row is a durable audit copy, not the model's
// working context, so it can be capped independently: keep a safe margin
// under the column limit here, and let the model-facing tool result (what
// actually goes back on the transcript) keep its own, separate limit.
export const EVENT_RESULT_MAX_BYTES = 60_000;

/**
 * Cap `text` to `maxBytes` UTF-8 bytes for a TEXT event column, appending a
 * marker with the untruncated size so the audit trail records that clipping
 * happened — and by how much — rather than silently losing the tail. The
 * excerpt is budgeted to leave room for the marker itself, so the total
 * output never exceeds `maxBytes`.
 */
export function truncateForEventColumn(
  text: string,
  maxBytes: number = EVENT_RESULT_MAX_BYTES,
): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  const marker =
    `\n\n[event-truncated: full result was ${encoded.byteLength} bytes]`;
  const markerEncoded = new TextEncoder().encode(marker);
  // A limit smaller than the marker itself degrades to a byte-safe slice of
  // the marker — the <= maxBytes guarantee holds for every input, not just
  // the production column budget.
  if (markerEncoded.byteLength >= maxBytes) {
    return new TextDecoder("utf-8")
      .decode(utf8SafePrefix(markerEncoded, maxBytes));
  }
  const excerptBudget = maxBytes - markerEncoded.byteLength;
  const excerpt = new TextDecoder("utf-8")
    .decode(utf8SafePrefix(encoded, excerptBudget));
  return `${excerpt}${marker}`;
}

/**
 * The `tool_call` event for one invocation. Arguments and result pass through
 * the shared redactor, under `command`'s declarations; `command` is undefined
 * for an unknown command id.
 */
export function buildCommandToolCallEventPayload(
  call: CommandCall,
  result: CommandInvocationResult,
  context: Omit<CommandEventContext, "writeEvent">,
  command?: CommandDefinition,
): EventInsert {
  const isError = result.isError;
  const redacted = redactToolCall(command, call, result);
  const spanKind = command?.spanKind;
  const event = toolCallEvent({
    event_id: context.eventId ?? generateULID(),
    session_id: context.sessionId,
    trace_id: context.traceId,
    span_id: context.spanId ?? generateSpanId(),
    parent_span_id: context.parentSpanId ?? null,
    ...(spanKind === undefined ? {} : {
      trace_flags: 0,
      span_kind: spanKind,
      parent_is_remote: false,
    }),
    principal_id: call.caller.principalId,
    principal_type: call.caller.principalType,
    action: result.decision === "allow" ? "invoke" : "deny",
    resource: `command:${call.commandId}`,
    authz_basis: result.authzBasis,
    tool_name: call.commandId,
    tool_call_id: call.callId,
    tool_arguments: JSON.stringify(redacted.arguments),
    tool_result: truncateForEventColumn(redacted.result),
    tool_is_error: isError,
    content: isError
      ? result.decision === "allow"
        ? `${call.commandId} failed: ${result.reason}`
        : `${call.commandId} denied: ${result.reason}`
      : `${call.commandId} allowed`,
    duration_ms: context.durationMs ?? null,
  });
  if (command?.eventContent !== undefined) {
    event.content = command.eventContent(isError, result);
  }
  return event;
}

export async function invokeCommandWithEvent<TResult = unknown>(
  registry: CommandRegistry,
  call: CommandCall,
  context: CommandEventContext,
  confirmApproval: ConfirmToolApproval = denyToolApproval,
  policyContext: CommandPolicyContext = {},
): Promise<CommandInvocationResult<TResult>> {
  const spanId = context.spanId ?? generateSpanId();
  const result = await invokeCommand<TResult>(
    registry,
    call,
    confirmApproval,
    policyContext,
    { traceId: context.traceId, spanId, traceFlags: 0 },
  );
  // Payload-bearing arguments (e.g. write_file content) and redactResult
  // results are redacted before the event is persisted, so the durable log and
  // session replay never retain the raw value (CWE-532).
  const event = buildCommandToolCallEventPayload(
    call,
    result,
    { ...context, spanId },
    registry.lookup(call.commandId),
  );
  await context.writeEvent(event);
  return result;
}
