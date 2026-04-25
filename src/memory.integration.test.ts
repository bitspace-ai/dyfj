/**
 * Integration tests for src/memory.ts — SQL retrieval functions
 *
 * These tests hit the live Dolt database at ~/.dyfj/data/dolt/.
 * They verify that the SQL layer correctly loads memories and that
 * executeReadMemory returns the right content for the extension's tool calls.
 *
 * Run with: bun test src/memory.integration.test.ts
 *
 * Prerequisites: Dolt running with seeded memories table
 *   (migrated from stage/ via migrate_stage.ts)
 */

import { test, expect, describe } from "bun:test";
import {
  loadMemoriesByType,
  loadMemoryIndex,
  getMemoryBySlug,
  executeReadMemory,
  buildSystemPrompt,
  type Memory,
  type MemoryIndexEntry,
} from "./memory";

// ── loadMemoriesByType ────────────────────────────────────────────────────────

describe("loadMemoriesByType (integration)", () => {
  test("loads user memories with full content", async () => {
    const memories = await loadMemoriesByType(["user"]);
    expect(memories.length).toBeGreaterThan(0);
    expect(memories.every(m => m.type === "user")).toBe(true);
    expect(memories.every(m => m.content.length > 0)).toBe(true);
    expect(memories.every(m => m.slug.length > 0)).toBe(true);
    expect(memories.every(m => m.name.length > 0)).toBe(true);
  });

  test("loads feedback memories with full content", async () => {
    const memories = await loadMemoriesByType(["feedback"]);
    expect(memories.length).toBeGreaterThan(0);
    expect(memories.every(m => m.type === "feedback")).toBe(true);
    expect(memories.every(m => m.content.length > 0)).toBe(true);
  });

  test("loads user + feedback combined — the core memory set", async () => {
    const memories = await loadMemoriesByType(["user", "feedback"]);
    expect(memories.some(m => m.type === "user")).toBe(true);
    expect(memories.some(m => m.type === "feedback")).toBe(true);
    // Spot-check known slugs
    const slugs = memories.map(m => m.slug);
    expect(slugs).toContain("user_profile");
    expect(slugs).toContain("feedback_humor");
  });

  test("content fields contain multiline text (not split by parser)", async () => {
    const memories = await loadMemoriesByType(["user"]);
    // At least one user memory should have a newline in its content —
    // confirms the RFC 4180 multiline CSV fix is working end-to-end
    const hasMultiline = memories.some(m => m.content.includes("\n"));
    expect(hasMultiline).toBe(true);
  });

  test("returns empty array for empty type list", async () => {
    const memories = await loadMemoriesByType([]);
    expect(memories).toEqual([]);
  });

  test("returns only requested types — no cross-contamination", async () => {
    const memories = await loadMemoriesByType(["user"]);
    expect(memories.every(m => m.type === "user")).toBe(true);
    expect(memories.some(m => m.type === "feedback")).toBe(false);
  });
});

// ── loadMemoryIndex ───────────────────────────────────────────────────────────

describe("loadMemoryIndex (integration)", () => {
  test("loads project + reference index entries", async () => {
    const index = await loadMemoryIndex(["project", "reference"]);
    expect(index.length).toBeGreaterThan(0);
    expect(index.some(e => e.type === "project")).toBe(true);
    expect(index.some(e => e.type === "reference")).toBe(true);
  });

  test("index entries have slug, name, description but NO content field", async () => {
    const index = await loadMemoryIndex(["project", "reference"]);
    for (const entry of index) {
      expect(entry.slug.length).toBeGreaterThan(0);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect("content" in entry).toBe(false);
    }
  });

  test("index includes known project slugs", async () => {
    const index = await loadMemoryIndex(["project"]);
    const slugs = index.map(e => e.slug);
    expect(slugs).toContain("project_dyfj");
  });

  test("index includes known reference slugs", async () => {
    const index = await loadMemoryIndex(["reference"]);
    const slugs = index.map(e => e.slug);
    expect(slugs).toContain("reference_sleipnir");
  });

  test("returns empty array for empty type list", async () => {
    const index = await loadMemoryIndex([]);
    expect(index).toEqual([]);
  });
});

