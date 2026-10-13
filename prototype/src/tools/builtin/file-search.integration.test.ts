// The search walk against entries only a real filesystem can supply: a named
// pipe, which the unit lane's sandbox cannot create. The rest of the walk's
// contract is in file.test.ts and file-hardening.test.ts.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { executeGlobFiles, executeGrepFiles } from "./file-search.ts";
import { RootAnchors } from "./root-anchors.ts";

const anchors = new RootAnchors();
const at = (root: string) => anchors.root(root);

describe("search walk over a named pipe", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tmp-"));
    await writeFile(`${root}/plain.txt`, "needle\n");
    const made = await new Deno.Command("bash", {
      args: ["-c", 'mkfifo "$1"', "bash", `${root}/pipe`],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!made.success) {
      throw new Error(
        `mkfifo failed: ${new TextDecoder().decode(made.stderr)}`,
      );
    }
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true });
  });

  it("grep skips the pipe as a non-regular file and still finds the regular one", async () => {
    const out = await executeGrepFiles(at(root), "needle");
    assert.ok(
      out.includes("plain.txt:1:needle"),
      `expected ${JSON.stringify(out)} to include "plain.txt:1:needle"`,
    );
    assert.ok(
      out.includes("1 non-regular file(s) skipped"),
      `expected ${
        JSON.stringify(out)
      } to include "1 non-regular file(s) skipped"`,
    );
  });

  it("glob does not list the pipe", async () => {
    const out = await executeGlobFiles(at(root), "**/*");
    assert.ok(
      out.includes("plain.txt"),
      `expected ${JSON.stringify(out)} to include "plain.txt"`,
    );
    assert.ok(
      out.includes("1 non-regular file(s) skipped"),
      `expected ${
        JSON.stringify(out)
      } to include "1 non-regular file(s) skipped"`,
    );
    if (out.split("\n").some((line) => line.endsWith("pipe"))) {
      throw new Error(`the pipe was listed: ${out}`);
    }
  });
});
