// `DoltStore` against a scripted pool: the SQL each reader issues, the
// boot-time column check, parameter binding, and how the journal chooses
// between one auto-committed statement and a transaction. Behavior against a
// real Dolt server is the conformance suite's job
// (`dolt-store.integration.test.ts`).

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
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

Deno.test("events.bySession queries one session in order, bound and capped", async () => {
  const { pool, calls } = scriptedPool();
  await new DoltStore(pool).events.bySession({
    sessionId: SESSION,
    limit: 5000,
    order: "desc",
  });
  assertStringIncludes(calls[0]!.sql, "WHERE session_id = ?");
  assertStringIncludes(
    calls[0]!.sql,
    "ORDER BY created_at DESC, event_id DESC LIMIT 5000;",
  );
  assertFalse(calls[0]!.sql.includes("AS OF"));
  assertStringIncludes(
    calls[0]!.sql,
    "CAST(runner_capabilities AS CHAR) AS runner_capabilities",
  );
  assertEquals(calls[0]!.params, [SESSION]);
});

Deno.test("events.bySession binds an event id and inlines a validated AS OF timestamp", async () => {
  const { pool, calls } = scriptedPool();
  await new DoltStore(pool).events.bySession({
    sessionId: SESSION,
    eventId: "01EVENT",
    asOf: "2026-06-12T10:00:00",
    limit: 10,
    order: "asc",
  });
  assertStringIncludes(
    calls[0]!.sql,
    "FROM events AS OF TIMESTAMP('2026-06-12 10:00:00') WHERE session_id = ? AND event_id = ?",
  );
  assertEquals(calls[0]!.params, [SESSION, "01EVENT"]);
});

Deno.test("events.bySession rejects a malformed AS OF value before touching SQL", async () => {
  const { pool, calls } = scriptedPool();
  await assertRejects(
    () =>
      new DoltStore(pool).events.bySession({
        sessionId: SESSION,
        asOf: "yesterday'); DROP TABLE events;--",
        limit: 10,
        order: "asc",
      }),
    Error,
    "asOf must be a timestamp",
  );
  assertEquals(calls, []);
});

Deno.test("events.exists and countBySession render driver values", async () => {
  const { pool } = scriptedPool((sql) =>
    sql.includes("COUNT(*)") ? [{ count: 3 }] : [{ event_id: "01EVENT" }]
  );
  const store = new DoltStore(pool);
  assert(await store.events.exists("01EVENT"));
  assertEquals(await store.events.countBySession(SESSION), 3);
});

// ─── other readers ───────────────────────────────────────────────────────────

Deno.test("sessions.list filters by project through a bound parameter", async () => {
  const { pool, calls } = scriptedPool();
  await new DoltStore(pool).sessions.list({ project: "dyfj", limit: 200 });
  assertStringIncludes(calls[0]!.sql, "WHERE project = ?");
  assertStringIncludes(
    calls[0]!.sql,
    "ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 200;",
  );
  assertEquals(calls[0]!.params, ["dyfj"]);
  await assertRejects(
    () => new DoltStore(pool).sessions.list({ limit: 1.5 }),
    Error,
    "limit must be a positive integer",
  );
});

Deno.test("memories bind slug, clearance and type values instead of interpolating them", async () => {
  const { pool, calls } = scriptedPool();
  const store = new DoltStore(pool);
  const injectedSlug = "private_memory' OR 1=1 --";
  await store.memories.bySlug(injectedSlug, ["client_safe", "public"]);
  await store.memories.list(["client_safe", "public"], { type: "project" });
  assertEquals(calls[0], {
    sql: "SELECT memory_id, slug, type, name, description, content " +
      "FROM memories WHERE slug = ? AND visibility IN (?, ?) LIMIT 1;",
    params: [injectedSlug, "client_safe", "public"],
    on: "pool",
  });
  assertStringIncludes(
    calls[1]!.sql,
    "WHERE visibility IN (?, ?) AND type = ? ORDER BY type, slug;",
  );
  assertFalse(calls[1]!.sql.includes("project"));
  assertEquals(calls[1]!.params, ["client_safe", "public", "project"]);
});

