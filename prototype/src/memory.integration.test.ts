/**
 * SQL integration coverage for memory retrieval in the isolated aggregate
 * lane. The fixture supplies the connection and every row asserted here.
 */

import { afterAll, describe, expect, test } from "vitest";
import {
  buildSystemPrompt,
  executeReadMemory,
  loadIndexedMemories,
  loadInjectedMemories,
} from "./memory.ts";
import { MEMORY_VISIBILITY_ALL } from "./store/mod.ts";
import { openFixtureStore } from "../testing/dolt/fixture-sql.ts";

const store = openFixtureStore();
afterAll(() => store.close());

describe("memory indexes (integration)", () => {
  test("uses the injection posture rather than a curated corpus size", async () => {
    const injected = await loadInjectedMemories(
      store.memories,
      MEMORY_VISIBILITY_ALL,
    );
    expect(injected.map((memory) => memory.slug)).toEqual([
      "fixture_user_private",
    ]);

    const indexed = await loadIndexedMemories(
      store.memories,
      MEMORY_VISIBILITY_ALL,
    );
    expect(indexed.map((memory) => memory.slug).sort()).toEqual([
      "fixture_feedback_shareable",
      "fixture_project_public",
      "fixture_reference_client_safe",
    ]);
    expect(indexed.every((memory) => !("content" in memory))).toBe(true);
  });

  test("remote clearance exposes only client-safe and public index rows", async () => {
    const indexed = await loadIndexedMemories(store.memories, [
      "client_safe",
      "public",
    ]);
    expect(indexed.map((memory) => memory.slug).sort()).toEqual([
      "fixture_project_public",
      "fixture_reference_client_safe",
    ]);
    expect(
      await loadInjectedMemories(store.memories, ["client_safe", "public"]),
    ).toEqual([]);
  });
});

describe("memory lookup (integration)", () => {
  test("reads a fixture row and treats unknown or SQL-shaped slugs as missing", async () => {
    const result = await executeReadMemory(
      store.memories,
      "fixture_feedback_shareable",
      MEMORY_VISIBILITY_ALL,
    );
    expect(result).toContain("Fixture Shareable Feedback");
    expect(result).toContain("shareable content");
    expect(
      await executeReadMemory(
        store.memories,
        "does-not-exist",
        MEMORY_VISIBILITY_ALL,
      ),
    ).toContain("Memory not found");
    expect(
      await executeReadMemory(
        store.memories,
        "' OR '1'='1",
        MEMORY_VISIBILITY_ALL,
      ),
    ).toContain("Memory not found");
  });

  test("formats a known row and gives a useful not-found result", async () => {
    const result = await executeReadMemory(
      store.memories,
      "fixture_user_private",
      MEMORY_VISIBILITY_ALL,
    );
    expect(result).toMatch(/^<untrusted-memory>/);
    expect(result).toContain("Fixture Private User");
    expect(result).toContain("private multiline");

    const missing = await executeReadMemory(
      store.memories,
      "does-not-exist",
      MEMORY_VISIBILITY_ALL,
    );
    expect(missing).toContain("Memory not found");
    expect(missing).toContain("does-not-exist");

    const outside = await executeReadMemory(
      store.memories,
      "fixture_user_private",
      ["client_safe", "public"],
    );
    expect(outside).toContain("Memory not found");
  });
});

describe("full session context (integration)", () => {
  test("builds a prompt from fixture core rows and fixture index rows", async () => {
    const core = await loadInjectedMemories(
      store.memories,
      MEMORY_VISIBILITY_ALL,
    );
    const index = await loadIndexedMemories(
      store.memories,
      MEMORY_VISIBILITY_ALL,
    );
    const prompt = buildSystemPrompt(core, index);

    expect(prompt).toContain("Fixture Private User");
    expect(prompt).toContain("Fixture Shareable Feedback");
    expect(prompt).toContain("fixture_project_public");
    expect(prompt).toContain("fixture_reference_client_safe");
  });
});
