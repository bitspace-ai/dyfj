import { executeReadMemory } from "./memory";
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

export interface CoreCommandDependencies {
  readMemory?: (slug: string) => Promise<string> | string;
  allowedMemorySlugs?: readonly string[];
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
    command.permission.filesystem === "none" &&
    command.permission.cost === "none" &&
    command.permission.network !== "external"
  ) {
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
  if (policy.decision !== "allow") {
    return {
      decision: policy.decision,
      authzBasis: policy.authzBasis,
      isError: true,
      // "ask" results may omit a reason; the outcome contract requires one.
      reason: policy.reason ?? "command requires operator approval",
    };
  }

  const result = await command.executor(call, {
    authzBasis: policy.authzBasis,
  });
  return {
    decision: "allow",
    authzBasis: policy.authzBasis,
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

export function registerCoreCommands(
  registry: CommandRegistry,
  deps: CoreCommandDependencies = {},
): void {
  registry.register(buildMemoryReadCommand(deps));
}

export function buildCommandToolCallEventPayload(
  call: CommandCall,
  result: CommandInvocationResult,
  context: CommandEventContext,
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
    tool_arguments: JSON.stringify(call.arguments),
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
): Promise<CommandInvocationResult<TResult>> {
  const result = await invokeCommand<TResult>(registry, call);
  const event = buildCommandToolCallEventPayload(call, result, context);
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
