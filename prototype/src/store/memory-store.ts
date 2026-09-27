/**
 * `MemoryStore`: the store port held in process memory, for unit and component
 * tests. It passes the same conformance suite as `DoltStore`
 * (`testing/conformance/store.ts`), so it renders rows the way the Dolt driver
 * does: timestamps through `String(Date)`, DECIMAL columns at their scale,
 * booleans as 0/1, JSON cast to text in MySQL's canonical form, NULL as "".
 * ENUM columns sort by declaration order, as MySQL sorts them.
 *
 * A commit applies to a copy of the tables and replaces them only when every
 * statement succeeded, so a failed batch changes nothing.
 */

import {
  type CommitBatch,
  type CommitOptions,
  type CommitReceipt,
  type EventReader,
  invalidAsOfError,
  isValidAsOfTimestamp,
  type Journal,
  type MemoryReader,
  type ModelReader,
  type PromptReader,
  type SessionReader,
  type SpendReader,
  type Store,
  type TextRow,
} from "./port.ts";
import type {
  EventInsert,
  MemoryType,
  MemoryVisibility,
} from "./generated/rows.ts";
import {
  assertProjectableRow,
  PHASE1_PROJECTORS,
  PROJECTED_TABLES,
  type ProjectionRow,
  type Projector,
} from "./projectors.ts";
import {
  assertDeclaredMutations,
  type UnjournaledMutation,
} from "./unjournaled.ts";

type Value = string | number | Date | null;
type Row = Record<string, Value>;

// ─── column rendering (what the Dolt driver hands back, as text) ─────────────

const EVENT_TYPES = [
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

const EVENT_COLUMNS = [
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

const EVENT_REQUIRED = [
  "event_id",
  "session_id",
  "event_type",
  "trace_id",
  "span_id",
  "principal_id",
  "principal_type",
  "action",
  "resource",
  "authz_basis",
];

type ColumnKind = "int" | "decimal6" | "json" | "timestamp" | "text";

const EVENT_COLUMN_KINDS: Record<string, ColumnKind> = {
  created_at: "timestamp",
  authn_authenticated_at: "timestamp",
  authn_expires_at: "timestamp",
  trace_flags: "int",
  parent_is_remote: "int",
  tokens_input: "int",
  tokens_output: "int",
  tokens_cache_read: "int",
  tokens_cache_write: "int",
  cost_total: "decimal6",
  provider_call_order: "int",
  unparsed_tool_call_count: "int",
  unparsed_tool_call_count_is_lower_bound: "int",
  tool_is_error: "int",
  duration_ms: "int",
  runner_capabilities: "json",
  tool_arguments: "json",
};

/** The columns `bySession` selects, in order. */
const SESSION_EVENT_COLUMNS = [
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
];

const MEMORY_TYPE_ORDER = [
  "user",
  "feedback",
  "environment",
  "project",
  "reference",
];

/** MySQL's canonical JSON text: keys by length then bytes, ", " and ": ". */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) =>
      a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
    );
    return `{${
      keys.map((k) =>
        `${JSON.stringify(k)}: ${
          canonicalJson((value as Record<string, unknown>)[k])
        }`
      ).join(", ")
    }}`;
  }
  return JSON.stringify(value);
}

function sqlError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function storeEventValue(column: string, raw: unknown): Value {
  // The caller skips null columns; a present-but-undefined one binds NULL.
  if (raw === undefined) return null;
  const kind = EVENT_COLUMN_KINDS[column] ?? "text";
  switch (kind) {
    case "int":
      return typeof raw === "boolean" ? (raw ? 1 : 0) : Number(raw);
    case "decimal6":
      return Number(raw);
    case "json": {
      let parsed: unknown;
      try {
        parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        throw sqlError(
          "ER_INVALID_JSON_TEXT",
          `Invalid JSON text for column '${column}'`,
        );
      }
      return canonicalJson(parsed);
    }
    case "timestamp":
      return raw instanceof Date ? raw : new Date(String(raw));
    case "text":
      return String(raw);
  }
}

