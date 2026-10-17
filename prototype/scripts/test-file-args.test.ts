// `test:file`'s argument parsing (`run-unit-tests.ts`): it runs unit test
// files only, and turns an integration file away before either runtime runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  integrationFileRejection,
  parseTestFileArgs,
  TEST_FILE_USAGE,
} from "./run-unit-tests.ts";

test("test:file rejects an integration file and names the lane to use", () => {
  for (
    const args of [
      ["src/server/events-asof.integration.test.ts"],
      ["src/cli-idea-local.test.ts", "src/a.integration.test.ts"],
      ["src/a.integration.test.ts", "--filter", "x"],
    ]
  ) {
    const integration = args.find((arg) => arg.includes(".integration."))!;
    assert.throws(
      () => parseTestFileArgs(args),
      (error: Error) => error.message === integrationFileRejection(integration),
      args.join(" "),
    );
  }
  const message = integrationFileRejection("src/a.integration.test.ts");
  assert.match(
    message,
    /^src\/a\.integration\.test\.ts is an integration test/,
  );
  assert.match(message, /`npm test` from the repository root/);
});

test("test:file still takes unit files and one filter", () => {
  assert.deepEqual(
    parseTestFileArgs(["src/a.test.ts", "--filter", "x", "src/b.test.ts"]),
    { files: ["src/a.test.ts", "src/b.test.ts"], filter: "x" },
  );
  assert.throws(() => parseTestFileArgs([]), { message: TEST_FILE_USAGE });
});
