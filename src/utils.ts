import { ulid } from 'ulid';
import type { AssistantMessage } from "@mariozechner/pi-ai";

export function generateULID(): string {
  return ulid();
}

// W3C trace context compatible — 32 hex chars
export function generateTraceId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 32);
}

// 16 hex chars
export function generateSpanId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export function extractText(content: AssistantMessage['content']): string | null {
  const texts = content.filter(c => c.type === 'text').map(c => c.text);
  return texts.length > 0 ? texts.join('') : null;
}

export function extractThinking(content: AssistantMessage['content']): string | null {
  const thoughts = content.filter(c => c.type === 'thinking').map(c => c.thinking);
  return thoughts.length > 0 ? thoughts.join('') : null;
}

// ─── Dolt infrastructure (TCP → sql-server) ─────────────────────────────────
// Uses mysql2 over TCP to avoid file-lock conflicts with dolt sql-server.
// sql-server is managed by launchd: org.dyfj.dolt-sql-server

import mysql from 'mysql2/promise';

let _pool: mysql.Pool | null = null;

function getDoltPool(): mysql.Pool {
  if (!_pool) {
    _pool = mysql.createPool({
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: 'dolt',
      database: 'dolt',
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return _pool;
}

/** Execute a SELECT query. Returns rows as plain string-value objects. */
export async function doltQuery(sql: string): Promise<Record<string, string>[]> {
  const [rows] = await getDoltPool().execute(sql);
  return (rows as mysql.RowDataPacket[]).map(r => {
    const out: Record<string, string> = {};
    for (const k of Object.keys(r)) out[k] = r[k] == null ? '' : String(r[k]);
    return out;
  });
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
  let field = '';
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

    if (ch === ',' && !inQuotes) {
      currentRow.push(field);
      field = '';
      i++;
      continue;
    }

    if (ch === '\r' && !inQuotes) {
      i++; // skip bare \r
      continue;
    }

    if (ch === '\n' && !inQuotes) {
      currentRow.push(field);
      field = '';
      if (currentRow.some(f => f.length > 0)) rows.push(currentRow);
      currentRow = [];
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  // Flush final row
  currentRow.push(field);
  if (currentRow.some(f => f.length > 0)) rows.push(currentRow);

  return rows;
}

/** Parse a single CSV row. Handles quoted fields and escaped double-quotes. */
export function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = '';
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
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Normalise a pi-ai StopReason (camelCase) to the Dolt events ENUM (snake_case).
 * pi-ai uses 'toolUse'; the DDL ENUM uses 'tool_use'.
 */
export function normaliseStopReason(reason: string | null | undefined): string | null {
  if (reason == null) return null;
  if (reason === 'toolUse') return 'tool_use';
  return reason;
}

export async function writeEvent(event: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(event).filter(k => event[k] !== null);
  const placeholders = columns.map(() => '?').join(', ');
  const values = columns.map(k => {
    const v = event[k];
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any[];
  const sql = `INSERT INTO events (${columns.join(', ')}) VALUES (${placeholders})`;
  await getDoltPool().execute(sql, values);
}

// ─── Telemetry helpers ────────────────────────────────────────────────────────

export async function writeModelSelectedEvent(params: {
  selected: string;
  considered: string[];
  reason: string;
  sessionId: string;
  traceId: string;
  durationMs?: number;
}): Promise<void> {
  await writeEvent({
    event_id:       generateULID(),
    session_id:     params.sessionId,
    event_type:     'model_selected',
    trace_id:       params.traceId,
    span_id:        generateSpanId(),
    principal_id:   process.env.DYFJ_PRINCIPAL_ID ?? process.env.USER ?? 'user',
    principal_type: 'human',
    action:         'select',
    resource:       params.selected,
    authz_basis:    'routing_heuristic',
    model_id:       params.selected,
    content:        JSON.stringify({
      selected:   params.selected,
      considered: params.considered,
      reason:     params.reason,
    }),
    duration_ms:    params.durationMs ?? null,
  });
}
