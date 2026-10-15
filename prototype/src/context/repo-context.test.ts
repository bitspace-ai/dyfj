import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { mock, test } from "node:test";
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
// repo-context.integration.test.ts in the integration lane.

test("extractReadmeSection1: returns only README Section 1", () => {
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

  assert.ok(
    section.includes("## 1. Decisions"),
    `expected ${JSON.stringify(section)} to include "## 1. Decisions"`,
  );
  assert.ok(
    section.includes("Layer 0 rules."),
    `expected ${JSON.stringify(section)} to include "Layer 0 rules."`,
  );
  assert.ok(!section.includes("## 2. Goal"));
  assert.ok(!section.includes("Later section."));
});

test("buildContextSourceLines: names repo files and context sources without private context paths", () => {
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

  assert.deepStrictEqual(lines, [
    "AGENTS.md <AGENTS.md>",
    "README.md Section 1 <README.md#section-1>",
    "notes/workbench-mvp-loop.md <notes/workbench-mvp-loop.md>",
  ]);
});

test("buildAskSystemPrompt: frames the repo-local next-work question with public-safe context", () => {
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
  assert.ok(
    prompt.includes("You are the test companion. Help with anything."),
    `expected ${
      JSON.stringify(prompt)
    } to include "You are the test companion. Help with anything."`,
  );
  assert.ok(
    prompt.includes("Workbench MVP loop: ship the smallest useful slice."),
    `expected ${
      JSON.stringify(prompt)
    } to include "Workbench MVP loop: ship the smallest useful slice."`,
  );
  assert.ok(
    prompt.includes("Context sources used"),
    `expected ${JSON.stringify(prompt)} to include "Context sources used"`,
  );
});

test("loadAskRepoContext: loads generic README and manifest context from the selected workspace", async () => {
  const selectedRoot = await mkdtemp(
    path.join(tmpdir(), "ask-context-selected-"),
  );
  try {
    await writeFile(
      path.join(selectedRoot, "README.md"),
      "# Music Rotater\n\nRotates a personal music library.\n",
    );
    await writeFile(
      path.join(selectedRoot, "package.json"),
      JSON.stringify({ name: "music-rotater", version: "1.0.0" }),
    );

    const context = await loadAskRepoContext({
      repoRoot: selectedRoot,
      profile: "full",
      budget: defaultBudgetFor("full"),
    });
    const rendered = buildAskSystemPrompt("test companion", context);

    assert.deepStrictEqual(context.sources, [
      { kind: "file", label: "README.md", path: "README.md" },
      { kind: "file", label: "package.json", path: "package.json" },
    ]);
    assert.ok(
      rendered.indexOf("untrusted workspace context") <
        rendered.indexOf("Music Rotater"),
      `expected rendered.indexOf("untrusted workspace context") < rendered.indexOf("Music Rotater")`,
    );
    assert.ok(
      rendered.includes("Music Rotater"),
      `expected ${JSON.stringify(rendered)} to include "Music Rotater"`,
    );
    assert.ok(
      rendered.includes('"name":"music-rotater"'),
      `expected ${
        JSON.stringify(rendered)
      } to include '"name":"music-rotater"'`,
    );
  } finally {
    await rm(selectedRoot, { recursive: true });
  }
});

