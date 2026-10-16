// The typecheck.tsc lane keeps the erasable-syntax guarantee (decision D32):
// Node strips types without transforming them, so the root tsconfig sets
// `erasableSyntaxOnly` and tsc rejects syntax Node cannot strip, such as a
// constructor parameter property.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

// Typechecks `source` under the root tsconfig's compiler options and returns
// tsc's exit code and output.
async function typecheck(
  source: string,
): Promise<{ code: number; output: string }> {
  const dir = await mkdtemp(join(tmpdir(), "dyfj-tsc-"));
  try {
    await writeFile(join(dir, "fixture.ts"), source);
    // An ES module, as every package in the repository is.
    await writeFile(join(dir, "package.json"), '{"type": "module"}\n');
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: join(root, "tsconfig.json"),
        compilerOptions: { typeRoots: [join(root, "node_modules", "@types")] },
        include: ["fixture.ts"],
        exclude: [],
      }),
    );
    return await new Promise((resolve) => {
      execFile(
        "node",
        [tsc, "--project", join(dir, "tsconfig.json")],
        // An explicit environment: the gate lane that runs this file grants
        // only named variables, and `node` needs PATH to be found.
        { env: { PATH: process.env.PATH ?? "" } },
        (error, stdout, stderr) => {
          const code = error === null
            ? 0
            : typeof error.code === "number"
            ? error.code
            : 1;
          resolve({ code, output: `${stdout}${stderr}` });
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true });
  }
}

test("tsc rejects a constructor parameter property", async () => {
  const result = await typecheck(
    "export class Point {\n  constructor(readonly x: number) {}\n}\n",
  );
  if (result.code === 0 || !result.output.includes("TS1294")) {
    throw new Error(`parameter property was not rejected: ${result.output}`);
  }
});

test("tsc accepts the same class written with an explicit field", async () => {
  const result = await typecheck(
    "export class Point {\n  readonly x: number;\n" +
      "  constructor(x: number) {\n    this.x = x;\n  }\n}\n",
  );
  if (result.code !== 0) {
    throw new Error(`erasable class was rejected: ${result.output}`);
  }
});
