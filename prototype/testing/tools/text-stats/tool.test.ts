// The test-only `text.stats` tool: the one catalog line that adds it next to
// the builtins, the tool conformance kit over that catalog, and unit tests of
// its executor.

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  buildToolCatalog,
  BUILTIN_TOOLS,
  invokeCommandWithEvent,
  REDACTED,
} from "../../../src/tools/mod.ts";
import type { EventInsert } from "../../../src/store/mod.ts";
import { toolConformance } from "../../conformance/tool.ts";
import { defineTextStats, executeTextStats } from "./tool.ts";

// The catalog line: one entry after the builtins.
const catalog = buildToolCatalog({}, { workspaceRoot: "/example" }, [], [
  ...BUILTIN_TOOLS,
  () => defineTextStats(),
]);

toolConformance({ name: "text.stats example", catalog });

Deno.test("text.stats registers after the builtins and reaches the model", () => {
  const names = catalog.projectTools().map((tool) => tool.name);
  assertStrictEquals(names.at(-1), "text.stats");
});

Deno.test("executeTextStats counts characters, words and lines", () => {
  assertEquals(executeTextStats(""), "characters: 0\nwords: 0\nlines: 0");
  assertEquals(
    executeTextStats("one two\nthree  four\n"),
    "characters: 20\nwords: 4\nlines: 3",
  );
  // Characters are code points, not UTF-16 units.
  assertEquals(executeTextStats("😀"), "characters: 1\nwords: 1\nlines: 1");
});

Deno.test("an invocation returns the stats and logs no text", async () => {
  const events: EventInsert[] = [];
  const result = await invokeCommandWithEvent(catalog, {
    commandId: "text.stats",
    callId: "call-1",
    caller: { principalId: "operator", principalType: "human" },
    arguments: { text: "private words" },
  }, {
    sessionId: "01EXAMPLESESSION0000000000",
    traceId: "0123456789abcdef0123456789abcdef",
    writeEvent: (event) => {
      events.push(event);
    },
  });
  assertEquals(result, {
    decision: "allow",
    authzBasis: "policy:allow:read-only-local",
    isError: false,
    result: "characters: 13\nwords: 2\nlines: 1",
  });
  assertEquals(events.length, 1);
  assertEquals(JSON.parse(String(events[0].tool_arguments)), {
    text: REDACTED,
  });
});
