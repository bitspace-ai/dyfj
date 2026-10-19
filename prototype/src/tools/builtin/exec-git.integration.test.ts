// Planted repository config must not run under an allowlisted git call
// (BIT-707). Repository config and attributes can make `git status` and
// `git diff` execute programs: core.fsmonitor and a diff driver's textconv.
// The allowlist lets those commands skip the prompt, so the executor runs them
// with git's config and attribute sources overridden. Each case first shows
// the plant is live by running it as an operator-approved call.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CommandCall } from "../definition.ts";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { defineBash } from "./exec.ts";

const posix = process.platform !== "win32";
let root = "";

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "exec-git-")));
  git("init", "-q");
  writeFileSync(join(root, "f.txt"), "a\n");
  git("add", "f.txt");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  writeFileSync(join(root, "f.txt"), "b\n");
});

afterEach(() => rmSync(root, { recursive: true }));

const call = (command: string): CommandCall => ({
  commandId: "bash",
  callId: "c1",
  caller: { principalId: "model", principalType: "agent" },
  arguments: { command },
});

async function run(command: string, authzBasis: string): Promise<string> {
  return String(await defineBash(root).executor(call(command), { authzBasis }));
}

describe("planted git config under an allowlisted call", { skip: !posix }, () => {
  it("core.fsmonitor does not run", async () => {
    const marker = join(root, "FSMONITOR_RAN");
    const hook = join(root, "fsm.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    git("config", "core.fsmonitor", hook);

    await run("git status", "policy:allow:operator-approved");
    assert.ok(existsSync(marker), "the plant must be live for this test to mean anything");
    rmSync(marker);

    const out = await run("git status", "policy:allow:bash-allowlist");
    assert.match(out, /^exit 0/);
    assert.equal(existsSync(marker), false, "fsmonitor ran under the allowlist");
  });

  it("a textconv driver assigned by .gitattributes does not run", async () => {
    const marker = join(root, "TEXTCONV_RAN");
    writeFileSync(join(root, ".gitattributes"), "* diff=evil\n");
    git("config", "diff.evil.textconv", `sh -c 'touch "${marker}"; cat "$0"'`);

    await run("git diff", "policy:allow:operator-approved");
    assert.ok(existsSync(marker), "the plant must be live for this test to mean anything");
    rmSync(marker);

    for (const command of ["git diff", "git log -p -1", "git show"]) {
      const out = await run(command, "policy:allow:bash-allowlist");
      assert.match(out, /^exit 0/, command);
      assert.equal(existsSync(marker), false, `textconv ran under the allowlist: ${command}`);
    }
  });

  it("an implicit bare repository planted in a subdirectory is not used", async () => {
    const marker = join(root, "BARE_RAN");
    const bare = join(root, "planted");
    execFileSync("git", ["clone", "-q", "--bare", root, bare]);
    writeFileSync(join(bare, "info", "attributes"), "* diff=evil\n");
    execFileSync("git", [
      "config",
      "--file",
      join(bare, "config"),
      "diff.evil.textconv",
      `sh -c 'touch "${marker}"; cat "$0"'`,
    ]);

    await run("cd planted && git show", "policy:allow:operator-approved");
    assert.ok(existsSync(marker), "the plant must be live for this test to mean anything");
    rmSync(marker);

    await run("cd planted && git show", "policy:allow:bash-allowlist");
    assert.equal(existsSync(marker), false, "git used the planted bare repository");
  });
});

// bash starts from the physical directory the classifier resolved: PWD and
// OLDPWD are set to it, and CDPATH is never passed, whatever the runtime's
// own environment holds (BIT-707).
describe("bash's starting directory", { skip: !posix }, () => {
  it("ignores an inherited symlinked PWD and an inherited CDPATH", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "exec-pwd-")));
    try {
      const ws = join(base, "ws");
      const elsewhere = join(base, "elsewhere");
      execFileSync("mkdir", ["-p", join(ws, "sub"), join(elsewhere, "sub")]);
      writeFileSync(join(ws, "sub", "f"), "inside\n");
      writeFileSync(join(elsewhere, "sub", "f"), "outside\n");
      const linkToWs = join(base, "ws-link");
      execFileSync("ln", ["-s", ws, linkToWs]);
      const env = new MapEnv({
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        PWD: linkToWs,
        OLDPWD: elsewhere,
        CDPATH: elsewhere,
      });
      const bash = defineBash(ws, { env });
      const out = String(
        await bash.executor(
          call("cd sub && cat f && echo pwd=$PWD old=$OLDPWD cdpath=$CDPATH"),
          { authzBasis: "policy:allow:bash-allowlist" },
        ),
      );
      assert.match(out, /^exit 0/, out);
      assert.match(out, /\ninside\n/, out);
      assert.doesNotMatch(out, /outside/, out);
      assert.match(out, new RegExp(`pwd=${join(ws, "sub")} old=${ws} cdpath=$`, "m"), out);
    } finally {
      rmSync(base, { recursive: true });
    }
  });
});
