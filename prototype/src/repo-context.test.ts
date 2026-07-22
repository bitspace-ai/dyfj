import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  AGENTS_INSTRUCTIONS_MAX_READ_BYTES,
  AGENTS_INSTRUCTIONS_TOKEN_LIMIT,
  buildAskSystemPrompt,
  buildContextSourceLines,
  COMPACT_CONTEXT_BUDGET,
  type ContextSection,
  DEFAULT_CONTEXT_BUDGET,
  estimateContextTokens,
  extractReadmeSection1,
  loadAgentsInstructions,
  type LoadedRepoContext,
  packContextSections,
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
  test("names repo files and context sources without private context paths", () => {
    const lines = buildContextSourceLines([
      { kind: "file", label: "AGENTS.md", path: "AGENTS.md" },
      {
        kind: "file",
        label: "README.md Section 1",
        path: "README.md#section-1",
      },
      {
        kind: "file",
        label: "notes/workbench-mvp-loop.md",
        path: "notes/workbench-mvp-loop.md",
      },
    ]);

    expect(lines).toEqual([
      "AGENTS.md <AGENTS.md>",
      "README.md Section 1 <README.md#section-1>",
      "notes/workbench-mvp-loop.md <notes/workbench-mvp-loop.md>",
    ]);
  });
});

describe("buildAskSystemPrompt", () => {
  test("frames the repo-local next-work question with public-safe context", () => {
    const context: LoadedRepoContext = {
      sources: [
        { kind: "file", label: "AGENTS.md", path: "AGENTS.md" },
        {
          kind: "file",
          label: "notes/workbench-mvp-loop.md",
          path: "notes/workbench-mvp-loop.md",
        },
      ],
      profile: "compact",
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
          title: "notes/workbench-mvp-loop.md excerpt",
          body: "Workbench MVP loop: ship the smallest useful slice.",
        },
      ],
    };

    const prompt = buildAskSystemPrompt(
      "You are the test companion. Help with anything.",
      context,
    );

    // The persona is the injected base prompt; the builder composes it with
    // the live repo context (no hardcoded persona of its own).
    expect(prompt).toContain("You are the test companion. Help with anything.");
    expect(prompt).toContain(
      "Workbench MVP loop: ship the smallest useful slice.",
    );
    expect(prompt).toContain("Context sources used");
  });
});

