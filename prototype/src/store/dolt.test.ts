// `DoltStore` against a scripted pool: the SQL each reader issues, the
// boot-time column check, parameter binding, and how the journal chooses
// between one auto-committed statement and a transaction. Behavior against a
// real Dolt server is the conformance suite's job
// (`dolt-store.integration.test.ts`).

import { captureRejection } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DoltConnection,
  type DoltPool,
  isReadOnlySelect,
  selectOnly,
} from "./dolt-pool.ts";
import { DoltStore } from "./dolt.ts";
import { CANONICAL_TABLE_COLUMNS, type EventInsert } from "./generated/rows.ts";
import {
  isDatabaseUnavailableError,
  MissingSchemaColumnsError,
} from "./schema-check.ts";

interface Call {
  sql: string;
  params: unknown[];
  on: "pool" | "connection";
}

type Responder = (sql: string, params: unknown[]) => unknown[] | Error;

/** A pool that records every statement and answers from `respond`. */
function scriptedPool(
  respond: Responder = () => [],
  onCommit?: () => Promise<void>,
) {
  const calls: Call[] = [];
  const log: string[] = [];
  const answer = (on: Call["on"]) => (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params, on });
    const result = respond(sql, params);
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve([result, []] as [unknown, unknown]);
  };
  let pendingConnection: Promise<void> | undefined;
  let releaseConnection: (() => void) | undefined;
  const connection: DoltConnection = {
    execute: answer("connection"),
    beginTransaction: () => (log.push("begin"), Promise.resolve()),
    commit: () => {
      log.push("commit");
      return onCommit?.() ?? Promise.resolve();
    },
    rollback: () => (log.push("rollback"), Promise.resolve()),
    release: () => void log.push("release"),
    destroy: () => void log.push("destroy"),
  };
  const pool: DoltPool = {
    execute: answer("pool"),
    getConnection: async () => {
      log.push("acquire");
      if (pendingConnection) await pendingConnection;
      return connection;
    },
    end: () => (log.push("end"), Promise.resolve()),
  };
  return {
    pool,
    calls,
    log,
    /** Hold `getConnection` until `release()` is called. */
    holdConnections() {
      pendingConnection = new Promise((resolve) => {
        releaseConnection = resolve;
      });
      return () => releaseConnection?.();
    },
  };
}

const SESSION = "01ABCDEF0123456789ABCDEF01";

function event(fields: Partial<EventInsert> = {}): EventInsert {
  return {
    event_id: "01EVENT",
    session_id: SESSION,
    event_type: "session_start",
    trace_id: "trace",
    span_id: "span",
    principal_id: "operator",
    principal_type: "human",
    action: "start",
    resource: "workbench_session",
    authz_basis: "test",
    ...fields,
  };
}

// ─── events ──────────────────────────────────────────────────────────────────

test("events.bySession queries one session in order, bound and capped", async () => {
  const { pool, calls } = scriptedPool();
  await new DoltStore(pool).events.bySession({
    sessionId: SESSION,
    limit: 5000,
    order: "desc",
  });
  assert.ok(
    calls[0]!.sql.includes("WHERE session_id = ?"),
    `expected calls[0]!.sql to include "WHERE session_id = ?"`,
  );
  assert.ok(
    calls[0]!.sql.includes(
      "ORDER BY created_at DESC, event_id DESC LIMIT 5000;",
    ),
    `expected calls[0]!.sql to include "ORDER BY created_at DESC, event_id DESC LIMIT 5000;"`,
  );
  assert.ok(!calls[0]!.sql.includes("AS OF"));
  assert.ok(
    calls[0]!.sql.includes(
      "CAST(runner_capabilities AS CHAR) AS runner_capabilities",
    ),
    `expected calls[0]!.sql to include "CAST(runner_capabilities AS CHAR) AS runner_capabilities"`,
  );
  assert.deepStrictEqual(calls[0]!.params, [SESSION]);
});