function renderEventValue(column: string, value: Value): string {
  if (value === null) return "";
  if (EVENT_COLUMN_KINDS[column] === "decimal6") {
    return (value as number).toFixed(6);
  }
  return String(value);
}

function renderRow(row: Row, columns: readonly string[]): TextRow {
  const out: TextRow = {};
  for (const column of columns) {
    const value = row[column] ?? null;
    out[column] = value === null ? "" : String(value);
  }
  return out;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Local-clock `YYYY-MM-DD HH:MM:SS` boundary, as the server compares it. */
function localBoundary(text: string): number {
  return new Date(text.replace(" ", "T")).getTime();
}

// ─── seed rows (reference data and fixtures the runtime never writes) ────────

export interface ModelSeed {
  slug: string;
  display_name: string;
  provider: string;
  api: string;
  base_url?: string | null;
  tier: number;
  context_window: number;
  max_output_tokens: number;
  cost_input?: number;
  cost_output?: number;
  capabilities: readonly string[];
  architecture?: string | null;
  total_params_b?: number | null;
  active_params_b?: number | null;
  recommended_quant?: string | null;
  resident_ram_gib?: number | null;
  reasoning_effort_control?: boolean;
  active?: boolean;
}

export interface PromptSeed {
  slug: string;
  display_name: string;
  kind: string;
  content: string;
  position?: number;
  active?: boolean;
}

export interface MemorySeed {
  memory_id: string;
  slug: string;
  type: MemoryType;
  visibility?: MemoryVisibility;
  inject?: "always" | "index" | "never";
  name: string;
  description: string;
  content: string;
}

export interface MemoryStoreSeed {
  models?: readonly ModelSeed[];
  prompts?: readonly PromptSeed[];
  memories?: readonly MemorySeed[];
}

// ─── tables ──────────────────────────────────────────────────────────────────

interface Stamped {
  row: Row;
  /** Insertion order: breaks created_at ties the way microseconds do. */
  seq: number;
}

interface StampedEvent {
  row: Row;
  /**
   * Insertion order, for an event whose created_at the store assigned: it
   * breaks ties the way Dolt's microseconds do (`Date` holds only
   * milliseconds). An event whose caller supplied created_at has none, so
   * equal timestamps fall through to event_id, as they do in Dolt.
   */
  seq: number | null;
}

interface Tables {
  events: StampedEvent[];
  sessions: Map<string, Stamped>;
  memories: Map<string, Stamped>;
}

function copyTables(tables: Tables): Tables {
  const copyMap = (m: Map<string, Stamped>) =>
    new Map(
      [...m].map(([k, v]) => [k, { row: { ...v.row }, seq: v.seq }]),
    );
  return {
    events: [...tables.events],
    sessions: copyMap(tables.sessions),
    memories: copyMap(tables.memories),
  };
}

const SESSION_DEFAULTS: Row = {
  session_name: null,
  external_id: null,
  project: null,
  workspace: null,
  effort_level: null,
  status: "active",
  progress_done: 0,
  progress_total: 0,
  mode: "interactive",
  iteration: null,
  content: null,
};

const MEMORY_DEFAULTS: Row = { visibility: "private", inject: "index" };

function abortError(): DOMException {
  return new DOMException("Event write aborted", "AbortError");
}

export class MemoryStore implements Store {
  readonly journal: Journal;
  readonly events: EventReader;
  readonly sessions: SessionReader;
  readonly memories: MemoryReader;
  readonly models: ModelReader;
  readonly prompts: PromptReader;
  readonly spend: SpendReader;

  #tables: Tables = { events: [], sessions: new Map(), memories: new Map() };
  #seq = 0;
  readonly #now: () => Date;
  readonly #projectors: readonly Projector[];
  readonly #models: Row[];
  readonly #prompts: Row[];

  constructor(
    seed: MemoryStoreSeed = {},
    options: { now?: () => Date; projectors?: readonly Projector[] } = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#projectors = options.projectors ?? PHASE1_PROJECTORS;
    this.#models = (seed.models ?? []).map((m) => ({
      slug: m.slug,
      display_name: m.display_name,
      provider: m.provider,
      api: m.api,
      base_url: m.base_url ?? null,
      tier: m.tier,
      cost_input: (m.cost_input ?? 0).toFixed(6),
      cost_output: (m.cost_output ?? 0).toFixed(6),
      // The driver decodes the JSON column to an array; text is its join.
      capabilities: String([...m.capabilities]),
      context_window: m.context_window,
      max_output_tokens: m.max_output_tokens,
      architecture: m.architecture ?? null,
      total_params_b: m.total_params_b == null
        ? null
        : m.total_params_b.toFixed(2),
      active_params_b: m.active_params_b == null
        ? null
        : m.active_params_b.toFixed(2),
      recommended_quant: m.recommended_quant ?? null,
      resident_ram_gib: m.resident_ram_gib == null
        ? null
        : m.resident_ram_gib.toFixed(2),
      reasoning_effort_control: m.reasoning_effort_control ? 1 : 0,
      active: m.active === false ? 0 : 1,
    }));
    this.#prompts = (seed.prompts ?? []).map((p) => ({
      slug: p.slug,
      content: p.content,
      active: p.active === false ? 0 : 1,
    }));
    const at = this.#now();
    for (const m of seed.memories ?? []) {
      this.#tables.memories.set(m.memory_id, {
        row: {
          ...MEMORY_DEFAULTS,
          ...m,
          created_at: at,
          updated_at: at,
        } as Row,
        seq: this.#seq++,
      });
    }
    this.journal = { commit: (batch, opts) => this.#commit(batch, opts) };
    this.events = this.#eventReader();
    this.sessions = this.#sessionReader();
    this.memories = this.#memoryReader();
    this.models = {
      listActive: () =>
        Promise.resolve(
          this.#models
            .filter((m) => m.active === 1)
            .sort((a, b) =>
              (a.tier as number) - (b.tier as number) ||
              compareText(a.slug as string, b.slug as string)
            )
            .map((m) =>
              renderRow(m, [
                "slug",
                "display_name",
                "provider",
                "api",
                "base_url",
                "tier",
                "cost_input",
                "cost_output",
                "capabilities",
                "context_window",
                "max_output_tokens",
                "architecture",
                "total_params_b",
                "active_params_b",
                "recommended_quant",
                "resident_ram_gib",
                "reasoning_effort_control",
              ])
            ),
        ),
    };
    this.prompts = {
      active: (slug) => {
        const row = this.#prompts.find((p) =>
          p.slug === slug && p.active === 1
        );
        return Promise.resolve(row ? renderRow(row, ["content"]) : null);
      },
    };
    this.spend = {
      baselines: (sessionId, dayStart) => {
        const boundary = localBoundary(dayStart);
        let session = 0;
        let today = 0;
        let others = 0;
        for (const { row } of this.#tables.events) {
          const cost = row.cost_total as number | null;
          if (row.event_type !== "model_response") continue;
          if (cost === null || !(cost > 0)) continue;
          const recent = (row.created_at as Date).getTime() >= boundary;
          if (row.session_id === sessionId) {
            session += cost;
            if (recent) today += cost;
          } else if (recent) {
            others += cost;
          }
        }
        const sum = (n: number) => Number(n.toFixed(6));
        return Promise.resolve({
          sessionSpentUsd: sum(session),
          sessionSpentTodayUsd: sum(today),
          dailyOtherSessionsUsd: sum(others),
        });
      },
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  // ─── journal ───────────────────────────────────────────────────────────────

  #commit(
    batch: CommitBatch,
    options: CommitOptions = {},
  ): Promise<CommitReceipt> {
    try {
      if (options.signal?.aborted) throw abortError();
      const mutations = batch.mutations ?? [];
      assertDeclaredMutations(mutations);
      const next = copyTables(this.#tables);
      let seq = this.#seq;
      const now = this.#now();
      for (const event of batch.events) {
        const stampedByStore = event.created_at == null;
        next.events.push({
          row: this.#eventRow(event, now),
          seq: stampedByStore ? seq++ : null,
        });
        for (const projector of this.#projectors) {
          seq = this.#project(next, projector, event, now, seq);
        }
      }
      for (const mutation of mutations) {
        seq = this.#mutate(next, mutation, now, seq);
      }
      if (options.signal?.aborted) throw abortError();
      const existing = new Set(this.#tables.events.map((e) => e.row.event_id));
      const seen = new Set<Value>();
      for (const { row } of next.events.slice(this.#tables.events.length)) {
        if (existing.has(row.event_id) || seen.has(row.event_id)) {
          throw sqlError(
            "ER_DUP_ENTRY",
            `duplicate primary key given: [${String(row.event_id)}]`,
          );
        }
        seen.add(row.event_id);
      }
      this.#tables = next;
      this.#seq = seq;
      return Promise.resolve({
        eventIds: batch.events.map((e) => String(e.event_id ?? "")),
        mutations: mutations.length,
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #eventRow(event: EventInsert, now: Date): Row {
    const row: Row = {};
    for (const [column, raw] of Object.entries(event)) {
      if (raw === null) continue;
      if (!(EVENT_COLUMNS as readonly string[]).includes(column)) {
        throw sqlError(
          "ER_BAD_FIELD_ERROR",
          `Unknown column '${column}' in 'events'`,
        );
      }
      row[column] = storeEventValue(column, raw);
    }
    for (const column of EVENT_REQUIRED) {
      if (!(column in row)) {
        throw sqlError(
          "ER_UNKNOWN_ERROR",
          `Field '${column}' doesn't have a default value`,
        );
      }
      if (row[column] === null) {
        throw sqlError(
          "ER_BAD_NULL_ERROR",
          `Column '${column}' cannot be null`,
        );
      }
    }
    if (!(EVENT_TYPES as readonly Value[]).includes(row.event_type)) {
      throw sqlError(
        "ER_UNKNOWN_ERROR",
        `invalid enum value for event_type: ${String(row.event_type)}`,
      );
    }
    for (const column of EVENT_COLUMNS) {
      if (!(column in row)) row[column] = null;
    }
    if (row.created_at === null) row.created_at = now;
    if (row.authn_status === null) row.authn_status = "unknown";
    return row;
  }

  #project(
    tables: Tables,
    projector: Projector,
    event: EventInsert,
    now: Date,
    seq: number,
  ): number {
    const key = projector.key(event);
    if (key === null) return seq;
    const spec = PROJECTED_TABLES[projector.table];
    const table = tables[projector.table];
    const current = table.get(key);
    const currentText = current
      ? renderRow(current.row, Object.keys(current.row))
      : null;
    const next: ProjectionRow | null = projector.project(currentText, event);
    if (next === null) {
      table.delete(key);
      return seq;
    }
    assertProjectableRow(projector.table, key, next);
    if (current === undefined) {
      const defaults = projector.table === "sessions"
        ? SESSION_DEFAULTS
        : MEMORY_DEFAULTS;
      table.set(key, {
        row: { ...defaults, ...next, created_at: now, updated_at: now },
        seq: seq++,
      });
    } else {
      const changed = Object.keys(next).some((c) =>
        c !== spec.key && current.row[c] !== next[c]
      );
      Object.assign(current.row, next);
      if (changed) current.row.updated_at = now;
    }
    return seq;
  }

  #mutate(
    tables: Tables,
    mutation: UnjournaledMutation,
    now: Date,
    seq: number,
  ): number {
    switch (mutation.kind) {
      case "session_insert": {
        for (const { row } of tables.sessions.values()) {
          if (
            row.session_id === mutation.sessionId || row.slug === mutation.slug
          ) {
            throw sqlError(
              "ER_DUP_ENTRY",
              `duplicate unique key given: [${mutation.slug}]`,
            );
          }
        }
        tables.sessions.set(mutation.sessionId, {
          row: {
            ...SESSION_DEFAULTS,
            session_id: mutation.sessionId,
            slug: mutation.slug,
            session_name: mutation.sessionName,
            task_description: mutation.taskDescription,
            status: mutation.status,
            mode: mutation.mode,
            workspace: mutation.workspace,
            content: mutation.content,
            progress_done: mutation.progressDone,
            progress_total: mutation.progressTotal,
            created_at: now,
            updated_at: now,
          },
          seq: seq++,
        });
        return seq;
      }
      case "session_update": {
        const current = tables.sessions.get(mutation.sessionId);
        if (current === undefined) return seq;
        const next: Row = {
          status: mutation.status,
          progress_done: mutation.progressDone,
          progress_total: mutation.progressTotal,
          content: mutation.content ?? current.row.content,
        };
        const changed = Object.keys(next).some((c) =>
          current.row[c] !== next[c]
        );
        Object.assign(current.row, next);
        if (changed) current.row.updated_at = now;
        return seq;
      }
      case "memory_upsert": {
        const current = [...tables.memories.values()].find(({ row }) =>
          row.memory_id === mutation.memoryId || row.slug === mutation.slug
        );
        if (current !== undefined) {
          Object.assign(current.row, {
            name: mutation.name,
            description: mutation.description,
            content: mutation.content,
            updated_at: now,
          });
          return seq;
        }
        tables.memories.set(mutation.memoryId, {
          row: {
            ...MEMORY_DEFAULTS,
            memory_id: mutation.memoryId,
            slug: mutation.slug,
            type: mutation.type,
            name: mutation.name,
            description: mutation.description,
            content: mutation.content,
            created_at: now,
            updated_at: now,
          },
          seq: seq++,
        });
        return seq;
      }
    }
  }

  // ─── readers ───────────────────────────────────────────────────────────────

  #eventReader(): EventReader {
    return {
      exists: (eventId) =>
        Promise.resolve(
          this.#tables.events.some((e) => e.row.event_id === eventId),
        ),
      countBySession: (sessionId) =>
        Promise.resolve(
          this.#tables.events.filter((e) => e.row.session_id === sessionId)
            .length,
        ),
      bySession: (query) => {
        try {
          if (query.asOf !== undefined) {
            if (!isValidAsOfTimestamp(query.asOf)) throw invalidAsOfError();
            throw new Error("MemoryStore does not support asOf time travel");
          }
          if (!Number.isInteger(query.limit) || query.limit <= 0) {
            throw new Error("limit must be a positive integer");
          }
          const direction = query.order === "desc" ? -1 : 1;
          const rows = this.#tables.events
            .filter((e) =>
              e.row.session_id === query.sessionId &&
              (!query.eventId || e.row.event_id === query.eventId)
            )
            .sort((a, b) =>
              direction * (
                (a.row.created_at as Date).getTime() -
                  (b.row.created_at as Date).getTime() ||
                (a.seq !== null && b.seq !== null ? a.seq - b.seq : 0) ||
                compareText(String(a.row.event_id), String(b.row.event_id))
              )
            )
            .slice(0, query.limit)
            .map((e) => {
              const out: TextRow = {};
              for (const column of SESSION_EVENT_COLUMNS) {
                out[column] = renderEventValue(column, e.row[column] ?? null);
              }
              return out;
            });
          return Promise.resolve(rows);
        } catch (error) {
          return Promise.reject(error);
        }
      },
    };
  }

  #sessionReader(): SessionReader {
    const byActivity = (a: Stamped, b: Stamped) =>
      (b.row.updated_at as Date).getTime() -
        (a.row.updated_at as Date).getTime() || b.seq - a.seq;
    const summaryColumns = [
      "session_id",
      "slug",
      "session_name",
      "task_description",
      "project",
      "status",
      "created_at",
      "updated_at",
    ];
    const positive = (limit: number) => {
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("limit must be a positive integer");
      }
      return limit;
    };
    return {
      workspace: (sessionId) => {
        const s = this.#tables.sessions.get(sessionId);
        return Promise.resolve(s ? renderRow(s.row, ["workspace"]) : null);
      },
      summary: (sessionId) => {
        const s = this.#tables.sessions.get(sessionId);
        return Promise.resolve(s ? renderRow(s.row, summaryColumns) : null);
      },
      list: ({ project, limit }) => {
        try {
          const bounded = positive(limit);
          return Promise.resolve(
            [...this.#tables.sessions.values()]
              .filter((s) => project === undefined || s.row.project === project)
              .sort(byActivity)
              .slice(0, bounded)
              .map((s) => renderRow(s.row, summaryColumns)),
          );
        } catch (error) {
          return Promise.reject(error);
        }
      },
      recent: ({ status, limit }) => {
        try {
          positive(limit);
        } catch (error) {
          return Promise.reject(error);
        }
        return Promise.resolve(
          [...this.#tables.sessions.values()]
            .filter((s) => !status || s.row.status === status)
            .sort((a, b) =>
              (b.row.created_at as Date).getTime() -
                (a.row.created_at as Date).getTime() || b.seq - a.seq
            )
            .slice(0, limit)
            .map((s) =>
              renderRow(s.row, [
                "session_id",
                "slug",
                "session_name",
                "task_description",
                "status",
                "progress_done",
                "progress_total",
                "created_at",
              ])
            ),
        );
      },
      detail: (key) => {
        const s = [...this.#tables.sessions.values()].find((s) =>
          "sessionId" in key
            ? s.row.session_id === key.sessionId
            : s.row.slug === key.slug
        );
        return Promise.resolve(
          s
            ? renderRow(s.row, [
              "session_id",
              "slug",
              "session_name",
              "task_description",
              "effort_level",
              "status",
              "progress_done",
              "progress_total",
              "mode",
              "content",
              "created_at",
              "updated_at",
            ])
            : null,
        );
      },
    };
  }

  #memoryReader(): MemoryReader {
    const within = (clearance: readonly MemoryVisibility[]) =>
      [...this.#tables.memories.values()]
        .map((m) => m.row)
        .filter((row) =>
          (clearance as readonly Value[]).includes(row.visibility)
        )
        .sort((a, b) =>
          MEMORY_TYPE_ORDER.indexOf(a.type as string) -
            MEMORY_TYPE_ORDER.indexOf(b.type as string) ||
          compareText(a.slug as string, b.slug as string)
        );
    const full = [
      "memory_id",
      "slug",
      "type",
      "name",
      "description",
      "content",
    ];
    const index = ["slug", "type", "name", "description"];
    return {
      injected: (clearance) =>
        Promise.resolve(
          within(clearance).filter((r) => r.inject === "always").map((r) =>
            renderRow(r, full)
          ),
        ),
      indexed: (clearance) =>
        Promise.resolve(
          within(clearance).filter((r) => r.inject === "index").map((r) =>
            renderRow(r, index)
          ),
        ),
      bySlug: (slug, clearance) => {
        const row = within(clearance).find((r) => r.slug === slug);
        return Promise.resolve(row ? renderRow(row, full) : null);
      },
      list: (clearance, filter = {}) =>
        Promise.resolve(
          within(clearance)
            .filter((r) => !filter.type || r.type === filter.type)
            .map((r) => renderRow(r, index)),
        ),
    };
  }
}
