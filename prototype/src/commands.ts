import { executeReadMemory } from "./memory";
import type { PermissionLevel } from "./config";
import {
  executeEditFile,
  executeListFiles,
  executeReadFile,
  executeWriteFile,
} from "./file-tools";
import { executeBash } from "./exec-tools";
import {
  generateSpanId,
  generateULID,
  writeEvent as writeDoltEvent,
} from "./utils";

export type PrincipalType = "human" | "agent" | "service";
export type PolicyDecision = "allow" | "ask" | "deny";
export type CommandEffect =
  | "read.memory"
  | "read.filesystem"
  | "write.filesystem"
  | "run.checks"
  | "run.process"
  | "call.model.local"
  | "call.model.paid"
  | "emit.event";

// Exec-class effects spawn external processes. Operator auto-approval NEVER
// covers them: command execution always requires an explicit per-call approval,
// regardless of the filesystem/cost/network envelope (the no-exec invariant).
// Metadata alone must not be trusted to gate exec — this effect check is the gate.
const EXEC_EFFECTS: ReadonlySet<CommandEffect> = new Set([
  "run.checks",
  "run.process",
]);

// Type aliases (not interfaces) so these stay assignable to
// Record<string, unknown> tool-parameter contracts: TypeScript gives
// aliases an implicit index signature that interfaces do not get.
export type JsonSchemaObject = {
  type: "object";
  required?: string[];
  properties?: Record<string, JsonSchemaProperty>;
  additionalProperties?: boolean;
};

export type JsonSchemaProperty = {
  type: "string" | "number" | "boolean" | "object" | "array";
  pattern?: string;
  description?: string;
  /**
   * Mark a payload-bearing argument (e.g. write_file `content`) sensitive: it is
   * replaced with a constant redaction sentinel before the tool-call event is
   * persisted — regardless of the runtime value's type — so the durable log and
   * session replay never retain the raw value (CWE-532).
   */
  redact?: boolean;
};

export interface PermissionEnvelope {
  effects: CommandEffect[];
  defaultDecision: PolicyDecision;
  resources: string[];
  // "recall": read-only egress to an operator-configured, fixed external memory
  // endpoint (the model picks the query, not the destination). Auto-allowed
  // without a per-call prompt — distinct from arbitrary "external" egress.
  network?: "none" | "local" | "external" | "recall";
  filesystem?: "none" | "read" | "write";
  cost?: "none" | "local" | "paid";
}

export interface CommandCall {
  commandId: string;
  callId: string;
  caller: {
    principalId: string;
    principalType: PrincipalType;
  };
  arguments: Record<string, unknown>;
}

export interface CommandExecutionContext {
  authzBasis: string;
}

export interface CommandDefinition<TResult = unknown> {
  id: string;
  title: string;
  description: string;
  inputSchema: JsonSchemaObject;
  permission: PermissionEnvelope;
  /**
   * Redact this command's RESULT from the durable tool_call event (the model
   * still receives it in-turn). Set for tools whose output can carry secrets the
   * approver cannot pre-screen — e.g. bash printing env or file contents that
   * would otherwise persist into session/event history (CWE-532).
   */
  redactResult?: boolean;
  executor: (
    call: CommandCall,
    context: CommandExecutionContext,
  ) => Promise<TResult> | TResult;
}

