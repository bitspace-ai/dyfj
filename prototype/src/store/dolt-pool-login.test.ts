/**
 * A refused Dolt login names the credential it refused.
 *
 * The driver's own error is masked to `[Error, N bytes]` at the turn boundary,
 * so a wrong DOLT_USER or DOLT_PASSWORD reached the operator as nothing at all:
 * every turn failed before the model call and the REPL printed only that
 * placeholder. The pool turns exactly that error into a `DomainError` built
 * from the runtime's resolved configuration, and every other failure is left
 * alone so it stays masked.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DoltConnectionConfig } from "../config/mod.ts";
import { composeRuntimePolicy } from "../config/mod.ts";
import { DomainError, summarizeError } from "../contract/mod.ts";
import {
  createDoltPool,
  DoltLoginRefusedError,
  guardDoltLogins,
} from "./dolt-pool.ts";
import type { DoltConnection, DoltPool } from "./dolt-pool.ts";

const configured: DoltConnectionConfig = {
  host: "127.0.0.1",
  port: 3306,
  user: "workbench",
  password: "hunter2-do-not-print",
  database: "dolt",
};

/** What the driver raises for a refused login. */
function refusedLogin(): Error & { code: string; errno: number } {
  return Object.assign(
    new Error(
      "Access denied for user 'workbench'@'localhost' (using password: YES)",
    ),
    { code: "ER_ACCESS_DENIED_ERROR", errno: 1045 },
  );
}

/** A driver pool standing in for mysql2's, failing every call with `error`. */
function failingPool(error: unknown): DoltPool {
  return {
    execute: () => Promise.reject(error),
    getConnection: () => Promise.reject(error),
    end: () => Promise.resolve(),
  };
}

test("a refused login becomes a DomainError naming the user and DOLT_USER", async () => {
  const guarded = guardDoltLogins(failingPool(refusedLogin()), "workbench");
  await assert.rejects(
    () => guarded.execute("SELECT 1"),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.ok(error instanceof DoltLoginRefusedError);
      assert.match(
        error.message,
        /Dolt refused the login for user "workbench"/,
      );
      assert.match(error.message, /DOLT_USER/);
      assert.match(error.message, /DOLT_PASSWORD/);
      assert.ok(!error.message.includes(configured.password));
      assert.ok(!error.message.includes("Access denied"));
      assert.ok(!error.message.includes("using password"));
      return true;
    },
  );
});

test("the errno alone identifies a refused login", async () => {
  const errnoOnly = Object.assign(new Error("driver detail"), { errno: 1045 });
  const guarded = guardDoltLogins(failingPool(errnoOnly), "workbench");
  await assert.rejects(
    () => guarded.execute("SELECT 1"),
    DoltLoginRefusedError,
  );
});

test("a refused login from getConnection becomes a DomainError", async () => {
  const guarded = guardDoltLogins(failingPool(refusedLogin()), "workbench");
  await assert.rejects(
    () => guarded.getConnection(),
    (error: unknown) =>
      error instanceof DoltLoginRefusedError &&
      error.user === "workbench" &&
      /DOLT_USER/.test(error.message),
  );
});

test("a refused login on a borrowed connection becomes a DomainError", async () => {
  const connection: DoltConnection = {
    execute: () => Promise.reject(refusedLogin()),
    beginTransaction: () => Promise.resolve(),
    commit: () => Promise.resolve(),
    rollback: () => Promise.resolve(),
    release: () => {},
    destroy: () => {},
  };
  const pool: DoltPool = {
    execute: () => Promise.resolve([[], []] as [unknown, unknown]),
    getConnection: () => Promise.resolve(connection),
    end: () => Promise.resolve(),
  };
  const guarded = guardDoltLogins(pool, "workbench");
  const borrowed = await guarded.getConnection();
  await assert.rejects(() => borrowed.execute("BEGIN"), DoltLoginRefusedError);
});

test("any other connection error is not turned into a DomainError", async () => {
  const others = [
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), {
      code: "ECONNREFUSED",
    }),
    Object.assign(new Error("Unknown database 'dolt'"), {
      code: "ER_BAD_DB_ERROR",
      errno: 1049,
    }),
    Object.assign(new Error("You have an error in your SQL syntax"), {
      code: "ER_PARSE_ERROR",
      errno: 1064,
    }),
    new Error("boom"),
    "not an error at all",
  ];
  for (const error of others) {
    const guarded = guardDoltLogins(failingPool(error), "workbench");
    await assert.rejects(
      () => guarded.execute("SELECT 1"),
      (thrown: unknown) => {
        assert.equal(thrown, error);
        assert.ok(!(thrown instanceof DomainError));
        return true;
      },
    );
  }
});

test("a refusing pool that names no user still names the keys to check", async () => {
  const guarded = guardDoltLogins(failingPool(refusedLogin()), undefined);
  await assert.rejects(
    () => guarded.execute("SELECT 1"),
    (error: unknown) =>
      error instanceof DoltLoginRefusedError &&
      error.user === undefined &&
      /DOLT_USER/.test(error.message) &&
      !error.message.includes("undefined"),
  );
});

test("the turn boundary shows the message instead of a byte count", () => {
  assert.match(
    summarizeError(new DoltLoginRefusedError("workbench")),
    /Dolt refused the login for user "workbench"/,
  );
  // The masked outcome this change removes, for contrast.
  assert.match(summarizeError(refusedLogin()), /^\[Error, \d+ bytes\]$/);
});

test("the pool the factory builds guards its statements", async () => {
  // Port 1, not 3306: a developer machine often runs a real Dolt on 3306,
  // which would refuse this fixture's user and turn the expected connection
  // refusal into a refused login.
  const unreachable = { ...configured, port: 1 };
  const pool = createDoltPool(
    unreachable,
    composeRuntimePolicy({ dolt: unreachable }),
  );
  // No server is listening: the guarded pool's own execute is what runs, and
  // the failure it reports is a connection refusal, not a refused login.
  await assert.rejects(
    () => pool.execute("SELECT 1"),
    (error: unknown) => !(error instanceof DomainError),
  );
  await pool.end();
});
