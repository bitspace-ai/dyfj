import { ulid } from "ulid";
import process from "node:process";

export type MessageContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: string; [key: string]: unknown };

export function generateULID(): string {
  return ulid();
}

// W3C trace context compatible — 32 hex chars
export function generateTraceId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 32);
}

// 16 hex chars
export function generateSpanId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export function extractText(content: MessageContent[]): string | null {
  const texts = content.filter(isTextContent).map((c) => c.text);
  return texts.length > 0 ? texts.join("") : null;
}

export function extractThinking(content: MessageContent[]): string | null {
  const thoughts = content.filter(isThinkingContent).map((c) => c.thinking);
  return thoughts.length > 0 ? thoughts.join("") : null;
}

function isTextContent(
  content: MessageContent,
): content is { type: "text"; text: string } {
  return content.type === "text" && typeof content.text === "string";
}

function isThinkingContent(
  content: MessageContent,
): content is { type: "thinking"; thinking: string } {
  return content.type === "thinking" && typeof content.thinking === "string";
}

// ─── Dolt infrastructure (TCP → sql-server) ─────────────────────────────────
// Uses mysql2 over TCP to avoid file-lock conflicts with dolt sql-server.
// sql-server is managed by launchd: org.dyfj.dolt-sql-server

import mysql from "mysql2/promise";

let _pool: any | null = null;

export type SqlParam = string | number | boolean | null;

export function buildDoltPoolOptions(
  env: Record<string, string | undefined> = process.env,
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

/**
 * Split a CSV string into rows of fields, correctly handling:
 *   - Quoted fields containing commas, newlines, or escaped double-quotes ("")
 *   - \r\n and \n line endings
 *   - Trailing blank lines
 *
 * Returns string[][] where each inner array is one row's field values
 * (outer quotes stripped, "" unescaped to ").
 */
export function parseCSVRows(csv: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < csv.length) {
    const ch = csv[i];

    if (ch === '"') {
      if (inQuotes && csv[i + 1] === '"') {
        field += '"'; // escaped quote
        i += 2;
        continue;
      }
      inQuotes = !inQuotes;
      i++;
      continue;
    }

    if (ch === "," && !inQuotes) {
      currentRow.push(field);
      field = "";
      i++;
      continue;
    }

    if (ch === "\r" && !inQuotes) {
      i++; // skip bare \r
      continue;
    }

    if (ch === "\n" && !inQuotes) {
      currentRow.push(field);
      field = "";
      if (currentRow.some((f) => f.length > 0)) rows.push(currentRow);
      currentRow = [];
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  // Flush final row
  currentRow.push(field);
  if (currentRow.some((f) => f.length > 0)) rows.push(currentRow);

  return rows;
}

/** Parse a single CSV row. Handles quoted fields and escaped double-quotes. */
export function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'; // escaped quote
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Normalise model stop reasons to the Dolt events ENUM.
 * Some providers use 'toolUse'; the DDL ENUM uses 'tool_use'.
 */
export function normaliseStopReason(
  reason: string | null | undefined,
): string | null {
  if (reason == null) return null;
  if (reason === "toolUse") return "tool_use";
  return reason;
}

export async function writeEvent(
  event: Record<string, unknown>,
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
  await getDoltPool().execute(sql, values);
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
  authnFields?: Record<string, unknown>;
}): Promise<void> {
  await writeEvent(buildModelSelectedEventPayload(params));
}

export function buildModelSelectedEventPayload(params: {
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
  principalId?: string;
  authnFields?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    event_id: params.eventId ?? generateULID(),
    session_id: params.sessionId,
    event_type: "model_selected",
    trace_id: params.traceId,
    span_id: params.spanId ?? generateSpanId(),
    principal_id: params.principalId ?? process.env.DYFJ_PRINCIPAL_ID ??
      process.env.USER ?? "user",
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