export interface ToolProjection {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

export interface CommandRegistry {
  register(command: CommandDefinition): void;
  lookup(commandId: string): CommandDefinition | undefined;
  list(): CommandDefinition[];
  projectTools(): ToolProjection[];
}

export type CommandPolicyResult =
  | { decision: "allow"; authzBasis: string; reason?: undefined }
  | { decision: "ask"; authzBasis: string; reason?: string }
  | { decision: "deny"; authzBasis: string; reason: string };

export type CommandInvocationResult<TResult = unknown> =
  | {
    decision: "allow";
    authzBasis: string;
    isError: false;
    result: TResult;
  }
  | {
    decision: "ask" | "deny";
    authzBasis: string;
    isError: true;
    reason: string;
  };

/** A mutating tool call awaiting operator approval. Serializable for the wire. */
export interface ToolApprovalRequest {
  commandId: string;
  callId: string;
  title: string;
  arguments: Record<string, unknown>;
}

export interface ToolApprovalVerdict {
  decision: "approve" | "deny";
  reason?: string;
}

/**
 * Resolve an `ask` policy: the runtime injects a transport-specific approver
 * (UDS asks the operator over the duplex channel; HTTP has no such channel). The
 * default denies — fail-closed, like denyPaidEscalation — so a missing approver
 * never executes a mutation.
 */
export type ConfirmToolApproval = (
  request: ToolApprovalRequest,
) => Promise<ToolApprovalVerdict>;

const denyToolApproval: ConfirmToolApproval = () =>
  Promise.resolve({
    decision: "deny",
    reason: "tool approval is unavailable on this transport",
  });

export interface CoreCommandDependencies {
  readMemory?: (slug: string) => Promise<string> | string;
  allowedMemorySlugs?: readonly string[];
  /** When set, register the workspace file tools rooted here. */
  workspaceRoot?: string;
  /**
   * When set, register the `search_memory` recall tool backed by this function.
   * Gated at registration: callers pass it only for loopback/operator turns with
   * an external memory endpoint configured, so the tool is absent otherwise.
   */
  searchMemory?: (query: string) => Promise<string> | string;
}

export interface CommandEventContext {
  sessionId: string;
  traceId: string;
  eventId?: string;
  spanId?: string;
  durationMs?: number;
  writeEvent?: (event: Record<string, unknown>) => Promise<void> | void;
}

export function createCommandRegistry(
  commands: CommandDefinition[] = [],
): CommandRegistry {
  const byId = new Map<string, CommandDefinition>();

  const registry: CommandRegistry = {
    register(command) {
      if (byId.has(command.id)) {
        throw new Error(`Command already registered: ${command.id}`);
      }
      byId.set(command.id, command);
    },

    lookup(commandId) {
      return byId.get(commandId);
    },

    list() {
      return [...byId.values()];
    },

    projectTools() {
      return [...byId.values()].map((command) => ({
        name: command.id,
        description: command.description,
        parameters: command.inputSchema,
      }));
    },
  };

  for (const command of commands) {
    registry.register(command);
  }
  return registry;
}

/**
 * Policy context for the operator permission profile. Defaults are safe: an
 * absent context behaves as `strict` on a non-loopback turn, so nothing
 * auto-approves unless deliberately enabled.
 */
export interface CommandPolicyContext {
  /** Operator posture from config: "strict" (per-call approval) | "operator". */
  permissionLevel?: PermissionLevel;
  /** Whether this turn is on the canonical loopback transport. */
  loopback?: boolean;
}

export function evaluateCommandPolicy(
  command: CommandDefinition,
  call: CommandCall,
  context: CommandPolicyContext = {},
): CommandPolicyResult {
  const validationError = validateCommandArguments(
    command.inputSchema,
    call.arguments,
  );
  if (validationError) {
    return {
      decision: "deny",
      authzBasis: "policy:deny:invalid-arguments",
      reason: formatInvalidArgumentsReason(
        command.id,
        command.inputSchema,
        call.arguments,
        validationError,
      ),
    };
  }

  if (
    command.permission.network === "recall" &&
    command.permission.defaultDecision === "allow" &&
    command.permission.filesystem === "none" &&
    command.permission.cost === "none"
  ) {
    // Read-only recall to an operator-configured, fixed external memory endpoint.
    // The model chooses the query, never the destination, and the tool is
    // registered only for loopback/operator turns with the endpoint configured —
    // so this egress is auto-allowed without a per-call prompt, with its own
    // audit basis distinct from arbitrary external network.
    return {
      decision: "allow",
      authzBasis: "policy:allow:operator-configured-recall",
    };
  }

  if (
    command.permission.defaultDecision === "allow" &&
    (command.permission.filesystem === "none" ||
      command.permission.filesystem === "read") &&
    command.permission.cost === "none" &&
    command.permission.network !== "external" &&
    command.permission.network !== "recall"
  ) {
    // Read-only local access (memory reads, workspace file reads) needs no
    // approval. Write filesystem, paid cost, and external network still fall
    // through to "ask"/"deny" until the Slice B safety model gates them.
    return {
      decision: "allow",
      authzBasis: "policy:allow:read-only-local",
    };
  }

  if (command.permission.defaultDecision === "deny") {
    return {
      decision: "deny",
      authzBasis: "policy:deny:default",
      reason: "command default decision is deny",
    };
  }

  // Operator permission profile (config permissionLevel="operator", on a
  // loopback/operator turn): a CONTAINED mutating tool — local, free,
  // workspace-write, NON-exec — is auto-approved without a per-call prompt, with
  // its own audit basis. Command-execution, paid, or networked tools are
  // deliberately NOT covered and still fall through to "ask" even under the
  // operator profile. The no-exec invariant (`!executesProcesses`) is the
  // explicit gate: a tool carrying a run.* effect can never auto-approve here,
  // even if its filesystem/cost/network envelope would otherwise match — so bash
  // always asks regardless of how its metadata is tagged.
  if (
    context.permissionLevel === "operator" &&
    context.loopback === true &&
    command.permission.defaultDecision === "allow" &&
    command.permission.filesystem === "write" &&
    command.permission.cost === "none" &&
    (command.permission.network === "none" ||
      command.permission.network === undefined) &&
    !command.permission.effects.some((effect) => EXEC_EFFECTS.has(effect))
  ) {
    return {
      decision: "allow",
      authzBasis: "policy:allow:operator-profile",
    };
  }

  return {
    decision: "ask",
    authzBasis: "policy:ask:default",
    reason: "command requires operator approval",
  };
}

export async function invokeCommand<TResult = unknown>(
  registry: CommandRegistry,
  call: CommandCall,
  confirmApproval: ConfirmToolApproval = denyToolApproval,
  policyContext: CommandPolicyContext = {},
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

  const result = await command.executor(call, { authzBasis });
  return {
    decision: "allow",
    authzBasis,
    isError: false,
    result,
  };
}

export function buildMemoryReadCommand(
  deps: CoreCommandDependencies = {},
): CommandDefinition<string> {
  const readMemory = deps.readMemory ?? executeReadMemory;
  const slugPattern = buildMemorySlugPattern(deps.allowedMemorySlugs);
  return {
    id: "memory.read",
    title: "Read Memory",
    description: "Load one Dolt-backed memory by slug.",
    inputSchema: {
      type: "object",
      required: ["slug"],
      properties: {
        slug: {
          type: "string",
          pattern: slugPattern,
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["read.memory", "emit.event"],
      defaultDecision: "allow",
      resources: ["memory:*"],
      network: "local",
      filesystem: "none",
      cost: "none",
    },
    executor: async (call) => readMemory(String(call.arguments.slug)),
  };
}

export function buildMemorySearchCommand(
  search: (query: string) => Promise<string> | string,
): CommandDefinition<string> {
  return {
    id: "memory.search",
    title: "Search Memory",
    description:
      "Search long-term external memory by meaning and return relevant " +
      "entries. Use when the operator refers to past context — decisions, " +
      "people, ideas, or events — that may have been captured before.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "What to recall, in natural language.",
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["read.memory", "emit.event"],
      defaultDecision: "allow",
      resources: ["memory:external"],
      network: "recall",
      filesystem: "none",
      cost: "none",
    },
    executor: async (call) => search(String(call.arguments.query)),
  };
}

function buildMemorySlugPattern(allowedSlugs?: readonly string[]): string {
  if (allowedSlugs === undefined) return "^[a-z0-9][a-z0-9_-]*$";
  if (allowedSlugs.length === 0) return "a^";
  return `^(${allowedSlugs.map(escapeRegex).join("|")})$`;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

export function buildReadFileCommand(root: string): CommandDefinition<string> {
  return {
    id: "read_file",
    title: "Read File",
    description:
      "Read a UTF-8 text file from the workspace, by path relative to the " +
      "workspace root. Read-only.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root.",
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["read.filesystem", "emit.event"],
      defaultDecision: "allow",
      resources: ["file:read"],
      network: "none",
      filesystem: "read",
      cost: "none",
    },
    executor: (call) => executeReadFile(root, String(call.arguments.path)),
  };
}

export function buildListFilesCommand(root: string): CommandDefinition<string> {
  return {
    id: "list_files",
    title: "List Files",
    description:
      "List the entries of a workspace directory, by path relative to the " +
      "workspace root (omit for the root). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory path relative to the workspace root; defaults to the root.",
        },
      },
      additionalProperties: false,
    },
    permission: {
      effects: ["read.filesystem", "emit.event"],
      defaultDecision: "allow",
      resources: ["file:read"],
      network: "none",
      filesystem: "read",
      cost: "none",
    },
    executor: (call) =>
      executeListFiles(
        root,
        call.arguments.path === undefined ? "." : String(call.arguments.path),
      ),
  };
}

