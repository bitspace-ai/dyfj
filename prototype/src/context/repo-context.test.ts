import path from "node:path";
import {
  assert,
  assertEquals,
  assertFalse,
  assertGreater,
  assertLess,
  assertLessOrEqual,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCall, assertSpyCalls, stub } from "@std/testing/mock";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import {
  AGENTS_INSTRUCTIONS_MAX_READ_BYTES,
  AGENTS_INSTRUCTIONS_TOKEN_LIMIT,
  type AskContextProfile,
  buildAskSystemPrompt,
  buildContextSourceLines,
  COMPACT_CONTEXT_BUDGET,
  type ContextBudget,
  type ContextSection,
  DEFAULT_CONTEXT_BUDGET,
  estimateContextTokens,
  extractReadmeSection1,
  loadAgentsInstructions,
  loadAskRepoContext,
  type LoadedRepoContext,
  packContextSections,
} from "./repo-context.ts";

// When no profile or budget is passed, `loadAskRepoContext` reads their
// defaults (`DYFJ_WORKBENCH_CONTEXT_PROFILE`, `DYFJ_WORKBENCH_CONTEXT_TOKENS`)
// from its `env` option, or from the process environment when none is given.
// The unit lane grants no env access, so these tests either pass the budget
// the fallback resolves to when that variable is unset (the profile's
// default) or inject a `MapEnv`.
function defaultBudgetFor(profile: AskContextProfile): ContextBudget {
  return profile === "full" ? DEFAULT_CONTEXT_BUDGET : COMPACT_CONTEXT_BUDGET;
}

// The symlink case and a no-budget (env fallback) case need subprocess and
// env grants, which this lane does not give; they run from
// repo-context.platform.test.ts on the Vitest lane.

Deno.test("extractReadmeSection1: returns only README Section 1", () => {
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

  assertStringIncludes(section, "## 1. Decisions");
  assertStringIncludes(section, "Layer 0 rules.");
  assertFalse(section.includes("## 2. Goal"));
  assertFalse(section.includes("Later section."));
});

Deno.test("buildContextSourceLines: names repo files and context sources without private context paths", () => {
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

  assertEquals(lines, [
    "AGENTS.md <AGENTS.md>",
    "README.md Section 1 <README.md#section-1>",
    "notes/workbench-mvp-loop.md <notes/workbench-mvp-loop.md>",
  ]);
});

Deno.test("buildAskSystemPrompt: frames the repo-local next-work question with public-safe context", () => {
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
  assertStringIncludes(
    prompt,
    "You are the test companion. Help with anything.",
  );
  assertStringIncludes(
    prompt,
    "Workbench MVP loop: ship the smallest useful slice.",
  );
  assertStringIncludes(prompt, "Context sources used");
});

Deno.test("loadAskRepoContext: loads generic README and manifest context from the selected workspace", async () => {
  const selectedRoot = await Deno.makeTempDir({
    prefix: "ask-context-selected-",
  });
  try {
    await Deno.writeTextFile(
      path.join(selectedRoot, "README.md"),
      "# Music Rotater\n\nRotates a personal music library.\n",
    );
    await Deno.writeTextFile(
      path.join(selectedRoot, "package.json"),
      JSON.stringify({ name: "music-rotater", version: "1.0.0" }),
    );

    const context = await loadAskRepoContext({
      repoRoot: selectedRoot,
      profile: "full",
      budget: defaultBudgetFor("full"),
    });
    const rendered = buildAskSystemPrompt("test companion", context);

    assertEquals(context.sources, [
      { kind: "file", label: "README.md", path: "README.md" },
      { kind: "file", label: "package.json", path: "package.json" },
    ]);
    assertLess(
      rendered.indexOf("untrusted workspace context"),
      rendered.indexOf("Music Rotater"),
    );
    assertStringIncludes(rendered, "Music Rotater");
    assertStringIncludes(rendered, '"name":"music-rotater"');
  } finally {
    await Deno.remove(selectedRoot, { recursive: true });
  }
});

