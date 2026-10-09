import type { WorkbenchSessionEvent } from "../contract/mod.ts";
import type { EventReader, Journal, SessionReader } from "./port.ts";

export interface WorkbenchSessionContentInput {
  mode: string;
  prompt: string;
  traceId: string;
  contextSources: string[];
  receipt?: string;
}

export interface CreateWorkbenchSessionInput {
  sessionId: string;
  slug: string;
  taskDescription: string;
  content: string;
  /** Directory the file tools are scoped to for this session. Null when unbound. */
  workspace?: string;
  journal: Journal;
}

export interface UpdateWorkbenchSessionInput {
  sessionId: string;
  content: string;
  journal: Journal;
}

export function buildWorkbenchSessionSlug(sessionId: string): string {
  return `workbench-${sessionId.toLowerCase()}`;
}

export function buildWorkbenchSessionContent(
  input: WorkbenchSessionContentInput,
): string {
  const lines = [
    "# Workbench Session",
    "",
    `**Mode:** ${input.mode}`,
    `**Trace:** ${input.traceId}`,
    "",
    "## Prompt",
    "",
    input.prompt,
    "",
    "## Context Sources",
    "",
  ];
  if (input.contextSources.length === 0) {
    lines.push("- none");
  } else {
    for (const source of input.contextSources) {
      lines.push(`- ${source}`);
    }
  }
  if (input.receipt) {
    lines.push("", "## Receipt", "", input.receipt);
  }
  return lines.join("\n");
}

export async function createWorkbenchSession(
  input: CreateWorkbenchSessionInput,
): Promise<void> {
  await input.journal.commit({
    events: [],
    mutations: [{
      kind: "session_insert",
      sessionId: input.sessionId,
      slug: input.slug,
      sessionName: "Workbench Harness Shell",
      taskDescription: truncateTaskDescription(input.taskDescription),
      status: "active",
      mode: "interactive",
      workspace: input.workspace ?? null,
      content: input.content,
      progressDone: 0,
      progressTotal: 0,
    }],
  });
}

/**
 * Read the persisted workspace root for a session, or null if the session has
 * none (or does not exist). Used on resume so the file tools stay bound to the
 * directory the session was created in, without the client re-sending its cwd.
 */
export async function fetchWorkbenchSessionWorkspace(
  input: { sessionId: string; sessions: SessionReader },
): Promise<string | null> {
  return (await fetchWorkbenchSessionWorkspaceRecord(input)).workspace;
}

export async function fetchWorkbenchSessionWorkspaceRecord(
  input: { sessionId: string; sessions: SessionReader },
): Promise<{ exists: boolean; workspace: string | null }> {
  const row = await input.sessions.workspace(input.sessionId);
  if (row === null) return { exists: false, workspace: null };
  const value = row.workspace;
  return {
    exists: true,
    workspace: typeof value === "string" && value.length > 0 ? value : null,
  };
}

/**
 * The model a session last routed to: the model its latest `model_selected`
 * event names, or null when it has none. The event log is the record; a
 * resumed turn that names no model of its own routes to this one.
 */
export async function fetchWorkbenchSessionModel(
  input: { sessionId: string; events: EventReader },
): Promise<string | null> {
  return await input.events.latestSelectedModel(input.sessionId);
}

