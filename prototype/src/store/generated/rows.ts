// generated from schema/ — do not edit
//
// Emitted by schema/codegen.ts from schema/current/ + schema/catalog/.
// Regenerate with `deno task schema:codegen`; the schema.codegen gate lane
// fails when this file is stale.

/** A column's declared shape, as `information_schema` reports it. */
export interface ColumnSpec {
  /** `boolean` is `tinyint(1)`; `text` covers CHAR, VARCHAR and TEXT. */
  readonly kind:
    | "text"
    | "enum"
    | "int"
    | "boolean"
    | "decimal"
    | "timestamp"
    | "json";
  readonly nullable: boolean;
  /** The DDL default as text; absent when the column has none. */
  readonly default?: string;
  /** The default is an expression evaluated at insert time. */
  readonly generated?: true;
  /** Digits after the decimal point, for `decimal`. */
  readonly scale?: number;
}

// ─── events ───────────────────────────────────────────────────────────────────

/** `events.event_type`, in declaration order. */
export const EVENT_TYPE_VALUES = [
  "model_response",
  "tool_call",
  "error",
  "session_start",
  "session_end",
  "model_selected",
  "budget_summary",
  "context_compressed",
  "provider_call",
  "runner_selected",
  "agent_permission",
  "agent_response",
] as const;
export type EventType = (typeof EVENT_TYPE_VALUES)[number];

/** `events.span_kind`, in declaration order. */
export const EVENT_SPAN_KIND_VALUES = [
  "internal",
  "server",
  "client",
  "producer",
  "consumer",
] as const;
export type EventSpanKind = (typeof EVENT_SPAN_KIND_VALUES)[number];

/** `events.principal_type`, in declaration order. */
export const EVENT_PRINCIPAL_TYPE_VALUES = [
  "human",
  "agent",
  "service",
] as const;
export type EventPrincipalType = (typeof EVENT_PRINCIPAL_TYPE_VALUES)[number];

/** `events.authn_status`, in declaration order. */
export const EVENT_AUTHN_STATUS_VALUES = [
  "authenticated",
  "unauthenticated",
  "unknown",
  "not_applicable",
] as const;
export type EventAuthnStatus = (typeof EVENT_AUTHN_STATUS_VALUES)[number];

/** `events.runner_kind`, in declaration order. */
export const EVENT_RUNNER_KIND_VALUES = [
  "external_agent",
] as const;
export type EventRunnerKind = (typeof EVENT_RUNNER_KIND_VALUES)[number];

/** `events.runner_stop_reason`, in declaration order. */
export const EVENT_RUNNER_STOP_REASON_VALUES = [
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
] as const;
export type EventRunnerStopReason =
  (typeof EVENT_RUNNER_STOP_REASON_VALUES)[number];

/** `events.runner_transport`, in declaration order. */
export const EVENT_RUNNER_TRANSPORT_VALUES = [
  "local_stdio",
] as const;
export type EventRunnerTransport =
  (typeof EVENT_RUNNER_TRANSPORT_VALUES)[number];

/** `events.runner_access_route`, in declaration order. */
export const EVENT_RUNNER_ACCESS_ROUTE_VALUES = [
  "local_sidecar",
  "subscription_oauth",
  "metered_direct_api",
  "aggregator",
  "independent_host",
] as const;
export type EventRunnerAccessRoute =
  (typeof EVENT_RUNNER_ACCESS_ROUTE_VALUES)[number];

/** `events.runner_cost_basis`, in declaration order. */
export const EVENT_RUNNER_COST_BASIS_VALUES = [
  "local_free",
  "subscription_quota",
  "metered_usd",
  "unknown",
] as const;
export type EventRunnerCostBasis =
  (typeof EVENT_RUNNER_COST_BASIS_VALUES)[number];

/** `events.runner_evidence_scope`, in declaration order. */
export const EVENT_RUNNER_EVIDENCE_SCOPE_VALUES = [
  "outer_only",
] as const;
export type EventRunnerEvidenceScope =
  (typeof EVENT_RUNNER_EVIDENCE_SCOPE_VALUES)[number];