describe("packContextSections", () => {
  test("compact profile uses a small budget weighted to repo context", () => {
    expect(COMPACT_CONTEXT_BUDGET.totalTokens).toBe(500);
    expect(COMPACT_CONTEXT_BUDGET.totalTokens).toBeLessThan(
      DEFAULT_CONTEXT_BUDGET.totalTokens,
    );
    expect(COMPACT_CONTEXT_BUDGET.activeRepoPercent).toBeGreaterThan(
      COMPACT_CONTEXT_BUDGET.derivedMemoryPercent,
    );
  });

  test("compact budget can keep AGENTS and README Section 1 sources", () => {
    const packed = packContextSections([
      {
        title: "AGENTS.md excerpt",
        body:
          "Read README Section 1. Section 1 is authoritative. Use the private tracker.",
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
        title: "notes/workbench-mvp-loop.md excerpt",
        body: "Workbench MVP loop: ship the smallest useful slice.",
        bucket: "active_repo",
        source: {
          kind: "file",
          label: "notes/workbench-mvp-loop.md",
          path: "notes/workbench-mvp-loop.md",
        },
      },
    ], COMPACT_CONTEXT_BUDGET);

    expect(packed.sources.map((source) => source.label)).toEqual([
      "AGENTS.md",
      "README.md Section 1",
      "notes/workbench-mvp-loop.md",
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
        title: "derived memory note",
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

describe("loadAgentsInstructions", () => {
  test("loads AGENTS.md at the workspace root; no sibling markers required", async () => {
    const dir = await Deno.makeTempDir({ prefix: "agents-instructions-flat-" });
    try {
      await Deno.writeTextFile(path.join(dir, "AGENTS.md"), "# Flat Rules\n");

      const result = await loadAgentsInstructions(dir);
      expect(result?.body.trim()).toBe("# Flat Rules");
      expect(result?.source).toEqual({
        kind: "file",
        label: "AGENTS.md",
        path: "AGENTS.md",
      });
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("does NOT discover an ancestor's AGENTS.md — discovery is contained to the workspace root", async () => {
    // The containment contract: content from outside the operator-selected
    // workspace must never enter the model request. An ancestor carrying the
    // old walk-up markers (AGENTS.md + README.md) is exactly the escape this
    // pins shut; a subdirectory workspace degrades to graceful absence.
    const dir = await Deno.makeTempDir({ prefix: "agents-instructions-anc-" });
    try {
      await Deno.writeTextFile(
        path.join(dir, "AGENTS.md"),
        "# Ancestor Rules — must not leak\n",
      );
      await Deno.writeTextFile(path.join(dir, "README.md"), "# Repo\n");
      const nested = path.join(dir, "a", "b");
      await Deno.mkdir(nested, { recursive: true });

      expect(await loadAgentsInstructions(nested)).toBeNull();
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("rejects a non-regular-file AGENTS.md — the lstat guard never follows links", async () => {
    // Sandbox constraint, disclosed: Deno.symlink() requires unscoped
    // read+write, which the path-scoped test profile deliberately refuses,
    // so a literal symlink fixture cannot be constructed here. The guard
    // under test is `lstat` + `!isFile`, which rejects a symlink, a
    // directory, or a FIFO through the identical branch — lstat never
    // follows links by definition — so a directory fixture pins the same
    // containment behavior with a constructible fixture.
    const dir = await Deno.makeTempDir({ prefix: "agents-instructions-nrf-" });
    try {
      await Deno.mkdir(path.join(dir, "AGENTS.md"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(await loadAgentsInstructions(dir)).toBeNull();
        expect(warn).toHaveBeenCalledWith(
          "AGENTS.md skipped: not a regular file in the workspace root",
        );
      } finally {
        warn.mockRestore();
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("returns null for a workspace with no AGENTS.md", async () => {
    const dir = await Deno.makeTempDir({ prefix: "agents-instructions-none-" });
    try {
      expect(await loadAgentsInstructions(dir)).toBeNull();
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("caps an oversized AGENTS.md with a marker and an excerpt-labeled source", async () => {
    // The system prompt is never compressed, so the injected body must be
    // bounded here — and the receipt must say an excerpt entered the prompt,
    // not the whole file.
    const dir = await Deno.makeTempDir({ prefix: "agents-instructions-big-" });
    try {
      const oversized = "# Giant Rules\n\n" +
        "All work must be receipted. ".repeat(10_000); // ~70K tokens
      await Deno.writeTextFile(path.join(dir, "AGENTS.md"), oversized);
      await Deno.writeTextFile(path.join(dir, "README.md"), "# Repo\n");

      const result = await loadAgentsInstructions(dir);
      expect(result).not.toBeNull();
      expect(estimateContextTokens(result!.body))
        .toBeLessThanOrEqual(AGENTS_INSTRUCTIONS_TOKEN_LIMIT + 50);
      expect(result!.body).toContain("[AGENTS.md truncated");
      expect(result!.source).toEqual({
        kind: "file",
        label: "AGENTS.md excerpt",
        path: "AGENTS.md",
      });
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("flags truncation when the byte-bound read clips inside a whitespace run", async () => {
    // Adversarial shape: short real content, then a whitespace run spanning
    // the 64KB read bound, then more content past it. The token slice lands
    // inside the whitespace, so `trimEnd()` makes the capped and read bodies
    // agree — the string comparison alone would report the full file while
    // the content past the byte bound was silently dropped. The loader must
    // flag the clipped read itself.
    const dir = await Deno.makeTempDir({ prefix: "agents-instructions-ws-" });
    try {
      const head = "# Rules before the whitespace run\n";
      const padding = "\n".repeat(AGENTS_INSTRUCTIONS_MAX_READ_BYTES);
      const tail = "# Rules past the read bound\n";
      await Deno.writeTextFile(
        path.join(dir, "AGENTS.md"),
        head + padding + tail,
      );

      const result = await loadAgentsInstructions(dir);
      expect(result).not.toBeNull();
      expect(result!.body).toContain("[AGENTS.md truncated");
      expect(result!.body).not.toContain("past the read bound");
      expect(result!.source).toEqual({
        kind: "file",
        label: "AGENTS.md excerpt",
        path: "AGENTS.md",
      });
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});
