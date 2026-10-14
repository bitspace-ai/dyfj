import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  NODE_MODULES_REMEDY,
  nodeModulesState,
  runNodeModulesCheck,
} from "./node-modules-check.ts";

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// A lockfile in npm's v3 shape: the root package under "", every installed
// package under its node_modules path.
function lockfile(packages: Record<string, Record<string, unknown>>): string {
  return JSON.stringify({
    name: "fixture",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "fixture" }, ...packages },
  });
}

// npm's hidden lockfile, node_modules/.package-lock.json: no root entry, and
// only the packages actually installed.
function hidden(packages: Record<string, Record<string, unknown>>): string {
  return JSON.stringify({ name: "fixture", lockfileVersion: 3, packages });
}

// Every installed package's directory holds its package.json.
const present = (_path: string) => true;

const LOCKED = {
  "node_modules/zod": { version: "4.6.5" },
  "node_modules/a/node_modules/b": { version: "1.0.0" },
  "node_modules/codex-linux-x64": {
    version: "0.1.0",
    optional: true,
    os: ["linux"],
  },
};

test("node_modules matching the lockfile is current", () => {
  const installed = {
    "node_modules/zod": { version: "4.6.5" },
    "node_modules/a/node_modules/b": { version: "1.0.0" },
  };
  // An optional package for another platform is not installed, and that is
  // not staleness.
  assertEquals(nodeModulesState(lockfile(LOCKED), hidden(installed), present), {
    state: "current",
  });
});

test("missing node_modules is reported as missing", () => {
  assertEquals(nodeModulesState(lockfile(LOCKED), undefined, present), {
    state: "missing",
  });
});

test("node_modules out of date with the lockfile is stale", () => {
  const cases: Record<string, Record<string, unknown>>[] = [
    // A version differs.
    {
      "node_modules/zod": { version: "4.6.4" },
      "node_modules/a/node_modules/b": { version: "1.0.0" },
    },
    // A required package is not installed.
    { "node_modules/zod": { version: "4.6.5" } },
    // A package is installed that the lockfile does not name.
    {
      "node_modules/zod": { version: "4.6.5" },
      "node_modules/a/node_modules/b": { version: "1.0.0" },
      "node_modules/extra": { version: "1.0.0" },
    },
  ];
  for (const installed of cases) {
    const result = nodeModulesState(
      lockfile(LOCKED),
      hidden(installed),
      present,
    );
    assertEquals(result.state, "stale");
  }
  const result = nodeModulesState(
    lockfile(LOCKED),
    hidden({ "node_modules/zod": { version: "4.6.4" } }),
    present,
  );
  assertEquals(result, {
    state: "stale",
    differing: ["node_modules/a/node_modules/b", "node_modules/zod"],
  });
});

test("an unreadable lockfile or hidden lockfile fails closed", () => {
  assertEquals(nodeModulesState("{", hidden({}), present).state, "invalid");
  assertEquals(nodeModulesState("[]", hidden({}), present).state, "invalid");
  assertEquals(
    nodeModulesState(lockfile(LOCKED), "{", present).state,
    "stale",
  );
});

test("a package npm recorded but whose directory is gone is stale", () => {
  const installed = {
    "node_modules/zod": { version: "4.6.5" },
    "node_modules/a/node_modules/b": { version: "1.0.0" },
  };
  assertEquals(
    nodeModulesState(
      lockfile(LOCKED),
      hidden(installed),
      (path) => path !== "node_modules/zod",
    ),
    { state: "stale", differing: ["node_modules/zod"] },
  );
});

async function withPackageDir(
  files: Record<string, string>,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dyfj-node-modules-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    await body(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

function capture() {
  const lines: string[] = [];
  const out = {
    log: (line: string) => lines.push(line),
    error: (line: string) => lines.push(line),
  };
  return { lines, out };
}

const INSTALLED = {
  "node_modules/zod": { version: "4.6.5" },
  "node_modules/a/node_modules/b": { version: "1.0.0" },
};

// The package.json npm writes into each installed package's directory.
const INSTALLED_FILES = Object.fromEntries(
  Object.entries(INSTALLED).map((
    [path, entry],
  ) => [`${path}/package.json`, JSON.stringify(entry)]),
);

test("the check fails with the remedy when node_modules is missing", async () => {
  await withPackageDir(
    { "package-lock.json": lockfile(LOCKED) },
    async (dir) => {
      const { lines, out } = capture();
      assertEquals(await runNodeModulesCheck(dir, out), 1);
      const text = lines.join("\n");
      if (!text.includes("missing") || !text.includes(NODE_MODULES_REMEDY)) {
        throw new Error(`missing remedy: ${text}`);
      }
    },
  );
});

test("the check fails with the remedy when node_modules is stale", async () => {
  await withPackageDir({
    "package-lock.json": lockfile(LOCKED),
    "node_modules/.package-lock.json": hidden({
      "node_modules/zod": { version: "4.6.4" },
    }),
  }, async (dir) => {
    const { lines, out } = capture();
    assertEquals(await runNodeModulesCheck(dir, out), 1);
    const text = lines.join("\n");
    if (
      !text.includes("out of date") || !text.includes(NODE_MODULES_REMEDY) ||
      !text.includes("node_modules/zod")
    ) {
      throw new Error(`stale report incomplete: ${text}`);
    }
  });
});

test("the check passes when node_modules matches the lockfile", async () => {
  await withPackageDir({
    "package-lock.json": lockfile(LOCKED),
    "node_modules/.package-lock.json": hidden(INSTALLED),
    ...INSTALLED_FILES,
  }, async (dir) => {
    const { lines, out } = capture();
    assertEquals(await runNodeModulesCheck(dir, out), 0);
    assertEquals(lines, ["node_modules: matches package-lock.json"]);
  });
});

test("the check fails when a recorded package directory was deleted", async () => {
  const files = { ...INSTALLED_FILES };
  delete files["node_modules/zod/package.json"];
  await withPackageDir({
    "package-lock.json": lockfile(LOCKED),
    "node_modules/.package-lock.json": hidden(INSTALLED),
    ...files,
  }, async (dir) => {
    const { lines, out } = capture();
    assertEquals(await runNodeModulesCheck(dir, out), 1);
    const text = lines.join("\n");
    if (!text.includes("out of date") || !text.includes("node_modules/zod")) {
      throw new Error(`deleted package not reported: ${text}`);
    }
  });
});

test("the check fails closed without a lockfile", async () => {
  await withPackageDir({}, async (dir) => {
    const { lines, out } = capture();
    assertEquals(await runNodeModulesCheck(dir, out), 1);
    if (!lines.join("\n").includes("package-lock.json")) {
      throw new Error("a missing lockfile was not named");
    }
  });
});