test("events.bySession binds an event id and inlines a validated AS OF timestamp", async () => {
  const { pool, calls } = scriptedPool();
  await new DoltStore(pool).events.bySession({
    sessionId: SESSION,
    eventId: "01EVENT",
    asOf: "2026-06-12T10:00:00",
    limit: 10,
    order: "asc",
  });
  assert.ok(
    calls[0]!.sql.includes(
      "FROM events AS OF TIMESTAMP('2026-06-12 10:00:00') WHERE session_id = ? AND event_id = ?",
    ),
    `expected calls[0]!.sql to include "FROM events AS OF TIMESTAMP('2026-06-12 10:00:00') WHERE session_id = ? AND event_id = ?"`,
  );
  assert.deepStrictEqual(calls[0]!.params, [SESSION, "01EVENT"]);
});

test("events.bySession rejects a malformed AS OF value before touching SQL", async () => {
  const { pool, calls } = scriptedPool();
  await assert.rejects(
    () =>
      new DoltStore(pool).events.bySession({
        sessionId: SESSION,
        asOf: "yesterday'); DROP TABLE events;--",
        limit: 10,
        order: "asc",
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("asOf must be a timestamp"),
  );
  assert.deepStrictEqual(calls, []);
});

test("events.exists and countBySession render driver values", async () => {
  const { pool } = scriptedPool((sql) =>
    sql.includes("COUNT(*)") ? [{ count: 3 }] : [{ event_id: "01EVENT" }]
  );
  const store = new DoltStore(pool);
  assert.ok(await store.events.exists("01EVENT"));
  assert.deepStrictEqual(await store.events.countBySession(SESSION), 3);
});

// ─── other readers ───────────────────────────────────────────────────────────

test("sessions.list filters by project through a bound parameter", async () => {
  const { pool, calls } = scriptedPool();
  await new DoltStore(pool).sessions.list({ project: "dyfj", limit: 200 });
  assert.ok(
    calls[0]!.sql.includes("WHERE project = ?"),
    `expected calls[0]!.sql to include "WHERE project = ?"`,
  );
  assert.ok(
    calls[0]!.sql.includes(
      "ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 200;",
    ),
    `expected calls[0]!.sql to include "ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 200;"`,
  );
  assert.deepStrictEqual(calls[0]!.params, ["dyfj"]);
  await assert.rejects(
    () => new DoltStore(pool).sessions.list({ limit: 1.5 }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("limit must be a positive integer"),
  );
});

test("memories bind slug, clearance and type values instead of interpolating them", async () => {
  const { pool, calls } = scriptedPool();
  const store = new DoltStore(pool);
  const injectedSlug = "private_memory' OR 1=1 --";
  await store.memories.bySlug(injectedSlug, ["client_safe", "public"]);
  await store.memories.list(["client_safe", "public"], { type: "project" });
  assert.deepStrictEqual(calls[0], {
    sql: "SELECT memory_id, slug, type, name, description, content " +
      "FROM memories WHERE slug = ? AND visibility IN (?, ?) LIMIT 1;",
    params: [injectedSlug, "client_safe", "public"],
    on: "pool",
  });
  assert.ok(
    calls[1]!.sql.includes(
      "WHERE visibility IN (?, ?) AND type = ? ORDER BY type, slug;",
    ),
    `expected calls[1]!.sql to include "WHERE visibility IN (?, ?) AND type = ? ORDER BY type, slug;"`,
  );
  assert.ok(!calls[1]!.sql.includes("project"));
  assert.deepStrictEqual(calls[1]!.params, [
    "client_safe",
    "public",
    "project",
  ]);
});

test("models.listActive reads the current catalog columns, with no fallback", async () => {
  const error = new Error("Unknown column 'architecture' in 'field list'");
  const { pool, calls } = scriptedPool(() => error);
  const rejected = await captureRejection(() =>
    new DoltStore(pool).models.listActive()
  );
  assert.strictEqual(rejected, error);
  assert.deepStrictEqual(calls.length, 1);
  assert.ok(
    calls[0]!.sql.includes("architecture, total_params_b"),
    `expected calls[0]!.sql to include "architecture, total_params_b"`,
  );
});

test("events.bySession has no fallback for a column a snapshot predates", async () => {
  const error = new Error(
    'column "trace_flags" could not be found in any table in scope',
  );
  const { pool, calls } = scriptedPool(() => error);
  const rejected = await captureRejection(() =>
    new DoltStore(pool).events.bySession({
      sessionId: SESSION,
      asOf: "2026-06-12 10:00:00",
      limit: 10,
      order: "asc",
    })
  );
  assert.strictEqual(rejected, error);
  assert.deepStrictEqual(calls.length, 1);
});

// ─── boot-time column check ──────────────────────────────────────────────────

function liveColumns(
  omit: readonly string[] = [],
): Record<string, string>[] {
  return Object.entries(CANONICAL_TABLE_COLUMNS).flatMap(([tbl, columns]) =>
    columns
      .filter((col) => !omit.includes(`${tbl}.${col}`))
      .map((col) => ({ tbl, col }))
  );
}

test("assertCanonicalColumns passes a database at the current baseline", async () => {
  const extra = [{ tbl: "events", col: "vestigial" }, {
    tbl: "other",
    col: "x",
  }];
  const { pool, calls } = scriptedPool(() => [...liveColumns(), ...extra]);
  await new DoltStore(pool).assertCanonicalColumns();
  assert.deepStrictEqual(calls.length, 1);
  assert.ok(
    calls[0]!.sql.includes("FROM information_schema.columns"),
    `expected calls[0]!.sql to include "FROM information_schema.columns"`,
  );
  assert.ok(
    calls[0]!.sql.includes("table_schema = database()"),
    `expected calls[0]!.sql to include "table_schema = database()"`,
  );
});

test("assertCanonicalColumns names every missing column and points at the migrations", async () => {
  const { pool } = scriptedPool(() =>
    liveColumns([
      "events.trace_flags",
      "events.span_kind",
      "models.architecture",
    ])
  );
  const error = await captureRejection(
    () => new DoltStore(pool).assertCanonicalColumns(),
    MissingSchemaColumnsError,
  );
  assert.deepStrictEqual(error.missing, [
    { table: "events", column: "trace_flags" },
    { table: "events", column: "span_kind" },
    { table: "models", column: "architecture" },
  ]);
  assert.ok(
    error.message.includes(
      "events.trace_flags, events.span_kind, models.architecture",
    ),
    `expected error.message to include "events.trace_flags, events.span_kind, models.architecture"`,
  );
  assert.ok(
    error.message.includes("schema/migrations/"),
    `expected error.message to include "schema/migrations/"`,
  );
});

test("assertCanonicalColumns reports a missing table as all of its columns", async () => {
  const { pool } = scriptedPool(() =>
    liveColumns().filter((row) => row.tbl !== "prompts")
  );
  const error = await captureRejection(
    () => new DoltStore(pool).assertCanonicalColumns(),
    MissingSchemaColumnsError,
  );
  assert.deepStrictEqual(
    error.missing.map(({ column }) => column),
    [...CANONICAL_TABLE_COLUMNS.prompts],
  );
});

test("only connection, access and unknown-database errors count as unavailable", () => {
  for (
    const code of [
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "PROTOCOL_CONNECTION_LOST",
      "ER_ACCESS_DENIED_ERROR",
      "ER_BAD_DB_ERROR",
    ]
  ) {
    assert.ok(
      isDatabaseUnavailableError(Object.assign(new Error(code), { code })),
    );
  }
  // A check that reached the database and failed is not "unavailable": the
  // boot must fail rather than serve with the check incomplete.
  for (
    const code of ["ER_PARSE_ERROR", "ER_TABLEACCESS_DENIED_ERROR", undefined]
  ) {
    assert.ok(
      !isDatabaseUnavailableError(Object.assign(new Error("x"), { code })),
    );
  }
  assert.ok(!isDatabaseUnavailableError(new MissingSchemaColumnsError([])));
  assert.ok(!isDatabaseUnavailableError("ECONNREFUSED"));
});

test("assertCanonicalColumns passes a connection failure through unchanged", async () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });
  const { pool } = scriptedPool(() => refused);
  const rejected = await captureRejection(() =>
    new DoltStore(pool).assertCanonicalColumns()
  );
  assert.deepStrictEqual(rejected, refused);
});

