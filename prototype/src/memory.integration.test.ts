/**
 * Hermetic SQL integration coverage for memory retrieval.
 *
 * The aggregate fixture supplies the rows used here. This file deliberately
 * names only fixture data so it never reads or asserts against an operator
 * corpus.
 */

import { describe, expect, test } from "vitest";
import {
  buildSystemPrompt,
  executeReadMemory,
  getMemoryBySlug,
  loadIndexedMemories,
  loadInjectedMemories,
  loadMemoriesByType,
  loadMemoryIndex,
  MEMORY_VISIBILITY_ALL,
} from "./memory";

describe("loadMemoriesByType (integration)", () => {
  test("loads the fixture user and feedback rows with their full content", async () => {
    const user = await loadMemoriesByType(["user"], MEMORY_VISIBILITY_ALL);
    const feedback = await loadMemoriesByType(
      ["feedback"],
      MEMORY_VISIBILITY_ALL,
    );

    expect(user.map((memory) => memory.slug)).toEqual(["fixture_user_private"]);
    expect(user[0]?.content).toContain("private multiline\ncontent");
    expect(feedback.map((memory) => memory.slug)).toEqual([
      "fixture_feedback_shareable",
    ]);
  });

  test("does not cross-contaminate requested types or an empty request", async () => {
    const user = await loadMemoriesByType(["user"], MEMORY_VISIBILITY_ALL);
    expect(user.every((memory) => memory.type === "user")).toBe(true);
    expect(await loadMemoriesByType([], MEMORY_VISIBILITY_ALL)).toEqual([]);
  });

  test("remote clearance withholds private and shareable core rows", async () => {
    expect(
      await loadMemoriesByType(["user", "feedback"], [
        "client_safe",
        "public",
      ]),
    ).toEqual([]);
  });
});

describe("memory indexes (integration)", () => {
  test("loads project and reference index entries without their content", async () => {
    const index = await loadMemoryIndex(
      ["project", "reference"],
      MEMORY_VISIBILITY_ALL,
    );
    expect(index.map((memory) => memory.slug).sort()).toEqual([
      "fixture_project_public",
      "fixture_reference_client_safe",
    ]);
    expect(index.every((memory) => !("content" in memory))).toBe(true);
  });

  test("uses the injection posture rather than a curated corpus size", async () => {
    const injected = await loadInjectedMemories(MEMORY_VISIBILITY_ALL);
    expect(injected.map((memory) => memory.slug)).toEqual([
      "fixture_user_private",
    ]);

    const indexed = await loadIndexedMemories(MEMORY_VISIBILITY_ALL);
    expect(indexed.map((memory) => memory.slug).sort()).toEqual([
      "fixture_feedback_shareable",
      "fixture_project_public",
      "fixture_reference_client_safe",
    ]);
  });

  test("remote clearance exposes only client-safe and public index rows", async () => {
    const indexed = await loadIndexedMemories(["client_safe", "public"]);
    expect(indexed.map((memory) => memory.slug).sort()).toEqual([
      "fixture_project_public",
      "fixture_reference_client_safe",
    ]);
    expect(await loadInjectedMemories(["client_safe", "public"])).toEqual([]);
  });
});

describe("memory lookup (integration)", () => {
  test("retrieves a fixture row and handles unknown or SQL-shaped slugs", async () => {
    const memory = await getMemoryBySlug("fixture_feedback_shareable");
    expect(memory).toMatchObject({
      slug: "fixture_feedback_shareable",
      type: "feedback",
      name: "Fixture Shareable Feedback",
    });
    expect(memory?.content).toContain("shareable content");
    expect(await getMemoryBySlug("does-not-exist")).toBeNull();
    expect(await getMemoryBySlug("' OR '1'='1")).toBeNull();
  });

  test("formats a known row and gives a useful not-found result", async () => {
    const result = await executeReadMemory("fixture_user_private");
    expect(result).toMatch(/^<untrusted-memory>/);
    expect(result).toContain("Fixture Private User");
    expect(result).toContain("private multiline");

    const missing = await executeReadMemory("does-not-exist");
    expect(missing).toContain("Memory not found");
    expect(missing).toContain("does-not-exist");
  });
});

describe("full session context (integration)", () => {
  test("builds a prompt from fixture core rows and fixture index rows", async () => {
    const core = await loadMemoriesByType(
      ["user", "feedback"],
      MEMORY_VISIBILITY_ALL,
    );
    const index = await loadMemoryIndex(
      ["project", "reference"],
      MEMORY_VISIBILITY_ALL,
    );
    const prompt = buildSystemPrompt(core, index);

    expect(prompt).toContain("Fixture Private User");
    expect(prompt).toContain("Fixture Shareable Feedback");
    expect(prompt).toContain("fixture_project_public");
    expect(prompt).toContain("fixture_reference_client_safe");
  });
});
