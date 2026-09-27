import { assertEquals, assertRejects } from "@std/assert";
import {
  checkColumnsAtBoot,
  ColumnCheckTimeoutError,
  isDatabaseUnavailableError,
  MissingSchemaColumnsError,
} from "./schema-check.ts";

const probe = (assert: () => Promise<void>) => ({
  assertCanonicalColumns: assert,
});

Deno.test("checkColumnsAtBoot reports a completed check", async () => {
  assertEquals(
    await checkColumnsAtBoot(probe(() => Promise.resolve()), 1_000),
    "checked",
  );
});

Deno.test("checkColumnsAtBoot boots past an unreachable database", async () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });
  assertEquals(
    await checkColumnsAtBoot(probe(() => Promise.reject(refused)), 1_000),
    "unavailable",
  );
});

Deno.test("checkColumnsAtBoot bounds a check that never answers", async () => {
  // A blackholed host: the check never settles, so the bound decides.
  const started = Date.now();
  assertEquals(
    await checkColumnsAtBoot(probe(() => new Promise<void>(() => {})), 20),
    "unavailable",
  );
  assertEquals(Date.now() - started < 1_000, true);
  assertEquals(
    isDatabaseUnavailableError(new ColumnCheckTimeoutError(20)),
    true,
  );
});

Deno.test("checkColumnsAtBoot rejects on missing columns", async () => {
  const missing = new MissingSchemaColumnsError([
    { table: "events", column: "trace_flags" },
  ]);
  const error = await assertRejects(() =>
    checkColumnsAtBoot(probe(() => Promise.reject(missing)), 1_000)
  );
  assertEquals(error, missing);
});

Deno.test("checkColumnsAtBoot rejects on any other failure of the check", async () => {
  const parse = Object.assign(new Error("syntax"), { code: "ER_PARSE_ERROR" });
  const error = await assertRejects(() =>
    checkColumnsAtBoot(probe(() => Promise.reject(parse)), 1_000)
  );
  assertEquals(error, parse);
});
