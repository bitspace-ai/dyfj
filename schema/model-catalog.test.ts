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

Deno.test("fresh catalog activates Qwen and deactivates DeepSeek", async () => {
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

Deno.test("historical replay plus migrations selects Qwen and preserves operator deactivation", async () => {
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
        input: await Deno.readTextFile(new URL(migration, schemaDir)),
        label: `reapply schema/${migration}`,
      });
      await assertLocalModelStates(repository, 0);
    },
  );
});