Deno.test("loadAskRepoContext: reads the profile and token-budget defaults from the injected env", async () => {
  const selectedRoot = await Deno.makeTempDir({
    prefix: "ask-context-env-",
  });
  try {
    await Deno.writeTextFile(
      path.join(selectedRoot, "README.md"),
      "# Music Rotater\n\nRotates a personal music library.\n",
    );

    const configured = await loadAskRepoContext({
      repoRoot: selectedRoot,
      env: new MapEnv({
        DYFJ_WORKBENCH_CONTEXT_PROFILE: "full",
        DYFJ_WORKBENCH_CONTEXT_TOKENS: "12345",
      }),
    });
    assertEquals(configured.profile, "full");
    assertEquals(configured.budget.totalTokens, 12345);

    // An env without either variable yields the compact profile's default.
    const unset = await loadAskRepoContext({
      repoRoot: selectedRoot,
      env: new MapEnv({}),
    });
    assertEquals(unset.profile, "compact");
    assertEquals(
      unset.budget.totalTokens,
      COMPACT_CONTEXT_BUDGET.totalTokens,
    );
  } finally {
    await Deno.remove(selectedRoot, { recursive: true });
  }
});

Deno.test("loadAskRepoContext: a repository without DYFJ-shaped files degrades to empty bounded context", async () => {
  const selectedRoot = await Deno.makeTempDir({
    prefix: "ask-context-empty-",
  });
  try {
    const context = await loadAskRepoContext({
      repoRoot: selectedRoot,
      profile: "compact",
      budget: defaultBudgetFor("compact"),
    });

    assertEquals(context.sources, []);
    assertEquals(context.sections, []);
    assertStrictEquals(context.budget.usedTokens, 0);
  } finally {
    await Deno.remove(selectedRoot, { recursive: true });
  }
});

Deno.test("loadAskRepoContext: compact generic AGENTS context leaves room for the README section", async () => {
  const selectedRoot = await Deno.makeTempDir({
    prefix: "ask-context-system-budget-",
  });
  try {
    await Deno.writeTextFile(
      path.join(selectedRoot, "AGENTS.md"),
      "Generic project instructions. ".repeat(80),
    );
    await Deno.writeTextFile(
      path.join(selectedRoot, "README.md"),
      "# Project\n\n## 1. Decisions\n\nThe README decision context must remain visible.\n",
    );

    const context = await loadAskRepoContext({
      repoRoot: selectedRoot,
      profile: "compact",
      budget: defaultBudgetFor("compact"),
    });

    assertEquals(context.sources.map((source) => source.path), [
      "AGENTS.md",
      "README.md#section-1",
    ]);
  } finally {
    await Deno.remove(selectedRoot, { recursive: true });
  }
});

Deno.test("loadAskRepoContext: loads the richer Workbench context when those files exist in the selected workspace", async () => {
  const selectedRoot = await Deno.makeTempDir({
    prefix: "ask-context-dyfj-",
  });
  try {
    await Deno.writeTextFile(
      path.join(selectedRoot, "AGENTS.md"),
      "Read README Section 1; it is authoritative.\n",
    );
    await Deno.writeTextFile(
      path.join(selectedRoot, "README.md"),
      "# Project\n\n## 1. Decisions\n\nLayer 0 rules.\n\n## 2. Goal\n\nShip.\n",
    );
    await Deno.mkdir(path.join(selectedRoot, "notes"));
    await Deno.writeTextFile(
      path.join(selectedRoot, "notes", "workbench-mvp-loop.md"),
      "Workbench loop: ship the smallest useful slice.\n",
    );

    const context = await loadAskRepoContext({
      repoRoot: selectedRoot,
      profile: "full",
      budget: defaultBudgetFor("full"),
    });

    assertEquals(context.sources.map((source) => source.path), [
      "AGENTS.md",
      "README.md#section-1",
      "notes/workbench-mvp-loop.md",
    ]);
    const bodies = context.sections.map((section) => section.body).join(
      "\n",
    );
    assertStringIncludes(
      buildAskSystemPrompt("test companion", context),
      "untrusted workspace context",
    );
    assertFalse(bodies.includes("## 2. Goal"));
  } finally {
    await Deno.remove(selectedRoot, { recursive: true });
  }
});

