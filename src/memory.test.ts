/**
 * Unit tests for src/memory.ts
 *
 * All tests are pure — no Dolt, no network.
 * I/O functions (loadMemoriesByType, loadMemoryIndex, getMemoryBySlug,
 * executeReadMemory) are not tested here; they delegate to doltQuery which
 * shells out to Dolt. The pure functions that compose the session context
 * are fully covered.
 */

import { test, expect, describe } from "bun:test";
import {
  buildSystemPrompt,
  buildReadMemoryTool,
  buildToolResult,
  type Memory,
  type MemoryIndexEntry,
} from "./memory";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    memoryId:    "01TEST00000000000000000000",
    slug:        "user_profile",
    type:        "user",
    name:        "User Profile",
    description: "Core user context",
    content:     "Chris Woods. Principal Engineer. Bitspace LLC.",
    ...overrides,
  };
}

function makeIndex(overrides: Partial<MemoryIndexEntry> = {}): MemoryIndexEntry {
  return {
    slug:        "project_dyfj",
    type:        "project",
    name:        "DYFJ Workbench",
    description: "Chris's modular AI platform",
    ...overrides,
  };
}

const SAMPLE_USER_MEMORIES: Memory[] = [
  makeMemory({ slug: "user_profile",    name: "User Profile",    content: "Chris is a Principal Engineer." }),
  makeMemory({ slug: "user_left_handed",name: "Left-Handed",     content: "Chris is left-handed." }),
];

const SAMPLE_FEEDBACK_MEMORIES: Memory[] = [
  makeMemory({ slug: "feedback_humor",      type: "feedback", name: "Humor",       content: "Chris has dry humor." }),
  makeMemory({ slug: "feedback_local_models",type: "feedback", name: "Local Models", content: "Default to local models." }),
];

const SAMPLE_INDEX: MemoryIndexEntry[] = [
  makeIndex({ slug: "project_dyfj",    name: "DYFJ Workbench",    description: "Chris's AI platform" }),
  makeIndex({ slug: "reference_sleipnir", type: "reference", name: "Sleipnir", description: "Home server specs" }),
];

// ── buildSystemPrompt — nudge ─────────────────────────────────────────────────

describe("buildSystemPrompt — nudge", () => {
  test("includes nudge when index is non-empty", () => {
    const prompt = buildSystemPrompt(SAMPLE_USER_MEMORIES, SAMPLE_INDEX);
    expect(prompt).toContain("Before starting any task");
    expect(prompt).toContain("read_memory()");
  });

  test("nudge references 'Context Index'", () => {
    const prompt = buildSystemPrompt(SAMPLE_USER_MEMORIES, SAMPLE_INDEX);
    expect(prompt).toContain("Context Index");
  });

  test("nudge conveys consequence of skipping — 'working blind'", () => {
    const prompt = buildSystemPrompt(SAMPLE_USER_MEMORIES, SAMPLE_INDEX);
    expect(prompt).toContain("working blind");
  });

  test("omits nudge when index is empty", () => {
    const prompt = buildSystemPrompt(SAMPLE_USER_MEMORIES, []);
    expect(prompt).not.toContain("Before starting any task");
    expect(prompt).not.toContain("working blind");
  });

  test("nudge appears before the memory sections (model sees it early)", () => {
    const prompt = buildSystemPrompt(SAMPLE_USER_MEMORIES, SAMPLE_INDEX);
    const nudgePos  = prompt.indexOf("Before starting any task");
    const aboutPos  = prompt.indexOf("## About the User");
    expect(nudgePos).toBeLessThan(aboutPos);
  });
});

// ── buildSystemPrompt — user memories ────────────────────────────────────────

