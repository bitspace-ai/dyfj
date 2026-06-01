import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const kitDir = dirname(fileURLToPath(import.meta.url));
const projectionPath = resolve(
  kitDir,
  "projections",
  "assistant-context.md",
);

test("render.mjs writes the deterministic assistant projection", async () => {
  await rm(projectionPath, { force: true });

  const result = spawnSync(process.execPath, ["render.mjs"], {
    cwd: kitDir,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);

  const projection = await readFile(projectionPath, "utf8");

  assert.match(
    projection,
    /^# Solo Operator Assistant Context\n\nGenerated from `source\/` by `render\.mjs`\.\n\n/m,
  );
  assert.match(projection, /## Identity\n\nAlex is a fictional solo operator/m);
  assert.match(
    projection,
    /## Privacy Boundaries\n\n- Keep source notes canonical/m,
  );
  assert.doesNotMatch(projection, /canonical source repository|home directory/);
});
