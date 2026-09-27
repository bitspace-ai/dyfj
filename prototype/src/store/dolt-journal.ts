/**
 * `DoltStore`'s journal: the only module in the runtime that holds write SQL.
 *
 * `commit` appends a batch's events, applies the projectors each event
 * selects, and applies the batch's declared unjournaled mutations, in that
 * order and in one transaction. A single statement with no projection and no
 * abort signal runs auto-committed, exactly as the event writes did before the
 * store port existed; everything else runs on one pooled connection inside
 * `BEGIN` / `COMMIT`.
 */

import type { DoltConnection, DoltPool, DoltQueryable } from "./dolt-pool.ts";
import { queryText } from "./dolt-readers.ts";
import type {
  CommitBatch,
  CommitOptions,
  CommitReceipt,
  EventInsert,
  Journal,
} from "./port.ts";
import {
  assertProjectableRow,
  PROJECTED_TABLES,
  type ProjectionRow,
  type Projector,
} from "./projectors.ts";
import {
  assertDeclaredMutations,
  type UnjournaledMutation,
} from "./unjournaled.ts";

interface Statement {
  sql: string;
  params: unknown[];
}

/** `null` columns are omitted; booleans are stored as 0/1. */
function eventInsert(event: EventInsert): Statement {
  const columns = Object.keys(event).filter((k) => event[k] !== null);
  const placeholders = columns.map(() => "?").join(", ");
  const params = columns.map((k) => {
    const v = event[k];
    if (typeof v === "boolean") return v ? 1 : 0;
    return v ?? null;
  });
  return {
    sql: `INSERT INTO events (${columns.join(", ")}) VALUES (${placeholders})`,
    params,
  };
}

function mutationStatement(mutation: UnjournaledMutation): Statement {
  switch (mutation.kind) {
    case "session_insert":
      return {
        sql: "INSERT INTO sessions " +
          "(session_id, slug, session_name, task_description, status, mode, " +
          "workspace, content, progress_done, progress_total) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
        params: [
          mutation.sessionId,
          mutation.slug,
          mutation.sessionName,
          mutation.taskDescription,
          mutation.status,
          mutation.mode,
          mutation.workspace,
          mutation.content,
          mutation.progressDone,
          mutation.progressTotal,
        ],
      };
    case "session_update":
      return {
        sql:
          "UPDATE sessions SET status = ?, progress_done = ?, progress_total = ?, " +
          "content = COALESCE(?, content) WHERE session_id = ?;",
        params: [
          mutation.status,
          mutation.progressDone,
          mutation.progressTotal,
          mutation.content,
          mutation.sessionId,
        ],
      };
    case "memory_upsert":
      return {
        sql:
          `INSERT INTO memories (memory_id, slug, type, name, description, content) ` +
          `VALUES (?, ?, ?, ?, ?, ?) ` +
          `ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), content = VALUES(content), updated_at = CURRENT_TIMESTAMP(6);`,
        params: [
          mutation.memoryId,
          mutation.slug,
          mutation.type,
          mutation.name,
          mutation.description,
          mutation.content,
        ],
      };
  }
}

function projectionStatement(
  projector: Projector,
  key: string,
  current: Record<string, string> | null,
  next: ProjectionRow | null,
): Statement | null {
  const spec = PROJECTED_TABLES[projector.table];
  if (next === null) {
    if (current === null) return null;
    return {
      sql: `DELETE FROM ${projector.table} WHERE ${spec.key} = ?`,
      params: [key],
    };
  }
  assertProjectableRow(projector.table, key, next);
  const columns = Object.keys(next);
  if (current === null) {
    return {
      sql: `INSERT INTO ${projector.table} (${columns.join(", ")}) VALUES (${
        columns.map(() => "?").join(", ")
      })`,
      params: columns.map((c) => next[c]),
    };
  }
  const assigned = columns.filter((c) => c !== spec.key);
  if (assigned.length === 0) return null;
  return {
    sql: `UPDATE ${projector.table} SET ${
      assigned.map((c) => `${c} = ?`).join(", ")
    } WHERE ${spec.key} = ?`,
    params: [...assigned.map((c) => next[c]), key],
  };
}

async function applyProjections(
  connection: DoltQueryable,
  projectors: readonly Projector[],
  event: EventInsert,
): Promise<void> {
  for (const projector of projectors) {
    const key = projector.key(event);
    if (key === null) continue;
    const spec = PROJECTED_TABLES[projector.table];
    const rows = await queryText(
      connection,
      `SELECT * FROM ${projector.table} WHERE ${spec.key} = ? LIMIT 1`,
      [key],
    );
    const current = rows[0] ?? null;
    const statement = projectionStatement(
      projector,
      key,
      current,
      projector.project(current, event),
    );
    if (statement !== null) {
      await connection.execute(statement.sql, statement.params);
    }
  }
}

function abortError(): DOMException {
  return new DOMException("Event write aborted", "AbortError");
}

export class DoltJournal implements Journal {
  readonly #pool: DoltPool;
  readonly #projectors: readonly Projector[];

  constructor(pool: DoltPool, projectors: readonly Projector[]) {
    this.#pool = pool;
    this.#projectors = projectors;
  }

  async commit(
    batch: CommitBatch,
    options: CommitOptions = {},
  ): Promise<CommitReceipt> {
    // An aborted commit rejects whatever the batch holds, empty included.
    if (options.signal?.aborted) throw abortError();
    const mutations = batch.mutations ?? [];
    assertDeclaredMutations(mutations);
    const receipt: CommitReceipt = {
      eventIds: batch.events.map((e) => String(e.event_id ?? "")),
      mutations: mutations.length,
    };
    const projects = batch.events.some((event) =>
      this.#projectors.some((p) => p.key(event) !== null)
    );
    const statements = [
      ...batch.events.map(eventInsert),
      ...mutations.map(mutationStatement),
    ];
    if (statements.length === 0) return receipt;
    const { signal } = options;
    if (statements.length === 1 && !projects && signal === undefined) {
      await this.#pool.execute(statements[0]!.sql, statements[0]!.params);
      return receipt;
    }
    await this.#transaction(signal, async (connection) => {
      for (const event of batch.events) {
        const { sql, params } = eventInsert(event);
        await connection.execute(sql, params);
        await applyProjections(connection, this.#projectors, event);
      }
      for (const mutation of mutations) {
        const { sql, params } = mutationStatement(mutation);
        await connection.execute(sql, params);
      }
    });
    return receipt;
  }

  async #transaction(
    signal: AbortSignal | undefined,
    work: (connection: DoltConnection) => Promise<void>,
  ): Promise<void> {
    if (signal?.aborted) throw abortError();
    let connection: DoltConnection | undefined;
    let aborted = false;
    let rejectAbort: ((reason: DOMException) => void) | undefined;
    const abortedPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    abortedPromise.catch(() => {});
    const abort = () => {
      aborted = true;
      connection?.destroy();
      rejectAbort?.(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    const acquiring = this.#pool.getConnection();
    // A connection that arrives after an abort is closed, never pooled.
    acquiring.then(
      (late) => {
        if (aborted && late !== connection) late.destroy();
      },
      () => {},
    );
    try {
      connection = signal === undefined
        ? await acquiring
        : await Promise.race([acquiring, abortedPromise]);
      await connection.beginTransaction();
      await work(connection);
      if (aborted) throw abortError();
      await connection.commit();
    } catch (error) {
      try {
        await connection?.rollback();
      } catch {
        // A cancellation may already have destroyed the connection.
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (connection !== undefined && !aborted) connection.release();
    }
  }
}
