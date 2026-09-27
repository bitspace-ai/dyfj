/**
 * `DoltStore` readers: read-only SQL over the projected tables, the event log
 * and reference data. Each method is one query the runtime or the memory MCP
 * server issued before the store port existed, with the same SQL semantics.
 * Nothing here writes: every reader gets a `DoltSelect` handle, which runs
 * only a single SELECT, and writes live in `dolt-journal.ts`.
 */

import type { DoltSelect } from "./dolt-pool.ts";
import type {
  EventReader,
  MemoryReader,
  ModelReader,
  PromptReader,
  SessionEventsQuery,
  SessionReader,
  SpendBaselineSums,
  SpendReader,
  TextRow,
} from "./port.ts";
import { invalidAsOfError, isValidAsOfTimestamp } from "./port.ts";
import type { MemoryType, MemoryVisibility } from "./generated/rows.ts";

export type SqlParam = string | number | boolean | null;

/** Run a SELECT; render every value as text, NULL as "". */
export async function queryText(
  pool: DoltSelect,
  sql: string,
  params: SqlParam[] = [],
): Promise<TextRow[]> {
  return (await pool.select(sql, params)).map(textRow);
}

export function textRow(row: Record<string, unknown>): TextRow {
  const out: TextRow = {};
  for (const k of Object.keys(row)) {
    out[k] = row[k] == null ? "" : String(row[k]);
  }
  return out;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

// ─── events ──────────────────────────────────────────────────────────────────

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
  // Dolt/MySQL drivers may decode JSON columns to objects. Cast both
  // runner_capabilities and tool_arguments so Workbench owns their validation.
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
    `CAST(tool_arguments AS CHAR) AS tool_arguments, ` +
    `tool_result, tool_is_error, created_at FROM events${asOfClause} ` +
    `WHERE session_id = ?${eventClause} ORDER BY created_at ${orderClause}, event_id ${orderClause}${limitClause};`;
}

interface DriverError {
  code?: unknown;
  errno?: unknown;
  message?: unknown;
  sqlMessage?: unknown;
}

function driverMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as DriverError;
  return [candidate.message, candidate.sqlMessage]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function reportsMissingField(error: unknown): boolean {
  const candidate = error as DriverError;
  return candidate.code === "ER_BAD_FIELD_ERROR" || candidate.errno === 1054;
}

