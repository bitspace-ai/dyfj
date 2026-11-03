/**
 * A Dolt server the runtime cannot reach or use says what is wrong.
 *
 * The driver's errors are masked to `[Error, N bytes]` at the turn boundary,
 * so a stopped sql-server or a mistyped DOLT_DATABASE reached the operator as
 * nothing at all, or as a misleading "Model not found" once the catalog fell
 * back to the built-in rows. The pool turns those driver errors, recognized by
 * their code, into `DomainError`s built from the runtime's own configuration.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DoltConnectionConfig } from "../config/mod.ts";
import { composeRuntimePolicy } from "../config/mod.ts";
import { DomainError, summarizeError } from "../contract/mod.ts";
import {
  createDoltPool,
  DoltDatabaseMissingError,
  DoltLoginRefusedError,
  DoltUnreachableError,
  guardDoltLogins,
} from "./dolt-pool.ts";
import type { DoltPool } from "./dolt-pool.ts";
import { checkColumnsAtBoot } from "./schema-check.ts";

const endpoint = { host: "127.0.0.1", port: 3306, database: "dolt" };

function driverError(message: string, code: string, errno: number): Error {
  return Object.assign(new Error(message), { code, errno });
}

function failingPool(error: unknown): DoltPool {
  return {
    execute: () => Promise.reject(error),
    getConnection: () => Promise.reject(error),
    end: () => Promise.resolve(),
  };
}

async function rejection(pool: DoltPool): Promise<unknown> {
  try {
    await pool.execute("SELECT 1");
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

test("a refused connection names the endpoint and how to start Dolt", async () => {
  const error = await rejection(guardDoltLogins(
    failingPool(
      driverError("connect ECONNREFUSED 127.0.0.1:3306", "ECONNREFUSED", -61),
    ),
    "workbench",
    endpoint,
  ));
  assert.ok(error instanceof DoltUnreachableError);
  assert.ok(error instanceof DomainError);
  assert.match(error.message, /Dolt is not answering at 127\.0\.0\.1:3306/);
  assert.match(error.message, /connection refused/);
  assert.match(error.message, /dolt sql-server/);
  assert.match(error.message, /DOLT_HOST/);
  assert.match(error.message, /DOLT_PORT/);
  assert.equal(summarizeError(error), error.message);
});

test("an unresolvable host is reported as such", async () => {
  const error = await rejection(guardDoltLogins(
    failingPool(
      driverError("getaddrinfo ENOTFOUND dolt.invalid", "ENOTFOUND", -3008),
    ),
    "workbench",
    { ...endpoint, host: "dolt.invalid" },
  ));
  assert.ok(error instanceof DoltUnreachableError);
  assert.match(error.message, /dolt\.invalid:3306/);
  assert.match(error.message, /host name did not resolve/);
});

test("an unknown database names DOLT_DATABASE and the schema", async () => {
  const error = await rejection(guardDoltLogins(
    failingPool(
      driverError("database not found: nope_db", "ER_BAD_DB_ERROR", 1049),
    ),
    "workbench",
    { ...endpoint, database: "nope_db" },
  ));
  assert.ok(error instanceof DoltDatabaseMissingError);
  assert.ok(error instanceof DomainError);
  assert.match(error.message, /no database "nope_db"/);
  assert.match(error.message, /DOLT_DATABASE/);
  assert.match(error.message, /schema\/README\.md/);
});

test("a login refused for the default user says DOLT_USER was not set", async () => {
  const error = await rejection(guardDoltLogins(
    failingPool(
      driverError("Access denied for user 'root'", "ER_ACCESS_DENIED_ERROR", 1045),
    ),
    "root",
    { ...endpoint, userDefaulted: true },
  ));
  assert.ok(error instanceof DoltLoginRefusedError);
  assert.match(error.message, /Dolt refused the login for user "root"/);
  assert.match(error.message, /DOLT_USER is not set/);
  assert.match(error.message, /prototype\/\.env/);
  assert.ok(!error.message.includes("Access denied"));
});

test("the real driver's refused connection becomes DoltUnreachableError", async () => {
  // Port 1 on loopback has no listener, so the driver itself raises the
  // ECONNREFUSED this maps; no stand-in error is involved.
  const config: DoltConnectionConfig = {
    host: "127.0.0.1",
    port: 1,
    user: "workbench",
    password: "do-not-print",
    database: "dolt",
  };
  const pool = createDoltPool(config, composeRuntimePolicy({ dolt: config }));
  try {
    const error = await rejection(pool);
    assert.ok(error instanceof DoltUnreachableError, String(error));
    assert.match(error.message, /127\.0\.0\.1:1 \(connection refused\)/);
    assert.ok(!error.message.includes("do-not-print"));
  } finally {
    await pool.end();
  }
});

test("the boot column check boots past every store-unavailable error", async () => {
  const errors = [
    new DoltLoginRefusedError("root"),
    new DoltUnreachableError(endpoint, "refused"),
    new DoltDatabaseMissingError("nope_db"),
  ];
  for (const error of errors) {
    assert.equal(
      await checkColumnsAtBoot(
        { assertCanonicalColumns: () => Promise.reject(error) },
        1_000,
      ),
      "unavailable",
      error.name,
    );
  }
});
