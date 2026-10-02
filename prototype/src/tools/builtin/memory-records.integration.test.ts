/**
 * SQL integration coverage for memory retrieval in the isolated aggregate
 * lane. The fixture supplies the connection and every row asserted here.
 * executeReadMemory's lookup coverage lives beside the memory tools, in
 * tools/builtin/memory.integration.test.ts.
 */

import {
  assertEquals,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  buildSystemPrompt,
  loadIndexedMemories,
  loadInjectedMemories,
} from "./memory-records.ts";
import { type DoltStore, MEMORY_VISIBILITY_ALL } from "../../store/mod.ts";
import { openFixtureStore } from "../../../testing/dolt/fixture-sql.ts";

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

describe("memory indexes (integration)", () => {
  it("uses the injection posture rather than a curated corpus size", () =>
    withStore(async (store) => {
      const injected = await loadInjectedMemories(
        store.memories,
        MEMORY_VISIBILITY_ALL,
      );
      assertEquals(injected.map((memory) => memory.slug), [
        "fixture_user_private",
      ]);

      const indexed = await loadIndexedMemories(
        store.memories,
        MEMORY_VISIBILITY_ALL,
      );
      assertEquals(indexed.map((memory) => memory.slug).sort(), [
        "fixture_feedback_shareable",
        "fixture_project_public",
        "fixture_reference_client_safe",
      ]);
      assertStrictEquals(
        indexed.every((memory) => !("content" in memory)),
        true,
      );
    }));

  it("remote clearance exposes only client-safe and public index rows", () =>
    withStore(async (store) => {
      const indexed = await loadIndexedMemories(store.memories, [
        "client_safe",
        "public",
      ]);
      assertEquals(indexed.map((memory) => memory.slug).sort(), [
        "fixture_project_public",
        "fixture_reference_client_safe",
      ]);
      assertEquals(
        await loadInjectedMemories(store.memories, ["client_safe", "public"]),
        [],
      );
    }));
});

describe("full session context (integration)", () => {
  it("builds a prompt from fixture core rows and fixture index rows", () =>
    withStore(async (store) => {
      const core = await loadInjectedMemories(
        store.memories,
        MEMORY_VISIBILITY_ALL,
      );
      const index = await loadIndexedMemories(
        store.memories,
        MEMORY_VISIBILITY_ALL,
      );
      const prompt = buildSystemPrompt(core, index);

      assertStringIncludes(prompt, "Fixture Private User");
      assertStringIncludes(prompt, "Fixture Shareable Feedback");
      assertStringIncludes(prompt, "fixture_project_public");
      assertStringIncludes(prompt, "fixture_reference_client_safe");
    }));
});
