import { doltExec, doltQuery, generateULID, type SqlParam } from "./utils";
import type { WorkbenchMessage } from "./provider";
import { formatSummaryMessage } from "./context-compression";

export type SessionExec = (sql: string, params: SqlParam[]) => Promise<void>;
export type SessionQuery = (
  sql: string,
  params: SqlParam[],
) => Promise<Record<string, string>[]>;

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
  exec?: SessionExec;
}

export interface UpdateWorkbenchSessionInput {
  sessionId: string;
  content: string;
  exec?: SessionExec;
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
  const exec = input.exec ?? doltExec;
  await exec(
    "INSERT INTO sessions " +
      "(session_id, slug, session_name, task_description, status, mode, workspace, content) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
    [
      input.sessionId,
      input.slug,
      "Workbench Harness Shell",
      truncateTaskDescription(input.taskDescription),
      "active",
      "interactive",
      input.workspace ?? null,
      input.content,
    ],
  );
}

/**
 * Read the persisted workspace root for a session, or null if the session has
 * none (or does not exist). Used on resume so the file tools stay bound to the
 * directory the session was created in, without the client re-sending its cwd.
 */
export async function fetchWorkbenchSessionWorkspace(
  input: { sessionId: string; query?: SessionQuery },
): Promise<string | null> {
  return (await fetchWorkbenchSessionWorkspaceRecord(input)).workspace;
}

export async function fetchWorkbenchSessionWorkspaceRecord(
  input: { sessionId: string; query?: SessionQuery },
): Promise<{ exists: boolean; workspace: string | null }> {
  const query = input.query ?? doltQuery;
  const rows = await query(
    "SELECT workspace FROM sessions WHERE session_id = ? LIMIT 1;",
    [input.sessionId],
  );
  if (rows.length === 0) return { exists: false, workspace: null };
  const value = rows[0]?.workspace;
  return {
    exists: true,
    workspace: typeof value === "string" && value.length > 0 ? value : null,
  };
}

