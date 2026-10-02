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
import {
  invalidAsOfError,
  isValidAsOfTimestamp,
  SESSION_EVENT_COLUMNS,
} from "./port.ts";
import {
  EVENT_COLUMN_SPECS,
  type MemoryType,
  type MemoryVisibility,
} from "./generated/rows.ts";

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

/**
 * The `bySession` select list. Dolt/MySQL drivers may decode JSON columns to
 * objects, so JSON columns (`runner_capabilities`, `tool_arguments`) are cast
 * to text and Workbench owns their validation.
 */
const SESSION_EVENT_SELECT = SESSION_EVENT_COLUMNS.map((column) =>
  EVENT_COLUMN_SPECS[column].kind === "json"
    ? `CAST(${column} AS CHAR) AS ${column}`
    : column
).join(", ");

/** A session's events, oldest or newest first, optionally one event. */
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
  const params: string[] = [input.sessionId];
  let eventClause = "";
  if (typeof input.eventId === "string" && input.eventId.length > 0) {
    eventClause = " AND event_id = ?";
    params.push(input.eventId);
  }
  const order = input.order === "desc" ? "DESC" : "ASC";
  return await queryText(
    pool,
    `SELECT ${SESSION_EVENT_SELECT} FROM events${asOfClause} ` +
      `WHERE session_id = ?${eventClause} ` +
      `ORDER BY created_at ${order}, event_id ${order} LIMIT ${limit};`,
    params,
  );
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
    listActive() {
      return queryText(
        pool,
        "SELECT slug, display_name, provider, api, base_url, tier, " +
          "cost_input, cost_output, cost_cache_read, cost_cache_write, " +
          "capabilities, " +
          "context_window, max_output_tokens, " +
          "architecture, total_params_b, active_params_b, recommended_quant, " +
          "resident_ram_gib, reasoning_effort_control " +
          "FROM models WHERE active = TRUE ORDER BY tier, slug;",
      );
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