// ── getMemoryBySlug ───────────────────────────────────────────────────────────

describe("getMemoryBySlug (integration)", () => {
  test("fetches a known memory by slug", async () => {
    const memory = await getMemoryBySlug("user_profile");
    expect(memory).not.toBeNull();
    expect(memory!.slug).toBe("user_profile");
    expect(memory!.type).toBe("user");
    expect(memory!.content.length).toBeGreaterThan(0);
  });

  test("returns null for a slug that does not exist", async () => {
    const memory = await getMemoryBySlug("this-slug-does-not-exist-xyz");
    expect(memory).toBeNull();
  });

  test("fetched memory has all fields populated", async () => {
    const memory = await getMemoryBySlug("feedback_humor");
    expect(memory).not.toBeNull();
    expect(memory!.memoryId.length).toBeGreaterThan(0);
    expect(memory!.name.length).toBeGreaterThan(0);
    expect(memory!.description.length).toBeGreaterThan(0);
    expect(memory!.content.length).toBeGreaterThan(0);
  });

  test("slug with SQL special chars is handled safely (no injection)", async () => {
    // Should return null without throwing, not execute injected SQL
    const memory = await getMemoryBySlug("' OR '1'='1");
    expect(memory).toBeNull();
  });
});

// ── executeReadMemory ─────────────────────────────────────────────────────────

describe("executeReadMemory (integration)", () => {
  test("returns formatted content for a known slug", async () => {
    const result = await executeReadMemory("user_profile");
    // Should be formatted as: # Name\n\ncontent
    expect(result).toMatch(/^# .+/);
    expect(result.length).toBeGreaterThan(50);
  });

  test("result heading matches the memory's name", async () => {
    const memory = await getMemoryBySlug("feedback_humor");
    const result = await executeReadMemory("feedback_humor");
    expect(result).toContain(`# ${memory!.name}`);
  });

  test("result body contains the memory content", async () => {
    const memory = await getMemoryBySlug("user_left_handed");
    const result = await executeReadMemory("user_left_handed");
    // Result should contain the actual content text
    expect(result).toContain(memory!.content.trim().slice(0, 50));
  });

  test("returns helpful not-found message for unknown slug", async () => {
    const result = await executeReadMemory("nonexistent-slug-xyz");
    expect(result).toContain("Memory not found");
    expect(result).toContain("nonexistent-slug-xyz");
    expect(result).toContain("Context Index"); // guides model to valid slugs
  });

  test("not-found response does not throw — graceful for hallucinated slugs", async () => {
    // Model may occasionally hallucinate a slug; should never throw
    await expect(executeReadMemory("made-up-slug-123")).resolves.toBeDefined();
  });
});

// ── Full session context round-trip ──────────────────────────────────────────

describe("full session context (integration)", () => {
  test("buildSystemPrompt with live data produces a non-trivial prompt", async () => {
    const core  = await loadMemoriesByType(["user", "feedback"]);
    const index = await loadMemoryIndex(["project", "reference"]);
    const prompt = buildSystemPrompt(core, index);

    // Should contain key sections
    expect(prompt).toContain("## About Chris");
    expect(prompt).toContain("## Working Preferences");
    expect(prompt).toContain("## Context Index");
    expect(prompt).toContain("project_dyfj");

    // Should be substantial — more than a stub
    expect(prompt.length).toBeGreaterThan(5000);
  });

  test("core memories cover expected counts", async () => {
    const user     = await loadMemoriesByType(["user"]);
    const feedback = await loadMemoriesByType(["feedback"]);
    // We migrated 12 user and 14 feedback memories
    expect(user.length).toBe(12);
    expect(feedback.length).toBe(14);
  });

  test("index covers expected counts", async () => {
    const project   = await loadMemoryIndex(["project"]);
    const reference = await loadMemoryIndex(["reference"]);
    expect(project.length).toBe(25);
    expect(reference.length).toBe(7);
  });
});