test("loadAskRepoContext: reads the profile and token-budget defaults from the injected env", async () => {
  const selectedRoot = await mkdtemp(path.join(tmpdir(), "ask-context-env-"));
  try {
    await writeFile(
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
    assert.deepStrictEqual(configured.profile, "full");
    assert.deepStrictEqual(configured.budget.totalTokens, 12345);

    // An env without either variable yields the compact profile's default.
    const unset = await loadAskRepoContext({
      repoRoot: selectedRoot,
      env: new MapEnv({}),
    });
    assert.deepStrictEqual(unset.profile, "compact");
    assert.deepStrictEqual(
      unset.budget.totalTokens,
      COMPACT_CONTEXT_BUDGET.totalTokens,
    );
  } finally {
    await rm(selectedRoot, { recursive: true });
  }
});

test("loadAskRepoContext: a repository without DYFJ-shaped files degrades to empty bounded context", async () => {
  const selectedRoot = await mkdtemp(path.join(tmpdir(), "ask-context-empty-"));
  try {
    const context = await loadAskRepoContext({
      repoRoot: selectedRoot,
      profile: "compact",
      budget: defaultBudgetFor("compact"),
    });

    assert.deepStrictEqual(context.sources, []);
    assert.deepStrictEqual(context.sections, []);
    assert.strictEqual(context.budget.usedTokens, 0);
  } finally {
    await rm(selectedRoot, { recursive: true });
  }
});

test("loadAskRepoContext: compact generic AGENTS context leaves room for the README section", async () => {
  const selectedRoot = await mkdtemp(
    path.join(tmpdir(), "ask-context-system-budget-"),
  );
  try {
    await writeFile(
      path.join(selectedRoot, "AGENTS.md"),
      "Generic project instructions. ".repeat(80),
    );
    await writeFile(
      path.join(selectedRoot, "README.md"),
      "# Project\n\n## 1. Decisions\n\nThe README decision context must remain visible.\n",
    );

    const context = await loadAskRepoContext({
      repoRoot: selectedRoot,
      profile: "compact",
      budget: defaultBudgetFor("compact"),
    });

    assert.deepStrictEqual(context.sources.map((source) => source.path), [
      "AGENTS.md",
      "README.md#section-1",
    ]);
  } finally {
    await rm(selectedRoot, { recursive: true });
  }
});

test("loadAskRepoContext: loads the richer Workbench context when those files exist in the selected workspace", async () => {
  const selectedRoot = await mkdtemp(path.join(tmpdir(), "ask-context-dyfj-"));
  try {
    await writeFile(
      path.join(selectedRoot, "AGENTS.md"),
      "Read README Section 1; it is authoritative.\n",
    );
    await writeFile(
      path.join(selectedRoot, "README.md"),
      "# Project\n\n## 1. Decisions\n\nLayer 0 rules.\n\n## 2. Goal\n\nShip.\n",
    );
    await mkdir(path.join(selectedRoot, "notes"));
    await writeFile(
      path.join(selectedRoot, "notes", "workbench-mvp-loop.md"),
      "Workbench loop: ship the smallest useful slice.\n",
    );

    const context = await loadAskRepoContext({
      repoRoot: selectedRoot,
      profile: "full",
      budget: defaultBudgetFor("full"),
    });

    assert.deepStrictEqual(context.sources.map((source) => source.path), [
      "AGENTS.md",
      "README.md#section-1",
      "notes/workbench-mvp-loop.md",
    ]);
    const bodies = context.sections.map((section) => section.body).join(
      "\n",
    );
    assert.ok(
      buildAskSystemPrompt("test companion", context).includes(
        "untrusted workspace context",
      ),
      `expected buildAskSystemPrompt("test companion", context) to include "untrusted workspace context"`,
    );
    assert.ok(!bodies.includes("## 2. Goal"));
  } finally {
    await rm(selectedRoot, { recursive: true });
  }
});

test("loadAskRepoContext: compact Workbench context prioritizes notes ahead of a manifest", async () => {
  const selectedRoot = await mkdtemp(
    path.join(tmpdir(), "ask-context-priority-"),
  );
  try {
    await mkdir(path.join(selectedRoot, "notes"));
    await writeFile(
      path.join(selectedRoot, "notes", "workbench-mvp-loop.md"),
      "Workbench loop: ship the smallest useful slice. ".repeat(4),
    );
    await writeFile(
      path.join(selectedRoot, "deno.json"),
      JSON.stringify({ description: "manifest context ".repeat(100) }),
    );

    const context = await loadAskRepoContext({
      repoRoot: selectedRoot,
      profile: "compact",
      budget: defaultBudgetFor("compact"),
    });
    const paths = context.sources.map((source) => source.path);

    assert.ok(paths.includes("notes/workbench-mvp-loop.md"));
    if (paths.includes("deno.json")) {
      assert.ok(
        paths.indexOf("notes/workbench-mvp-loop.md") <
          paths.indexOf("deno.json"),
        `expected paths.indexOf("notes/workbench-mvp-loop.md") < paths.indexOf("deno.json")`,
      );
    }
  } finally {
    await rm(selectedRoot, { recursive: true });
  }
});

test("packContextSections: compact profile uses a small budget weighted to repo context", () => {
  assert.strictEqual(COMPACT_CONTEXT_BUDGET.totalTokens, 500);
  assert.ok(
    COMPACT_CONTEXT_BUDGET.totalTokens < DEFAULT_CONTEXT_BUDGET.totalTokens,
    `expected ${COMPACT_CONTEXT_BUDGET.totalTokens} < ${DEFAULT_CONTEXT_BUDGET.totalTokens}`,
  );
  assert.ok(
    COMPACT_CONTEXT_BUDGET.activeRepoPercent >
      COMPACT_CONTEXT_BUDGET.derivedMemoryPercent,
    `expected ${COMPACT_CONTEXT_BUDGET.activeRepoPercent} > ${COMPACT_CONTEXT_BUDGET.derivedMemoryPercent}`,
  );
});

test("packContextSections: compact budget can keep AGENTS and README Section 1 sources", () => {
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

  assert.deepStrictEqual(packed.sources.map((source) => source.label), [
    "AGENTS.md",
    "README.md Section 1",
    "notes/workbench-mvp-loop.md",
  ]);
});

test("packContextSections: enforces tiered budget ceilings and reserves headroom", () => {
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

  assert.ok(
    packed.summary.usedTokens <= 90,
    `expected ${packed.summary.usedTokens} <= 90`,
  );
  assert.ok(
    packed.summary.byBucket.system.usedTokens <= 20,
    `expected ${packed.summary.byBucket.system.usedTokens} <= 20`,
  );
  assert.ok(
    packed.summary.byBucket.active_repo.usedTokens <= 50,
    `expected ${packed.summary.byBucket.active_repo.usedTokens} <= 50`,
  );
  assert.ok(
    packed.summary.byBucket.derived_memory.usedTokens <= 20,
    `expected ${packed.summary.byBucket.derived_memory.usedTokens} <= 20`,
  );
  assert.strictEqual(packed.summary.headroomTokens, 10);
  assert.strictEqual(
    packed.sections.some((section) => section.truncated),
    true,
  );
});

test("packContextSections: keeps source metadata only for included sections", () => {
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

  assert.deepStrictEqual(packed.sources.map((source) => source.label), [
    "large",
  ]);
});

test("estimateContextTokens: uses the same four-character approximation as model preflight", () => {
  assert.strictEqual(estimateContextTokens("12345678"), 2);
});

test("loadAgentsInstructions: loads AGENTS.md at the workspace root; no sibling markers required", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agents-instructions-flat-"));
  try {
    await writeFile(path.join(dir, "AGENTS.md"), "# Flat Rules\n");

    const result = await loadAgentsInstructions(dir);
    assert.strictEqual(result?.body.trim(), "# Flat Rules");
    assert.deepStrictEqual(result?.source, {
      kind: "file",
      label: "AGENTS.md",
      path: "AGENTS.md",
    });
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("loadAgentsInstructions: does NOT discover an ancestor's AGENTS.md — discovery is contained to the workspace root", async () => {
  // The containment contract: content from outside the operator-selected
  // workspace must never enter the model request. An ancestor carrying the
  // old walk-up markers (AGENTS.md + README.md) is exactly the escape this
  // pins shut; a subdirectory workspace degrades to graceful absence.
  const dir = await mkdtemp(path.join(tmpdir(), "agents-instructions-anc-"));
  try {
    await writeFile(
      path.join(dir, "AGENTS.md"),
      "# Ancestor Rules — must not leak\n",
    );
    await writeFile(path.join(dir, "README.md"), "# Repo\n");
    const nested = path.join(dir, "a", "b");
    await mkdir(nested, { recursive: true });

    assert.strictEqual(await loadAgentsInstructions(nested), null);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("loadAgentsInstructions: rejects a non-regular-file AGENTS.md — the lstat guard never follows links", async () => {
  // Sandbox constraint, disclosed: creating a symlink (`node:fs` `symlink`
  // included) requires unscoped read+write under the current runtime,
  // which the path-scoped test profile deliberately refuses,
  // so a literal symlink fixture cannot be constructed here. The guard
  // under test is `lstat` + `!isFile`, which rejects a symlink, a
  // directory, or a FIFO through the identical branch — lstat never
  // follows links by definition — so a directory fixture pins the same
  // containment behavior with a constructible fixture.
  const dir = await mkdtemp(path.join(tmpdir(), "agents-instructions-nrf-"));
  try {
    await mkdir(path.join(dir, "AGENTS.md"));
    const warn = mock.method(console, "warn", () => {});
    assert.strictEqual(await loadAgentsInstructions(dir), null);
    assert.equal(warn.mock.callCount(), 1);
    assert.deepStrictEqual(warn.mock.calls[0].arguments, [
      "AGENTS.md skipped: not a regular file in the workspace root",
    ]);
  } finally {
    mock.restoreAll();
    await rm(dir, { recursive: true });
  }
});

test("loadAgentsInstructions: returns null for a workspace with no AGENTS.md", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agents-instructions-none-"));
  try {
    assert.strictEqual(await loadAgentsInstructions(dir), null);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("loadAgentsInstructions: a root whose identity differs from the selection anchor is refused", async () => {
  // The adversarial root-replacement shape, pinned via its constructible
  // half: the caller anchors the identity of the directory it verified at
  // selection time; if discovery resolves the same pathname to a DIFFERENT
  // directory (a persisted root/ancestor swap), the loader refuses. The
  // live mid-read race itself cannot be scheduled deterministically in a
  // test; this pins the detection branch both sides of the read share.
  const dir = await mkdtemp(path.join(tmpdir(), "agents-instructions-swap-"));
  try {
    await writeFile(
      path.join(dir, "AGENTS.md"),
      "# Swapped-in rules — must not load\n",
    );
    const real = await stat(await realpath(dir));
    const warn = mock.method(console, "warn", () => {});
    const result = await loadAgentsInstructions(dir, {
      dev: real.dev,
      ino: real.ino + 1,
    });
    assert.strictEqual(result, null);
    assert.equal(warn.mock.callCount(), 1);
    assert.deepStrictEqual(warn.mock.calls[0].arguments, [
      "AGENTS.md skipped: workspace root is not the selected directory",
    ]);
  } finally {
    mock.restoreAll();
    await rm(dir, { recursive: true });
  }
});

test("loadAgentsInstructions: a matching selection anchor loads normally; a zero-identity anchor fails closed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agents-instructions-anc2-"));
  try {
    await writeFile(path.join(dir, "AGENTS.md"), "# Anchored\n");
    const real = await stat(await realpath(dir));

    const loaded = await loadAgentsInstructions(dir, {
      dev: real.dev,
      ino: real.ino,
    });
    assert.strictEqual(loaded?.body.trim(), "# Anchored");

    const warn = mock.method(console, "warn", () => {});
    assert.strictEqual(
      await loadAgentsInstructions(dir, { dev: 0, ino: 0 }),
      null,
    );
    assert.equal(warn.mock.callCount(), 1);
    assert.deepStrictEqual(warn.mock.calls[0].arguments, [
      "AGENTS.md skipped: workspace root identity unavailable on this platform",
    ]);
  } finally {
    mock.restoreAll();
    await rm(dir, { recursive: true });
  }
});

test("loadAgentsInstructions: an unresolvable workspace root warns — it is a discovery failure, not absence", async () => {
  // Only a missing AGENTS.md is silent. A root that cannot be resolved
  // must not masquerade as "this workspace has no instructions": the
  // operator elevated trust expecting instructions from a workspace that
  // does not exist as named.
  const dir = await mkdtemp(path.join(tmpdir(), "agents-instructions-mrr-"));
  try {
    const missingRoot = path.join(dir, "does-not-exist");
    const warn = mock.method(console, "warn", () => {});
    assert.strictEqual(await loadAgentsInstructions(missingRoot), null);
    assert.equal(warn.mock.callCount(), 1);
    const [call] = warn.mock.calls;
    assert.deepStrictEqual(call.arguments.length, 1);
    assert.ok(
      String(call.arguments[0]).includes(
        "AGENTS.md skipped: workspace root not resolvable",
      ),
      `expected String(call.arguments[0]) to include "AGENTS.md skipped: workspace root not resolvable"`,
    );
  } finally {
    mock.restoreAll();
    await rm(dir, { recursive: true });
  }
});

test("loadAgentsInstructions: caps an oversized AGENTS.md with a marker and an excerpt-labeled source", async () => {
  // The system prompt is never compressed, so the injected body must be
  // bounded here — and the receipt must say an excerpt entered the prompt,
  // not the whole file.
  const dir = await mkdtemp(path.join(tmpdir(), "agents-instructions-big-"));
  try {
    const oversized = "# Giant Rules\n\n" +
      "All work must be receipted. ".repeat(10_000); // ~70K tokens
    await writeFile(path.join(dir, "AGENTS.md"), oversized);
    await writeFile(path.join(dir, "README.md"), "# Repo\n");

    const result = await loadAgentsInstructions(dir);
    assert.ok(result !== null);
    assert.ok(
      estimateContextTokens(result.body) <=
        (AGENTS_INSTRUCTIONS_TOKEN_LIMIT + 50),
      `expected estimateContextTokens(result.body) <= AGENTS_INSTRUCTIONS_TOKEN_LIMIT + 50`,
    );
    assert.ok(
      result.body.includes("[AGENTS.md truncated"),
      `expected ${
        JSON.stringify(result.body)
      } to include "[AGENTS.md truncated"`,
    );
    assert.deepStrictEqual(result.source, {
      kind: "file",
      label: "AGENTS.md excerpt",
      path: "AGENTS.md",
    });
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("loadAgentsInstructions: flags truncation when the byte-bound read clips inside a whitespace run", async () => {
  // Adversarial shape: short real content, then a whitespace run spanning
  // the 64KB read bound, then more content past it. The token slice lands
  // inside the whitespace, so `trimEnd()` makes the capped and read bodies
  // agree — the string comparison alone would report the full file while
  // the content past the byte bound was silently dropped. The loader must
  // flag the clipped read itself.
  const dir = await mkdtemp(path.join(tmpdir(), "agents-instructions-ws-"));
  try {
    const head = "# Rules before the whitespace run\n";
    const padding = "\n".repeat(AGENTS_INSTRUCTIONS_MAX_READ_BYTES);
    const tail = "# Rules past the read bound\n";
    await writeFile(
      path.join(dir, "AGENTS.md"),
      head + padding + tail,
    );

    const result = await loadAgentsInstructions(dir);
    assert.ok(result !== null);
    assert.ok(
      result.body.includes("[AGENTS.md truncated"),
      `expected ${
        JSON.stringify(result.body)
      } to include "[AGENTS.md truncated"`,
    );
    assert.ok(!result.body.includes("past the read bound"));
    assert.deepStrictEqual(result.source, {
      kind: "file",
      label: "AGENTS.md excerpt",
      path: "AGENTS.md",
    });
  } finally {
    await rm(dir, { recursive: true });
  }
});