Deno.test("models.listActive reads the current catalog columns, with no fallback", async () => {
  const error = new Error("Unknown column 'architecture' in 'field list'");
  const { pool, calls } = scriptedPool(() => error);
  const rejected = await assertRejects(() =>
    new DoltStore(pool).models.listActive()
  );
  assertEquals(rejected, error);
  assertEquals(calls.length, 1);
  assertStringIncludes(calls[0]!.sql, "architecture, total_params_b");
});

Deno.test("events.bySession has no fallback for a column a snapshot predates", async () => {
  const error = new Error(
    'column "trace_flags" could not be found in any table in scope',
  );
  const { pool, calls } = scriptedPool(() => error);
  const rejected = await assertRejects(() =>
    new DoltStore(pool).events.bySession({
      sessionId: SESSION,
      asOf: "2026-06-12 10:00:00",
      limit: 10,
      order: "asc",
    })
  );
  assertEquals(rejected, error);
  assertEquals(calls.length, 1);
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

Deno.test("assertCanonicalColumns passes a database at the current baseline", async () => {
  const extra = [{ tbl: "events", col: "vestigial" }, {
    tbl: "other",
    col: "x",
  }];
  const { pool, calls } = scriptedPool(() => [...liveColumns(), ...extra]);
  await new DoltStore(pool).assertCanonicalColumns();
  assertEquals(calls.length, 1);
  assertStringIncludes(calls[0]!.sql, "FROM information_schema.columns");
  assertStringIncludes(calls[0]!.sql, "table_schema = database()");
});

Deno.test("assertCanonicalColumns names every missing column and points at the migrations", async () => {
  const { pool } = scriptedPool(() =>
    liveColumns([
      "events.trace_flags",
      "events.span_kind",
      "models.architecture",
    ])
  );
  const error = await assertRejects(
    () => new DoltStore(pool).assertCanonicalColumns(),
    MissingSchemaColumnsError,
  );
  assertEquals(error.missing, [
    { table: "events", column: "trace_flags" },
    { table: "events", column: "span_kind" },
    { table: "models", column: "architecture" },
  ]);
  assertStringIncludes(
    error.message,
    "events.trace_flags, events.span_kind, models.architecture",
  );
  assertStringIncludes(error.message, "schema/migrations/");
});

Deno.test("assertCanonicalColumns reports a missing table as all of its columns", async () => {
  const { pool } = scriptedPool(() =>
    liveColumns().filter((row) => row.tbl !== "prompts")
  );
  const error = await assertRejects(
    () => new DoltStore(pool).assertCanonicalColumns(),
    MissingSchemaColumnsError,
  );
  assertEquals(
    error.missing.map(({ column }) => column),
    [...CANONICAL_TABLE_COLUMNS.prompts],
  );
});

Deno.test("only connection, access and unknown-database errors count as unavailable", () => {
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
    assert(
      isDatabaseUnavailableError(Object.assign(new Error(code), { code })),
    );
  }
  // A check that reached the database and failed is not "unavailable": the
  // boot must fail rather than serve with the check incomplete.
  for (
    const code of ["ER_PARSE_ERROR", "ER_TABLEACCESS_DENIED_ERROR", undefined]
  ) {
    assertFalse(
      isDatabaseUnavailableError(Object.assign(new Error("x"), { code })),
    );
  }
  assertFalse(isDatabaseUnavailableError(new MissingSchemaColumnsError([])));
  assertFalse(isDatabaseUnavailableError("ECONNREFUSED"));
});

Deno.test("assertCanonicalColumns passes a connection failure through unchanged", async () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });
  const { pool } = scriptedPool(() => refused);
  const rejected = await assertRejects(() =>
    new DoltStore(pool).assertCanonicalColumns()
  );
  assertEquals(rejected, refused);
});

