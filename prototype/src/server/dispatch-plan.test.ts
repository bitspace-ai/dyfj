/**
 * Unit tests for the dispatch planner's effort validation: a dispatched
 * native child takes an effort when its target model supports one, and the
 * plan carries the effort the child's turn sends.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { MemoryStore, type ModelSeed } from "../store/mod.ts";
import { loadWorkbenchModels } from "../providers/mod.ts";
import type { DispatchConfig } from "../config/mod.ts";
import type { DispatchStartInput } from "../tools/mod.ts";
import { planDispatchStart } from "./dispatch-plan.ts";

const NATIVE_REASONING: ModelSeed = {
  slug: "deepseek/deepseek-v4.1-flash-1017",
  display_name: "DeepSeek V4.1 Flash",
  provider: "openrouter",
  api: "openai-completions",
  base_url: "https://openrouter.ai/api/v1",
  tier: 1,
  cost_input: 0.3,
  cost_output: 1.2,
  context_window: 131_072,
  max_output_tokens: 32_768,
  capabilities: ["text", "code", "reasoning"],
  reasoning_effort_control: true,
};

const GEMINI: ModelSeed = {
  slug: "gemini-3.8-flash",
  display_name: "Gemini 3.8 Flash",
  provider: "google",
  api: "google-generative-ai",
  base_url: "https://generativelanguage.googleapis.com",
  tier: 1,
  cost_input: 0.75,
  cost_output: 3.75,
  context_window: 1_048_576,
  max_output_tokens: 65_536,
  capabilities: ["text", "reasoning"],
  reasoning_effort_control: true,
};

const PLAIN: ModelSeed = {
  slug: "claude-haiku-5-5",
  display_name: "Claude Haiku 5.5",
  provider: "anthropic",
  api: "anthropic-messages",
  base_url: "https://api.anthropic.com",
  tier: 1,
  cost_input: 1,
  cost_output: 5,
  context_window: 200_000,
  max_output_tokens: 16_000,
  capabilities: ["text", "code"],
};

async function plan(
  seeds: ModelSeed[],
  input: Partial<DispatchStartInput>,
) {
  // The workspace and HOME must be separate trees: a workspace inside HOME
  // would overlap the protected `~/.dyfj`.
  const root = await mkdtemp(join(tmpdir(), "dyfj-dispatch-plan-"));
  const home = await mkdtemp(join(tmpdir(), "dyfj-dispatch-home-"));
  try {
    const config: DispatchConfig = {
      maxChildren: 3,
      maxWaitSeconds: 50,
      roots: [root],
    };
    return await planDispatchStart({
      config,
      env: new MapEnv({ HOME: home }),
      input: {
        label: "impl",
        task: "do the thing",
        model: NATIVE_REASONING.slug,
        workspace: root,
        approvePaid: true,
        ...input,
      },
      loadCatalog: () => loadWorkbenchModels(new MemoryStore({ models: seeds }).models),
      occupiedWorkspaces: new Set(),
      trustWorkspaceInstructions: true,
      defaultCodexReasoningEffort: "medium",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

test("a dispatched native child carries the effort its model accepts", async () => {
  const result = await plan([NATIVE_REASONING], { effort: "high" });
  assert.ok("plan" in result, JSON.stringify(result));
  assert.equal(result.plan.effort, "high");
  assert.equal(result.plan.route, "native");
});

test("a dispatched native child without an effort keeps its model default", async () => {
  const result = await plan([NATIVE_REASONING], {});
  assert.ok("plan" in result, JSON.stringify(result));
  assert.equal(result.plan.effort, "low");
});

test("a dispatched child refuses a level its provider does not accept", async () => {
  const result = await plan([GEMINI], {
    model: GEMINI.slug,
    effort: "xhigh",
  });
  assert.ok("refusal" in result, JSON.stringify(result));
  assert.match(
    result.refusal,
    /does not accept reasoning effort "xhigh"; it accepts low, medium, high/,
  );
});

test("a dispatched child refuses an effort on a model with no effort control", async () => {
  const result = await plan([PLAIN], { model: PLAIN.slug, effort: "high" });
  assert.ok("refusal" in result, JSON.stringify(result));
  assert.match(result.refusal, /takes no reasoning effort/);
});