export async function fetchWorkbenchSessionRecord(
  input: { sessionId: string; query?: SessionQuery },
): Promise<WorkbenchSessionSummary | null> {
  const query = input.query ?? doltQuery;
  const rows = await query(
    "SELECT session_id, slug, session_name, task_description, project, " +
      "status, created_at, updated_at FROM sessions WHERE session_id = ? LIMIT 1;",
    [input.sessionId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
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
  query?: SessionQuery;
}): Promise<number> {
  const query = input.query ?? doltQuery;
  const rows = await query(
    "SELECT COUNT(*) as count FROM events WHERE session_id = ?;",
    [input.sessionId],
  );
  if (rows.length === 0) return 0;
  const count = Number(rows[0].count);
  return Number.isNaN(count) ? 0 : count;
}

export * from "./idea-packet";

export async function updateWorkbenchSession(
  input: UpdateWorkbenchSessionInput,
): Promise<void> {
  const exec = input.exec ?? doltExec;
  await exec(
    "UPDATE sessions SET status = ?, progress_done = ?, progress_total = ?, " +
      "content = ? WHERE session_id = ?;",
    [
      "completed",
      1,
      1,
      input.content,
      input.sessionId,
    ],
  );
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

export async function listWorkbenchSessions(options: {
  project?: string;
  limit?: number;
  query?: SessionQuery;
} = {}): Promise<WorkbenchProjectSessions[]> {
  const query = options.query ?? doltQuery;
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
  const params: SqlParam[] = [];
  let where = "";
  if (options.project !== undefined) {
    where = "WHERE project = ? ";
    params.push(options.project);
  }
  const rows = await query(
    "SELECT session_id, slug, session_name, task_description, project, " +
      "status, created_at, updated_at FROM sessions " +
      where +
      `ORDER BY updated_at DESC LIMIT ${limit};`,
    params,
  );
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  // Named projects first (most recently active first), unfiled sessions last.
  return [...groups.values()].sort((a, b) => {
    if (a.project === null) return 1;
    if (b.project === null) return -1;
    return (b.sessions[0]?.updatedAt ?? "").localeCompare(
      a.sessions[0]?.updatedAt ?? "",
    );
  });
}

export async function createProjectWorkbenchSession(input: {
  project?: string;
  taskDescription?: string;
  exec?: SessionExec;
  sessionId?: string;
}): Promise<{ sessionId: string; slug: string; project: string | null }> {
  const exec = input.exec ?? doltExec;
  const sessionId = input.sessionId ?? generateULID();
  const slug = buildWorkbenchSessionSlug(sessionId);
  const project = input.project?.trim() || null;
  await exec(
    "INSERT INTO sessions " +
      "(session_id, slug, session_name, project, task_description, mode, content) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?);",
    [
      sessionId,
      slug,
      "Workbench Harness Shell",
      project,
      truncateTaskDescription(
        input.taskDescription ?? "Workbench conversation",
      ),
      "interactive",
      "# Workbench Session\n\nCreated empty; turns append below.",
    ],
  );
  return { sessionId, slug, project };
}

export interface WorkbenchSessionEvent {
  eventId: string;
  eventType: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  traceFlags: number | null;
  traceState: string | null;
  spanKind: string | null;
  parentIsRemote: boolean | null;
  principalId: string;
  modelId: string | null;
  provider: string | null;
  api: string | null;
  content: string | null;
  stopReason: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  costTotal: string | null;
  durationMs: number | null;
  providerCallOrder: number | null;
  providerCallPurpose: string | null;
  providerErrorClass: string | null;
  unparsedToolCallCount: number | null;
  unparsedToolCallCountIsLowerBound: boolean | null;
  runnerKind: string | null;
  runnerProfile: string | null;
  runnerProtocol: string | null;
  runnerProtocolVersion: string | null;
  runnerStopReason: string | null;
  runnerExternalSessionId: string | null;
  runnerAgentName: string | null;
  runnerAgentVersion: string | null;
  runnerTransport: string | null;
  runnerAccessRoute: string | null;
  runnerCostBasis: string | null;
  runnerWorkspace: string | null;
  runnerCapabilities: string[] | null;
  runnerEvidenceScope: string | null;
  runnerRouteSource: string | null;
  runnerAuthType: string | null;
  permissionVerdict: string | null;
  // tool-call audit fields, so resume can replay tool turns.
  toolName: string | null;
  toolCallId: string | null;
  toolArguments: Record<string, unknown> | null;
  toolResult: string | null;
  toolIsError: boolean | null;
  createdAt: string;
}

const AS_OF_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;

export function isValidAsOfTimestamp(value: string): boolean {
  return AS_OF_TIMESTAMP.test(value);
}

function eventQuery(
  asOfClause: string,
  historicalProviderCallSchema = false,
  historicalUnparsedToolCallSchema = false,
  historicalRunnerSchema = false,
  historicalRunnerAuthSchema = false,
  historicalTraceContextSchema = false,
  limit?: number,
  order: "asc" | "desc" = "asc",
  eventId?: string,
): string {
  const traceContextFields = historicalTraceContextSchema
    ? "NULL AS trace_flags, NULL AS trace_state, NULL AS span_kind, " +
      "NULL AS parent_is_remote"
    : "trace_flags, trace_state, span_kind, parent_is_remote";
  const providerCallFields = historicalProviderCallSchema
    ? "NULL AS provider_call_order, NULL AS provider_call_purpose, " +
      "NULL AS provider_error_class"
    : "provider_call_order, provider_call_purpose, provider_error_class";
  const unparsedToolCallFields = historicalUnparsedToolCallSchema
    ? "NULL AS unparsed_tool_call_count, " +
      "NULL AS unparsed_tool_call_count_is_lower_bound"
    : "unparsed_tool_call_count, " +
      "unparsed_tool_call_count_is_lower_bound";
  const runnerFields = historicalRunnerSchema
    ? "NULL AS runner_kind, NULL AS runner_profile, NULL AS runner_protocol, " +
      "NULL AS runner_protocol_version, NULL AS runner_stop_reason, " +
      "NULL AS runner_external_session_id, " +
      "NULL AS runner_agent_name, NULL AS runner_agent_version, " +
      "NULL AS runner_transport, NULL AS runner_access_route, " +
      "NULL AS runner_cost_basis, " +
      "NULL AS runner_workspace, NULL AS runner_capabilities, " +
      "NULL AS runner_evidence_scope, NULL AS runner_route_source, " +
      "NULL AS runner_auth_type, NULL AS permission_verdict"
    : "runner_kind, runner_profile, runner_protocol, runner_protocol_version, " +
      "runner_stop_reason, runner_external_session_id, runner_agent_name, runner_agent_version, " +
      "runner_transport, runner_access_route, runner_cost_basis, runner_workspace, " +
      "CAST(runner_capabilities AS CHAR) AS runner_capabilities, " +
      "runner_evidence_scope, " +
      (historicalRunnerAuthSchema
        ? "NULL AS runner_route_source, NULL AS runner_auth_type, "
        : "runner_route_source, runner_auth_type, ") +
      "permission_verdict";
  const limitClause = typeof limit === "number" && limit > 0
    ? ` LIMIT ${Math.floor(limit)}`
    : "";
  const orderClause = order === "desc" ? "DESC" : "ASC";
  const eventClause = typeof eventId === "string" && eventId.length > 0
    ? " AND event_id = ?"
    : "";
  return `SELECT event_id, event_type, trace_id, span_id, parent_span_id, ` +
    `${traceContextFields}, ` +
    `principal_id, model_id, provider, api, content, stop_reason, ` +
    `tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, ` +
    `cost_total, duration_ms, ${providerCallFields}, ${unparsedToolCallFields}, ` +
    `${runnerFields}, ` +
    `tool_name, tool_call_id, ` +
    `tool_arguments, tool_result, tool_is_error, created_at FROM events${asOfClause} ` +
    `WHERE session_id = ?${eventClause} ORDER BY created_at ${orderClause}${limitClause};`;
}

function isMissingRunnerColumn(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
    sqlMessage?: unknown;
  };
  const message = [candidate.message, candidate.sqlMessage]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (
    !/runner_(?:kind|profile|protocol|stop|external|agent_(?:name|version)|transport|access|cost|workspace|capabilities|evidence)|permission_verdict/
      .test(message)
  ) {
    return false;
  }
  return candidate.code === "ER_BAD_FIELD_ERROR" || candidate.errno === 1054 ||
    /unknown column|column\s+["'](?:runner_(?:kind|profile|protocol[^"']*|stop[^"']*|external[^"']*|agent_(?:name|version)|transport|access[^"']*|cost[^"']*|workspace|capabilities|evidence[^"']*)|permission_verdict)["']\s+could not be found/i
      .test(message);
}

function isMissingRunnerAuthColumn(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
    sqlMessage?: unknown;
  };
  const message = [candidate.message, candidate.sqlMessage]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (!/runner_(?:route_source|auth_type)/.test(message)) return false;
  return candidate.code === "ER_BAD_FIELD_ERROR" || candidate.errno === 1054 ||
    /unknown column|column\s+["']runner_(?:route_source|auth_type)["']\s+could not be found/i
      .test(message);
}

function isMissingTraceContextColumn(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
    sqlMessage?: unknown;
  };
  const message = [candidate.message, candidate.sqlMessage]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (!/(?:trace_flags|trace_state|span_kind|parent_is_remote)/.test(message)) {
    return false;
  }
  return candidate.code === "ER_BAD_FIELD_ERROR" || candidate.errno === 1054 ||
    /unknown column|column\s+["'](?:trace_flags|trace_state|span_kind|parent_is_remote)["']\s+could not be found/i
      .test(message);
}

function isMissingProviderCallColumn(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
    sqlMessage?: unknown;
  };
  const message = [candidate.message, candidate.sqlMessage]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const knownProviderCallColumn =
    /provider_call_(order|purpose)|provider_error_class/.test(message);
  if (!knownProviderCallColumn) return false;
  const driverReportsMissingField = candidate.code === "ER_BAD_FIELD_ERROR" ||
    candidate.errno === 1054;
  return driverReportsMissingField ||
    /unknown column|column\s+["'](?:provider_call_(?:order|purpose)|provider_error_class)["']\s+could not be found/i
      .test(message);
}

function isMissingUnparsedToolCallColumn(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
    sqlMessage?: unknown;
  };
  const message = [candidate.message, candidate.sqlMessage]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (!/unparsed_tool_call_count/.test(message)) return false;
  return candidate.code === "ER_BAD_FIELD_ERROR" || candidate.errno === 1054 ||
    /unknown column|column\s+["']unparsed_tool_call_count(?:_is_lower_bound)?["']\s+could not be found/i
      .test(message);
}

export async function fetchWorkbenchSessionEvents(input: {
  sessionId: string;
  eventId?: string;
  asOf?: string;
  limit?: number;
  order?: "asc" | "desc";
  query?: SessionQuery;
}): Promise<WorkbenchSessionEvent[]> {
  const query = input.query ?? doltQuery;
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
  const effectiveLimit = input.limit ?? (input.eventId ? 10 : undefined);
  const explicitOrder = input.order;
  const order = explicitOrder ?? (input.limit ? "desc" : "asc");
  // AS OF cannot be parameterized; the timestamp is validated against a
  // strict shape before being inlined.
  let asOfClause = "";
  if (input.asOf !== undefined) {
    if (!isValidAsOfTimestamp(input.asOf)) {
      throw new Error(
        "asOf must be a timestamp like 2026-06-12 10:00:00",
      );
    }
    asOfClause = ` AS OF TIMESTAMP('${input.asOf.replace("T", " ")}')`;
  }
  const queryArgs: string[] = [input.sessionId];
  if (typeof input.eventId === "string" && input.eventId.length > 0) {
    queryArgs.push(input.eventId);
  }
  let rows: Record<string, string>[] | undefined;
  let historicalProviderCallSchema = false;
  let historicalUnparsedToolCallSchema = false;
  let historicalRunnerSchema = false;
  let historicalRunnerAuthSchema = false;
  let historicalTraceContextSchema = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rows = await query(eventQuery(
        asOfClause,
        historicalProviderCallSchema,
        historicalUnparsedToolCallSchema,
        historicalRunnerSchema,
        historicalRunnerAuthSchema,
        historicalTraceContextSchema,
        effectiveLimit,
        order,
        input.eventId,
      ), queryArgs);
      break;
    } catch (error) {
      if (input.asOf === undefined) throw error;
      const missingProviderCall = isMissingProviderCallColumn(error);
      const missingUnparsedToolCall = isMissingUnparsedToolCallColumn(error);
      const missingRunner = isMissingRunnerColumn(error);
      const missingRunnerAuth = isMissingRunnerAuthColumn(error);
      const missingTraceContext = isMissingTraceContextColumn(error);
      if (
        !missingProviderCall && !missingUnparsedToolCall && !missingRunner &&
        !missingRunnerAuth && !missingTraceContext
      ) throw error;
      historicalProviderCallSchema ||= missingProviderCall;
      historicalUnparsedToolCallSchema ||=
        missingProviderCall || missingUnparsedToolCall;
      historicalRunnerSchema ||=
        missingProviderCall || missingUnparsedToolCall || missingRunner;
      historicalRunnerAuthSchema ||=
        missingProviderCall || missingUnparsedToolCall || missingRunner ||
        missingRunnerAuth;
      // A snapshot missing any migration 003-006 column necessarily predates
      // migration 007 too, regardless of which missing column the driver names.
      historicalTraceContextSchema ||=
        missingProviderCall || missingUnparsedToolCall || missingRunner ||
        missingRunnerAuth || missingTraceContext;
    }
  }
  if (rows === undefined) throw new Error("historical event schema did not converge");
  if (!explicitOrder && order === "desc") {
    rows.reverse();
  }
  return rows.map((row) => ({
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
    toolName: row.tool_name ? String(row.tool_name) : null,
    toolCallId: row.tool_call_id ? String(row.tool_call_id) : null,
    toolArguments: normalizeToolArguments(row.tool_arguments),
    toolResult: row.tool_result ? String(row.tool_result) : null,
    // tinyint(1) round-trips as a number or numeric string depending on the
    // driver path; normalize either to a boolean, absent to null.
    toolIsError:
      row.tool_is_error === null || row.tool_is_error === undefined ||
        row.tool_is_error === ""
        ? null
        : Number(row.tool_is_error) === 1,
    createdAt: row.created_at,
  }));
}