/** `events.runner_route_source`, in declaration order. */
export const EVENT_RUNNER_ROUTE_SOURCE_VALUES = [
  "profile_declared",
  "agent_auth_status",
] as const;
export type EventRunnerRouteSource =
  (typeof EVENT_RUNNER_ROUTE_SOURCE_VALUES)[number];

/** `events.runner_auth_type`, in declaration order. */
export const EVENT_RUNNER_AUTH_TYPE_VALUES = [
  "chat-gpt",
  "api-key",
  "gateway",
  "unauthenticated",
] as const;
export type EventRunnerAuthType =
  (typeof EVENT_RUNNER_AUTH_TYPE_VALUES)[number];

/** `events.permission_verdict`, in declaration order. */
export const EVENT_PERMISSION_VERDICT_VALUES = [
  "approved",
  "denied",
  "cancelled",
] as const;
export type EventPermissionVerdict =
  (typeof EVENT_PERMISSION_VERDICT_VALUES)[number];

/** `events.stop_reason`, in declaration order. */
export const EVENT_STOP_REASON_VALUES = [
  "stop",
  "length",
  "tool_use",
  "error",
  "aborted",
] as const;
export type EventStopReason = (typeof EVENT_STOP_REASON_VALUES)[number];

/** `events.provider_call_purpose`, in declaration order. */
export const EVENT_PROVIDER_CALL_PURPOSE_VALUES = [
  "initial",
  "tool_followup",
  "forced_conclusion",
  "recovery",
  "context_compression",
] as const;
export type EventProviderCallPurpose =
  (typeof EVENT_PROVIDER_CALL_PURPOSE_VALUES)[number];

/** `events` columns, in declaration order. */
export const EVENT_COLUMNS = [
  "event_id",
  "session_id",
  "event_type",
  "created_at",
  "trace_id",
  "span_id",
  "parent_span_id",
  "trace_flags",
  "trace_state",
  "span_kind",
  "parent_is_remote",
  "principal_id",
  "principal_type",
  "action",
  "resource",
  "authz_basis",
  "authn_status",
  "authn_mechanism",
  "authn_issuer_ref",
  "authn_session_ref",
  "authn_authenticated_at",
  "authn_expires_at",
  "authn_evidence_ref",
  "model_id",
  "provider",
  "api",
  "runner_kind",
  "runner_profile",
  "runner_protocol",
  "runner_protocol_version",
  "runner_stop_reason",
  "runner_external_session_id",
  "runner_agent_name",
  "runner_agent_version",
  "runner_transport",
  "runner_access_route",
  "runner_cost_basis",
  "runner_workspace",
  "runner_capabilities",
  "runner_evidence_scope",
  "runner_route_source",
  "runner_auth_type",
  "permission_verdict",
  "tokens_input",
  "tokens_output",
  "tokens_cache_read",
  "tokens_cache_write",
  "cost_total",
  "content",
  "stop_reason",
  "provider_call_order",
  "provider_call_purpose",
  "provider_error_class",
  "unparsed_tool_call_count",
  "unparsed_tool_call_count_is_lower_bound",
  "tool_name",
  "tool_call_id",
  "tool_arguments",
  "tool_result",
  "tool_is_error",
  "thinking",
  "duration_ms",
] as const;
export type EventColumn = (typeof EVENT_COLUMNS)[number];

/** How each `events` column is declared. */
export const EVENT_COLUMN_SPECS: Readonly<
  Record<EventColumn, ColumnSpec>
