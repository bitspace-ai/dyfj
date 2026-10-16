import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import { composeRuntimePolicy, type RuntimePolicy } from "./runtime-policy.ts";
import {
  assertSpawnAllowed,
  guardedSpawn,
  SpawnRefusedError,
} from "./spawn-guard.ts";

const posix = process.platform !== "win32";

function policyWith(run: string[]): RuntimePolicy {
  return { ...composeRuntimePolicy({}), run };
}

describe("assertSpawnAllowed", () => {
  let dir: string;
  let tool: string;
  let alias: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "dyfj-spawn-guard-"));
    tool = join(dir, "tool");
    await writeFile(tool, "#!/bin/sh\nexit 0\n");
    await chmod(tool, 0o755);
    alias = join(dir, "alias");
    await symlink(tool, alias);
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("allows an exact entry, by absolute path or by name", () => {
    const policy = policyWith(["/bin/kill", "git"]);
    assertSpawnAllowed(policy, "/bin/kill");
    assertSpawnAllowed(policy, "git");
  });

  it("allows a bare name whose PATH lookup is an absolute entry", {
    skip: !posix,
  }, () => {
    assertSpawnAllowed(policyWith([tool]), "tool", { PATH: dir });
  });

  it("allows an absolute command that a bare-name entry resolves to on PATH", {
    skip: !posix,
  }, () => {
    assertSpawnAllowed(policyWith(["tool"]), tool, { PATH: dir });
  });

  it("compares resolved files, so a symlink to an allowed file is allowed", {
    skip: !posix,
  }, () => {
    assertSpawnAllowed(policyWith([tool]), alias);
  });

  it("refuses a binary outside the run policy, naming it and where to configure it", () => {
    assert.throws(
      () => assertSpawnAllowed(policyWith(["git"]), "/usr/bin/curl"),
      (error: unknown) => {
        assert.ok(error instanceof SpawnRefusedError);
        assert.strictEqual(error.command, "/usr/bin/curl");
        assert.match(error.message, /"\/usr\/bin\/curl"/);
        assert.doesNotMatch(error.message, /runtime-policy/);
        assert.match(error.message, /DYFJ_NODE_PATH/);
        assert.match(error.message, /\[secrets\]\.command/);
        return true;
      },
    );
  });

  it(
    "refuses a bare name that is not allowed and resolves to nothing allowed",
    { skip: !posix },
    () => {
      assert.throws(
        () => assertSpawnAllowed(policyWith(["git"]), "tool", { PATH: dir }),
        SpawnRefusedError,
      );
    },
  );

  it("refuses a relative path with a separator: it cannot be decided", () => {
    assert.throws(
      () => assertSpawnAllowed(policyWith(["./tool", "tool"]), "./tool"),
      SpawnRefusedError,
    );
  });

  it("refuses an empty command", () => {
    assert.throws(
      () => assertSpawnAllowed(policyWith([""]), ""),
      SpawnRefusedError,
    );
  });

  it("bounds and strips control characters from the named binary", () => {
    assert.throws(
      () => assertSpawnAllowed(policyWith([]), `evil\n${"x".repeat(400)}`),
      (error: unknown) =>
        error instanceof SpawnRefusedError &&
        !error.message.includes("\n") &&
        error.message.length < 700,
    );
  });
});

describe("guardedSpawn", () => {
  it("throws before any process starts when the binary is refused", () => {
    const spawn = guardedSpawn(policyWith(["git"]));
    assert.throws(
      () => spawn("/usr/bin/curl", ["https://example.test"], {}),
      SpawnRefusedError,
    );
  });

  it("starts an allowed binary with the caller's arguments and options", async () => {
    const spawn = guardedSpawn(policyWith([process.execPath]));
    const child = spawn(process.execPath, ["-e", "process.exit(7)"], {
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((resolve) =>
      child.once("exit", (exit) => resolve(exit))
    );
    assert.strictEqual(code, 7);
  });

  it(
    "reads PATH from the spawn's own env when it has one",
    { skip: !posix },
    () => {
      const spawn = guardedSpawn(policyWith(["/bin/kill"]));
      assert.throws(
        () => spawn("kill", ["-0", "1"], { env: { PATH: "/nonexistent" } }),
        SpawnRefusedError,
      );
    },
  );
});