describe("buildSystemPrompt — user memories", () => {
  test("includes 'About the User' section", () => {
    const prompt = buildSystemPrompt(SAMPLE_USER_MEMORIES, []);
    expect(prompt).toContain("## About the User");
  });

  test("includes each user memory name as a heading", () => {
    const prompt = buildSystemPrompt(SAMPLE_USER_MEMORIES, []);
    expect(prompt).toContain("### User Profile");
    expect(prompt).toContain("### Left-Handed");
  });

  test("includes user memory content verbatim", () => {
    const prompt = buildSystemPrompt(SAMPLE_USER_MEMORIES, []);
    expect(prompt).toContain("Chris is a Principal Engineer.");
    expect(prompt).toContain("Chris is left-handed.");
  });

  test("omits 'About the User' section when no user memories", () => {
    const prompt = buildSystemPrompt([], []);
    expect(prompt).not.toContain("## About the User");
  });

  test("does not include user memory content in the index table", () => {
    const prompt = buildSystemPrompt(SAMPLE_USER_MEMORIES, SAMPLE_INDEX);
    // Content should be in prose sections, not duplicated in table rows
    const tableStart = prompt.indexOf("| slug |");
    if (tableStart === -1) return; // no table — pass
    const tableSection = prompt.slice(tableStart);
    expect(tableSection).not.toContain("Chris is a Principal Engineer.");
  });
});

// ── buildSystemPrompt — feedback memories ────────────────────────────────────

describe("buildSystemPrompt — feedback memories", () => {
  test("includes 'Working Preferences' section", () => {
    const prompt = buildSystemPrompt(SAMPLE_FEEDBACK_MEMORIES, []);
    expect(prompt).toContain("## Working Preferences");
  });

  test("includes each feedback memory name as a heading", () => {
    const prompt = buildSystemPrompt(SAMPLE_FEEDBACK_MEMORIES, []);
    expect(prompt).toContain("### Humor");
    expect(prompt).toContain("### Local Models");
  });

  test("includes feedback memory content verbatim", () => {
    const prompt = buildSystemPrompt(SAMPLE_FEEDBACK_MEMORIES, []);
    expect(prompt).toContain("Chris has dry humor.");
    expect(prompt).toContain("Default to local models.");
  });

  test("omits 'Working Preferences' section when no feedback memories", () => {
    const prompt = buildSystemPrompt(SAMPLE_USER_MEMORIES, []);
    expect(prompt).not.toContain("## Working Preferences");
  });

  test("user section appears before feedback section", () => {
    const all = [...SAMPLE_USER_MEMORIES, ...SAMPLE_FEEDBACK_MEMORIES];
    const prompt = buildSystemPrompt(all, []);
    const aboutPos    = prompt.indexOf("## About the User");
    const prefsPos    = prompt.indexOf("## Working Preferences");
    expect(aboutPos).toBeLessThan(prefsPos);
  });
});

// ── buildSystemPrompt — context index ────────────────────────────────────────

