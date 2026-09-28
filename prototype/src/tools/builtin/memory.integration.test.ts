/**
 * SQL integration coverage for `executeReadMemory` (the reader behind
 * `memory.read`) in the isolated aggregate lane. The fixture supplies the
 * connection and every row asserted here.
 */

import { assertMatch, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
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
      assertStringIncludes(result, "Fixture Shareable Feedback");
      assertStringIncludes(result, "shareable content");
      assertStringIncludes(
        await executeReadMemory(
          store.memories,
          "does-not-exist",
          MEMORY_VISIBILITY_ALL,
        ),
        "Memory not found",
      );
      assertStringIncludes(
        await executeReadMemory(
          store.memories,
          "' OR '1'='1",
          MEMORY_VISIBILITY_ALL,
        ),
        "Memory not found",
      );
    }));

  it("formats a known row and gives a useful not-found result", () =>
    withStore(async (store) => {
      const result = await executeReadMemory(
        store.memories,
        "fixture_user_private",
        MEMORY_VISIBILITY_ALL,
      );
      assertMatch(result, /^<untrusted-memory>/);
      assertStringIncludes(result, "Fixture Private User");
      assertStringIncludes(result, "private multiline");

      const missing = await executeReadMemory(
        store.memories,
        "does-not-exist",
        MEMORY_VISIBILITY_ALL,
      );
      assertStringIncludes(missing, "Memory not found");
      assertStringIncludes(missing, "does-not-exist");

      const outside = await executeReadMemory(
        store.memories,
        "fixture_user_private",
        ["client_safe", "public"],
      );
      assertStringIncludes(outside, "Memory not found");
    }));
});
