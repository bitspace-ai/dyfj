// `npm run test:file` given an integration file: the real unit runner exits
// non-zero with the rejection, and no test process loads the file. The file
// writes a marker when it is loaded, so its absence shows that nothing ran
// it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { integrationFileRejection } from "./run-unit-tests.ts";

const RUNNER = fileURLToPath(new URL("./run-unit-tests.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "dyfj-test-file-rejection-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("test:file turns away an integration file before any test starts", () => {
  const root = mkdtempSync(join(dir, "root-"));
  const marker = join(root, "loaded");
  const file = "src/probe.integration.test.ts";
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, file),
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(marker)}, "loaded");\n` +
      'import { test } from "node:test";\ntest("ran", () => {});\n',
  );
  const result = spawnSync("node", [RUNNER, file], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    timeout: 60_000,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr.trim(), integrationFileRejection(file));
  assert.equal(existsSync(marker), false, "a test process loaded the file");
});