/**
 * Rebuild prior session turns as real conversation messages for resume, so the
 * model sees structured user/assistant turns instead of a flattened "Conversation
 * so far:" string. Prompts live on session_start events (operator → user turns);
 * responses on model_response events (→ assistant turns); and tool_call events
 * are replayed as the assistant's tool-call intention immediately
 * followed by its matching result, so a resumed model sees its own tool trail
 * rather than a transcript that silently dropped it. Returns the most recent
 * `maxTurns` turns; whole turns are kept (no mid-turn truncation). The caller
 * appends the current user message and seeds the agent loop with the result.
 */
export function buildConversationMessages(
  events: WorkbenchSessionEvent[],
  options: { maxTurns?: number } = {},
): WorkbenchMessage[] {
  const maxTurns = options.maxTurns ?? 10;
  const messages: WorkbenchMessage[] = [];
  // The pinned summary from the most recent context_compressed event, if any.
  // It survives the recent-turns cap below, mirroring the live session where a
  // compression replaced everything before it.
  let pinnedSummary: WorkbenchMessage | null = null;
  for (const event of events) {
    if (event.eventType === "context_compressed") {
      // Compression replaced the elder turns with one summary, keeping a
      // verbatim tail. Rebuild the SAME marked summary the live session injected
      // — via the shared formatter — and keep exactly the turns it kept, so a
      // resumed transcript is [summary, tail, ...]: byte-consistent with what the
      // model saw. Removing everything before the event instead would drop the
      // tail and the current prompt too.
      //
      // Key on the RETAINED (trailing) count, never a compressed (leading) one:
      // the live path counts against a seed already capped to the recent turns,
      // while this rebuilds the FULL history, so a leading count would drop
      // unrelated oldest turns and leave the summarized ones standing. A trailing
      // count needs no shared base — see THE TURN-COUNTING INVARIANT on
      // countTurns, whose turn semantics this must match.
      //
      // A missing or unparseable payload — including an event predating the
      // retained count — keeps prior turns rather than losing history: that
      // session resumes uncompressed.
      if (event.content === null) continue;
      let parsed: { summary?: unknown; turnsRetained?: unknown };
      try {
        parsed = JSON.parse(event.content);
      } catch {
        continue;
      }
      const { summary, turnsRetained } = parsed;
      if (typeof summary !== "string" || summary.trim().length === 0) continue;
      if (
        typeof turnsRetained !== "number" ||
        !Number.isInteger(turnsRetained) || turnsRetained < 0
      ) {
        continue;
      }
      keepTrailingTurns(messages, turnsRetained);
      pinnedSummary = formatSummaryMessage(summary);
      messages.unshift(pinnedSummary);
    } else if (event.eventType === "session_start") {
      if (event.content === null) continue;
      messages.push({ role: "user", content: event.content });
    } else if (
      event.eventType === "model_response" ||
      event.eventType === "agent_response"
    ) {
      if (event.content === null) continue;
      messages.push({ role: "assistant", content: event.content });
    } else if (event.eventType === "tool_call") {
      // One tool_call event carries both halves: the call (name/id/arguments)
      // and its result. Emit them as a paired assistant+tool sequence so the
      // wire-format invariant holds — a `tool` message MUST be immediately
      // preceded by an `assistant` message bearing the same tool-call id.
      if (event.toolCallId === null || event.toolName === null) continue;
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [{
          id: event.toolCallId,
          name: event.toolName,
          arguments: parseToolArguments(event.toolArguments),
        }],
      });
      messages.push({
        role: "tool",
        toolCallId: event.toolCallId,
        name: event.toolName,
        content: event.toolResult ?? "",
        // Replay the failure mark, so a resumed transcript serializes the
        // result as an error (Anthropic is_error) exactly like the live turn.
        ...(event.toolIsError ? { isError: true } : {}),
      });
    }
  }
  // Pin the summary past the recent-turns cap: keep it, then the most recent
  // `maxTurns` turns that followed it. Without this a long post-compression run
  // could slice the summary off and lose all the compressed history.
  if (pinnedSummary !== null && messages[0] === pinnedSummary) {
    return [pinnedSummary, ...sliceToRecentTurns(messages.slice(1), maxTurns)];
  }
  return sliceToRecentTurns(messages, maxTurns);
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