> = {
  event_id: { kind: "text", nullable: false },
  session_id: { kind: "text", nullable: false },
  event_type: { kind: "enum", nullable: false },
  created_at: {
    kind: "timestamp",
    nullable: false,
    default: "CURRENT_TIMESTAMP(6)",
    generated: true,
  },
  trace_id: { kind: "text", nullable: false },
  span_id: { kind: "text", nullable: false },
  parent_span_id: { kind: "text", nullable: true },
  trace_flags: { kind: "int", nullable: true },
  trace_state: { kind: "text", nullable: true },
  span_kind: { kind: "enum", nullable: true },
  parent_is_remote: { kind: "boolean", nullable: true },
  principal_id: { kind: "text", nullable: false },
  principal_type: { kind: "enum", nullable: false },
  action: { kind: "text", nullable: false },
  resource: { kind: "text", nullable: false },
  authz_basis: { kind: "text", nullable: false },
  authn_status: { kind: "enum", nullable: false, default: "unknown" },
  authn_mechanism: { kind: "text", nullable: true },
  authn_issuer_ref: { kind: "text", nullable: true },
  authn_session_ref: { kind: "text", nullable: true },
  authn_authenticated_at: { kind: "timestamp", nullable: true },
  authn_expires_at: { kind: "timestamp", nullable: true },
  authn_evidence_ref: { kind: "text", nullable: true },
  model_id: { kind: "text", nullable: true },
  provider: { kind: "text", nullable: true },
  api: { kind: "text", nullable: true },
  runner_kind: { kind: "enum", nullable: true },
  runner_profile: { kind: "text", nullable: true },
  runner_protocol: { kind: "text", nullable: true },
  runner_protocol_version: { kind: "text", nullable: true },
  runner_stop_reason: { kind: "enum", nullable: true },
  runner_external_session_id: { kind: "text", nullable: true },
  runner_agent_name: { kind: "text", nullable: true },
  runner_agent_version: { kind: "text", nullable: true },
  runner_transport: { kind: "enum", nullable: true },
  runner_access_route: { kind: "enum", nullable: true },
  runner_cost_basis: { kind: "enum", nullable: true },
  runner_workspace: { kind: "text", nullable: true },
  runner_capabilities: { kind: "json", nullable: true },
  runner_evidence_scope: { kind: "enum", nullable: true },
  runner_route_source: { kind: "enum", nullable: true },
  runner_auth_type: { kind: "enum", nullable: true },
  permission_verdict: { kind: "enum", nullable: true },
  tokens_input: { kind: "int", nullable: true },
  tokens_output: { kind: "int", nullable: true },
  tokens_cache_read: { kind: "int", nullable: true },
  tokens_cache_write: { kind: "int", nullable: true },
  cost_total: { kind: "decimal", nullable: true, scale: 6 },
  content: { kind: "text", nullable: true },
  stop_reason: { kind: "enum", nullable: true },
  provider_call_order: { kind: "int", nullable: true },
  provider_call_purpose: { kind: "enum", nullable: true },
  provider_error_class: { kind: "text", nullable: true },
  unparsed_tool_call_count: { kind: "int", nullable: true },
  unparsed_tool_call_count_is_lower_bound: { kind: "boolean", nullable: true },
  tool_name: { kind: "text", nullable: true },
  tool_call_id: { kind: "text", nullable: true },
  tool_arguments: { kind: "json", nullable: true },
  tool_result: { kind: "text", nullable: true },
  tool_is_error: { kind: "boolean", nullable: true },
  thinking: { kind: "text", nullable: true },
  duration_ms: { kind: "int", nullable: true },
};

