import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dependencyProblem } from "./dependency-check.ts";

/** A repository root holding `prototype/package.json` and `node_modules`. */
async function tree(
  pins: Record<string, string>,
  installed: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp("/tmp/dyfj_dc_");
  await mkdir(join(root, "prototype"));
  await writeFile(
    join(root, "prototype", "package.json"),
    JSON.stringify({ name: "p", dependencies: pins }),
  );
  for (const [name, version] of Object.entries(installed)) {
    const dir = join(root, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ version }));
  }
  return root;
}

test("installed pinned dependencies pass", async () => {
  const root = await tree(
    { ulid: "3.0.2", "@scope/pkg": "1.0.0" },
    { ulid: "3.0.2", "@scope/pkg": "1.0.0" },
  );
  try {
    assert.equal(dependencyProblem(join(root, "prototype")), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing dependency names it and says to run npm ci", async () => {
  const root = await tree({ ulid: "3.0.2", zod: "4.6.7" }, { zod: "4.6.7" });
  try {
    const problem = dependencyProblem(join(root, "prototype"));
    assert.ok(problem !== undefined);
    assert.match(problem, /ulid is not installed/);
    assert.match(problem, /npm ci/);
    assert.ok(problem.includes(root), problem);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dependency at another version than the pin names both", async () => {
  const root = await tree({ zod: "4.6.7" }, { zod: "4.6.6" });
  try {
    const problem = dependencyProblem(join(root, "prototype"));
    assert.ok(problem !== undefined);
    assert.match(problem, /zod 4\.6\.6 is installed, but prototype\/package\.json pins 4\.6\.7/);
    assert.match(problem, /npm ci/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a range instead of an exact pin is not compared", async () => {
  const root = await tree({ zod: "^4.6.0" }, { zod: "4.6.6" });
  try {
    assert.equal(dependencyProblem(join(root, "prototype")), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an installed manifest that cannot be parsed says to run npm ci", async () => {
  const root = await tree({ ulid: "3.0.2" }, {});
  try {
    await mkdir(join(root, "node_modules", "ulid"), { recursive: true });
    await writeFile(join(root, "node_modules", "ulid", "package.json"), "");
    const problem = dependencyProblem(join(root, "prototype"));
    assert.ok(problem !== undefined);
    assert.match(problem, /ulid/);
    assert.match(problem, /npm ci/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
