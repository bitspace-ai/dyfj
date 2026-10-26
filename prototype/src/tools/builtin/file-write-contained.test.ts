// Tests for the executor-side write of `write_file` and `edit_file`
// (BIT-796). The executor is stood in for by a runner that runs the same argv
// with this machine's node, in a temporary workspace, so the script's own
// checks are exercised for real.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import type { BoundedResult } from "./bounded-process.ts";
import { defineEditFile, defineWriteFile } from "./file.ts";
import {
  CONTAINED_WRITE_MAX_BYTES,
  CONTAINED_WRITE_SCRIPT,
  type ContainedProcessRunner,
  containedWriteArgv,
  executeContainedWrite,
} from "./file-write-contained.ts";
import { RootAnchors } from "./root-anchors.ts";

/** Runs the argv with this machine's node, as the executor would. */
const localRunner: ContainedProcessRunner = (argv, cwd, _timeoutMs, _env, _binding, stdin) => {
  assert.strictEqual(argv[0], "node");
  const child = spawnSync(process.execPath, argv.slice(1), {
    cwd,
    encoding: "utf8",
    input: stdin,
  });
  return Promise.resolve({
    code: child.status,
    signal: child.signal,
    stdout: child.stdout,
    stderr: child.stderr,
    timedOut: false,
  } as BoundedResult);
};

