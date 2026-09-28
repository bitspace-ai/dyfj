/**
 * The one tool shape: `CommandDefinition` and the types a command call, its
 * policy verdict and its invocation result are made of
 * (`specs/01-architecture.md` section 5.4). A provider sees a tool through its
 * projection (`ToolProjection`, which the provider tier types as
 * `WorkbenchToolDefinition`); nothing else defines a second tool shape.
 */

export type PrincipalType = "human" | "agent" | "service";
export type PolicyDecision = "allow" | "ask" | "deny";
export type CommandEffect =
  | "read.memory"
  | "read.external"
  | "read.filesystem"
  | "write.filesystem"
  | "write.external"
  | "run.checks"
  | "run.process"
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
  type: "string" | "number" | "integer" | "boolean" | "object" | "array";
  pattern?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, JsonSchemaProperty>;
  additionalProperties?: boolean;
  items?: JsonSchemaProperty;
  maxItems?: number;
  enum?: Array<string | number | boolean | null>;
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
  network?: "none" | "local" | "external" | "configured-external" | "recall";
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
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
  traceState?: string;
}

export interface CommandTraceContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: string;
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
  /** Redact schema-declared argument values; undeclared keys are omitted. */
  redactArguments?: boolean;
  /** Minimum transport clearance required before this command is registered. */
  minimumClearance?: "loopback" | "remote";
  /** Optional bounded public-safe event content for protocol-backed tools. */
  eventContent?: (
    isError: boolean,
    result: CommandInvocationResult,
  ) => string;
  /** OpenTelemetry span kind when this command crosses a protocol boundary. */
  spanKind?: "client" | "server" | "producer" | "consumer" | "internal";
  executor: (
    call: CommandCall,
    context: CommandExecutionContext,
  ) => Promise<TResult> | TResult;
}

/** What a provider is offered for one command: its name, prose and schema. */
export interface ToolProjection {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
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
    decision: "allow";
    authzBasis: string;
    isError: true;
    reason: string;
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
  signal?: AbortSignal,
) => Promise<ToolApprovalVerdict>;

export class CommandExecutionError extends Error {
  constructor(public readonly publicReason: string) {
    super(publicReason);
    this.name = "CommandExecutionError";
  }
}
