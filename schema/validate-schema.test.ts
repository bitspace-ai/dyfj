import {
  assertEventsTablePresent,
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