describe("contained writes", () => {
  let dir: string;
  let outside: string;
  const anchors = new RootAnchors();

  before(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "dyfj-cw-")));
    outside = await realpath(await mkdtemp(join(tmpdir(), "dyfj-cw-out-")));
    await mkdir(join(dir, "sub"));
    await mkdir(join(dir, ".git"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const write = (p: string, content: string, run = localRunner) =>
    executeContainedWrite(anchors.root(dir), run, p, content);

  describe("containedWriteArgv", () => {
    it("is node -e, the script, --, then the path, and nothing else", () => {
      assert.deepStrictEqual(
        containedWriteArgv("a.txt"),
        ["node", "-e", CONTAINED_WRITE_SCRIPT, "--", "a.txt"],
      );
    });
  });

  describe("executeContainedWrite", () => {
    it("writes inside the workspace, through the runner, with no deadline from the model", async () => {
      const seen: number[] = [];
      const run: ContainedProcessRunner = (argv, cwd, timeoutMs, env, binding, stdin) => {
        seen.push(timeoutMs);
        return localRunner(argv, cwd, timeoutMs, env, binding, stdin);
      };
      assert.strictEqual(await write("sub/a.txt", "héllo\n", run), "wrote sub/a.txt");
      assert.strictEqual(await readFile(join(dir, "sub/a.txt"), "utf8"), "héllo\n");
      assert.deepStrictEqual(seen, [30_000]);
    });

    it("sends the content on stdin and never in argv, in any encoding", async () => {
      const content = "canary-7f3a9c secret body\nsecond line";
      const forms = [
        content,
        btoa(content),
        Buffer.from(content, "utf8").toString("hex"),
        encodeURIComponent(content),
        "canary-7f3a9c",
      ];
      const seen: { argv: readonly string[]; stdin: string }[] = [];
      const run: ContainedProcessRunner = (argv, cwd, timeoutMs, env, binding, stdin) => {
        seen.push({ argv, stdin });
        return localRunner(argv, cwd, timeoutMs, env, binding, stdin);
      };
      assert.strictEqual(await write("canary.txt", content, run), "wrote canary.txt");
      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0].stdin, content);
      const argv = seen[0].argv.join("\0");
      for (const form of forms) assert.ok(!argv.includes(form), form);
      assert.strictEqual(await readFile(join(dir, "canary.txt"), "utf8"), content);
    });

    it("creates a new file with no access for other users", async () => {
      assert.strictEqual(await write("private.txt", "x"), "wrote private.txt");
      const mode = (await stat(join(dir, "private.txt"))).mode & 0o777;
      assert.strictEqual(mode & 0o007, 0, mode.toString(8));
    });

    it("round-trips large content", async () => {
      const content = "0123456789".repeat(40_000);
      assert.strictEqual(await write("big.txt", content), "wrote big.txt");
      assert.strictEqual(await readFile(join(dir, "big.txt"), "utf8"), content);
    });

    it("refuses content that would not fit the request line once escaped", async () => {
      let ran = false;
      const result = await write("ctl.txt", "\u0001".repeat(200_000), () => {
        ran = true;
        return Promise.reject(new Error("not reached"));
      });
      assert.match(result, /too many control characters/);
      assert.strictEqual(ran, false);
    });

    it("refuses content above the limit without starting the executor", async () => {
      let ran = false;
      const result = await write("big.txt", "x".repeat(CONTAINED_WRITE_MAX_BYTES + 1), () => {
        ran = true;
        return Promise.reject(new Error("not reached"));
      });
      assert.match(result, /^error: cannot write big\.txt: the content is \d+ bytes, above the/);
      assert.strictEqual(ran, false);
    });

    it("refuses an absolute path, an escape and .git before the executor", async () => {
      let ran = false;
      const never: ContainedProcessRunner = () => {
        ran = true;
        return Promise.reject(new Error("not reached"));
      };
      assert.match(await write("/etc/x", "x", never), /^error: path must be relative/);
      assert.match(await write("../x", "x", never), /^error: path escapes the workspace root/);
      assert.match(await write(".git/config", "x", never), /^error: refusing to write inside \.git/);
      assert.strictEqual(ran, false);
    });

    it("the script itself refuses an escape, .git and an absolute path", () => {
      for (const [rel, status] of [["../x", "escape"], [".git/x", "git"], ["/etc/x", "escape"]]) {
        const child = spawnSync(process.execPath, ["-e", CONTAINED_WRITE_SCRIPT, "--", rel], {
          cwd: dir,
          encoding: "utf8",
          input: "x",
        });
        assert.strictEqual(child.stdout, status, rel);
      }
    });

    it("the script refuses a parent that is a symlink out of the workspace, and a symlink target", async (t) => {
      try {
        await symlink(outside, join(dir, "link-out"));
        await symlink(join(outside, "target"), join(dir, "dangling"));
      } catch {
        t.skip("this environment cannot create symlinks");
        return;
      }
      assert.match(await write("link-out/x", "x"), /^error: path escapes the workspace root/);
      assert.match(await write("dangling", "x"), /^error: refusing to write through a symlink/);
      await assert.rejects(readFile(join(outside, "target")));
    });

    it("writes a path that starts with - or .., inside the workspace", async () => {
      assert.strictEqual(await write("-notes.txt", "a"), "wrote -notes.txt");
      assert.strictEqual(await readFile(join(dir, "-notes.txt"), "utf8"), "a");
      const child = spawnSync(
        process.execPath,
        ["-e", CONTAINED_WRITE_SCRIPT, "--", "..notes.txt"],
        { cwd: dir, encoding: "utf8", input: "b" },
      );
      assert.strictEqual(child.stdout, "ok");
      assert.strictEqual(await readFile(join(dir, "..notes.txt"), "utf8"), "b");
    });

    it("reports a missing parent directory as an error, not a write", async () => {
      assert.strictEqual(
        await write("missing/a.txt", "x"),
        "error: cannot write missing/a.txt: not found",
      );
    });

    it("an executor that fails or is unreachable is an error result, never a throw", async () => {
      const failed: ContainedProcessRunner = () =>
        Promise.resolve({ code: 1, signal: null, stdout: "", stderr: "boom", timedOut: false });
      assert.match(await write("a.txt", "x", failed), /the isolated executor did not finish the write/);
      const gone: ContainedProcessRunner = () =>
        Promise.reject(new Error("executor unavailable: no executor connection is configured"));
      assert.match(await write("a.txt", "x", gone), /the isolated executor is unavailable$/);
    });
  });

  describe("the write tools on the executor route", () => {
    const env = new MapEnv({ DYFJ_EXECUTOR_SOCKET: "/run/dyfj-exec/exec.sock" });

    it("write_file without a dialer refuses rather than writing here", async () => {
      const tool = defineWriteFile(anchors.root(dir), { env });
      const result = await tool.executor(
        {
          commandId: "write_file",
          callId: "c",
          caller: { principalId: "workbench", principalType: "agent" },
          arguments: { path: "never.txt", content: "x" },
        },
        { authzBasis: "policy:allow:operator-approved" },
      );
      assert.match(String(result), /the isolated executor is unavailable$/);
      await assert.rejects(readFile(join(dir, "never.txt")));
    });

    it("edit_file refuses an oversized new_string before reading the file", async () => {
      const tool = defineEditFile(anchors.root(dir), { env });
      const result = await tool.executor(
        {
          commandId: "edit_file",
          callId: "c",
          caller: { principalId: "workbench", principalType: "agent" },
          arguments: {
            path: "absent.txt",
            old_string: "a",
            new_string: "x".repeat(CONTAINED_WRITE_MAX_BYTES + 1),
          },
        },
        { authzBasis: "policy:allow:attested-envelope" },
      );
      assert.match(String(result), /^error: cannot edit absent\.txt: new_string is above the/);
    });

    it("edit_file refuses a file larger than one contained write, before reading it", async () => {
      await writeFile(join(dir, "huge.txt"), "y".repeat(CONTAINED_WRITE_MAX_BYTES + 1));
      const tool = defineEditFile(anchors.root(dir), { env });
      const result = await tool.executor(
        {
          commandId: "edit_file",
          callId: "c",
          caller: { principalId: "workbench", principalType: "agent" },
          arguments: { path: "huge.txt", old_string: "y", new_string: "z" },
        },
        { authzBasis: "policy:allow:attested-envelope" },
      );
      assert.match(String(result), /^error: cannot edit huge\.txt: the file is \d+ bytes, above the/);
    });

    it("edit_file reads here and writes through the executor", async () => {
      await writeFile(join(dir, "e.txt"), "one two\n");
      const tool = defineEditFile(anchors.root(dir), {
        env,
        dialExecutor: () => Promise.reject(new Error("unused")),
      });
      // The supervisor cannot be reached, so the write-back fails there and
      // the file keeps its content: nothing was written here.
      const result = await tool.executor(
        {
          commandId: "edit_file",
          callId: "c",
          caller: { principalId: "workbench", principalType: "agent" },
          arguments: { path: "e.txt", old_string: "two", new_string: "three" },
        },
        { authzBasis: "policy:allow:attested-envelope" },
      );
      assert.match(String(result), /^error: cannot write e\.txt: /);
      assert.strictEqual(await readFile(join(dir, "e.txt"), "utf8"), "one two\n");
    });
  });
});