/** A selected `events` row, as the Dolt driver decodes it. */
export interface EventRow {
  event_id: string;
  session_id: string;
  event_type: EventType;
  created_at: Date;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  trace_flags: number | null;
  trace_state: string | null;
  span_kind: EventSpanKind | null;
  parent_is_remote: number | null;
  principal_id: string;
  principal_type: EventPrincipalType;
  action: string;
  resource: string;
  authz_basis: string;
  authn_status: EventAuthnStatus;
  authn_mechanism: string | null;
  authn_issuer_ref: string | null;
  authn_session_ref: string | null;
  authn_authenticated_at: Date | null;
  authn_expires_at: Date | null;
  authn_evidence_ref: string | null;
  model_id: string | null;
  provider: string | null;
  api: string | null;
  runner_kind: EventRunnerKind | null;
  runner_profile: string | null;
  runner_protocol: string | null;
  runner_protocol_version: string | null;
  runner_stop_reason: EventRunnerStopReason | null;
  runner_external_session_id: string | null;
  runner_agent_name: string | null;
  runner_agent_version: string | null;
  runner_transport: EventRunnerTransport | null;
  runner_access_route: EventRunnerAccessRoute | null;
  runner_cost_basis: EventRunnerCostBasis | null;
  runner_workspace: string | null;
  runner_capabilities: unknown;
  runner_evidence_scope: EventRunnerEvidenceScope | null;
  runner_route_source: EventRunnerRouteSource | null;
  runner_auth_type: EventRunnerAuthType | null;
  permission_verdict: EventPermissionVerdict | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  cost_total: string | null;
  content: string | null;
  stop_reason: EventStopReason | null;
  provider_call_order: number | null;
  provider_call_purpose: EventProviderCallPurpose | null;
  provider_error_class: string | null;
  unparsed_tool_call_count: number | null;
  unparsed_tool_call_count_is_lower_bound: number | null;
  tool_name: string | null;
  tool_call_id: string | null;
  tool_arguments: unknown;
  tool_result: string | null;
  tool_is_error: number | null;
  thinking: string | null;
  duration_ms: number | null;
}

/**
 * One `events` row to insert. NOT NULL columns without a default are
 * required; a null or omitted column takes its DDL default.
 */
export interface EventInsert {
  event_id: string;
  session_id: string;
  event_type: EventType;
  created_at?: string | Date | null;
  trace_id: string;
  span_id: string;
  parent_span_id?: string | null;
  trace_flags?: number | null;
  trace_state?: string | null;
  span_kind?: EventSpanKind | null;
  parent_is_remote?: boolean | null;
  principal_id: string;
  principal_type: EventPrincipalType;
  action: string;
  resource: string;
  authz_basis: string;
  authn_status?: EventAuthnStatus | null;
  authn_mechanism?: string | null;
  authn_issuer_ref?: string | null;
  authn_session_ref?: string | null;
  authn_authenticated_at?: string | Date | null;
  authn_expires_at?: string | Date | null;
  authn_evidence_ref?: string | null;
  model_id?: string | null;
  provider?: string | null;
  api?: string | null;
  runner_kind?: EventRunnerKind | null;
  runner_profile?: string | null;
  runner_protocol?: string | null;
  runner_protocol_version?: string | null;
  runner_stop_reason?: EventRunnerStopReason | null;
  runner_external_session_id?: string | null;
  runner_agent_name?: string | null;
  runner_agent_version?: string | null;
  runner_transport?: EventRunnerTransport | null;
  runner_access_route?: EventRunnerAccessRoute | null;
  runner_cost_basis?: EventRunnerCostBasis | null;
  runner_workspace?: string | null;
  runner_capabilities?: string | null;
  runner_evidence_scope?: EventRunnerEvidenceScope | null;
  runner_route_source?: EventRunnerRouteSource | null;
  runner_auth_type?: EventRunnerAuthType | null;
  permission_verdict?: EventPermissionVerdict | null;
  tokens_input?: number | null;
  tokens_output?: number | null;
  tokens_cache_read?: number | null;
  tokens_cache_write?: number | null;
  cost_total?: number | null;
  content?: string | null;
  stop_reason?: EventStopReason | null;
  provider_call_order?: number | null;
  provider_call_purpose?: EventProviderCallPurpose | null;
  provider_error_class?: string | null;
  unparsed_tool_call_count?: number | null;
  unparsed_tool_call_count_is_lower_bound?: boolean | null;
  tool_name?: string | null;
  tool_call_id?: string | null;
  tool_arguments?: string | null;
  tool_result?: string | null;
  tool_is_error?: boolean | null;
  thinking?: string | null;
  duration_ms?: number | null;
}

// ─── memories ─────────────────────────────────────────────────────────────────

