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
  sessionName: string;
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
  principalId: string;
  modelId: string | null;
  provider: string | null;
  content: string | null;
  stopReason: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costTotal: string | null;
  // tool-call audit fields, so resume can replay tool turns.
  // toolArguments is normalized to a JSON string regardless of how the JSON
  // column round-trips.
  toolName: string | null;
  toolCallId: string | null;
  toolArguments: string | null;
  toolResult: string | null;
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
      `cost_total, tool_name, tool_call_id, tool_arguments, tool_result, ` +
      `created_at FROM events${asOfClause} ` +
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
    toolName: row.tool_name ? String(row.tool_name) : null,
    toolCallId: row.tool_call_id ? String(row.tool_call_id) : null,
    toolArguments: normalizeToolArguments(row.tool_arguments),
    toolResult: row.tool_result ? String(row.tool_result) : null,
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
    } else if (event.eventType === "model_response") {
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

/**
 * Normalize a tool_arguments JSON column to a string, regardless of whether the
 * driver returns JSON as text or an already-parsed object.
 */
function normalizeToolArguments(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

/** Parse a persisted tool_arguments JSON string back to a structured object. */
function parseToolArguments(raw: string | null): Record<string, unknown> {
  if (raw === null || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
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
