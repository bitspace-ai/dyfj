/**
 * The store probe behind `runtime/status`: three states, no driver text.
 *
 * A refused login or an unreachable server used to show only when a turn
 * failed. The probe runs one `SELECT 1` through the guarded pool and reports
 * what it learned — never rejects, and never holds the status past its bound.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DoltLoginRefusedError, type DoltQueryable } from "./dolt-pool.ts";
import { probeStoreStatus, STORE_PROBE_TIMEOUT_MS } from "./store-status.ts";

/** A stand-in for the pool: what the one `SELECT 1` does. */
function standin(
  answer: () => Promise<[unknown, unknown]>,
): DoltQueryable & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    execute(statement) {
      sql.push(statement);
      return answer();
    },
  };
}

test("probeStoreStatus — a query that answers is ok", async () => {
  const pool = standin(() => Promise.resolve([{ 1: 1 }, []]));
  assert.deepStrictEqual(await probeStoreStatus(pool), { state: "ok" });
  assert.deepStrictEqual(pool.sql, ["SELECT 1"]);
});

test("probeStoreStatus — a refused login is refused, naming the user", async () => {
  const pool = standin(() =>
    Promise.reject(new DoltLoginRefusedError("workbench"))
  );
  assert.deepStrictEqual(
    await probeStoreStatus(pool),
    { state: "refused", user: "workbench" },
  );
});

test("probeStoreStatus — a refused login with no user names none", async () => {
  const pool = standin(() => Promise.reject(new DoltLoginRefusedError()));
  assert.deepStrictEqual(await probeStoreStatus(pool), { state: "refused" });
});

test("probeStoreStatus — any other failure is unreachable, carrying nothing", async () => {
  // The driver's own message repeats the account and whatever the server
  // chose to say; none of it reaches the status.
  const pool = standin(() =>
    Promise.reject(
      new Error("connect ECONNREFUSED 127.0.0.1:3306 user 'workbench'"),
    )
  );
  assert.deepStrictEqual(await probeStoreStatus(pool), {
    state: "unreachable",
  });
});

test("probeStoreStatus — a query that never settles is unreachable at the bound", async () => {
  const pool = standin(() => new Promise<[unknown, unknown]>(() => {}));
  const started = Date.now();
  const status = await probeStoreStatus(pool, 20);
  assert.deepStrictEqual(status, { state: "unreachable" });
  // The bound, not the query, is what returned it.
  assert.ok(Date.now() - started < 1000);
});

test("probeStoreStatus — the default bound is 1500 ms", () => {
  assert.equal(STORE_PROBE_TIMEOUT_MS, 1500);
});