function isMissingRunnerColumn(error: unknown): boolean {
  const message = driverMessage(error);
  if (message === null) return false;
  if (
    !/runner_(?:kind|profile|protocol|stop|external|agent_(?:name|version)|transport|access|cost|workspace|capabilities|evidence)|permission_verdict/
      .test(message)
  ) {
    return false;
  }
  return reportsMissingField(error) ||
    /unknown column|column\s+["'](?:runner_(?:kind|profile|protocol[^"']*|stop[^"']*|external[^"']*|agent_(?:name|version)|transport|access[^"']*|cost[^"']*|workspace|capabilities|evidence[^"']*)|permission_verdict)["']\s+could not be found/i
      .test(message);
}

function isMissingRunnerAuthColumn(error: unknown): boolean {
  const message = driverMessage(error);
  if (message === null) return false;
  if (!/runner_(?:route_source|auth_type)/.test(message)) return false;
  return reportsMissingField(error) ||
    /unknown column|column\s+["']runner_(?:route_source|auth_type)["']\s+could not be found/i
      .test(message);
}

function isMissingTraceContextColumn(error: unknown): boolean {
  const message = driverMessage(error);
  if (message === null) return false;
  if (!/(?:trace_flags|trace_state|span_kind|parent_is_remote)/.test(message)) {
    return false;
  }
  return reportsMissingField(error) ||
    /unknown column|column\s+["'](?:trace_flags|trace_state|span_kind|parent_is_remote)["']\s+could not be found/i
      .test(message);
}

function isMissingProviderCallColumn(error: unknown): boolean {
  const message = driverMessage(error);
  if (message === null) return false;
  const knownProviderCallColumn =
    /provider_call_(order|purpose)|provider_error_class/.test(message);
  if (!knownProviderCallColumn) return false;
  return reportsMissingField(error) ||
    /unknown column|column\s+["'](?:provider_call_(?:order|purpose)|provider_error_class)["']\s+could not be found/i
      .test(message);
}

function isMissingUnparsedToolCallColumn(error: unknown): boolean {
  const message = driverMessage(error);
  if (message === null) return false;
  if (!/unparsed_tool_call_count/.test(message)) return false;
  return reportsMissingField(error) ||
    /unknown column|column\s+["']unparsed_tool_call_count(?:_is_lower_bound)?["']\s+could not be found/i
      .test(message);
}

/**
 * A session's events. Retries with NULL placeholders for columns a
 * historical (`AS OF`) snapshot predates, so time travel across schema
 * migrations still reads.
 */
async function eventsBySession(
  pool: DoltSelect,
  input: SessionEventsQuery,
): Promise<TextRow[]> {
  // AS OF cannot be parameterized; the timestamp is validated against a
  // strict shape before being inlined.
  let asOfClause = "";
  if (input.asOf !== undefined) {
    if (!isValidAsOfTimestamp(input.asOf)) throw invalidAsOfError();
    asOfClause = ` AS OF TIMESTAMP('${input.asOf.replace("T", " ")}')`;
  }
  const limit = positiveInteger(input.limit, "limit");
  const queryArgs: string[] = [input.sessionId];
  if (typeof input.eventId === "string" && input.eventId.length > 0) {
    queryArgs.push(input.eventId);
  }
  let historicalProviderCallSchema = false;
  let historicalUnparsedToolCallSchema = false;
  let historicalRunnerSchema = false;
  let historicalRunnerAuthSchema = false;
  let historicalTraceContextSchema = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await queryText(
        pool,
        eventQuery(
          asOfClause,
          historicalProviderCallSchema,
          historicalUnparsedToolCallSchema,
          historicalRunnerSchema,
          historicalRunnerAuthSchema,
          historicalTraceContextSchema,
          limit,
          input.order,
          input.eventId,
        ),
        queryArgs,
      );
    } catch (error) {
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
      historicalUnparsedToolCallSchema ||= missingProviderCall ||
        missingUnparsedToolCall;
      historicalRunnerSchema ||= missingProviderCall ||
        missingUnparsedToolCall || missingRunner;
      historicalRunnerAuthSchema ||= missingProviderCall ||
        missingUnparsedToolCall || missingRunner ||
        missingRunnerAuth;
      // A snapshot missing any migration 003-006 column necessarily predates
      // migration 007 too, regardless of which missing column the driver names.
      historicalTraceContextSchema ||= missingProviderCall ||
        missingUnparsedToolCall || missingRunner ||
        missingRunnerAuth || missingTraceContext;
    }
  }
  throw new Error("historical event schema did not converge");
}

export function doltEventReader(pool: DoltSelect): EventReader {
  return {
    async exists(eventId) {
      const rows = await queryText(
        pool,
        "SELECT event_id FROM events WHERE event_id = ? LIMIT 1",
        [eventId],
      );
      return rows.length > 0;
    },
    async countBySession(sessionId) {
      const rows = await queryText(
        pool,
        "SELECT COUNT(*) as count FROM events WHERE session_id = ?;",
        [sessionId],
      );
      if (rows.length === 0) return 0;
      const count = Number(rows[0]!.count);
      return Number.isNaN(count) ? 0 : count;
    },
    bySession: (query) => eventsBySession(pool, query),
  };
}

// ─── sessions ────────────────────────────────────────────────────────────────

const SESSION_SUMMARY_COLUMNS =
  "SELECT session_id, slug, session_name, task_description, project, " +
  "status, created_at, updated_at FROM sessions ";

export function doltSessionReader(pool: DoltSelect): SessionReader {
  return {
    async workspace(sessionId) {
      const rows = await queryText(
        pool,
        "SELECT workspace FROM sessions WHERE session_id = ? LIMIT 1;",
        [sessionId],
      );
      return rows[0] ?? null;
    },
    async summary(sessionId) {
      const rows = await queryText(
        pool,
        SESSION_SUMMARY_COLUMNS + "WHERE session_id = ? LIMIT 1;",
        [sessionId],
      );
      return rows[0] ?? null;
    },
    async list({ project, limit }) {
      const bounded = positiveInteger(limit, "limit");
      const params: SqlParam[] = [];
      let where = "";
      if (project !== undefined) {
        where = "WHERE project = ? ";
        params.push(project);
      }
      return queryText(
        pool,
        SESSION_SUMMARY_COLUMNS + where +
          `ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ${bounded};`,
        params,
      );
    },
    async recent({ status, limit }) {
      const bounded = positiveInteger(limit, "limit");
      const where = status ? "WHERE status = ?" : "";
      const params: SqlParam[] = status ? [status, bounded] : [bounded];
      return queryText(
        pool,
        `SELECT session_id, slug, session_name, task_description, status, ` +
          `progress_done, progress_total, created_at ` +
          `FROM sessions ${where} ORDER BY created_at DESC LIMIT ?;`,
        params,
      );
    },
    async detail(key) {
      const bySessionId = "sessionId" in key;
      const where = bySessionId ? "WHERE session_id = ?" : "WHERE slug = ?";
      const rows = await queryText(
        pool,
        `SELECT session_id, slug, session_name, task_description, effort_level, ` +
          `status, progress_done, progress_total, mode, content, created_at, updated_at ` +
          `FROM sessions ${where} LIMIT 1;`,
        [bySessionId ? key.sessionId : key.slug],
      );
      return rows[0] ?? null;
    },
  };
}

// ─── memories ────────────────────────────────────────────────────────────────

export function doltMemoryReader(pool: DoltSelect): MemoryReader {
  return {
    injected(clearance) {
      if (clearance.length === 0) return Promise.resolve([]);
      return queryText(
        pool,
        `SELECT memory_id, slug, type, name, description, content ` +
          `FROM memories WHERE inject = 'always' ` +
          `AND visibility IN (${placeholders(clearance)}) ORDER BY type, slug;`,
        [...clearance],
      );
    },
    indexed(clearance) {
      if (clearance.length === 0) return Promise.resolve([]);
      return queryText(
        pool,
        `SELECT slug, type, name, description ` +
          `FROM memories WHERE inject = 'index' ` +
          `AND visibility IN (${placeholders(clearance)}) ORDER BY type, slug;`,
        [...clearance],
      );
    },
    async bySlug(slug: string, clearance: readonly MemoryVisibility[]) {
      if (clearance.length === 0) return null;
      const rows = await queryText(
        pool,
        `SELECT memory_id, slug, type, name, description, content ` +
          `FROM memories WHERE slug = ? ` +
          `AND visibility IN (${placeholders(clearance)}) LIMIT 1;`,
        [slug, ...clearance],
      );
      return rows[0] ?? null;
    },
    list(clearance, filter: { type?: MemoryType } = {}) {
      if (clearance.length === 0) return Promise.resolve([]);
      const predicates = [`visibility IN (${placeholders(clearance)})`];
      const params: SqlParam[] = [...clearance];
      if (filter.type) {
        predicates.push("type = ?");
        params.push(filter.type);
      }
      return queryText(
        pool,
        `SELECT slug, type, name, description FROM memories ` +
          `WHERE ${predicates.join(" AND ")} ORDER BY type, slug;`,
        params,
      );
    },
  };
}

// ─── reference data ──────────────────────────────────────────────────────────

export function doltModelReader(pool: DoltSelect): ModelReader {
  return {
    async listActive() {
      try {
        return await queryText(
          pool,
          "SELECT slug, display_name, provider, api, base_url, tier, " +
            "cost_input, cost_output, capabilities, " +
            "context_window, max_output_tokens, " +
            "architecture, total_params_b, active_params_b, recommended_quant, " +
            "resident_ram_gib, reasoning_effort_control " +
            "FROM models WHERE active = TRUE ORDER BY tier, slug;",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          message.includes("architecture") ||
          message.includes("Unknown column")
        ) {
          return await queryText(
            pool,
            "SELECT slug, display_name, provider, api, base_url, tier, " +
              "cost_input, cost_output, capabilities, " +
              "context_window, max_output_tokens " +
              "FROM models WHERE active = TRUE ORDER BY tier, slug;",
          );
        }
        throw err;
      }
    },
  };
}

export function doltPromptReader(pool: DoltSelect): PromptReader {
  return {
    async active(slug) {
      const rows = await queryText(
        pool,
        "SELECT content FROM prompts " +
          "WHERE slug = ? AND active = TRUE LIMIT 1;",
        [slug],
      );
      return rows[0] ?? null;
    },
  };
}

// ─── spend ───────────────────────────────────────────────────────────────────

export function doltSpendReader(pool: DoltSelect): SpendReader {
  return {
    async baselines(sessionId, dayStart): Promise<SpendBaselineSums> {
      const rows = await queryText(
        pool,
        "SELECT " +
          "COALESCE(SUM(CASE WHEN session_id = ? THEN cost_total ELSE 0 END), 0) AS session_spent, " +
          "COALESCE(SUM(CASE WHEN session_id = ? AND created_at >= ? THEN cost_total ELSE 0 END), 0) AS session_today, " +
          "COALESCE(SUM(CASE WHEN created_at >= ? AND session_id <> ? THEN cost_total ELSE 0 END), 0) AS daily_others " +
          "FROM events WHERE event_type = 'model_response' AND cost_total IS NOT NULL AND cost_total > 0",
        [sessionId, sessionId, dayStart, dayStart, sessionId],
      );
      return {
        sessionSpentUsd: Number(rows[0]?.session_spent ?? 0) || 0,
        sessionSpentTodayUsd: Number(rows[0]?.session_today ?? 0) || 0,
        dailyOtherSessionsUsd: Number(rows[0]?.daily_others ?? 0) || 0,
      };
    },
  };
}