export function buildWriteFileCommand(root: string): CommandDefinition<string> {
  return {
    id: "write_file",
    title: "Write File",
    description:
      "Write UTF-8 text to a file in the workspace, by path relative to the " +
      "workspace root, creating or overwriting it. Mutating — requires " +
      "operator approval before it runs.",
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root.",
        },
        content: {
          type: "string",
          description: "Full UTF-8 text to write to the file.",
          // Redacted from the persisted tool-call event + session replay; the
          // raw body is written to the file, never retained in the audit log.
          redact: true,
        },
      },
      additionalProperties: false,
    },
    permission: {
      // defaultDecision "allow" + filesystem "write" routes through "ask" in
      // evaluateCommandPolicy (the write-fs branch) — i.e. operator approval.
      effects: ["write.filesystem", "emit.event"],
      defaultDecision: "allow",
      resources: ["file:write"],
      network: "none",
      filesystem: "write",
      cost: "none",
    },
    executor: (call) =>
      executeWriteFile(
        root,
        String(call.arguments.path),
        String(call.arguments.content),
      ),
  };
}

export function buildEditFileCommand(root: string): CommandDefinition<string> {
  return {
    id: "edit_file",
    title: "Edit File",
    description:
      "Replace an exact text fragment in an existing file in the workspace, by " +
      "path relative to the workspace root. The old text must occur exactly " +
      "once. Mutating — requires operator approval before it runs.",
    inputSchema: {
      type: "object",
      required: ["path", "old_string", "new_string"],
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root.",
        },
        old_string: {
          type: "string",
          description:
            "Exact text to replace; must occur exactly once in the file.",
          // Payload-bearing file content — redacted from the persisted event.
          redact: true,
        },
        new_string: {
          type: "string",
          description: "Replacement text.",
          redact: true,
        },
      },
      additionalProperties: false,
    },
    permission: {
      // Same contained-write envelope as write_file: routes through "ask" under
      // strict, auto-approves under the operator profile on a loopback turn.
      effects: ["write.filesystem", "emit.event"],
      defaultDecision: "allow",
      resources: ["file:write"],
      network: "none",
      filesystem: "write",
      cost: "none",
    },
    executor: (call) =>
      executeEditFile(
        root,
        String(call.arguments.path),
        String(call.arguments.old_string),
        String(call.arguments.new_string),
      ),
  };
}