test("spend.baselines scopes by session and day and maps the rollup row", async () => {
  const { pool, calls } = scriptedPool(() => [{
    session_spent: "0.12",
    session_today: 0.05,
    daily_others: "3.4",
  }]);
  const baselines = await new DoltStore(pool).spend.baselines(
    SESSION,
    "2026-07-06 00:00:00",
  );
  assert.deepStrictEqual(baselines, {
    sessionSpentUsd: 0.12,
    sessionSpentTodayUsd: 0.05,
    dailyOtherSessionsUsd: 3.4,
  });
  assert.deepStrictEqual(calls[0]!.params, [
    SESSION,
    SESSION,
    "2026-07-06 00:00:00",
    "2026-07-06 00:00:00",
    SESSION,
  ]);
  // Other-session scoping: this session's own rows must not count twice.
  assert.ok(
    calls[0]!.sql.includes("session_id <> ?"),
    `expected calls[0]!.sql to include "session_id <> ?"`,
  );
  // One row per paid call: model_response and budget_summary repeat
  // per-turn totals and would double count.
  assert.ok(
    calls[0]!.sql.includes("event_type = 'provider_call'"),
    `expected calls[0]!.sql to include "event_type = 'provider_call'"`,
  );
});

// ─── the read-only handle ────────────────────────────────────────────────────