/** Default absent tool arguments to the empty object needed for replay. */
function parseToolArguments(
  raw: Record<string, unknown> | null,
): Record<string, unknown> {
  return raw ?? {};
}

/**
 * Keep only the most recent `turns` turns, mutating in place. Used on resume to
 * retain exactly the verbatim tail a context_compressed event kept, counted per
 * THE TURN-COUNTING INVARIANT (a turn begins at each user message — the same
 * rule `countTurns` and `sliceToRecentTurns` use; they must not drift apart).
 *
 * Trailing rather than leading on purpose: the live path's tail is a suffix of
 * the full history even though its seed was capped, so a trailing count means
 * the same thing to both paths. `turns` of 0 keeps nothing; more turns than
 * exist keeps everything.
 */
function keepTrailingTurns(messages: WorkbenchMessage[], turns: number): void {
  if (turns <= 0) {
    messages.splice(0, messages.length);
    return;
  }
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userIndices.push(i);
  }
  if (userIndices.length <= turns) return;
  messages.splice(0, userIndices[userIndices.length - turns]);
}

/**
 * Keep the most recent `maxTurns` user-initiated turns. Truncation lands on a
 * `user` turn boundary so a `tool` message is never separated from the
 * `assistant` tool-call it answers (which the wire format forbids). For a
 * tool-free transcript this is exactly the prior "last maxTurns exchanges".
 */
function sliceToRecentTurns(
  messages: WorkbenchMessage[],
  maxTurns: number,
): WorkbenchMessage[] {
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userIndices.push(i);
  }
  if (userIndices.length <= maxTurns) return messages;
  return messages.slice(userIndices[userIndices.length - maxTurns]);
}
