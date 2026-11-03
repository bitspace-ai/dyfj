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
import { type AddressInfo, createServer } from "node:net";
import { test } from "node:test";
import type { DoltConnectionConfig } from "../config/mod.ts";
import { composeRuntimePolicy } from "../config/mod.ts";
import { DomainError, summarizeError } from "../contract/mod.ts";
import {
  createDoltPool,
  DoltDatabaseMissingError,
  DoltGrantMissingError,
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

test("a statement refused for want of a grant names the user and the grants", async () => {
  // Dolt's answers, as the driver raised them against a user granted SELECT
  // only: a write is ER_TABLEACCESS_DENIED_ERROR; a read of an ungranted table
  // is the generic ER_UNKNOWN_ERROR, recognized by its message's fixed shape.
  for (
    const raw of [
      driverError(
        "command denied to user 'probe_rw'@'%'",
        "ER_TABLEACCESS_DENIED_ERROR",
        1142,
      ),
      driverError(
        "Access denied for user 'probe_ro'@'%' to table 'events'",
        "ER_UNKNOWN_ERROR",
        1105,
      ),
    ]
  ) {
    const error = await rejection(
      guardDoltLogins(failingPool(raw), "dyfj_runtime", endpoint),
    );
    assert.ok(error instanceof DoltGrantMissingError, String(error));
    assert.ok(error instanceof DomainError);
    assert.match(error.message, /user "dyfj_runtime"/);
    assert.match(error.message, /grant/);
    assert.match(error.message, /Dolt users/);
    assert.ok(!error.message.includes("probe_"), error.message);
  }
});

test("an unrelated ER_UNKNOWN_ERROR is left alone", async () => {
  const raw = driverError(
    'column "nope" could not be found in any table in scope',
    "ER_UNKNOWN_ERROR",
    1105,
  );
  const error = await rejection(
    guardDoltLogins(failingPool(raw), "dyfj_runtime", endpoint),
  );
  assert.equal(error, raw);
});

test("an unroutable host is reported as no route, not a timeout", async () => {
  for (const code of ["EHOSTUNREACH", "ENETUNREACH"]) {
    const error = await rejection(guardDoltLogins(
      failingPool(driverError(`connect ${code} 10.0.0.1:3306`, code, -65)),
      "workbench",
      endpoint,
    ));
    assert.ok(error instanceof DoltUnreachableError, code);
    assert.match(error.message, /\(no route to the host\)/, code);
  }
});

test("a transaction's begin, commit and rollback report a store failure", async () => {
  const lost = driverError(
    "Connection lost: The server closed the connection.",
    "PROTOCOL_CONNECTION_LOST",
    -1,
  );
  const connection = {
    execute: () => Promise.resolve([[], []] as never),
    beginTransaction: () => Promise.reject(lost),
    commit: () => Promise.reject(lost),
    rollback: () => Promise.reject(lost),
    release: () => {},
    destroy: () => {},
  };
  const guarded = await guardDoltLogins(
    { ...failingPool(lost), getConnection: () => Promise.resolve(connection) },
    "workbench",
    endpoint,
  ).getConnection();
  for (const step of ["beginTransaction", "commit", "rollback"] as const) {
    await assert.rejects(
      () => guarded[step](),
      (error: unknown) =>
        error instanceof DoltUnreachableError &&
        /\(the connection was lost\)/.test(error.message),
      step,
    );
  }
});

/** A loopback port that was just free: bound, then released. */
async function freedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("the real driver's refused connection becomes DoltUnreachableError", async () => {
  // A port this test bound and released has no listener, so the driver
  // itself raises the ECONNREFUSED this maps; no stand-in error is involved.
  const port = await freedLoopbackPort();
  const config: DoltConnectionConfig = {
    host: "127.0.0.1",
    port,
    user: "workbench",
    password: "do-not-print",
    database: "dolt",
  };
  const pool = createDoltPool(config, composeRuntimePolicy({ dolt: config }));
  try {
    const error = await rejection(pool);
    assert.ok(error instanceof DoltUnreachableError, String(error));
    assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${port} \\(connection refused\\)`));
    assert.ok(!error.message.includes("do-not-print"));
  } finally {
    await pool.end();
  }
});

test("the boot column check boots past a refused login, an unreachable server and a missing database", async () => {
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
