// The store conformance suite against `DoltStore`, in the isolated Dolt
// integration lane. Each case gets its own database on the fixture server,
// with tables copied from the fixture's schema (`CREATE TABLE ... LIKE`), so
// the suite never touches the rows other integration tests read.

import mysql from "mysql2/promise";
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  event,
  storeConformance,
  type StoreConformanceSubject,
} from "../../testing/conformance/store.ts";
import { resolveDoltConnection } from "../config/mod.ts";
import { processEnv } from "../config/mod.ts";
import {
  createDoltPool,
  DoltStore,
  type MemoryStoreSeed,
  MissingSchemaColumnsError,
  type Store,
} from "./mod.ts";

const TABLES = ["events", "sessions", "memories", "models", "prompts"];
const connection = resolveDoltConnection(processEnv);

interface AdminPool {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

function adminPool(database: string): AdminPool {
  // Deno's npm declaration bridge drops mysql2's mixed-in promise methods.
  return mysql.createPool({
    ...connection,
    database,
    connectionLimit: 1,
  }) as unknown as AdminPool;
}

async function seedRows(pool: AdminPool, seed: MemoryStoreSeed): Promise<void> {
  for (const m of seed.models ?? []) {
    await pool.query(
      "INSERT INTO models (slug, display_name, provider, api, base_url, tier, " +
        "context_window, max_output_tokens, cost_input, cost_output, capabilities, " +
        "architecture, total_params_b, active_params_b, recommended_quant, " +
        "resident_ram_gib, reasoning_effort_control, active) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        m.slug,
        m.display_name,
        m.provider,
        m.api,
        m.base_url ?? null,
        m.tier,
        m.context_window,
        m.max_output_tokens,
        m.cost_input ?? 0,
        m.cost_output ?? 0,
        JSON.stringify(m.capabilities),
        m.architecture ?? null,
        m.total_params_b ?? null,
        m.active_params_b ?? null,
        m.recommended_quant ?? null,
        m.resident_ram_gib ?? null,
        m.reasoning_effort_control ? 1 : 0,
        m.active === false ? 0 : 1,
      ],
    );
  }
  for (const p of seed.prompts ?? []) {
    await pool.query(
      "INSERT INTO prompts (slug, display_name, kind, content, position, active) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
      [
        p.slug,
        p.display_name,
        p.kind,
        p.content,
        p.position ?? 0,
        p.active === false ? 0 : 1,
      ],
    );
  }
  for (const m of seed.memories ?? []) {
    await pool.query(
      "INSERT INTO memories (memory_id, slug, type, visibility, inject, name, description, content) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        m.memory_id,
        m.slug,
        m.type,
        m.visibility ?? "private",
        m.inject ?? "index",
        m.name,
        m.description,
        m.content,
      ],
    );
  }
}

const databases = new WeakMap<Store, string>();
let next = 0;

const subject: StoreConformanceSubject = {
  name: "DoltStore",
  async make(seed, options) {
    next += 1;
    const database = `store_conformance_${Deno.pid}_${next}`;
    const admin = adminPool(connection.database);
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      for (const table of TABLES) {
        await admin.query(
          `CREATE TABLE ${database}.${table} LIKE ${connection.database}.${table}`,
        );
      }
    } finally {
      await admin.end();
    }
    const seeder = adminPool(database);
    try {
      await seedRows(seeder, seed);
    } finally {
      await seeder.end();
    }
    const store = new DoltStore(
      createDoltPool({ ...connection, database }),
      options,
    );
    databases.set(store, database);
    return store;
  },
  async dispose(store) {
    await store.close();
    const admin = adminPool(connection.database);
    try {
      await admin.query(`DROP DATABASE ${databases.get(store)}`);
    } finally {
      await admin.end();
    }
  },
  // TIMESTAMP(6): a few milliseconds put the next write strictly later.
  tick: () => new Promise((resolve) => setTimeout(resolve, 5)),
};

storeConformance(subject);

// An aborted commit destroys its connection rather than returning it to the
// pool; the pool must replace it and serve the next commit and read normally.
Deno.test("DoltStore: the pool serves the next commit after an aborted commit", async () => {
  const store = await subject.make({});
  try {
    const aborted = new AbortController();
    const first = store.journal.commit(
      { events: [event({ event_id: "EV_ABORTED" })] },
      { signal: aborted.signal },
    );
    aborted.abort();
    const error = await first.then(() => undefined, (e) => e as Error);
    assertEquals(error?.name, "AbortError");
    assertFalse(await store.events.exists("EV_ABORTED"));

    // Aborting after the INSERT but before COMMIT: nothing lands either.
    const midway = new AbortController();
    const second = store.journal.commit(
      {
        events: [event({ event_id: "EV_MIDWAY" })],
        mutations: [],
      },
      { signal: midway.signal },
    );
    queueMicrotask(() => midway.abort());
    await second.then(() => undefined, () => undefined);

    // Every later commit and read runs on a healthy pooled connection.
    for (let i = 0; i < 8; i++) {
      await store.journal.commit({ events: [event({ event_id: `EV_NEXT_${i}` })] });
      await store.journal.commit(
        { events: [event({ event_id: `EV_SIGNAL_${i}` })] },
        { signal: new AbortController().signal },
      );
    }
    for (let i = 0; i < 8; i++) {
      assert(await store.events.exists(`EV_NEXT_${i}`));
      assert(await store.events.exists(`EV_SIGNAL_${i}`));
    }
  } finally {
    await subject.dispose(store);
  }
});

// The boot-time column check against a real information_schema: a copy of
// the fixture's schema passes; the same copy with a migration-added column
// dropped fails, naming it.
Deno.test("DoltStore: the boot-time column check names a column a migration added", async () => {
  const store = await subject.make({});
  try {
    await (store as DoltStore).assertCanonicalColumns();
    const admin = adminPool(databases.get(store)!);
    try {
      await admin.query("ALTER TABLE events DROP COLUMN trace_flags");
    } finally {
      await admin.end();
    }
    const error = await assertRejects(
      () => (store as DoltStore).assertCanonicalColumns(),
      MissingSchemaColumnsError,
    );
    assertEquals(error.missing, [{ table: "events", column: "trace_flags" }]);
    assertStringIncludes(error.message, "schema/migrations/");
  } finally {
    await subject.dispose(store);
  }
});
