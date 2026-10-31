/**
 * The store probe behind `runtime/status`: three states, no driver text.
 *
 * A refused login or an unreachable server used to show only when a turn
 * failed. The probe runs one `SELECT 1` through the guarded pool and reports
 * what it learned. It never rejects, races its query against a timer, and keeps
 * at most one query outstanding.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DoltLoginRefusedError, type DoltQueryable } from "./dolt-pool.ts";
import { createStoreProbe, STORE_PROBE_TIMEOUT_MS } from "./store-status.ts";

/** One probe call, as `runtime/status` makes it. */
function probeStoreStatus(pool: DoltQueryable, timeoutMs?: number) {
  return createStoreProbe(pool, timeoutMs)();
}

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

test("probeStoreStatus — a query that never settles is unreachable at the timer", async () => {
  const pool = standin(() => new Promise<[unknown, unknown]>(() => {}));
  const started = Date.now();
  const status = await probeStoreStatus(pool, 20);
  assert.deepStrictEqual(status, { state: "unreachable" });
  // The 20 ms timer, not the 1500 ms default, returned it; the margin is for a
  // loaded machine.
  assert.ok(Date.now() - started < 500);
});

test("createStoreProbe — a hung query is not repeated while it is pending", async () => {
  let settle: (value: [unknown, unknown]) => void = () => {};
  let hung = true;
  // The first query hangs until released; any query after that answers.
  const pool = standin(() =>
    hung
      ? new Promise<[unknown, unknown]>((resolve) => {
        settle = resolve;
      })
      : Promise.resolve([{ 1: 1 }, []])
  );
  const probe = createStoreProbe(pool, 10);
  for (let call = 0; call < 3; call += 1) {
    assert.deepStrictEqual(await probe(), { state: "unreachable" });
  }
  assert.strictEqual(pool.sql.length, 1);
  // Once the query settles, the next call starts a fresh one.
  hung = false;
  settle([{ 1: 1 }, []]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(await probe(), { state: "ok" });
  assert.strictEqual(pool.sql.length, 2);
});

test("probeStoreStatus — the default bound is 1500 ms", () => {
  assert.equal(STORE_PROBE_TIMEOUT_MS, 1500);
});