test("readers get a handle that runs only a single SELECT", async () => {
  const table = "events";
  for (
    const write of [
      `INSERT INTO ${table} (event_id) VALUES (?)`,
      "insert into events (event_id) values (?)",
      "  update sessions set status = ?",
      "DELETE FROM memories",
      "REPLACE INTO prompts VALUES (?)",
      "CALL DOLT_COMMIT('-Am', 'x')",
      "SELECT DOLT_COMMIT('-Am', 'x')",
      "select dolt_reset('--hard')",
      "SELECT 1; DELETE FROM events",
      "SELECT * FROM events INTO OUTFILE '/tmp/x'",
      "SELECT 1 INTO @v",
      "WITH x AS (SELECT 1) DELETE FROM events",
    ]
  ) {
    assert.ok(!isReadOnlySelect(write), write);
  }
  for (
    const read of [
      "SELECT event_id FROM events WHERE event_id = ? LIMIT 1",
      "  select slug from memories;",
      "SELECT COALESCE(SUM(cost_total), 0) AS s FROM events",
    ]
  ) {
    assert.ok(isReadOnlySelect(read), read);
  }
  const { pool, calls } = scriptedPool();
  await assert.rejects(
    () => selectOnly(pool).select(`INSERT INTO ${table} VALUES (?)`, [1]),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("store readers may run only a single SELECT"),
  );
  assert.deepStrictEqual(calls, []);
});

