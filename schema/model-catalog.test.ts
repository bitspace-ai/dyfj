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

async function assertLocalModelStates(
  repository: string,
  qwenActive: number,
): Promise<void> {
  const rows = await queryRows(
    repository,
    `SELECT slug, active FROM models WHERE slug IN ('${deepSeek}', '${qwen}') ORDER BY slug`,
    undefined,
  );
  const actual = rows.map((row) => [row.slug, Number(row.active)]);
  const expected = [[deepSeek, 0], [qwen, qwenActive]];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected local model states ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

test("fresh catalog activates Qwen and deactivates DeepSeek", async () => {
  const plan = await readSchemaApplyPlan(schemaDir);
  assertSchemaApplyPlan(plan);
  await withSchemaRepository(
    schemaDir,
    [...plan.current, ...plan.catalog],
    "fresh local model catalog",
    undefined,
    (repository) => assertLocalModelStates(repository, 1),
  );
});

test("historical replay plus migrations selects Qwen and preserves operator deactivation", async () => {
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
      await assertLocalModelStates(repository, 1);
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
      await assertLocalModelStates(repository, 0);
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