/** `memories.type`, in declaration order. */
export const MEMORY_TYPE_VALUES = [
  "user",
  "feedback",
  "environment",
  "project",
  "reference",
] as const;
export type MemoryType = (typeof MEMORY_TYPE_VALUES)[number];

/** `memories.visibility`, in declaration order. */
export const MEMORY_VISIBILITY_VALUES = [
  "private",
  "shareable",
  "client_safe",
  "public",
] as const;
export type MemoryVisibility = (typeof MEMORY_VISIBILITY_VALUES)[number];

/** `memories.inject`, in declaration order. */
export const MEMORY_INJECT_VALUES = [
  "always",
  "index",
  "never",
] as const;
export type MemoryInject = (typeof MEMORY_INJECT_VALUES)[number];

/** `memories` columns, in declaration order. */
export const MEMORY_COLUMNS = [
  "memory_id",
  "slug",
  "type",
  "visibility",
  "inject",
  "name",
  "description",
  "content",
  "created_at",
  "updated_at",
] as const;
export type MemoryColumn = (typeof MEMORY_COLUMNS)[number];

/** How each `memories` column is declared. */
export const MEMORY_COLUMN_SPECS: Readonly<
  Record<MemoryColumn, ColumnSpec>
> = {
  memory_id: { kind: "text", nullable: false },
  slug: { kind: "text", nullable: false },
  type: { kind: "enum", nullable: false },
  visibility: { kind: "enum", nullable: false, default: "private" },
  inject: { kind: "enum", nullable: false, default: "index" },
  name: { kind: "text", nullable: false },
  description: { kind: "text", nullable: false },
  content: { kind: "text", nullable: false },
  created_at: {
    kind: "timestamp",
    nullable: false,
    default: "CURRENT_TIMESTAMP(6)",
    generated: true,
  },
  updated_at: {
    kind: "timestamp",
    nullable: false,
    default: "CURRENT_TIMESTAMP(6)",
    generated: true,
  },
};

