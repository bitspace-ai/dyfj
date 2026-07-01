import {
  assertEventsTablePresent,
  assertSchemaApplyPlan,
  buildSchemaApplyPlan,
  migrationFileNames,
} from "./validate-schema.ts";

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertThrows(fn: () => unknown, expectedMessage: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) {
      return;
    }
    throw error;
  }

  throw new Error(`Expected function to throw ${expectedMessage}`);
}

Deno.test("migrationFileNames returns sql files in lexical order", () => {
  const entries = [
    { name: "010_events_capability.sql", isFile: true },
    { name: "README.md", isFile: true },
    { name: "001_events.sql", isFile: true },
    { name: "notes", isFile: false },
  ];

  assertEquals(migrationFileNames(entries), [
    "001_events.sql",
    "010_events_capability.sql",
  ]);
});

Deno.test("buildSchemaApplyPlan groups schema files by purpose", () => {
  const plan = buildSchemaApplyPlan({
    current: [
      { name: "README.md", isFile: true },
      { name: "001_structure.sql", isFile: true },
    ],
    catalog: [
      { name: "002_prompts.sql", isFile: true },
      { name: "001_models.sql", isFile: true },
    ],
    migrations: [
      { name: "001_future_change.sql", isFile: true },
    ],
    history: [
      { name: "006_models.sql", isFile: true },
      { name: "001_events.sql", isFile: true },
    ],
  });

  assertEquals(plan, {
    current: ["current/001_structure.sql"],
    catalog: ["catalog/001_models.sql", "catalog/002_prompts.sql"],
    migrations: ["migrations/001_future_change.sql"],
    history: ["history/001_events.sql", "history/006_models.sql"],
  });
});

Deno.test("assertSchemaApplyPlan requires a current baseline", () => {
  assertThrows(
    () =>
      assertSchemaApplyPlan({
        current: [],
        catalog: ["catalog/001_models.sql"],
        migrations: [],
        history: ["history/001_events.sql"],
      }),
    "schema/current",
  );
});

Deno.test("assertSchemaApplyPlan requires preserved history", () => {
  assertThrows(
    () =>
      assertSchemaApplyPlan({
        current: ["current/001_structure.sql"],
        catalog: ["catalog/001_models.sql"],
        migrations: [],
        history: [],
      }),
    "schema/history",
  );
});

Deno.test("assertEventsTablePresent rejects missing events table output", () => {
  assertThrows(
    () => assertEventsTablePresent("+-------+\n| Tables |\n+-------+\n"),
    "events table was not found",
  );
});

Deno.test("assertEventsTablePresent accepts events table output", () => {
  assertEventsTablePresent(
    "+--------+\n| Tables |\n+--------+\n| events |\n+--------+\n",
  );
});
