/**
 * SQL integration coverage for `executeReadMemory` (the reader behind
 * `memory.read`) in the isolated aggregate lane. The fixture supplies the
 * connection and every row asserted here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type DoltStore, MEMORY_VISIBILITY_ALL } from "../../store/mod.ts";
import { openFixtureStore } from "../../../testing/dolt/fixture-sql.ts";
import { executeReadMemory } from "./memory.ts";

// Each test opens its own fixture store and closes it before returning, so the
// test sanitizers see no pooled connection outlive the test that opened it.
async function withStore(
  fn: (store: DoltStore) => Promise<void>,
): Promise<void> {
  const store = openFixtureStore();
  try {
    await fn(store);
  } finally {
    await store.close();
  }
}

describe("memory lookup (integration)", () => {
  it("reads a fixture row and treats unknown or SQL-shaped slugs as missing", () =>
    withStore(async (store) => {
      const result = await executeReadMemory(
        store.memories,
        "fixture_feedback_shareable",
        MEMORY_VISIBILITY_ALL,
      );
      assert.ok(
        result.includes("Fixture Shareable Feedback"),
        `expected ${
          JSON.stringify(result)
        } to include "Fixture Shareable Feedback"`,
      );
      assert.ok(
        result.includes("shareable content"),
        `expected ${JSON.stringify(result)} to include "shareable content"`,
      );
      assert.ok(
        (await executeReadMemory(
          store.memories,
          "does-not-exist",
          MEMORY_VISIBILITY_ALL,
        )).includes("Memory not found"),
        `expected await executeReadMemory(
          store.memories,
          "does-not-exist",
          MEMORY_VISIBILITY_ALL,
        ) to include "Memory not found"`,
      );
      assert.ok(
        (await executeReadMemory(
          store.memories,
          "' OR '1'='1",
          MEMORY_VISIBILITY_ALL,
        )).includes("Memory not found"),
        `expected await executeReadMemory(
          store.memories,
          "' OR '1'='1",
          MEMORY_VISIBILITY_ALL,
        ) to include "Memory not found"`,
      );
    }));

  it("formats a known row and gives a useful not-found result", () =>
    withStore(async (store) => {
      const result = await executeReadMemory(
        store.memories,
        "fixture_user_private",
        MEMORY_VISIBILITY_ALL,
      );
      assert.match(result, /^<untrusted-memory>/);
      assert.ok(
        result.includes("Fixture Private User"),
        `expected ${JSON.stringify(result)} to include "Fixture Private User"`,
      );
      assert.ok(
        result.includes("private multiline"),
        `expected ${JSON.stringify(result)} to include "private multiline"`,
      );

      const missing = await executeReadMemory(
        store.memories,
        "does-not-exist",
        MEMORY_VISIBILITY_ALL,
      );
      assert.ok(
        missing.includes("Memory not found"),
        `expected ${JSON.stringify(missing)} to include "Memory not found"`,
      );
      assert.ok(
        missing.includes("does-not-exist"),
        `expected ${JSON.stringify(missing)} to include "does-not-exist"`,
      );

      const outside = await executeReadMemory(
        store.memories,
        "fixture_user_private",
        ["client_safe", "public"],
      );
      assert.ok(
        outside.includes("Memory not found"),
        `expected ${JSON.stringify(outside)} to include "Memory not found"`,
      );
    }));
});
