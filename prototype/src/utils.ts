import { generateSpanId, generateULID } from "./kernel/mod.ts";
import { type Env, processEnv, resolvePrincipalId } from "./config/mod.ts";

// ─── Dolt infrastructure (TCP → sql-server) ─────────────────────────────────
// Uses mysql2 over TCP to avoid file-lock conflicts with dolt sql-server.
// sql-server is managed by launchd: org.dyfj.dolt-sql-server

import mysqlCore from "mysql2";
import mysql from "mysql2/promise";

let _pool: any | null = null;

export type SqlParam = string | number | boolean | null;

export function buildDoltPoolOptions(
  env: Record<string, string | undefined> = readDoltEnv(processEnv),
): mysql.PoolOptions {
  return {
    host: env.DOLT_HOST ?? "127.0.0.1",
    port: Number(env.DOLT_PORT ?? "3306"),
    user: env.DOLT_USER ?? "root",
    password: env.DOLT_PASSWORD ?? "",
    database: env.DOLT_DATABASE ?? "dolt",
    waitForConnections: true,
    connectionLimit: 5,
  };
}

function readDoltEnv(env: Env): Record<string, string | undefined> {
  return {
    DOLT_HOST: env.get("DOLT_HOST"),
    DOLT_PORT: env.get("DOLT_PORT"),
    DOLT_USER: env.get("DOLT_USER"),
    DOLT_PASSWORD: env.get("DOLT_PASSWORD"),
    DOLT_DATABASE: env.get("DOLT_DATABASE"),
  };
}

function getDoltPool(): any {
  if (!_pool) {
    _pool = mysql.createPool(buildDoltPoolOptions());
  }
  return _pool;
}

export async function closeDoltPool(): Promise<void> {
  if (!_pool) return;
  await _pool.end();
  _pool = null;
}

/** Execute a SELECT query. Returns rows as plain string-value objects. */
export async function doltQuery(
  sql: string,
  params: SqlParam[] = [],
): Promise<Record<string, string>[]> {
  const [rows] = await getDoltPool().execute(sql, params);
  return (rows as mysql.RowDataPacket[]).map((r) => {
    const out: Record<string, string> = {};
    for (const k of Object.keys(r)) out[k] = r[k] == null ? "" : String(r[k]);
    return out;
  });
}

export async function doltExec(
  sql: string,
  params: SqlParam[] = [],
): Promise<void> {
  await getDoltPool().execute(sql, params);
}

export async function writeEvent(
  event: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const columns = Object.keys(event).filter((k) => event[k] !== null);
  const placeholders = columns.map(() => "?").join(", ");
  const values = columns.map((k) => {
    const v = event[k];
    if (typeof v === "boolean") return v ? 1 : 0;
    return v ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any[];
  const sql = `INSERT INTO events (${
    columns.join(", ")
  }) VALUES (${placeholders})`;
  if (options.signal === undefined) {
    await getDoltPool().execute(sql, values);
    return;
  }
  if (options.signal.aborted) {
    throw new DOMException("Event write aborted", "AbortError");
  }
  const rawConnection = mysqlCore.createConnection(buildDoltPoolOptions());
  const connection = rawConnection.promise();
  let rejectAbort: ((reason: DOMException) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    rawConnection.destroy();
    rejectAbort?.(new DOMException("Event write aborted", "AbortError"));
  };
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  try {
    await Promise.race([connection.connect(), aborted]);
    await connection.beginTransaction();
    await connection.execute(sql, values);
    if (options.signal.aborted) {
      throw new DOMException("Event write aborted", "AbortError");
    }
    await connection.commit();
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // A cancellation may already have destroyed the connection.
    }
    throw error;
  } finally {
    options.signal.removeEventListener("abort", abort);
    rawConnection.destroy();
  }
}

/**
 * Whether an event row is durable, by its (caller-generated) id.
 *
 * `writeEvent` is a bare autocommit INSERT, so a rejection cannot be told apart
 * from "committed, but the acknowledgment was lost". That ambiguity is harmless
 * for an event that only records what happened, but not for one whose presence
 * CHANGES how the transcript is later reconstructed: such a writer must be able
 * to ask whether the row actually landed. Deliberately narrow — only the context
 * compression write needs this today; generalizing it across every writer is a
 * separate concern.
 */
export async function eventExists(eventId: string): Promise<boolean> {
  const rows = await doltQuery(
    "SELECT event_id FROM events WHERE event_id = ? LIMIT 1",
    [eventId],
  );
  return rows.length > 0;
}

// ─── Telemetry helpers ────────────────────────────────────────────────────────

export async function writeModelSelectedEvent(params: {
  selected: string;
  considered: string[];
  reason: string;
  sessionId: string;
  traceId: string;
  provider?: string;
  api?: string;
  durationMs?: number;
  parentSpanId?: string;
  authnFields?: Record<string, unknown>;
}): Promise<void> {
  await writeEvent(buildModelSelectedEventPayload(params));
}

function buildModelSelectedEventPayload(params: {
  selected: string;
  considered: string[];
  reason: string;
  sessionId: string;
  traceId: string;
  provider?: string;
  api?: string;
  durationMs?: number;
  eventId?: string;
  spanId?: string;
  parentSpanId?: string;
  principalId?: string;
  authnFields?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    event_id: params.eventId ?? generateULID(),
    session_id: params.sessionId,
    event_type: "model_selected",
    trace_id: params.traceId,
    span_id: params.spanId ?? generateSpanId(),
    parent_span_id: params.parentSpanId ?? null,
    principal_id: params.principalId ??
      resolvePrincipalId(processEnv),
    principal_type: "human",
    action: "select",
    resource: params.selected,
    authz_basis: "routing_heuristic",
    model_id: params.selected,
    provider: params.provider ?? null,
    api: params.api ?? null,
    ...params.authnFields,
    content: JSON.stringify({
      selected: params.selected,
      considered: params.considered,
      reason: params.reason,
    }),
    duration_ms: params.durationMs ?? null,
  };
}