Deno.test("loadAskRepoContext: compact Workbench context prioritizes notes ahead of a manifest", async () => {
  const selectedRoot = await Deno.makeTempDir({
    prefix: "ask-context-priority-",
  });
  try {
    await Deno.mkdir(path.join(selectedRoot, "notes"));
    await Deno.writeTextFile(
      path.join(selectedRoot, "notes", "workbench-mvp-loop.md"),
      "Workbench loop: ship the smallest useful slice. ".repeat(4),
    );
    await Deno.writeTextFile(
      path.join(selectedRoot, "deno.json"),
      JSON.stringify({ description: "manifest context ".repeat(100) }),
    );

    const context = await loadAskRepoContext({
      repoRoot: selectedRoot,
      profile: "compact",
      budget: defaultBudgetFor("compact"),
    });
    const paths = context.sources.map((source) => source.path);

    assert(paths.includes("notes/workbench-mvp-loop.md"));
    if (paths.includes("deno.json")) {
      assertLess(
        paths.indexOf("notes/workbench-mvp-loop.md"),
        paths.indexOf("deno.json"),
      );
    }
  } finally {
    await Deno.remove(selectedRoot, { recursive: true });
  }
});

Deno.test("packContextSections: compact profile uses a small budget weighted to repo context", () => {
  assertStrictEquals(COMPACT_CONTEXT_BUDGET.totalTokens, 500);
  assertLess(
    COMPACT_CONTEXT_BUDGET.totalTokens,
    DEFAULT_CONTEXT_BUDGET.totalTokens,
  );
  assertGreater(
    COMPACT_CONTEXT_BUDGET.activeRepoPercent,
    COMPACT_CONTEXT_BUDGET.derivedMemoryPercent,
  );
});

Deno.test("packContextSections: compact budget can keep AGENTS and README Section 1 sources", () => {
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

  assertEquals(packed.sources.map((source) => source.label), [
    "AGENTS.md",
    "README.md Section 1",
    "notes/workbench-mvp-loop.md",
  ]);
});

Deno.test("packContextSections: enforces tiered budget ceilings and reserves headroom", () => {
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

  assertLessOrEqual(packed.summary.usedTokens, 90);
  assertLessOrEqual(packed.summary.byBucket.system.usedTokens, 20);
  assertLessOrEqual(packed.summary.byBucket.active_repo.usedTokens, 50);
  assertLessOrEqual(packed.summary.byBucket.derived_memory.usedTokens, 20);
  assertStrictEquals(packed.summary.headroomTokens, 10);
  assertStrictEquals(
    packed.sections.some((section) => section.truncated),
    true,
  );
});

Deno.test("packContextSections: keeps source metadata only for included sections", () => {
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

  assertEquals(packed.sources.map((source) => source.label), ["large"]);
});

Deno.test("estimateContextTokens: uses the same four-character approximation as model preflight", () => {
  assertStrictEquals(estimateContextTokens("12345678"), 2);
});