Deno.test("spend.baselines scopes by session and day and maps the rollup row", async () => {
  const { pool, calls } = scriptedPool(() => [{
    session_spent: "0.12",
    session_today: 0.05,
    daily_others: "3.4",
  }]);
  const baselines = await new DoltStore(pool).spend.baselines(
    SESSION,
    "2026-07-06 00:00:00",
  );
  assertEquals(baselines, {
    sessionSpentUsd: 0.12,
    sessionSpentTodayUsd: 0.05,
    dailyOtherSessionsUsd: 3.4,
  });
  assertEquals(calls[0]!.params, [
    SESSION,
    SESSION,
    "2026-07-06 00:00:00",
    "2026-07-06 00:00:00",
    SESSION,
  ]);
  // Other-session scoping: this session's own rows must not count twice.
  assertStringIncludes(calls[0]!.sql, "session_id <> ?");
  // budget_summary rows aggregate the session and would double count.
  assertStringIncludes(calls[0]!.sql, "event_type = 'model_response'");
});

// ─── the read-only handle ────────────────────────────────────────────────────

Deno.test("readers get a handle that runs only a single SELECT", async () => {
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
    assertFalse(isReadOnlySelect(write), write);
  }
  for (
    const read of [
      "SELECT event_id FROM events WHERE event_id = ? LIMIT 1",
      "  select slug from memories;",
      "SELECT COALESCE(SUM(cost_total), 0) AS s FROM events",
    ]
  ) {
    assert(isReadOnlySelect(read), read);
  }
  const { pool, calls } = scriptedPool();
  await assertRejects(
    () => selectOnly(pool).select(`INSERT INTO ${table} VALUES (?)`, [1]),
    Error,
    "store readers may run only a single SELECT",
  );
  assertEquals(calls, []);
});

Deno.test("every reader query passes the read-only guard", async () => {
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
  await store.prompts.active("companion-base");
  await store.spend.baselines(SESSION, "2026-07-06 00:00:00");
  assertEquals(calls.length, 15);
  for (const call of calls) assert(isReadOnlySelect(call.sql), call.sql);
});

// ─── journal ─────────────────────────────────────────────────────────────────

Deno.test("journal.commit writes one event as a single auto-committed INSERT", async () => {
  const { pool, calls, log } = scriptedPool();
  const receipt = await new DoltStore(pool).journal.commit({
    events: [
      event({ tool_is_error: true, model_id: null, content: undefined }),
    ],
  });
  assertEquals(receipt, { eventIds: ["01EVENT"], mutations: 0 });
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.on, "pool");
  // null columns are omitted; undefined ones bind NULL; booleans bind 0/1.
  assertFalse(calls[0]!.sql.includes("model_id"));
  assertStringIncludes(calls[0]!.sql, "INSERT INTO events (event_id,");
  assertEquals(calls[0]!.params.slice(-2), [1, null]);
  assertEquals(log, []);
});

Deno.test("journal.commit runs a multi-statement batch in one transaction", async () => {
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
  assertEquals(calls.map((c) => c.on), ["connection", "connection"]);
  assertStringIncludes(calls[1]!.sql, "content = COALESCE(?, content)");
  assertEquals(log, ["acquire", "begin", "commit", "release"]);
});

Deno.test("journal.commit rolls a failed batch back and releases the connection", async () => {
  const { pool, log } = scriptedPool((sql) =>
    sql.startsWith("INSERT INTO sessions") ? new Error("duplicate") : []
  );
  await assertRejects(
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
    Error,
    "duplicate",
  );
  assertEquals(log, ["acquire", "begin", "rollback", "release"]);
});