/** A selected `memories` row, as the Dolt driver decodes it. */
export interface MemoryRow {
  memory_id: string;
  slug: string;
  type: MemoryType;
  visibility: MemoryVisibility;
  inject: MemoryInject;
  name: string;
  description: string;
  content: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * One `memories` row to insert. NOT NULL columns without a default are
 * required; a null or omitted column takes its DDL default.
 */
export interface MemoryInsert {
  memory_id: string;
  slug: string;
  type: MemoryType;
  visibility?: MemoryVisibility | null;
  inject?: MemoryInject | null;
  name: string;
  description: string;
  content: string;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
}

// ─── models ───────────────────────────────────────────────────────────────────

/** `models` columns, in declaration order. */
export const MODEL_COLUMNS = [
  "slug",
  "display_name",
  "provider",
  "api",
  "base_url",
  "tier",
  "context_window",
  "max_output_tokens",
  "cost_input",
  "cost_output",
  "cost_cache_read",
  "cost_cache_write",
  "reasoning",
  "capabilities",
  "architecture",
  "total_params_b",
  "active_params_b",
  "recommended_quant",
  "resident_ram_gib",
  "reasoning_effort_control",
  "active",
  "created_at",
  "updated_at",
] as const;
export type ModelColumn = (typeof MODEL_COLUMNS)[number];

/** How each `models` column is declared. */
export const MODEL_COLUMN_SPECS: Readonly<
  Record<ModelColumn, ColumnSpec>
> = {
  slug: { kind: "text", nullable: false },
  display_name: { kind: "text", nullable: false },
  provider: { kind: "text", nullable: false },
  api: { kind: "text", nullable: false },
  base_url: { kind: "text", nullable: true },
  tier: { kind: "int", nullable: false },
  context_window: { kind: "int", nullable: false },
  max_output_tokens: { kind: "int", nullable: false },
  cost_input: {
    kind: "decimal",
    nullable: false,
    default: "0.000000",
    scale: 6,
  },
  cost_output: {
    kind: "decimal",
    nullable: false,
    default: "0.000000",
    scale: 6,
  },
  cost_cache_read: {
    kind: "decimal",
    nullable: false,
    default: "0.000000",
    scale: 6,
  },
  cost_cache_write: {
    kind: "decimal",
    nullable: false,
    default: "0.000000",
    scale: 6,
  },
  reasoning: { kind: "boolean", nullable: false, default: "0" },
  capabilities: { kind: "json", nullable: false },
  architecture: { kind: "text", nullable: true },
  total_params_b: { kind: "decimal", nullable: true, scale: 2 },
  active_params_b: { kind: "decimal", nullable: true, scale: 2 },
  recommended_quant: { kind: "text", nullable: true },
  resident_ram_gib: { kind: "decimal", nullable: true, scale: 2 },
  reasoning_effort_control: { kind: "boolean", nullable: false, default: "0" },
  active: { kind: "boolean", nullable: false, default: "1" },
  created_at: {
    kind: "timestamp",
    nullable: false,
    default: "CURRENT_TIMESTAMP(6)",
    generated: true,
  },
  updated_at: {
    kind: "timestamp",
    nullable: false,
    default: "CURRENT_TIMESTAMP(6)",
    generated: true,
  },
};

/** A selected `models` row, as the Dolt driver decodes it. */
export interface ModelRow {
  slug: string;
  display_name: string;
  provider: string;
  api: string;
  base_url: string | null;
  tier: number;
  context_window: number;
  max_output_tokens: number;
  cost_input: string;
  cost_output: string;
  cost_cache_read: string;
  cost_cache_write: string;
  reasoning: number;
  capabilities: unknown;
  architecture: string | null;
  total_params_b: string | null;
  active_params_b: string | null;
  recommended_quant: string | null;
  resident_ram_gib: string | null;
  reasoning_effort_control: number;
  active: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * One `models` row to insert. NOT NULL columns without a default are
 * required; a null or omitted column takes its DDL default.
 */
export interface ModelInsert {
  slug: string;
  display_name: string;
  provider: string;
  api: string;
  base_url?: string | null;
  tier: number;
  context_window: number;
  max_output_tokens: number;
  cost_input?: number | null;
  cost_output?: number | null;
  cost_cache_read?: number | null;
  cost_cache_write?: number | null;
  reasoning?: boolean | null;
  capabilities: string;
  architecture?: string | null;
  total_params_b?: number | null;
  active_params_b?: number | null;
  recommended_quant?: string | null;
  resident_ram_gib?: number | null;
  reasoning_effort_control?: boolean | null;
  active?: boolean | null;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
}

// ─── prompts ──────────────────────────────────────────────────────────────────

/** `prompts` columns, in declaration order. */
export const PROMPT_COLUMNS = [
  "slug",
  "display_name",
  "kind",
  "content",
  "position",
  "active",
  "created_at",
  "updated_at",
] as const;
export type PromptColumn = (typeof PROMPT_COLUMNS)[number];

/** How each `prompts` column is declared. */
export const PROMPT_COLUMN_SPECS: Readonly<
  Record<PromptColumn, ColumnSpec>
> = {
  slug: { kind: "text", nullable: false },
  display_name: { kind: "text", nullable: false },
  kind: { kind: "text", nullable: false },
  content: { kind: "text", nullable: false },
  position: { kind: "int", nullable: false, default: "0" },
  active: { kind: "boolean", nullable: false, default: "1" },
  created_at: {
    kind: "timestamp",
    nullable: false,
    default: "CURRENT_TIMESTAMP(6)",
    generated: true,
  },
  updated_at: {
    kind: "timestamp",
    nullable: false,
    default: "CURRENT_TIMESTAMP(6)",
    generated: true,
  },
};

/** A selected `prompts` row, as the Dolt driver decodes it. */
export interface PromptRow {
  slug: string;
  display_name: string;
  kind: string;
  content: string;
  position: number;
  active: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * One `prompts` row to insert. NOT NULL columns without a default are
 * required; a null or omitted column takes its DDL default.
 */
export interface PromptInsert {
  slug: string;
  display_name: string;
  kind: string;
  content: string;
  position?: number | null;
  active?: boolean | null;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
}

// ─── sessions ─────────────────────────────────────────────────────────────────

/** `sessions.effort_level`, in declaration order. */
export const SESSION_EFFORT_LEVEL_VALUES = [
  "standard",
  "extended",
  "advanced",
  "deep",
  "comprehensive",
] as const;
export type SessionEffortLevel = (typeof SESSION_EFFORT_LEVEL_VALUES)[number];

/** `sessions.status`, in declaration order. */
export const SESSION_STATUS_VALUES = [
  "active",
  "completed",
] as const;
export type SessionStatus = (typeof SESSION_STATUS_VALUES)[number];

/** `sessions.mode`, in declaration order. */
export const SESSION_MODE_VALUES = [
  "interactive",
  "loop",
] as const;
export type SessionMode = (typeof SESSION_MODE_VALUES)[number];

/** `sessions` columns, in declaration order. */
export const SESSION_COLUMNS = [
  "session_id",
  "slug",
  "session_name",
  "external_id",
  "project",
  "workspace",
  "task_description",
  "effort_level",
  "status",
  "progress_done",
  "progress_total",
  "mode",
  "iteration",
  "content",
  "created_at",
  "updated_at",
] as const;
export type SessionColumn = (typeof SESSION_COLUMNS)[number];

/** How each `sessions` column is declared. */
export const SESSION_COLUMN_SPECS: Readonly<
  Record<SessionColumn, ColumnSpec>
> = {
  session_id: { kind: "text", nullable: false },
  slug: { kind: "text", nullable: false },
  session_name: { kind: "text", nullable: true },
  external_id: { kind: "text", nullable: true },
  project: { kind: "text", nullable: true },
  workspace: { kind: "text", nullable: true },
  task_description: { kind: "text", nullable: false },
  effort_level: { kind: "enum", nullable: true },
  status: { kind: "enum", nullable: false, default: "active" },
  progress_done: { kind: "int", nullable: false, default: "0" },
  progress_total: { kind: "int", nullable: false, default: "0" },
  mode: { kind: "enum", nullable: false, default: "interactive" },
  iteration: { kind: "int", nullable: true },
  content: { kind: "text", nullable: true },
  created_at: {
    kind: "timestamp",
    nullable: false,
    default: "CURRENT_TIMESTAMP(6)",
    generated: true,
  },
  updated_at: {
    kind: "timestamp",
    nullable: false,
    default: "CURRENT_TIMESTAMP(6)",
    generated: true,
  },
};

/** A selected `sessions` row, as the Dolt driver decodes it. */
export interface SessionRow {
  session_id: string;
  slug: string;
  session_name: string | null;
  external_id: string | null;
  project: string | null;
  workspace: string | null;
  task_description: string;
  effort_level: SessionEffortLevel | null;
  status: SessionStatus;
  progress_done: number;
  progress_total: number;
  mode: SessionMode;
  iteration: number | null;
  content: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * One `sessions` row to insert. NOT NULL columns without a default are
 * required; a null or omitted column takes its DDL default.
 */
export interface SessionInsert {
  session_id: string;
  slug: string;
  session_name?: string | null;
  external_id?: string | null;
  project?: string | null;
  workspace?: string | null;
  task_description: string;
  effort_level?: SessionEffortLevel | null;
  status?: SessionStatus | null;
  progress_done?: number | null;
  progress_total?: number | null;
  mode?: SessionMode | null;
  iteration?: number | null;
  content?: string | null;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
}

/** Every canonical table's columns, for the boot-time column check. */
export const CANONICAL_TABLE_COLUMNS = {
  events: EVENT_COLUMNS,
  memories: MEMORY_COLUMNS,
  models: MODEL_COLUMNS,
  prompts: PROMPT_COLUMNS,
  sessions: SESSION_COLUMNS,
} as const;
export type CanonicalTable = keyof typeof CANONICAL_TABLE_COLUMNS;
