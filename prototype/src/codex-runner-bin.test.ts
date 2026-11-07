// Execute-bit decisions for the Codex runner's private npm and npx shims.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import { modeBitsAllowExecute, writeCodexRunnerBin } from "./codex-runner-bin.ts";

describe("Codex runner bin execute bits", () => {
  it("follows the effective uid rather than a real-uid root shortcut", () => {
    if (process.platform === "win32") return;
    const rootOwned = { uid: 0, gid: 0, mode: 0o700 };
    const other = { uid: 1000, gids: new Set([1000]) };
    // A non-root effective uid cannot execute a root-owned 0700 file.
    assert.strictEqual(modeBitsAllowExecute(rootOwned, other), false);
    // Effective uid 0 can, when any execute bit is set.
    assert.strictEqual(
      modeBitsAllowExecute(rootOwned, { uid: 0, gids: new Set([0]) }),
      true,
    );
    // Owner execute unset (0641): other-execute is not the owner's bit.
    assert.strictEqual(
      modeBitsAllowExecute(
        { uid: 1000, gid: 1000, mode: 0o641 },
        other,
      ),
      false,
    );
    assert.strictEqual(
      modeBitsAllowExecute(
        { uid: 1000, gid: 1000, mode: 0o700 },
        other,
      ),
      true,
    );
    assert.strictEqual(
      modeBitsAllowExecute(
        { uid: 0, gid: 1000, mode: 0o710 },
        other,
      ),
      true,
    );
    assert.strictEqual(
      modeBitsAllowExecute(
        { uid: 0, gid: 0, mode: 0o701 },
        other,
      ),
      true,
    );
    assert.strictEqual(
      modeBitsAllowExecute(rootOwned, { uid: undefined, gids: new Set() }),
      false,
    );
  });

  it("reads the effective uid when deciding whether to shim npm", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "dyfj-codex-bin-"));
    const names = ["getuid", "geteuid", "getgid", "getegid", "getgroups"] as const;
    const saved = new Map(
      names.map((name) => [name, Object.getOwnPropertyDescriptor(process, name)]),
    );
    const stub = (name: (typeof names)[number], value: () => number | number[]) => {
      Object.defineProperty(process, name, {
        configurable: true,
        writable: true,
        value,
      });
    };
    try {
      const nodePath = join(root, "node");
      await writeFile(nodePath, "#!/bin/sh\nexit 0\n");
      await chmod(nodePath, 0o700);
      const npm = join(root, "npm");
      await writeFile(npm, "#!/bin/sh\nexit 0\n");
      await chmod(npm, 0o700);
      const info = await stat(npm);
      const runnerBin = join(root, "bin");
      await mkdir(runnerBin, { mode: 0o700 });
      // The real uid looks like root. The effective uid is neither root nor
      // the file owner, and the effective group does not match the file.
      stub("getuid", () => 0);
      stub("geteuid", () => info.uid === 0 ? 1000 : info.uid + 1);
      stub("getgid", () => 0);
      stub("getegid", () => info.gid === 0 ? 1000 : info.gid + 1);
      stub("getgroups", () => []);
      await writeCodexRunnerBin({ runnerBin, nodePath });
      await assert.rejects(() => stat(join(runnerBin, "npm")), { code: "ENOENT" });
      await assert.rejects(() => stat(join(runnerBin, "npx")), { code: "ENOENT" });
      assert.strictEqual((await stat(join(runnerBin, "node"))).mode & 0o777, 0o700);
    } finally {
      for (const name of names) {
        const descriptor = saved.get(name);
        if (descriptor !== undefined) Object.defineProperty(process, name, descriptor);
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