Deno.test("loadAgentsInstructions: loads AGENTS.md at the workspace root; no sibling markers required", async () => {
  const dir = await Deno.makeTempDir({ prefix: "agents-instructions-flat-" });
  try {
    await Deno.writeTextFile(path.join(dir, "AGENTS.md"), "# Flat Rules\n");

    const result = await loadAgentsInstructions(dir);
    assertStrictEquals(result?.body.trim(), "# Flat Rules");
    assertEquals(result?.source, {
      kind: "file",
      label: "AGENTS.md",
      path: "AGENTS.md",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadAgentsInstructions: does NOT discover an ancestor's AGENTS.md — discovery is contained to the workspace root", async () => {
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

    assertStrictEquals(await loadAgentsInstructions(nested), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadAgentsInstructions: rejects a non-regular-file AGENTS.md — the lstat guard never follows links", async () => {
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
    using warn = stub(console, "warn");
    assertStrictEquals(await loadAgentsInstructions(dir), null);
    assertSpyCalls(warn, 1);
    assertSpyCall(warn, 0, {
      args: ["AGENTS.md skipped: not a regular file in the workspace root"],
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadAgentsInstructions: returns null for a workspace with no AGENTS.md", async () => {
  const dir = await Deno.makeTempDir({ prefix: "agents-instructions-none-" });
  try {
    assertStrictEquals(await loadAgentsInstructions(dir), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadAgentsInstructions: a root whose identity differs from the selection anchor is refused", async () => {
  // The adversarial root-replacement shape, pinned via its constructible
  // half: the caller anchors the identity of the directory it verified at
  // selection time; if discovery resolves the same pathname to a DIFFERENT
  // directory (a persisted root/ancestor swap), the loader refuses. The
  // live mid-read race itself cannot be scheduled deterministically in a
  // test; this pins the detection branch both sides of the read share.
  const dir = await Deno.makeTempDir({ prefix: "agents-instructions-swap-" });
  try {
    await Deno.writeTextFile(
      path.join(dir, "AGENTS.md"),
      "# Swapped-in rules — must not load\n",
    );
    const real = await Deno.stat(await Deno.realPath(dir));
    using warn = stub(console, "warn");
    const result = await loadAgentsInstructions(dir, {
      dev: real.dev,
      ino: real.ino === null ? 1 : real.ino + 1,
    });
    assertStrictEquals(result, null);
    assertSpyCalls(warn, 1);
    assertSpyCall(warn, 0, {
      args: [
        "AGENTS.md skipped: workspace root is not the selected directory",
      ],
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadAgentsInstructions: a matching selection anchor loads normally; a null-identity anchor fails closed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "agents-instructions-anc2-" });
  try {
    await Deno.writeTextFile(path.join(dir, "AGENTS.md"), "# Anchored\n");
    const real = await Deno.stat(await Deno.realPath(dir));

    const loaded = await loadAgentsInstructions(dir, {
      dev: real.dev,
      ino: real.ino,
    });
    assertStrictEquals(loaded?.body.trim(), "# Anchored");

    using warn = stub(console, "warn");
    assertStrictEquals(
      await loadAgentsInstructions(dir, { dev: null, ino: null }),
      null,
    );
    assertSpyCalls(warn, 1);
    assertSpyCall(warn, 0, {
      args: [
        "AGENTS.md skipped: workspace root identity unavailable on this platform",
      ],
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadAgentsInstructions: an unresolvable workspace root warns — it is a discovery failure, not absence", async () => {
  // Only a missing AGENTS.md is silent. A root that cannot be resolved
  // must not masquerade as "this workspace has no instructions": the
  // operator elevated trust expecting instructions from a workspace that
  // does not exist as named.
  const dir = await Deno.makeTempDir({ prefix: "agents-instructions-mrr-" });
  try {
    const missingRoot = path.join(dir, "does-not-exist");
    using warn = stub(console, "warn");
    assertStrictEquals(await loadAgentsInstructions(missingRoot), null);
    assertSpyCalls(warn, 1);
    const [call] = warn.calls;
    assertEquals(call.args.length, 1);
    assertStringIncludes(
      String(call.args[0]),
      "AGENTS.md skipped: workspace root not resolvable",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadAgentsInstructions: caps an oversized AGENTS.md with a marker and an excerpt-labeled source", async () => {
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
    assert(result !== null);
    assertLessOrEqual(
      estimateContextTokens(result.body),
      AGENTS_INSTRUCTIONS_TOKEN_LIMIT + 50,
    );
    assertStringIncludes(result.body, "[AGENTS.md truncated");
    assertEquals(result.source, {
      kind: "file",
      label: "AGENTS.md excerpt",
      path: "AGENTS.md",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadAgentsInstructions: flags truncation when the byte-bound read clips inside a whitespace run", async () => {
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
    assert(result !== null);
    assertStringIncludes(result.body, "[AGENTS.md truncated");
    assertFalse(result.body.includes("past the read bound"));
    assertEquals(result.source, {
      kind: "file",
      label: "AGENTS.md excerpt",
      path: "AGENTS.md",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
