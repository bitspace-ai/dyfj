import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  assertSchemaApplyPlan,
  queryRows,
  readSchemaApplyPlan,
  runChecked,
  withSchemaRepository,
} from "./dolt-apply.ts";

const schemaDir = new URL("./", import.meta.url);
const deepSeek = "llama-cpp/deepseek-r1-32b";
const qwen = "llama-cpp/qwen3.6-35b-a3b";

async function assertQwenActive(
  repository: string,
  qwenActive: number,
): Promise<void> {
  const rows = await queryRows(
    repository,
    `SELECT slug, active FROM models WHERE slug = '${qwen}'`,
    undefined,
  );
  const actual = rows.map((row) => [row.slug, Number(row.active)]);
  const expected = [[qwen, qwenActive]];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected Qwen state ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

async function assertSlugAbsent(
  repository: string,
  slug: string,
): Promise<void> {
  const rows = await queryRows(
    repository,
    `SELECT slug FROM models WHERE slug = '${slug}'`,
    undefined,
  );
  if (rows.length !== 0) {
    throw new Error(
      `Expected ${slug} to be absent, got ${JSON.stringify(rows)}`,
    );
  }
}

test("fresh catalog activates Qwen and omits the superseded llama.cpp row", async () => {
  const plan = await readSchemaApplyPlan(schemaDir);
  assertSchemaApplyPlan(plan);
  await withSchemaRepository(
    schemaDir,
    [...plan.current, ...plan.catalog],
    "fresh local model catalog",
    undefined,
    async (repository) => {
      await assertQwenActive(repository, 1);
      await assertSlugAbsent(repository, deepSeek);
    },
  );
});

test("historical replay plus migrations selects Qwen, omits the superseded row, and preserves operator deactivation", async () => {
  const plan = await readSchemaApplyPlan(schemaDir);
  assertSchemaApplyPlan(plan);
  const migration = "migrations/014_models_qwen36_llama_cpp_local_default.sql";
  if (!plan.migrations.includes(migration)) {
    throw new Error(`Missing ${migration}`);
  }
  await withSchemaRepository(
    schemaDir,
    [...plan.history, ...plan.migrations],
    "migrated local model catalog",
    undefined,
    async (repository) => {
      await assertQwenActive(repository, 1);
      await assertSlugAbsent(repository, deepSeek);
      await runChecked("dolt", [
        "sql",
        "-q",
        `UPDATE models SET active = FALSE WHERE slug = '${qwen}'`,
      ], {
        cwd: repository,
        label: "disable Qwen in disposable catalog",
      });
      await runChecked("dolt", ["sql"], {
        cwd: repository,
        input: await readFile(new URL(migration, schemaDir), "utf8"),
        label: `reapply schema/${migration}`,
      });
      await assertQwenActive(repository, 0);
      await assertSlugAbsent(repository, deepSeek);
    },
  );
});

const sonnet55 = "claude-sonnet-5-5";
const kimiK3 = "moonshotai/kimi-k3";
const hostedMigration =
  "migrations/015_models_claude_sonnet_5_5_and_kimi_k3.sql";
const expectedHostedRows = [
  [
    sonnet55,
    "anthropic",
    "2.000000",
    "10.000000",
    "0.100000",
    "2.500000",
    1000000,
    128000,
  ],
  [
    kimiK3,
    "openrouter",
    "0.304000",
    "11.936000",
    "0.210000",
    "0.000000",
    1048576,
    943718,
  ],
];

async function assertHostedRows(
  repository: string,
  active: number,
): Promise<void> {
  const rows = await queryRows(
    repository,
    `SELECT slug, provider, cost_input, cost_output, cost_cache_read, cost_cache_write, context_window, max_output_tokens, active FROM models WHERE slug IN ('${sonnet55}', '${kimiK3}') ORDER BY slug`,
    undefined,
  );
  const actual = rows.map((row) => [
    row.slug,
    row.provider,
    String(row.cost_input),
    String(row.cost_output),
    String(row.cost_cache_read),
    String(row.cost_cache_write),
    Number(row.context_window),
    Number(row.max_output_tokens),
    Number(row.active),
  ]);
  const expected = expectedHostedRows.map((row) => [...row, active]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected hosted model rows ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

test("fresh catalog carries Sonnet 5.5 and Kimi K3", async () => {
  const plan = await readSchemaApplyPlan(schemaDir);
  assertSchemaApplyPlan(plan);
  await withSchemaRepository(
    schemaDir,
    [...plan.current, ...plan.catalog],
    "fresh hosted model catalog",
    undefined,
    (repository) => assertHostedRows(repository, 1),
  );
});

test("historical replay plus migrations adds Sonnet 5.5 and Kimi K3 and preserves operator deactivation", async () => {
  const plan = await readSchemaApplyPlan(schemaDir);
  assertSchemaApplyPlan(plan);
  if (!plan.migrations.includes(hostedMigration)) {
    throw new Error(`Missing ${hostedMigration}`);
  }
  await withSchemaRepository(
    schemaDir,
    [...plan.history, ...plan.migrations],
    "migrated hosted model catalog",
    undefined,
    async (repository) => {
      await assertHostedRows(repository, 1);
      await runChecked("dolt", [
        "sql",
        "-q",
        `UPDATE models SET active = FALSE WHERE slug IN ('${sonnet55}', '${kimiK3}')`,
      ], {
        cwd: repository,
        label: "disable hosted models in disposable catalog",
      });
      await runChecked("dolt", ["sql"], {
        cwd: repository,
        input: await readFile(new URL(hostedMigration, schemaDir), "utf8"),
        label: `reapply schema/${hostedMigration}`,
      });
      await assertHostedRows(repository, 0);
    },
  );
});

const progressMigration =
  "migrations/017_models_claude_sonnet_5_5_progress_updates.sql";

async function assertSonnet55Capabilities(repository: string): Promise<void> {
  const rows = await queryRows(
    repository,
    `SELECT capabilities FROM models WHERE slug = '${sonnet55}'`,
    undefined,
  );
  const capabilities = rows.map((row) =>
    typeof row.capabilities === "string"
      ? JSON.parse(row.capabilities)
      : row.capabilities
  );
  const expected = [[
    "text",
    "code",
    "reasoning",
    "vision",
    "tools",
    "thinking",
    "thinking-progress-updates",
    "long-context",
  ]];
  if (JSON.stringify(capabilities) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected Sonnet 5.5 capabilities ${JSON.stringify(expected)}, got ${
        JSON.stringify(capabilities)
      }`,
    );
  }
}

test("fresh catalog marks Sonnet 5.5 for progress updates", async () => {
  const plan = await readSchemaApplyPlan(schemaDir);
  assertSchemaApplyPlan(plan);
  await withSchemaRepository(
    schemaDir,
    [...plan.current, ...plan.catalog],
    "fresh progress-update catalog",
    undefined,
    assertSonnet55Capabilities,
  );
});

test("historical replay plus migrations marks Sonnet 5.5 for progress updates, idempotently", async () => {
  const plan = await readSchemaApplyPlan(schemaDir);
  assertSchemaApplyPlan(plan);
  if (!plan.migrations.includes(progressMigration)) {
    throw new Error(`Missing ${progressMigration}`);
  }
  await withSchemaRepository(
    schemaDir,
    [...plan.history, ...plan.migrations],
    "migrated progress-update catalog",
    undefined,
    async (repository) => {
      await assertSonnet55Capabilities(repository);
      await runChecked("dolt", ["sql"], {
        cwd: repository,
        input: await readFile(new URL(progressMigration, schemaDir), "utf8"),
        label: `reapply schema/${progressMigration}`,
      });
      await assertSonnet55Capabilities(repository);
    },
  );
});

const haiku55 = "claude-haiku-5-5";
const haikuMigration = "migrations/018_models_claude_haiku_5_5.sql";

async function assertHaiku55Row(
  repository: string,
  active: number,
): Promise<void> {
  const rows = await queryRows(
    repository,
    `SELECT slug, provider, api, tier, cost_input, cost_output, cost_cache_read, cost_cache_write, context_window, max_output_tokens, capabilities, active FROM models WHERE slug = '${haiku55}'`,
    undefined,
  );
  const actual = rows.map((row) => [
    row.slug,
    row.provider,
    row.api,
    Number(row.tier),
    String(row.cost_input),
    String(row.cost_output),
    String(row.cost_cache_read),
    String(row.cost_cache_write),
    Number(row.context_window),
    Number(row.max_output_tokens),
    typeof row.capabilities === "string"
      ? JSON.parse(row.capabilities)
      : row.capabilities,
    Number(row.active),
  ]);
  const expected = [[
    haiku55,
    "anthropic",
    "anthropic-messages",
    1,
    "0.500000",
    "2.500000",
    "0.050000",
    "0.625000",
    1000000,
    128000,
    ["text", "code", "reasoning", "vision", "tools", "thinking", "long-context"],
    active,
  ]];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected Haiku 5.5 row ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

test("fresh catalog carries Haiku 5.5 at the over-100K price tier", async () => {
  const plan = await readSchemaApplyPlan(schemaDir);
  assertSchemaApplyPlan(plan);
  await withSchemaRepository(
    schemaDir,
    [...plan.current, ...plan.catalog],
    "fresh Haiku 5.5 catalog",
    undefined,
    (repository) => assertHaiku55Row(repository, 1),
  );
});

test("historical replay plus migrations adds Haiku 5.5 and preserves operator deactivation", async () => {
  const plan = await readSchemaApplyPlan(schemaDir);
  assertSchemaApplyPlan(plan);
  if (!plan.migrations.includes(haikuMigration)) {
    throw new Error(`Missing ${haikuMigration}`);
  }
  await withSchemaRepository(
    schemaDir,
    [...plan.history, ...plan.migrations],
    "migrated Haiku 5.5 catalog",
    undefined,
    async (repository) => {
      await assertHaiku55Row(repository, 1);
      await runChecked("dolt", [
        "sql",
        "-q",
        `UPDATE models SET active = FALSE WHERE slug = '${haiku55}'`,
      ], {
        cwd: repository,
        label: "disable Haiku 5.5 in disposable catalog",
      });
      await runChecked("dolt", ["sql"], {
        cwd: repository,
        input: await readFile(new URL(haikuMigration, schemaDir), "utf8"),
        label: `reapply schema/${haikuMigration}`,
      });
      await assertHaiku55Row(repository, 0);
    },
  );
});

// ── the first catalog trim: migration 020 ────────────────────────────────────

const flash1017 = "deepseek/deepseek-v4.1-flash-1017";
const glm53 = "z-ai/glm-5.3";
const trimMigration =
  "migrations/020_models_deepseek_v4_1_flash_1017_and_glm_5_3.sql";

// Every slug migration 020 removes, in the order the migration groups them:
// provider = 'ollama', then already-inactive rows, then superseded generations.
const deletedSlugs = [
  // ollama (15)
  "deepseek-r1:32b",
  "gemma4",
  "gemma4:26b",
  "gemma4:e2b",
  "gpt-oss-120b",
  "laguna-xs-2.1",
  "laguna-xs.2",
  "mistral-small-4-119b-a6b",
  "mistral-small:24b-instruct-2501-q4_K_M",
  "muse-glimmer:30b",
  "qwen3-coder-next-80b-a3b",
  "qwen3:30b-a3b",
  "qwen3:32b",
  "qwen3.5-122b-a10b",
  "qwen3.6:35b-a3b",
  // already inactive, non-ollama (21)
  "claude-acp/claude-fable-5",
  "claude-opus-4-5",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "cursor-agent/composer-2.0",
  "deepseek/deepseek-v4-flash",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-3.5-flash",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "grok-4.5",
  "grok-build/grok-4.6",
  "llama-cpp/deepseek-r1-32b",
  "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
  "mlx-community/Qwen3.5-4B-8bit",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "tencent/hy3",
  "z-ai/glm-5.2",
  // superseded generations still active (13)
  "claude-haiku-4-5-20251001",
  "claude-sonnet-5",
  "deepseek/deepseek-chat",
  "deepseek/deepseek-v3.1-terminus",
  "deepseek/deepseek-v4.1-flash",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "grok-4.3",
  "meta-llama/llama-3.3-70b-instruct",
  "moonshotai/kimi-k2-0905",
  "x-ai/grok-4.3",
  "z-ai/glm-4.5",
  "z-ai/glm-4.5-air",
];

const expectedTrimRows = [
  [
    flash1017,
    "openrouter",
    "openai-completions",
    1,
    "0.150000",
    "0.600000",
    "0.003000",
    "0.000000",
    1048576,
    393216,
    ["text", "code", "reasoning", "long-context"],
  ],
  [
    glm53,
    "openrouter",
    "openai-completions",
    1,
    "0.069900",
    "1.400000",
    "0.068900",
    "0.000000",
    1048576,
    943718,
    ["text", "code", "reasoning", "long-context"],
  ],
];

async function assertTrimRows(
  repository: string,
  active: number,
): Promise<void> {
  const rows = await queryRows(
    repository,
    `SELECT slug, provider, api, tier, cost_input, cost_output, cost_cache_read, cost_cache_write, context_window, max_output_tokens, capabilities, active FROM models WHERE slug IN ('${flash1017}', '${glm53}') ORDER BY slug`,
    undefined,
  );
  const actual = rows.map((row) => [
    row.slug,
    row.provider,
    row.api,
    Number(row.tier),
    String(row.cost_input),
    String(row.cost_output),
    String(row.cost_cache_read),
    String(row.cost_cache_write),
    Number(row.context_window),
    Number(row.max_output_tokens),
    typeof row.capabilities === "string"
      ? JSON.parse(row.capabilities)
      : row.capabilities,
    Number(row.active),
  ]);
  // The query orders by slug, so sort the expectation the same way.
  const expected = [...expectedTrimRows].sort((a, b) =>
    String(a[0]).localeCompare(String(b[0]))
  ).map((row) => [...row, active]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected trimmed model rows ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

/** No deleted slug may remain, and no provider = 'ollama' row may remain. */
async function assertTrimRemovals(repository: string): Promise<void> {
  const remaining = await queryRows(
    repository,
    `SELECT slug FROM models WHERE slug IN (${
      deletedSlugs.map((slug) => `'${slug}'`).join(", ")
    }) ORDER BY slug`,
    undefined,
  );
  if (remaining.length !== 0) {
    throw new Error(
      `Deleted slugs still present: ${
        remaining.map((row) => row.slug).join(", ")
      }`,
    );
  }
  const ollama = await queryRows(
    repository,
    "SELECT slug FROM models WHERE provider = 'ollama' ORDER BY slug",
    undefined,
  );
  if (ollama.length !== 0) {
    throw new Error(
      `Ollama rows still present: ${
        ollama.map((row) => row.slug).join(", ")
      }`,
    );
  }
}

test("fresh catalog carries DeepSeek V4.1 Flash 1017 and GLM 5.3 and no trimmed rows", async () => {
  const plan = await readSchemaApplyPlan(schemaDir);
  assertSchemaApplyPlan(plan);
  await withSchemaRepository(
    schemaDir,
    [...plan.current, ...plan.catalog],
    "fresh trimmed catalog",
    undefined,
    async (repository) => {
      await assertTrimRows(repository, 1);
      await assertTrimRemovals(repository);
    },
  );
});

test("historical replay plus migrations adds the trimmed-in rows and removes the trimmed-out rows", async () => {
  const plan = await readSchemaApplyPlan(schemaDir);
  assertSchemaApplyPlan(plan);
  if (!plan.migrations.includes(trimMigration)) {
    throw new Error(`Missing ${trimMigration}`);
  }
  await withSchemaRepository(
    schemaDir,
    [...plan.history, ...plan.migrations],
    "migrated trimmed catalog",
    undefined,
    async (repository) => {
      await assertTrimRows(repository, 1);
      await assertTrimRemovals(repository);
      // Operator deactivation survives a re-apply, as the earlier model
      // migrations' tests assert.
      await runChecked("dolt", [
        "sql",
        "-q",
        `UPDATE models SET active = FALSE WHERE slug IN ('${flash1017}', '${glm53}')`,
      ], {
        cwd: repository,
        label: "disable trimmed-in models in disposable catalog",
      });
      await runChecked("dolt", ["sql"], {
        cwd: repository,
        input: await readFile(new URL(trimMigration, schemaDir), "utf8"),
        label: `reapply schema/${trimMigration}`,
      });
      await assertTrimRows(repository, 0);
      await assertTrimRemovals(repository);
    },
  );
});