describe("buildSystemPrompt — context index", () => {
  test("includes 'Context Index' section heading", () => {
    const prompt = buildSystemPrompt([], SAMPLE_INDEX);
    expect(prompt).toContain("## Context Index");
  });

  test("includes markdown table header row", () => {
    const prompt = buildSystemPrompt([], SAMPLE_INDEX);
    expect(prompt).toContain("| slug | type | name | description |");
  });

  test("includes each index entry slug", () => {
    const prompt = buildSystemPrompt([], SAMPLE_INDEX);
    expect(prompt).toContain("project_dyfj");
    expect(prompt).toContain("reference_sleipnir");
  });

  test("includes type in index row", () => {
    const prompt = buildSystemPrompt([], SAMPLE_INDEX);
    expect(prompt).toContain("| project |");
    expect(prompt).toContain("| reference |");
  });

  test("includes name and description in index row", () => {
    const prompt = buildSystemPrompt([], SAMPLE_INDEX);
    expect(prompt).toContain("DYFJ Workbench");
    expect(prompt).toContain("Chris's AI platform");
  });

  test("omits index section when index is empty", () => {
    const prompt = buildSystemPrompt(SAMPLE_USER_MEMORIES, []);
    expect(prompt).not.toContain("## Context Index");
    expect(prompt).not.toContain("| slug |");
  });

  test("index section appears after memory sections", () => {
    const all = [...SAMPLE_USER_MEMORIES, ...SAMPLE_FEEDBACK_MEMORIES];
    const prompt = buildSystemPrompt(all, SAMPLE_INDEX);
    const prefsPos  = prompt.indexOf("## Working Preferences");
    const indexPos  = prompt.indexOf("## Context Index");
    expect(prefsPos).toBeLessThan(indexPos);
  });

  test("index section invites calling read_memory(slug)", () => {
    const prompt = buildSystemPrompt([], SAMPLE_INDEX);
    expect(prompt).toContain("read_memory(slug)");
  });

  test("descriptions with pipe characters are escaped for table safety", () => {
    const index = [makeIndex({ description: "A | B | C" })];
    const prompt = buildSystemPrompt([], index);
    // Pipes in content should be escaped so they don't break the table
    expect(prompt).toContain("A \\| B \\| C");
  });

  test("descriptions with newlines are collapsed to spaces", () => {
    const index = [makeIndex({ description: "Line one\nLine two" })];
    const prompt = buildSystemPrompt([], index);
    expect(prompt).toContain("Line one Line two");
    expect(prompt).not.toMatch(/Line one\nLine two/);
  });

  test("long descriptions are truncated to 120 chars", () => {
    const long = "x".repeat(200);
    const index = [makeIndex({ description: long })];
    const prompt = buildSystemPrompt([], index);
    // The description column should not contain 200 x's
    expect(prompt).not.toContain("x".repeat(200));
    expect(prompt).toContain("x".repeat(120));
  });
});

// ── buildSystemPrompt — identity injection ───────────────────────────────────

const TEST_PREFIX = "user_agent_";
const TEST_OPTS   = { identitySlugPrefix: TEST_PREFIX };

const AGENT_IDENTITY_MEMORY = makeMemory({
  slug: "user_agent_identity",
  name: "Agent Identity",
  content: "You are the DYFJ workbench AI.",
});
const AGENT_VOICE_MEMORY = makeMemory({
  slug: "user_agent_voice",
  name: "Agent Voice",
  content: "Be direct. Match dry humor.",
});
const AGENT_STEERING_MEMORY = makeMemory({
  slug: "user_agent_steering",
  name: "Agent Steering Rules",
  content: "Check north star before every task.",
});
const AGENT_IDENTITY_MEMORIES = [AGENT_IDENTITY_MEMORY, AGENT_VOICE_MEMORY, AGENT_STEERING_MEMORY];