Deno.test("journal.commit with a signal runs in a transaction and commits", async () => {
  const { pool, calls, log } = scriptedPool();
  await new DoltStore(pool).journal.commit(
    { events: [event()] },
    { signal: new AbortController().signal },
  );
  assertEquals(calls.map((c) => c.on), ["connection"]);
  assertEquals(log, ["acquire", "begin", "commit", "release"]);
});

Deno.test("journal.commit aborted while acquiring a connection writes nothing and closes it", async () => {
  const scripted = scriptedPool();
  const release = scripted.holdConnections();
  const controller = new AbortController();
  const commit = new DoltStore(scripted.pool).journal.commit(
    { events: [event()] },
    { signal: controller.signal },
  );
  controller.abort();
  const error = await assertRejects(() => commit);
  assertEquals((error as Error).name, "AbortError");
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(scripted.calls, []);
  assertEquals(scripted.log, ["acquire", "destroy"]);
});

Deno.test("journal.commit rejects an already-aborted empty batch", async () => {
  const { pool, calls, log } = scriptedPool();
  const controller = new AbortController();
  controller.abort();
  const error = await assertRejects(() =>
    new DoltStore(pool).journal.commit(
      { events: [] },
      { signal: controller.signal },
    )
  );
  assertEquals((error as Error).name, "AbortError");
  assertEquals(calls, []);
  assertEquals(log, []);
});

Deno.test("an abort while COMMIT is in flight cannot recall an acknowledged commit", async () => {
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
  assertEquals(receipt.eventIds, ["01EVENT"]);
  assertEquals(log, ["acquire", "begin", "commit", "destroy"]);
});

Deno.test("a connection lost mid-COMMIT rejects with the driver's error", async () => {
  const controller = new AbortController();
  const lost = new Error("Connection lost: The server closed the connection.");
  const { pool } = scriptedPool(() => [], () => {
    controller.abort();
    return Promise.reject(lost);
  });
  const error = await assertRejects(() =>
    new DoltStore(pool).journal.commit(
      { events: [event()] },
      { signal: controller.signal },
    )
  );
  assertEquals(error, lost);
});

Deno.test("after an abort destroys its connection, the pool serves the next commit", async () => {
  const controller = new AbortController();
  // Abort while the transaction's INSERT runs on the pooled connection.
  const { pool, calls, log } = scriptedPool((sql) => {
    if (sql.startsWith("SELECT")) return [{ event_id: "01PLAIN" }];
    if (!controller.signal.aborted) controller.abort();
    return [];
  });
  const store = new DoltStore(pool);
  const error = await assertRejects(() =>
    store.journal.commit(
      { events: [event({ event_id: "01ABORTED" })] },
      { signal: controller.signal },
    )
  );
  assertEquals((error as Error).name, "AbortError");
  // The aborted transaction rolled back, and its connection was destroyed,
  // not returned to the pool.
  assertEquals(log, ["acquire", "begin", "destroy", "rollback"]);

  log.length = 0;
  calls.length = 0;
  await store.journal.commit(
    { events: [event({ event_id: "01NEXT" })] },
    { signal: new AbortController().signal },
  );
  assertEquals(log, ["acquire", "begin", "commit", "release"]);
  await store.journal.commit({ events: [event({ event_id: "01PLAIN" })] });
  assert(await store.events.exists("01PLAIN"));
  assertEquals(calls.map((c) => c.on), ["connection", "pool", "pool"]);
});

Deno.test("journal.commit rejects an undeclared mutation before touching SQL", async () => {
  const { pool, calls } = scriptedPool();
  await assertRejects(() =>
    new DoltStore(pool).journal.commit({
      events: [event()],
      mutations: [{ kind: "drop_everything" } as never],
    })
  );
  assertEquals(calls, []);
});

Deno.test("close ends the pool the store was given", async () => {
  const { pool, log } = scriptedPool();
  await new DoltStore(pool).close();
  assertEquals(log, ["end"]);
});