test("every reader query passes the read-only guard", async () => {
  const { pool, calls } = scriptedPool((sql) =>
    sql.includes("COUNT(*)") ? [{ count: 0 }] : []
  );
  const store = new DoltStore(pool);
  await store.events.exists("e");
  await store.events.countBySession(SESSION);
  await store.events.bySession({
    sessionId: SESSION,
    eventId: "e",
    asOf: "2026-06-12 10:00:00",
    limit: 10,
    order: "desc",
  });
  await store.sessions.workspace(SESSION);
  await store.sessions.summary(SESSION);
  await store.sessions.list({ project: "p", limit: 5 });
  await store.sessions.recent({ status: "active", limit: 5 });
  await store.sessions.detail({ slug: "s" });
  await store.memories.injected(["public"]);
  await store.memories.indexed(["public"]);
  await store.memories.bySlug("s", ["public"]);
  await store.memories.list(["public"], { type: "user" });
  await store.models.listActive();
  await store.models.listInactiveSlugs();
  await store.prompts.active("companion-base");
  await store.spend.baselines(SESSION, "2026-07-06 00:00:00");
  assert.deepStrictEqual(calls.length, 16);
  for (const call of calls) assert.ok(isReadOnlySelect(call.sql), call.sql);
});

// ─── journal ─────────────────────────────────────────────────────────────────

test("journal.commit writes one event as a single auto-committed INSERT", async () => {
  const { pool, calls, log } = scriptedPool();
  const receipt = await new DoltStore(pool).journal.commit({
    events: [
      event({ tool_is_error: true, model_id: null, content: undefined }),
    ],
  });
  assert.deepStrictEqual(receipt, { eventIds: ["01EVENT"], mutations: 0 });
  assert.deepStrictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0]!.on, "pool");
  // null columns are omitted; undefined ones bind NULL; booleans bind 0/1.
  assert.ok(!calls[0]!.sql.includes("model_id"));
  assert.ok(
    calls[0]!.sql.includes("INSERT INTO events (event_id,"),
    `expected calls[0]!.sql to include "INSERT INTO events (event_id,"`,
  );
  assert.deepStrictEqual(calls[0]!.params.slice(-2), [1, null]);
  assert.deepStrictEqual(log, []);
});

test("journal.commit runs a multi-statement batch in one transaction", async () => {
  const { pool, calls, log } = scriptedPool();
  await new DoltStore(pool).journal.commit({
    events: [event()],
    mutations: [{
      kind: "session_update",
      sessionId: SESSION,
      status: "completed",
      progressDone: 1,
      progressTotal: 1,
      content: null,
    }],
  });
  assert.deepStrictEqual(calls.map((c) => c.on), ["connection", "connection"]);
  assert.ok(
    calls[1]!.sql.includes("content = COALESCE(?, content)"),
    `expected calls[1]!.sql to include "content = COALESCE(?, content)"`,
  );
  assert.deepStrictEqual(log, ["acquire", "begin", "commit", "release"]);
});

test("journal.commit rolls a failed batch back and releases the connection", async () => {
  const { pool, log } = scriptedPool((sql) =>
    sql.startsWith("INSERT INTO sessions") ? new Error("duplicate") : []
  );
  await assert.rejects(
    () =>
      new DoltStore(pool).journal.commit({
        events: [event()],
        mutations: [{
          kind: "session_insert",
          sessionId: SESSION,
          slug: "s",
          sessionName: null,
          taskDescription: "t",
          status: "active",
          mode: "interactive",
          workspace: null,
          content: null,
          progressDone: 0,
          progressTotal: 0,
        }],
      }),
    (error: unknown) =>
      error instanceof Error && error.message.includes("duplicate"),
  );
  assert.deepStrictEqual(log, ["acquire", "begin", "rollback", "release"]);
});

test("journal.commit with a signal runs in a transaction and commits", async () => {
  const { pool, calls, log } = scriptedPool();
  await new DoltStore(pool).journal.commit(
    { events: [event()] },
    { signal: new AbortController().signal },
  );
  assert.deepStrictEqual(calls.map((c) => c.on), ["connection"]);
  assert.deepStrictEqual(log, ["acquire", "begin", "commit", "release"]);
});

