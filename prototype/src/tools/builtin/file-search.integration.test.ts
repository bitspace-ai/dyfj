// The search walk against entries only a real filesystem can supply: a named
// pipe, which the unit lane's sandbox cannot create. The rest of the walk's
// contract is in file.test.ts and file-hardening.test.ts.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import { executeGlobFiles, executeGrepFiles } from "./file-search.ts";
import { RootAnchors } from "./root-anchors.ts";

const anchors = new RootAnchors();
const at = (root: string) => anchors.root(root);

// Makes the pipe through bash, with cwd and stdin inherited and only PATH from
// the env: given no env, spawn copies the whole parent env, which needs an
// unscoped env grant the integration lane does not give. A shell that cannot
// start rejects (spawn reports it as an `error` event); otherwise the
// exit code and stderr come back once the child has exited and its streams
// have closed.
function mkfifo(
  path: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", 'mkfifo "$1"', "bash", path], {
      env: process.env.PATH === undefined ? {} : { PATH: process.env.PATH },
      stdio: ["inherit", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

describe("search walk over a named pipe", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "tmp-"));
    await writeFile(`${root}/plain.txt`, "needle\n");
    const made = await mkfifo(`${root}/pipe`);
    if (made.code !== 0) {
      throw new Error(`mkfifo failed: ${made.stderr}`);
    }
  });

  after(async () => {
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
