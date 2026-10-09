/**
 * The store port: the types every adapter implements and every caller sees
 * (`specs/02-data-layer.md` section 2). See `mod.ts` for the directory's
 * responsibility.
 */

import type {
  EventColumn,
  EventInsert,
  MemoryType,
  MemoryVisibility,
} from "./generated/rows.ts";
import type { UnjournaledMutation } from "./unjournaled.ts";

/** A row as the driver renders it to text; SQL NULL reads as "". */
export type TextRow = Record<string, string>;

export interface CommitBatch {
  /**
   * Events to append, built with `events/builders.ts`. A null column is
   * omitted, so its DDL default applies; booleans are stored as 0/1.
   */
  events: readonly EventInsert[];
  mutations?: readonly UnjournaledMutation[];
}

export interface CommitOptions {
  /**
   * Abort the commit. An abort before the transaction commits rejects with
   * an `AbortError` and leaves nothing written. An abort cannot recall a
   * COMMIT already sent: if the server acknowledges it, the batch is durable
   * and `commit` resolves; if the connection is lost first, `commit` rejects
   * with the driver's error and the outcome is unknown, so a caller that must
   * know reads the batch back (`events.exists`).
   */
  signal?: AbortSignal;
}

export interface CommitReceipt {
  /** `event_id` of each appended event, in batch order. */
  eventIds: string[];
  /** Number of unjournaled mutations applied. */
  mutations: number;
}

/**
 * The only mutation path. A batch's events, their projections and its declared
 * mutations are applied in one transaction: all of them, or none.
 */
export interface Journal {
  commit(batch: CommitBatch, options?: CommitOptions): Promise<CommitReceipt>;
}

export interface SessionEventsQuery {
  sessionId: string;
  /** Only this event (still scoped to the session). */
  eventId?: string;
  /**
   * Read the table as of a Dolt commit timestamp
   * (`YYYY-MM-DD HH:MM:SS[.ffffff]`, `T` accepted). Dolt time travel;
   * `MemoryStore` rejects it.
   */
  asOf?: string;
  /** Positive integer row cap. */
  limit: number;
  order: "asc" | "desc";
}

/** The columns `EventReader.bySession` returns, in order. */
export const SESSION_EVENT_COLUMNS = [
  "event_id",
  "event_type",
  "trace_id",
  "span_id",
  "parent_span_id",
  "trace_flags",
  "trace_state",
  "span_kind",
  "parent_is_remote",
  "principal_id",
  "model_id",
  "provider",
  "api",
  "content",
  "stop_reason",
  "tokens_input",
  "tokens_output",
  "tokens_cache_read",
  "tokens_cache_write",
  "cost_total",
  "duration_ms",
  "provider_call_order",
  "provider_call_purpose",
  "provider_error_class",
  "unparsed_tool_call_count",
  "unparsed_tool_call_count_is_lower_bound",
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
  "tool_name",
  "tool_call_id",
  "tool_arguments",
  "tool_result",
  "tool_is_error",
  "created_at",
] as const satisfies readonly EventColumn[];

export interface EventReader {
  exists(eventId: string): Promise<boolean>;
  countBySession(sessionId: string): Promise<number>;
  /**
   * A session's events, ordered by `created_at` then `event_id`. The rows
   * carry the columns a transcript projection reads; JSON columns
   * (`tool_arguments`, `runner_capabilities`) are rendered as JSON text.
   */
  bySession(query: SessionEventsQuery): Promise<TextRow[]>;
  /**
   * What the session last ran on, or null when it never ran: the newer of
   * its latest `provider_call` that completed (stop reason `stop`, `length`
   * or `tool_use`; compression calls excluded), which names a native model,
   * and its latest `agent_response`, which names an external-agent runner
   * profile. A model a turn only selected, or whose call failed or never
   * dispatched, does not count.
   */
  latestRun(sessionId: string): Promise<SessionLastRun | null>;
}

/** What a session last ran on: a native model, or an external-agent runner. */
export type SessionLastRun =
  | { kind: "model"; slug: string }
  | { kind: "runner"; profile: string };

export interface SessionReader {
  /** `{ workspace }` for a session, or null when there is no such session. */
  workspace(sessionId: string): Promise<TextRow | null>;
  /** The listing columns of one session, or null. */
  summary(sessionId: string): Promise<TextRow | null>;
  /**
   * Sessions by latest activity (`COALESCE(updated_at, created_at)` desc),
   * optionally one project's, capped at `limit` (a positive integer).
   */
  list(query: { project?: string; limit: number }): Promise<TextRow[]>;
  /** Newest sessions first, optionally by status (memory MCP listing). */
  recent(query: { status?: string; limit: number }): Promise<TextRow[]>;
  /** One session's full record by id or slug (memory MCP `get_session`). */
  detail(key: { sessionId: string } | { slug: string }): Promise<
    TextRow | null
  >;
}

export interface MemoryReader {
  /** Full rows classified `inject = 'always'` within the clearance. */
  injected(clearance: readonly MemoryVisibility[]): Promise<TextRow[]>;
  /** Index rows (no content) classified `inject = 'index'`. */
  indexed(clearance: readonly MemoryVisibility[]): Promise<TextRow[]>;
  /** One full row by slug, if its visibility is within the clearance. */
  bySlug(
    slug: string,
    clearance: readonly MemoryVisibility[],
  ): Promise<TextRow | null>;
  /** Index rows of every inject class, optionally of one type. */
  list(
    clearance: readonly MemoryVisibility[],
    filter?: { type?: MemoryType },
  ): Promise<TextRow[]>;
}

/** Reference data: the model catalog (written only by `schema/`). */
export interface ModelReader {
  /** Active catalog rows, by tier then slug. */
  listActive(): Promise<TextRow[]>;
  /**
   * Slugs of the catalog rows marked inactive, sorted. The built-in local
   * defaults are overlaid only where the catalog has no row at all, so an
   * operator's deactivation sticks.
   */
  listInactiveSlugs(): Promise<string[]>;
}

/** Reference data: companion prompts (written only by `schema/`). */
export interface PromptReader {
  /** `{ content }` of the active prompt with this slug, or null. */
  active(slug: string): Promise<TextRow | null>;
}

export interface SpendBaselineSums {
  /** This session's lifetime `model_response` spend. */
  sessionSpentUsd: number;
  /** This session's spend at or after `dayStart`. */
  sessionSpentTodayUsd: number;
  /** Every other session's spend at or after `dayStart`. */
  dailyOtherSessionsUsd: number;
}

/** Spend rolled up from `model_response` events. */
export interface SpendReader {
  /** `dayStart` is a `YYYY-MM-DD HH:MM:SS` local-clock boundary. */
  baselines(sessionId: string, dayStart: string): Promise<SpendBaselineSums>;
}

export interface Store {
  /** The only mutation path. */
  journal: Journal;
  events: EventReader;
  sessions: SessionReader;
  memories: MemoryReader;
  models: ModelReader;
  prompts: PromptReader;
  spend: SpendReader;
  close(): Promise<void>;
}

const AS_OF_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;

export function isValidAsOfTimestamp(value: string): boolean {
  return AS_OF_TIMESTAMP.test(value);
}

/** Thrown by `bySession` for a malformed `asOf`. */
export function invalidAsOfError(): Error {
  return new Error("asOf must be a timestamp like 2026-06-12 10:00:00");
}
