import { doltExec, doltQuery, generateULID, type SqlParam } from "./utils";
import type { WorkbenchMessage } from "./provider";

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
      "(session_id, slug, session_name, task_description, phase, mode, workspace, content) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
    [
      input.sessionId,
      input.slug,
      "Workbench Harness Shell",
      truncateTaskDescription(input.taskDescription),
      "execute",
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
  const query = input.query ?? doltQuery;
  const rows = await query(
    "SELECT workspace FROM sessions WHERE session_id = ? LIMIT 1;",
    [input.sessionId],
  );
  const value = rows[0]?.workspace;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function updateWorkbenchSession(
  input: UpdateWorkbenchSessionInput,
): Promise<void> {
  const exec = input.exec ?? doltExec;
  await exec(
    "UPDATE sessions SET phase = ?, progress_done = ?, progress_total = ?, " +
      "content = ? WHERE session_id = ?;",
    [
      "complete",
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

// ─── Session REST surface (dfj-1dv.4) ────────────────────────────────────────

export interface WorkbenchSessionSummary {
  sessionId: string;
  slug: string;
  sessionName: string;
  taskDescription: string;
  project: string | null;
  phase: string | null;
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
      "phase, created_at, updated_at FROM sessions " +
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
      phase: row.phase === "" ? null : row.phase,
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
  principalId: string;
  modelId: string | null;
  provider: string | null;
  content: string | null;
  stopReason: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costTotal: string | null;
  createdAt: string;
}

const AS_OF_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;

export function isValidAsOfTimestamp(value: string): boolean {
  return AS_OF_TIMESTAMP.test(value);
}

export async function fetchWorkbenchSessionEvents(input: {
  sessionId: string;
  asOf?: string;
  query?: SessionQuery;
}): Promise<WorkbenchSessionEvent[]> {
  const query = input.query ?? doltQuery;
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
  const rows = await query(
    `SELECT event_id, event_type, trace_id, principal_id, model_id, ` +
      `provider, content, stop_reason, tokens_input, tokens_output, ` +
      `cost_total, created_at FROM events${asOfClause} ` +
      `WHERE session_id = ? ORDER BY created_at ASC;`,
    [input.sessionId],
  );
  return rows.map((row) => ({
    eventId: row.event_id,
    eventType: row.event_type,
    traceId: row.trace_id,
    principalId: row.principal_id,
    modelId: row.model_id === "" ? null : row.model_id,
    provider: row.provider === "" ? null : row.provider,
    content: row.content === "" ? null : row.content,
    stopReason: row.stop_reason === "" ? null : row.stop_reason,
    tokensInput: row.tokens_input === "" ? null : Number(row.tokens_input),
    tokensOutput: row.tokens_output === "" ? null : Number(row.tokens_output),
    costTotal: row.cost_total === "" ? null : row.cost_total,
    createdAt: row.created_at,
  }));
}

/**
 * Rebuild prior session turns as real conversation messages for resume, so the
 * model sees structured user/assistant turns instead of a flattened "Conversation
 * so far:" string. Prompts live on session_start events (operator → user turns);
 * responses on model_response events (→ assistant turns). Returns the most recent
 * `maxTurns` exchanges; whole turns are kept (no mid-turn truncation). The caller
 * appends the current user message and seeds the agent loop with the result.
 *
 * NOTE: prior tool calls/results are not yet persisted as resumable events, so
 * they are not replayed here — only the operator/assistant text turns. That is
 * still strictly better than the old string blob, which dropped them too.
 */
export function buildConversationMessages(
  events: WorkbenchSessionEvent[],
  options: { maxTurns?: number } = {},
): WorkbenchMessage[] {
  const maxTurns = options.maxTurns ?? 10;
  const messages: WorkbenchMessage[] = [];
  for (const event of events) {
    if (event.content === null) continue;
    if (event.eventType === "session_start") {
      messages.push({ role: "user", content: event.content });
    } else if (event.eventType === "model_response") {
      messages.push({ role: "assistant", content: event.content });
    }
  }
  // Keep the most recent maxTurns exchanges (a user+assistant pair per turn).
  return messages.length > maxTurns * 2
    ? messages.slice(messages.length - maxTurns * 2)
    : messages;
}