export function buildBashCommand(root: string): CommandDefinition<string> {
  return {
    id: "bash",
    title: "Run Bash Command",
    description:
      "Run a shell command via `bash -c`. The working directory is the workspace " +
      "root, but the command is NOT sandboxed — it can read and write anywhere on " +
      "the machine and reach the network, exactly as if the operator ran it. " +
      "Returns the exit status and combined stdout/stderr. Always requires " +
      "explicit operator approval before it runs — it is never auto-approved.",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: {
          type: "string",
          description: "The shell command to run (executed as `bash -c`).",
        },
      },
      additionalProperties: false,
    },
    permission: {
      // run.process is an exec-class effect: the no-exec invariant in
      // evaluateCommandPolicy keeps it out of operator auto-approval, so bash
      // ALWAYS routes to "ask". The honest filesystem/network envelope (a shell
      // command can read, write, and reach the network) is recorded for audit,
      // but the run.process effect is what actually gates it.
      effects: [
        "run.process",
        "read.filesystem",
        "write.filesystem",
        "emit.event",
      ],
      defaultDecision: "allow",
      resources: ["process:run"],
      network: "external",
      filesystem: "write",
      cost: "none",
    },
    // bash output can carry secrets the approver can't pre-screen (env dumps,
    // file contents), so keep the raw result out of the durable event log.
    redactResult: true,
    executor: (call) => executeBash(root, String(call.arguments.command)),
  };
}

export function registerCoreCommands(
  registry: CommandRegistry,
  deps: CoreCommandDependencies = {},
): void {
  registry.register(buildMemoryReadCommand(deps));
  if (deps.searchMemory !== undefined) {
    registry.register(buildMemorySearchCommand(deps.searchMemory));
  }
  if (deps.workspaceRoot !== undefined) {
    registry.register(buildReadFileCommand(deps.workspaceRoot));
    registry.register(buildListFilesCommand(deps.workspaceRoot));
    registry.register(buildWriteFileCommand(deps.workspaceRoot));
    registry.register(buildEditFileCommand(deps.workspaceRoot));
    registry.register(buildBashCommand(deps.workspaceRoot));
  }
}

