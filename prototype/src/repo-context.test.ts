import { describe, expect, test } from "vitest";
import {
  BEADS_FIRST_CONTEXT_BUDGET,
  buildAskSystemPrompt,
  buildContextSourceLines,
  type ContextSection,
  DEFAULT_CONTEXT_BUDGET,
  estimateContextTokens,
  extractReadmeSection1,
  type LoadedRepoContext,
  packContextSections,
  parseReadyIssueIds,
} from "./repo-context";

describe("extractReadmeSection1", () => {
  test("returns only README Section 1", () => {
    const section = extractReadmeSection1([
      "# DYFJ",
      "",
      "## 1. Decisions",
      "",
      "Layer 0 rules.",
      "",
      "## 2. Goal",
      "",
      "Later section.",
    ].join("\n"));

    expect(section).toContain("## 1. Decisions");
    expect(section).toContain("Layer 0 rules.");
    expect(section).not.toContain("## 2. Goal");
    expect(section).not.toContain("Later section.");
  });
});

describe("buildContextSourceLines", () => {
  test("names repo files and Beads commands without private context paths", () => {
    const lines = buildContextSourceLines([
      { kind: "file", label: "AGENTS.md", path: "AGENTS.md" },
      {
        kind: "file",
        label: "README.md Section 1",
        path: "README.md#section-1",
      },
      { kind: "command", label: "bd ready", path: "bd ready" },
    ]);

    expect(lines).toEqual([
      "AGENTS.md <AGENTS.md>",
      "README.md Section 1 <README.md#section-1>",
      "bd ready <bd ready>",
    ]);
  });
});

describe("buildAskSystemPrompt", () => {
  test("frames the repo-local next-work question with public-safe context", () => {
    const context: LoadedRepoContext = {
      sources: [
        { kind: "file", label: "AGENTS.md", path: "AGENTS.md" },
        { kind: "command", label: "bd ready", path: "bd ready" },
      ],
      profile: "beads-first",
      budget: {
        totalTokens: 100,
        usedTokens: 20,
        headroomTokens: 10,
        byBucket: {
          system: { limitTokens: 20, usedTokens: 10 },
          active_repo: { limitTokens: 50, usedTokens: 0 },
          derived_memory: { limitTokens: 20, usedTokens: 10 },
        },
      },
      sections: [
        { title: "AGENTS.md", body: "Read README Section 1." },
        {
          title: "Beads: bd ready",
          body: "dyfj-2fl.7 Build first usable command",
        },
      ],
    };

    const prompt = buildAskSystemPrompt(
      "You are the test companion. Help with anything.",
      context,
    );

    // The persona is the injected base prompt; the builder composes it with
    // the live repo/Beads context (no hardcoded persona of its own).
    expect(prompt).toContain("You are the test companion. Help with anything.");
    expect(prompt).toContain("dyfj-2fl.7 Build first usable command");
    expect(prompt).toContain("Context sources used");
  });
});

describe("parseReadyIssueIds", () => {
  test("extracts ready Beads issue ids in display order", () => {
    const ids = parseReadyIssueIds([
      "○ dyfj-2fl.8.2 ● P1 Build next-work model routing experiment",
      "○ dyfj-2fl.7 ● P1 Build first usable DYFJ companion command",
      "○ dyfj-2fl ● P1 Design Workbench MVP",
      "",
      "Ready: 3 issues with no active blockers",
    ].join("\n"));

    expect(ids).toEqual(["dyfj-2fl.8.2", "dyfj-2fl.7", "dyfj-2fl"]);
  });
});

describe("packContextSections", () => {
  test("beads-first profile reserves most non-system context for Beads", () => {
    expect(BEADS_FIRST_CONTEXT_BUDGET.totalTokens).toBe(500);
    expect(BEADS_FIRST_CONTEXT_BUDGET.derivedMemoryPercent).toBeGreaterThan(
      BEADS_FIRST_CONTEXT_BUDGET.activeRepoPercent,
    );
  });

  test("beads-first budget can keep AGENTS and README Section 1 sources", () => {
    const packed = packContextSections([
      {
        title: "AGENTS.md excerpt",
        body: "Read README Section 1. Section 1 is authoritative. Use Beads.",
        bucket: "system",
        source: { kind: "file", label: "AGENTS.md", path: "AGENTS.md" },
      },
      {
        title: "README.md Section 1 excerpt",
        body:
          "Layer 0: local-first. Goal 1 done-line. Policy and authority rules win.",
        bucket: "system",
        source: {
          kind: "file",
          label: "README.md Section 1",
          path: "README.md#section-1",
        },
      },
      {
        title: "Beads: bd ready",
        body: "○ dyfj-2fl.7 ● P1 Build first usable DYFJ companion command",
        bucket: "derived_memory",
        source: { kind: "command", label: "bd ready", path: "bd ready" },
      },
    ], BEADS_FIRST_CONTEXT_BUDGET);

    expect(packed.sources.map((source) => source.label)).toEqual([
      "AGENTS.md",
      "README.md Section 1",
      "bd ready",
    ]);
  });

  test("enforces tiered budget ceilings and reserves headroom", () => {
    const sections: ContextSection[] = [
      { title: "AGENTS.md", body: "s".repeat(400), bucket: "system" },
      { title: "README.md Section 1", body: "r".repeat(400), bucket: "system" },
      {
        title: "notes/workbench-mvp-loop.md",
        body: "a".repeat(1200),
        bucket: "active_repo",
      },
      {
        title: "Beads: bd ready",
        body: "b".repeat(800),
        bucket: "derived_memory",
      },
    ];

    const packed = packContextSections(sections, {
      totalTokens: 100,
      systemPercent: 0.2,
      activeRepoPercent: 0.5,
      derivedMemoryPercent: 0.2,
      headroomPercent: 0.1,
    });

    expect(packed.summary.usedTokens).toBeLessThanOrEqual(90);
    expect(packed.summary.byBucket.system.usedTokens).toBeLessThanOrEqual(20);
    expect(packed.summary.byBucket.active_repo.usedTokens).toBeLessThanOrEqual(
      50,
    );
    expect(packed.summary.byBucket.derived_memory.usedTokens)
      .toBeLessThanOrEqual(20);
    expect(packed.summary.headroomTokens).toBe(10);
    expect(packed.sections.some((section) => section.truncated)).toBe(true);
  });

  test("keeps source metadata only for included sections", () => {
    const packed = packContextSections([
      {
        title: "large",
        body: "x".repeat(400),
        bucket: "active_repo",
        source: { kind: "file", label: "large", path: "large.md" },
      },
      {
        title: "second",
        body: "y".repeat(400),
        bucket: "active_repo",
        source: { kind: "file", label: "second", path: "second.md" },
      },
    ], {
      ...DEFAULT_CONTEXT_BUDGET,
      totalTokens: 40,
    });

    expect(packed.sources.map((source) => source.label)).toEqual(["large"]);
  });
});

describe("estimateContextTokens", () => {
  test("uses the same four-character approximation as model preflight", () => {
    expect(estimateContextTokens("12345678")).toBe(2);
  });
});