describe("buildSystemPrompt — identity injection", () => {
  test("identity memories appear before user context section", () => {
    const prompt = buildSystemPrompt([...AGENT_IDENTITY_MEMORIES, ...SAMPLE_USER_MEMORIES], [], TEST_OPTS);
    const identityPos = prompt.indexOf("You are the DYFJ");
    const aboutPos    = prompt.indexOf("## About the User");
    expect(identityPos).toBeGreaterThanOrEqual(0);
    expect(identityPos).toBeLessThan(aboutPos);
  });

  test("identity memories appear in canonical order: identity → voice → steering", () => {
    const prompt = buildSystemPrompt([...AGENT_IDENTITY_MEMORIES, ...SAMPLE_USER_MEMORIES], [], TEST_OPTS);
    const idPos       = prompt.indexOf("You are the DYFJ");
    const voicePos    = prompt.indexOf("Be direct");
    const steeringPos = prompt.indexOf("Check north star");
    expect(idPos).toBeLessThan(voicePos);
    expect(voicePos).toBeLessThan(steeringPos);
  });

  test("identity slugs are NOT included in user context section", () => {
    const prompt = buildSystemPrompt([...AGENT_IDENTITY_MEMORIES, ...SAMPLE_USER_MEMORIES], [], TEST_OPTS);
    const aboutStart = prompt.indexOf("## About the User");
    if (aboutStart === -1) return;
    const aboutSection = prompt.slice(aboutStart);
    expect(aboutSection).not.toContain("### Agent Identity");
    expect(aboutSection).not.toContain("### Agent Voice");
  });

  test("empty memories produces empty prompt — identity comes from Dolt", () => {
    const prompt = buildSystemPrompt([], [], TEST_OPTS);
    expect(prompt.trim()).toBe("");
  });

  test("unknown identity slugs still appear in identity section", () => {
    const future = makeMemory({ slug: "user_agent_future", name: "Future Rule", content: "Future rule content." });
    const prompt = buildSystemPrompt([...AGENT_IDENTITY_MEMORIES, future, ...SAMPLE_USER_MEMORIES], [], TEST_OPTS);
    const identityPos = prompt.indexOf("Future rule content.");
    const aboutPos    = prompt.indexOf("## About the User");
    expect(identityPos).toBeGreaterThanOrEqual(0);
    expect(identityPos).toBeLessThan(aboutPos);
  });

  test("no identitySlugPrefix — all user memories appear in user context section", () => {
    const prompt = buildSystemPrompt([...AGENT_IDENTITY_MEMORIES, ...SAMPLE_USER_MEMORIES], []);
    // No identity section hoisted above the user section
    const userSectionPos  = prompt.indexOf("## About the User");
    const identityContent = prompt.indexOf("You are the DYFJ");
    expect(userSectionPos).toBeGreaterThanOrEqual(0);
    // Identity content appears AFTER (inside) the user section, not before it
    expect(identityContent).toBeGreaterThan(userSectionPos);
  });
});

// ── buildReadMemoryTool ───────────────────────────────────────────────────────

describe("buildReadMemoryTool", () => {
  test("tool name is 'read_memory'", () => {
    const tool = buildReadMemoryTool();
    expect(tool.name).toBe("read_memory");
  });

  test("description mentions loading full content", () => {
    const tool = buildReadMemoryTool();
    expect(tool.description.toLowerCase()).toContain("full content");
  });

  test("description mentions the Context Index as source for slugs", () => {
    const tool = buildReadMemoryTool();
    expect(tool.description).toContain("Context Index");
  });

  test("parameters schema has a required 'slug' string property", () => {
    const tool = buildReadMemoryTool();
    const schema = tool.parameters as any;
    expect(schema.type).toBe("object");
    expect(schema.properties?.slug?.type).toBe("string");
    expect(schema.required).toContain("slug");
  });

  test("slug parameter description gives an example slug", () => {
    const tool = buildReadMemoryTool();
    const schema = tool.parameters as any;
    expect(schema.properties.slug.description).toContain("project_dyfj");
  });
});

// ── buildToolResult ───────────────────────────────────────────────────────────

describe("buildToolResult", () => {
  test("sets role to 'toolResult'", () => {
    const result = buildToolResult("call-123", "read_memory", "content");
    expect(result.role).toBe("toolResult");
  });

  test("carries toolCallId and toolName", () => {
    const result = buildToolResult("call-abc", "read_memory", "some content");
    expect(result.toolCallId).toBe("call-abc");
    expect(result.toolName).toBe("read_memory");
  });

  test("wraps content as TextContent array", () => {
    const result = buildToolResult("call-1", "read_memory", "memory content here");
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as any).text).toBe("memory content here");
  });

  test("defaults isError to false", () => {
    const result = buildToolResult("call-1", "read_memory", "ok");
    expect(result.isError).toBe(false);
  });

  test("isError can be set to true for error responses", () => {
    const result = buildToolResult("call-1", "read_memory", "not found", true);
    expect(result.isError).toBe(true);
  });

  test("timestamp is a recent number", () => {
    const before = Date.now();
    const result = buildToolResult("call-1", "read_memory", "x");
    const after  = Date.now();
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });
});