// Constant redaction sentinel — no length or content-derived hash, so a
// sensitive value's size and a guess-confirming fingerprint never reach the log.
const REDACTED = "[redacted]";

/**
 * Replace each argument marked `redact` in the command's input schema with a
 * constant sentinel — REGARDLESS of the runtime value's type — so payload-bearing
 * values (write_file content) never reach the durable event log or session replay
 * (CWE-532), including for malformed (non-string) values and denied
 * calls (which are still logged). Returns the original object untouched when
 * nothing is redacted, so non-mutating tools are unaffected. Centralized here so
 * every future mutating tool inherits it.
 */
export function redactCommandArguments(
  command: CommandDefinition | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
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

// events.tool_result is a Dolt/MySQL TEXT column: 65,535 BYTES, not
// characters. A tool result can run right up to the model-facing cap
// (file-tools.ts's DEFAULT_MAX_BYTES, itself measured in characters), which
// overflows the column once multibyte UTF-8 characters are counted in bytes —
// before even accounting for the fact that char-count and byte-count aren't
// the same limit. The event row is a durable audit copy, not the model's
// working context, so it can be capped independently: keep a safe margin
// under the column limit here, and let the model-facing tool result (what
// actually goes back on the transcript) keep its own, separate limit.
export const EVENT_RESULT_MAX_BYTES = 60_000;

/**
 * The largest prefix of `bytes` that is at most `maxBytes` long AND does not
 * split a multi-byte UTF-8 character. A UTF-8 continuation byte has the top
 * two bits `10`; walking `end` back while `bytes[end]` is a continuation byte
 * lands the cut on the start of a character (or the end of the array), so the
 * result decodes cleanly with zero replacement characters — unlike a naive
 * `slice` + permissive decode, which can silently swap a clipped tail for a
 * differently-sized replacement character and land past `maxBytes`.
 */
function utf8SafeByteSlice(bytes: Uint8Array, maxBytes: number): Uint8Array {
  let end = Math.min(maxBytes, bytes.byteLength);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.slice(0, end);
}

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
      .decode(utf8SafeByteSlice(markerEncoded, maxBytes));
  }
  const excerptBudget = maxBytes - markerEncoded.byteLength;
  const excerpt = new TextDecoder("utf-8")
    .decode(utf8SafeByteSlice(encoded, excerptBudget));
  return `${excerpt}${marker}`;
}

export function buildCommandToolCallEventPayload(
  call: CommandCall,
  result: CommandInvocationResult,
  context: CommandEventContext,
  loggedArguments: Record<string, unknown> = call.arguments,
  redactResult = false,
): Record<string, unknown> {
  const isError = result.isError;
  // An error reason is our own message (safe); a success result may carry the
  // command's raw output, which for redactResult tools (bash) is replaced with
  // the sentinel so secrets never reach the durable log (CWE-532).
  const resultText = isError
    ? result.reason
    : redactResult
    ? REDACTED
    : formatCommandResult(result.result);
  return {
    event_id: context.eventId ?? generateULID(),
    session_id: context.sessionId,
    event_type: "tool_call",
    trace_id: context.traceId,
    span_id: context.spanId ?? generateSpanId(),
    principal_id: call.caller.principalId,
    principal_type: call.caller.principalType,
    action: isError ? "deny" : "invoke",
    resource: `command:${call.commandId}`,
    authz_basis: result.authzBasis,
    tool_name: call.commandId,
    tool_call_id: call.callId,
    tool_arguments: JSON.stringify(loggedArguments),
    tool_result: truncateForEventColumn(resultText),
    tool_is_error: isError,
    content: isError
      ? `${call.commandId} denied: ${result.reason}`
      : `${call.commandId} allowed`,
    duration_ms: context.durationMs ?? null,
  };
}

export async function invokeCommandWithEvent<TResult = unknown>(
  registry: CommandRegistry,
  call: CommandCall,
  context: CommandEventContext,
  confirmApproval: ConfirmToolApproval = denyToolApproval,
  policyContext: CommandPolicyContext = {},
): Promise<CommandInvocationResult<TResult>> {
  const result = await invokeCommand<TResult>(
    registry,
    call,
    confirmApproval,
    policyContext,
  );
  // Redact payload-bearing arguments (e.g. write_file content) before the event
  // is persisted, so the durable log and session replay never retain the raw
  // value (CWE-532).
  const command = registry.lookup(call.commandId);
  const loggedArguments = redactCommandArguments(command, call.arguments);
  const event = buildCommandToolCallEventPayload(
    call,
    result,
    context,
    loggedArguments,
    command?.redactResult ?? false,
  );
  await (context.writeEvent ?? writeDoltEvent)(event);
  return result;
}

