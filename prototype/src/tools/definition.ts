/**
 * The one tool shape: `CommandDefinition` and the types a command call, its
 * policy verdict and its invocation result are made of
 * (`specs/01-architecture.md` section 5.4). A provider sees a tool through its
 * projection (`ToolProjection`, which the provider tier types as
 * `WorkbenchToolDefinition`); nothing else defines a second tool shape.
 */

import type { ApprovalEnvelope } from "../config/approval-envelope.ts";

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
  /** Inclusive bounds for `integer` and `number` properties. */
  minimum?: number;
  maximum?: number;
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
  /**
   * The supervisor instance a call allowed by the attested envelope is bound
   * to (BIT-736). A contained tool sends it with the command, and the
   * supervisor refuses it if another instance now serves.
   */
  binding?: string;
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

/**
 * The attestation of a contained tool's executor for one call (BIT-736;
 * `builtin/containment.ts` produces it).
 */
export type ContainmentVerdict =
  | {
    readonly status: "attested";
    readonly envelope: ApprovalEnvelope;
    /** The operator's grant names this envelope's policy digest. */
    readonly granted: boolean;
    /** Why the supervisor refused a grant that is present, if it did. */
    readonly grantRefusal?: string;
  }
  | { readonly status: "unattested"; readonly reason: string };

/** A tool's link to the executor it runs in. */
export interface Containment {
  readonly route: "linux-isolated";
  /** Attest now. Never throws; a failure is `unattested`. */
  attest(): Promise<ContainmentVerdict>;
  /**
   * The deadline this call asks for, in ms, when the tool takes one. A
   * declared read of a model-supplied argument (README Section 1): it can
   * only turn an envelope allow into a prompt, never the reverse.
   */
  callTimeoutMs?(call: CommandCall): number | undefined;
}

export interface CommandDefinition<TResult = unknown> {
  id: string;
  /** Names the tool in listings and, unless `approvalTitle` says otherwise, in the approval prompt. */
  title: string;
  description: string;
  inputSchema: JsonSchemaObject;
  permission: PermissionEnvelope;
  /**
   * The approval prompt's title for one call, when what the operator approves
   * depends on the arguments (bash shows the effective timeout). Called only
   * after the arguments have been validated. Absent, the prompt shows `title`.
   */
  approvalTitle?: (call: CommandCall) => string;
  /**
   * True when this call may run without a prompt because it only reads
   * (bash's read-only allowlist, BIT-707). Called after argument validation,
   * and only under the operator posture on loopback. It is one of the two
   * declared places where a permission check reads a model-supplied argument
   * (README Section 1); `Containment.callTimeoutMs` is the other. It must
   * fail closed: false whenever it is unsure.
   */
  readOnlyCall?: (call: CommandCall) => boolean;
  /**
   * Set when the tool runs its commands in the isolated machine's executor
   * (BIT-736). `invokeCommand` attests it before each call, and the policy
   * may then allow the call by the attested envelope instead of a prompt.
   * A contained tool declares no `readOnlyCall`: no shell parsing decides
   * anything on that route.
   */
  containment?: Containment;
  /**
   * The approval prompt may offer "allow this exact call for the rest of the
   * session" (BIT-707). The grant matches the command id and every argument
   * exactly, lives in the runtime's memory for that session only, and is
   * never persisted.
   */
  grantable?: boolean;
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
    /**
     * The executor's operator-facing reason, scrubbed and capped, and
     * withheld when it echoes an argument value (`tools/failure-reason.ts`).
     * Absent when the executor gave none; the reason is then derived from
     * `reason`.
     */
    operatorReason?: string;
    /**
     * What every durable surface records for this failure: the event's
     * `tool_result` and `content`, the runtime log, the turn-end notice and
     * so the stored receipt. `invokeCommand` sets it on every error result,
     * from the redactor (`durableFailureReason`); `reason` stays on the model
     * path only. Upstream text is shown live, never recorded.
     */
    recordedReason?: string;
  }
  | {
    decision: "ask" | "deny";
    authzBasis: string;
    isError: true;
    reason: string;
    /** What durable surfaces record for this refusal (see the allow branch). */
    recordedReason?: string;
    /**
     * Set when a call that needed approval was not approved: the verdict
     * the runtime frame carries, so a client can render a refusal as one and
     * the loop can end tool use. Absent on every other result.
     */
    verdict?: "approval_denied";
  };

/** A mutating tool call awaiting operator approval. Serializable for the wire. */
export interface ToolApprovalRequest {
  commandId: string;
  callId: string;
  title: string;
  arguments: Record<string, unknown>;
  /** The operator may answer "allow this exact call for the rest of the session". */
  grantable?: boolean;
}

export interface ToolApprovalVerdict {
  decision: "approve" | "deny";
  reason?: string;
  /** On an approval: also allow this exact call for the rest of the session. */
  scope?: "session";
}

/**
 * One session's "allow for the rest of the session" grants, keyed by
 * `sessionGrantKey`. Owned by the engine's session owners; held in memory
 * only.
 */
export interface SessionGrants {
  has(key: string): boolean;
  add(key: string): void;
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
  /** What the model reads in place of a result. */
  public readonly publicReason: string;
  /**
   * A compact form of the reason for the operator's ✗ line, the runtime log
   * and the durable event, when it should differ from `publicReason`.
   * When `operatorReasonLabel` is set too, `invokeCommand` withholds it if it
   * echoes an argument value; otherwise it is only scrubbed and capped.
   */
  declare public readonly operatorReason?: string;
  /**
   * Set when `operatorReason` quotes text this code did not compose (an
   * upstream server's error): it then gets the echo check, and leads the
   * withheld line (`upstream error (text withheld: …)`). Absent, the operator
   * reason is fixed text and is only scrubbed and capped.
   */
  declare public readonly operatorReasonLabel?: string;
  /**
   * What durable surfaces (the runtime log, the event log, the stored
   * receipt) record instead of `operatorReason`, which is shown live only.
   * A reason quoting upstream text records a fixed line here.
   */
  declare public readonly recordedReason?: string;
  constructor(
    publicReason: string,
    options: {
      operatorReason?: string;
      operatorReasonLabel?: string;
      recordedReason?: string;
    } = {},
  ) {
    super(publicReason);
    this.publicReason = publicReason;
    this.name = "CommandExecutionError";
    for (
      const key of [
        "operatorReason",
        "operatorReasonLabel",
        "recordedReason",
      ] as const
    ) {
      if (options[key] !== undefined) {
        Object.defineProperty(this, key, {
          value: options[key],
          enumerable: true,
        });
      }
    }
  }
}
