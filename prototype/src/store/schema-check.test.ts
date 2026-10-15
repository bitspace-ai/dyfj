import assert from "node:assert/strict";
import { test } from "node:test";
import { captureRejection } from "../../testing/assertions/captured.ts";
import {
  checkColumnsAtBoot,
  ColumnCheckTimeoutError,
  isDatabaseUnavailableError,
  MissingSchemaColumnsError,
} from "./schema-check.ts";

const probe = (check: () => Promise<void>) => ({
  assertCanonicalColumns: check,
});

test("checkColumnsAtBoot reports a completed check", async () => {
  assert.strictEqual(
    await checkColumnsAtBoot(probe(() => Promise.resolve()), 1_000),
    "checked",
  );
});

test("checkColumnsAtBoot boots past an unreachable database", async () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });
  assert.strictEqual(
    await checkColumnsAtBoot(probe(() => Promise.reject(refused)), 1_000),
    "unavailable",
  );
});

test("checkColumnsAtBoot bounds a check that never answers", async () => {
  // A blackholed host: the check never settles, so the bound decides.
  const started = Date.now();
  assert.strictEqual(
    await checkColumnsAtBoot(probe(() => new Promise<void>(() => {})), 20),
    "unavailable",
  );
  assert.strictEqual(Date.now() - started < 1_000, true);
  assert.strictEqual(
    isDatabaseUnavailableError(new ColumnCheckTimeoutError(20)),
    true,
  );
});

test("checkColumnsAtBoot rejects on missing columns", async () => {
  const missing = new MissingSchemaColumnsError([
    { table: "events", column: "trace_flags" },
  ]);
  const error = await captureRejection(() =>
    checkColumnsAtBoot(probe(() => Promise.reject(missing)), 1_000)
  );
  assert.strictEqual(error, missing);
});

test("checkColumnsAtBoot rejects on any other failure of the check", async () => {
  const parse = Object.assign(new Error("syntax"), { code: "ER_PARSE_ERROR" });
  const error = await captureRejection(() =>
    checkColumnsAtBoot(probe(() => Promise.reject(parse)), 1_000)
  );
  assert.strictEqual(error, parse);
});
