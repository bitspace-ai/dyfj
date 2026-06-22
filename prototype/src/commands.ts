import { executeReadMemory } from "./memory";
import {
  executeListFiles,
  executeReadFile,
  executeWriteFile,
} from "./file-tools";
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
  | "call.model.local"
  | "call.model.paid"
  | "emit.event";

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
  network?: "none" | "local" | "external";
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

export function evaluateCommandPolicy(
  command: CommandDefinition,
  call: CommandCall,
): CommandPolicyResult {
  const validationError = validateCommandArguments(
    command.inputSchema,
    call.arguments,
  );
  if (validationError) {
    return {
      decision: "deny",
      authzBasis: "policy:deny:invalid-arguments",
      reason: validationError,
    };
  }

  if (
    command.permission.defaultDecision === "allow" &&
    (command.permission.filesystem === "none" ||
      command.permission.filesystem === "read") &&
    command.permission.cost === "none" &&
    command.permission.network !== "external"
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

  const policy = evaluateCommandPolicy(command, call);
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

export function registerCoreCommands(
  registry: CommandRegistry,
  deps: CoreCommandDependencies = {},
): void {
  registry.register(buildMemoryReadCommand(deps));
  if (deps.workspaceRoot !== undefined) {
    registry.register(buildReadFileCommand(deps.workspaceRoot));
    registry.register(buildListFilesCommand(deps.workspaceRoot));
    registry.register(buildWriteFileCommand(deps.workspaceRoot));
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

export function buildCommandToolCallEventPayload(
  call: CommandCall,
  result: CommandInvocationResult,
  context: CommandEventContext,
  loggedArguments: Record<string, unknown> = call.arguments,
): Record<string, unknown> {
  const isError = result.isError;
  const resultText = isError
    ? result.reason
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
    tool_result: resultText,
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
): Promise<CommandInvocationResult<TResult>> {
  const result = await invokeCommand<TResult>(registry, call, confirmApproval);
  // Redact payload-bearing arguments (e.g. write_file content) before the event
  // is persisted, so the durable log and session replay never retain the raw
  // value (CWE-532).
  const loggedArguments = redactCommandArguments(
    registry.lookup(call.commandId),
    call.arguments,
  );
  const event = buildCommandToolCallEventPayload(
    call,
    result,
    context,
    loggedArguments,
  );
  await (context.writeEvent ?? writeDoltEvent)(event);
  return result;
}

function validateCommandArguments(
  schema: JsonSchemaObject,
  args: Record<string, unknown>,
): string | null {
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  for (const field of required) {
    if (!(field in args)) return `missing required argument: ${field}`;
  }

  if (schema.additionalProperties === false) {
    for (const field of Object.keys(args)) {
      if (!(field in properties)) return `unexpected argument: ${field}`;
    }
  }

  for (const [field, property] of Object.entries(properties)) {
    if (!(field in args)) continue;
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