/**
 * Render the argument shape a command expects, from its input schema: a
 * one-line JSON-ish shape (`{"path": string (required)}`) followed by one
 * description line per documented property. Deterministic and value-free, so
 * it is safe for both model context and the durable event log.
 */
function describeExpectedArguments(schema: JsonSchemaObject): string {
  const properties = Object.entries(schema.properties ?? {});
  if (properties.length === 0) return "{} (no arguments)";
  const required = new Set(schema.required ?? []);
  const shape = properties
    .map(([name, property]) =>
      `"${name}": ${property.type} (${
        required.has(name) ? "required" : "optional"
      })`
    )
    .join(", ");
  const descriptions = properties
    .filter(([, property]) => property.description)
    .map(([name, property]) => `  ${name} — ${property.description}`);
  return [`{${shape}}`, ...descriptions].join("\n");
}

/**
 * The model-visible reason for an invalid-arguments denial. The bare
 * validation verdict ("missing required argument: path") gives the model
 * nothing to correct with — observed in the field as a verbatim retry of the
 * same malformed call, which the loop's repeat guard then turns into a forced
 * conclusion. Wrap the verdict with the tool name, the expected argument
 * shape, a summary of what was received, and an explicit corrected-retry
 * instruction.
 *
 * The received summary names only keys DECLARED in the tool's schema and
 * reports any others as a bare count. Both argument values AND unrecognized
 * property names are untrusted model output that can carry a path, token, or
 * personal text, and this string is persisted to the durable event log and
 * replayed to the provider — so nothing model-controlled is echoed verbatim
 * (CWE-532); only the tool's own schema vocabulary appears.
 */
export function formatInvalidArgumentsReason(
  commandId: string,
  schema: JsonSchemaObject,
  args: Record<string, unknown>,
  validationError: string,
): string {
  const declared = schema.properties ?? {};
  const received = Object.keys(args);
  // Own-property test, not `in`: `in` walks the prototype chain, so a
  // model-sent key like `constructor` or `__proto__` would otherwise count as
  // a declared property and be echoed verbatim.
  const recognized = received.filter((key) => Object.hasOwn(declared, key));
  const unrecognized = received.length - recognized.length;
  let receivedText: string;
  if (received.length === 0) {
    receivedText = "(none)";
  } else {
    const parts = recognized.map((key) => `"${key}"`);
    if (unrecognized > 0) {
      parts.push(`${unrecognized} not declared in the schema`);
    }
    receivedText = parts.join(", ");
  }
  return [
    `invalid arguments for ${commandId}: ${validationError}`,
    `expected: ${describeExpectedArguments(schema)}`,
    `received keys: ${receivedText}`,
    `The call was rejected before execution. Call ${commandId} again with ` +
    `arguments matching the expected shape.`,
  ].join("\n");
}

function validateCommandArguments(
  schema: JsonSchemaObject,
  args: Record<string, unknown>,
): string | null {
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  // Membership on the model-controlled `args` and against `properties` uses an
  // own-property test, never `in`: `in` walks the prototype chain, so a key
  // like `constructor`, `toString`, or `__proto__` would spuriously satisfy
  // `additionalProperties: false` (bypassing validation) or read as declared.
  for (const field of required) {
    if (!Object.hasOwn(args, field)) {
      return `missing required argument: ${field}`;
    }
  }

  if (schema.additionalProperties === false) {
    for (const field of Object.keys(args)) {
      // Do not echo the raw name: a property name is untrusted model output and
      // could itself carry a path, token, or personal text, and this string is
      // persisted to the durable event log and replayed to the provider.
      if (!Object.hasOwn(properties, field)) {
        return "unexpected argument not declared in the tool's schema";
      }
    }
  }

  for (const [field, property] of Object.entries(properties)) {
    if (!Object.hasOwn(args, field)) continue;
    const value = args[field];
    if (typeof value !== property.type) {
      return `${field} must be a ${property.type}`;
    }
    if (
      property.type === "string" &&
      property.pattern &&
      !new RegExp(property.pattern).test(String(value))
    ) {
      return `${field} does not match required pattern`;
    }
  }

  return null;
}

function formatCommandResult(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