test("journal.commit aborted while acquiring a connection writes nothing and closes it", async () => {
  const scripted = scriptedPool();
  const release = scripted.holdConnections();
  const controller = new AbortController();
  const commit = new DoltStore(scripted.pool).journal.commit(
    { events: [event()] },
    { signal: controller.signal },
  );
  controller.abort();
  const error = await captureRejection(() => commit);
  assert.strictEqual((error as Error).name, "AbortError");
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepStrictEqual(scripted.calls, []);
  assert.deepStrictEqual(scripted.log, ["acquire", "destroy"]);
});

test("journal.commit rejects an already-aborted empty batch", async () => {
  const { pool, calls, log } = scriptedPool();
  const controller = new AbortController();
  controller.abort();
  const error = await captureRejection(() =>
    new DoltStore(pool).journal.commit(
      { events: [] },
      { signal: controller.signal },
    )
  );
  assert.strictEqual((error as Error).name, "AbortError");
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(log, []);
});

test("an abort while COMMIT is in flight cannot recall an acknowledged commit", async () => {
  const controller = new AbortController();
  // The abort lands while the server is committing, and the server then
  // acknowledges: the batch is durable, so commit reports it.
  const { pool, log } = scriptedPool(() => [], () => {
    controller.abort();
    return Promise.resolve();
  });
  const receipt = await new DoltStore(pool).journal.commit(
    { events: [event()] },
    { signal: controller.signal },
  );
  assert.deepStrictEqual(receipt.eventIds, ["01EVENT"]);
  assert.deepStrictEqual(log, ["acquire", "begin", "commit", "destroy"]);
});

test("a connection lost mid-COMMIT rejects with the driver's error", async () => {
  const controller = new AbortController();
  const lost = new Error("Connection lost: The server closed the connection.");
  const { pool } = scriptedPool(() => [], () => {
    controller.abort();
    return Promise.reject(lost);
  });
  const error = await captureRejection(() =>
    new DoltStore(pool).journal.commit(
      { events: [event()] },
      { signal: controller.signal },
    )
  );
  assert.strictEqual(error, lost);
});

test("after an abort destroys its connection, the pool serves the next commit", async () => {
  const controller = new AbortController();
  // Abort while the transaction's INSERT runs on the pooled connection.
  const { pool, calls, log } = scriptedPool((sql) => {
    if (sql.startsWith("SELECT")) return [{ event_id: "01PLAIN" }];
    if (!controller.signal.aborted) controller.abort();
    return [];
  });
  const store = new DoltStore(pool);
  const error = await captureRejection(() =>
    store.journal.commit(
      { events: [event({ event_id: "01ABORTED" })] },
      { signal: controller.signal },
    )
  );
  assert.strictEqual((error as Error).name, "AbortError");
  // The aborted transaction rolled back, and its connection was destroyed,
  // not returned to the pool.
  assert.deepStrictEqual(log, ["acquire", "begin", "destroy", "rollback"]);

  log.length = 0;
  calls.length = 0;
  await store.journal.commit(
    { events: [event({ event_id: "01NEXT" })] },
    { signal: new AbortController().signal },
  );
  assert.deepStrictEqual(log, ["acquire", "begin", "commit", "release"]);
  await store.journal.commit({ events: [event({ event_id: "01PLAIN" })] });
  assert.ok(await store.events.exists("01PLAIN"));
  assert.deepStrictEqual(calls.map((c) => c.on), [
    "connection",
    "pool",
    "pool",
  ]);
});

test("journal.commit rejects an undeclared mutation before touching SQL", async () => {
  const { pool, calls } = scriptedPool();
  await assert.rejects(() =>
    new DoltStore(pool).journal.commit({
      events: [event()],
      mutations: [{ kind: "drop_everything" } as never],
    })
  );
  assert.deepStrictEqual(calls, []);
});

test("close ends the pool the store was given", async () => {
  const { pool, log } = scriptedPool();
  await new DoltStore(pool).close();
  assert.deepStrictEqual(log, ["end"]);
});