export async function fetchWorkbenchSessionRecord(
  input: { sessionId: string; sessions: SessionReader },
): Promise<WorkbenchSessionSummary | null> {
  const row = await input.sessions.summary(input.sessionId);
  if (row === null) return null;
  const project = row.project === "" ? null : row.project;
  return {
    sessionId: row.session_id,
    slug: row.slug,
    sessionName: row.session_name,
    taskDescription: row.task_description,
    project,
    status: row.status || "active",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function countWorkbenchSessionEvents(input: {
  sessionId: string;
  events: EventReader;
}): Promise<number> {
  return await input.events.countBySession(input.sessionId);
}

export async function updateWorkbenchSession(
  input: UpdateWorkbenchSessionInput,
): Promise<void> {
  await input.journal.commit({
    events: [],
    mutations: [{
      kind: "session_update",
      sessionId: input.sessionId,
      status: "completed",
      progressDone: 1,
      progressTotal: 1,
      content: input.content,
    }],
  });
}

function truncateTaskDescription(value: string): string {
  return value.slice(0, 256);
}

// ─── Session REST surface ────────────────────────────────────────

export interface WorkbenchSessionSummary {
  sessionId: string;
  slug: string;
  sessionName: string | null;
  taskDescription: string;
  project: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkbenchProjectSessions {
  project: string | null;
  sessions: WorkbenchSessionSummary[];
}

export function normalizeSessionTimestamp(val: unknown): string {
  if (!val) return "";
  if (val instanceof Date) return val.toISOString();
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return trimmed;
    const parsed = Date.parse(trimmed);
    if (!isNaN(parsed)) return new Date(parsed).toISOString();
    return trimmed;
  }
  if (typeof val === "number") {
    return new Date(val).toISOString();
  }
  return String(val);
}

export function compareSessionActivity(
  a: {
    updatedAt?: string | null;
    createdAt?: string | null;
    sessionId?: string;
  },
  b: {
    updatedAt?: string | null;
    createdAt?: string | null;
    sessionId?: string;
  },
): number {
  const aTime = normalizeSessionTimestamp(a.updatedAt || a.createdAt);
  const bTime = normalizeSessionTimestamp(b.updatedAt || b.createdAt);
  const timeCmp = bTime.localeCompare(aTime);
  if (timeCmp !== 0) return timeCmp;
  return (b.sessionId || "").localeCompare(a.sessionId || "");
}

export async function listWorkbenchSessions(options: {
  project?: string;
  limit?: number;
  sessions: SessionReader;
}): Promise<WorkbenchProjectSessions[]> {
  const limit = Math.floor(
    Math.min(
      Math.max(
        typeof options.limit === "number" && Number.isFinite(options.limit)
          ? options.limit
          : 200,
        1,
      ),
      1000,
    ),
  );
  const rows = await options.sessions.list({
    ...(options.project !== undefined ? { project: options.project } : {}),
    limit,
  });
  const groups = new Map<string, WorkbenchProjectSessions>();
  for (const row of rows) {
    const project = row.project === "" ? null : row.project;
    const key = project ?? "";
    let group = groups.get(key);
    if (group === undefined) {
      group = { project, sessions: [] };
      groups.set(key, group);
    }
    group.sessions.push({
      sessionId: row.session_id,
      slug: row.slug,
      sessionName: row.session_name,
      taskDescription: row.task_description,
      project,
      status: row.status || "active",
      createdAt: normalizeSessionTimestamp(row.created_at),
      updatedAt: normalizeSessionTimestamp(row.updated_at),
    });
  }
  // Sort sessions within each group by latest activity
  for (const group of groups.values()) {
    group.sessions.sort(compareSessionActivity);
  }
  // Named projects first (most recently active first), unfiled sessions last.
  return [...groups.values()].sort((a, b) => {
    if (a.project === null) return 1;
    if (b.project === null) return -1;
    const aFirst = a.sessions[0];
    const bFirst = b.sessions[0];
    if (!aFirst && !bFirst) return 0;
    if (!aFirst) return 1;
    if (!bFirst) return -1;
    return compareSessionActivity(aFirst, bFirst);
  });
}

export async function fetchWorkbenchSessionEvents(input: {
  sessionId: string;
  eventId?: string;
  asOf?: string;
  limit?: number;
  order?: "asc" | "desc";
  events: EventReader;
}): Promise<WorkbenchSessionEvent[]> {
  if (input.limit !== undefined) {
    if (
      typeof input.limit !== "number" ||
      !Number.isInteger(input.limit) ||
      input.limit <= 0 ||
      input.limit > 5000
    ) {
      throw new Error("limit must be a positive integer <= 5000");
    }
  }
  const effectiveLimit = input.limit ?? (input.eventId ? 10 : 5000);
  const explicitOrder = input.order;
  const order = explicitOrder ?? "desc";
  const rows = await input.events.bySession({
    sessionId: input.sessionId,
    ...(typeof input.eventId === "string" && input.eventId.length > 0
      ? { eventId: input.eventId }
      : {}),
    ...(input.asOf !== undefined ? { asOf: input.asOf } : {}),
    limit: effectiveLimit,
    order,
  });
  if (!explicitOrder && order === "desc") {
    rows.reverse();
  }
  return rows.map((row) => {
    const toolName = nullableString(row.tool_name);
    const toolCallId = nullableString(row.tool_call_id);
    const toolArguments = normalizeToolArguments(row.tool_arguments);
    const toolResult = nullableStringPreservingEmpty(row.tool_result);
    const toolError = normalizeToolErrorFlag(row.tool_is_error);
    const toolHistoryValid = row.event_type === "tool_call"
      ? toolName !== null && toolCallId !== null && toolArguments !== null &&
        toolResult !== null && toolError.valid
      : null;
    return {
      sessionId: input.sessionId,
      eventId: row.event_id,
      eventType: row.event_type,
      traceId: row.trace_id,
      spanId: row.span_id,
      parentSpanId: nullableString(row.parent_span_id),
      traceFlags: nullableNumber(row.trace_flags),
      traceState: nullableString(row.trace_state),
      spanKind: nullableString(row.span_kind),
      parentIsRemote:
        row.parent_is_remote === null || row.parent_is_remote === undefined ||
          row.parent_is_remote === ""
          ? null
          : Number(row.parent_is_remote) === 1,
      principalId: row.principal_id,
      modelId: nullableString(row.model_id),
      provider: nullableString(row.provider),
      api: nullableString(row.api),
      content: nullableString(row.content),
      stopReason: nullableString(row.stop_reason),
      tokensInput: nullableNumber(row.tokens_input),
      tokensOutput: nullableNumber(row.tokens_output),
      tokensCacheRead: nullableNumber(row.tokens_cache_read),
      tokensCacheWrite: nullableNumber(row.tokens_cache_write),
      costTotal: nullableString(row.cost_total),
      durationMs: nullableNumber(row.duration_ms),
      providerCallOrder: nullableNumber(row.provider_call_order),
      providerCallPurpose: nullableString(row.provider_call_purpose),
      providerErrorClass: nullableString(row.provider_error_class),
      unparsedToolCallCount: nullableNumber(row.unparsed_tool_call_count),
      unparsedToolCallCountIsLowerBound:
        row.unparsed_tool_call_count_is_lower_bound === null ||
          row.unparsed_tool_call_count_is_lower_bound === undefined ||
          row.unparsed_tool_call_count_is_lower_bound === ""
          ? null
          : Number(row.unparsed_tool_call_count_is_lower_bound) === 1,
      runnerKind: nullableString(row.runner_kind),
      runnerProfile: nullableString(row.runner_profile),
      runnerProtocol: nullableString(row.runner_protocol),
      runnerProtocolVersion: nullableString(row.runner_protocol_version),
      runnerStopReason: nullableString(row.runner_stop_reason),
      runnerExternalSessionId: nullableString(row.runner_external_session_id),
      runnerAgentName: nullableString(row.runner_agent_name),
      runnerAgentVersion: nullableString(row.runner_agent_version),
      runnerTransport: nullableString(row.runner_transport),
      runnerAccessRoute: nullableString(row.runner_access_route),
      runnerCostBasis: nullableString(row.runner_cost_basis),
      runnerWorkspace: nullableString(row.runner_workspace),
      runnerCapabilities: normalizeStringArray(row.runner_capabilities),
      runnerEvidenceScope: nullableString(row.runner_evidence_scope),
      runnerRouteSource: nullableString(row.runner_route_source),
      runnerAuthType: nullableString(row.runner_auth_type),
      permissionVerdict: nullableString(row.permission_verdict),
      toolName,
      toolCallId,
      toolArguments,
      toolResult,
      // tinyint(1) round-trips as a number or numeric string depending on the
      // driver path; normalize either to a boolean, absent to null.
      toolIsError: toolError.value,
      toolHistoryValid,
      createdAt: row.created_at,
    };
  });
}

function normalizeStringArray(raw: unknown): string[] | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : null;
}

function nullableString(raw: unknown): string | null {
  return raw === null || raw === undefined || raw === "" ? null : String(raw);
}

function nullableStringPreservingEmpty(raw: unknown): string | null {
  return raw === null || raw === undefined ? null : String(raw);
}

function nullableNumber(raw: unknown): number | null {
  return raw === null || raw === undefined || raw === "" ? null : Number(raw);
}

/**
 * Decode textual or already-parsed JSON objects/records from tool_arguments.
 * Invalid, empty, array, and other non-object values stay absent.
 */
function normalizeToolArguments(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" &&
        !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizeToolErrorFlag(
  raw: unknown,
): { value: boolean | null; valid: boolean } {
  if (raw === null || raw === undefined || raw === "") {
    return { value: null, valid: false };
  }
  if (raw === true || raw === 1 || raw === "1") {
    return { value: true, valid: true };
  }
  if (raw === false || raw === 0 || raw === "0") {
    return { value: false, valid: true };
  }
  return { value: null, valid: false };
}
