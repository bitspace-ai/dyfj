// The launcher-grant cases that need a process grant the unit lane does not
// give: each builds a symlink fixture with `ln -s`, because creating a symlink
// in-process needs unscoped read and write. They run in the integration lane.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@std/testing/bdd";
import {
  nodeRunGrant,
  rustupHomeReadGrant,
  toolchainReadGrant,
} from "./grants.ts";

describe("nodeRunGrant", () => {
  it("carries the selected absolute executable after validating its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "dyfj-grants-"));
    const target = `${root}/target`;
    const executable = `${root}/selected`;
    try {
      await writeFile(target, "#!/bin/sh\nexit 0\n");
      await chmod(target, 0o700);
      // An explicit environment, so the spawn reads none from the process.
      const linked = spawnSync("ln", ["-s", target, executable], { env: {} });
      assert.ifError(linked.error);
      assert.strictEqual(linked.status, 0);
      assert.strictEqual(
        await nodeRunGrant({ get: () => executable }),
        executable,
      );
      await assert.rejects(
        () => nodeRunGrant({ get: () => "node" }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("must name an absolute executable"),
      );
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("rejects delimiter-unsafe selected and canonical paths", async () => {
    for (const delimiter of [",", ":"]) {
      const root = await mkdtemp(join(tmpdir(), "dyfj-grants-"));
      const target = `${root}/node${delimiter}target`;
      const selected = `${root}/node`;
      try {
        await writeFile(target, "#!/bin/sh\nexit 0\n");
        await chmod(target, 0o700);
        // An explicit environment, so the spawn reads none from the process.
        const linked = spawnSync("ln", ["-s", target, selected], {
          env: {},
          stdio: "ignore",
        });
        assert.ifError(linked.error);
        assert.strictEqual(linked.status, 0);
        await assert.rejects(
          () => nodeRunGrant({ get: () => selected }),
          (error: unknown) =>
            error instanceof Error &&
            error.message.includes(
              "canonical target contains an unsupported delimiter",
            ),
        );
        await assert.rejects(
          () => nodeRunGrant({ get: () => target }),
          (error: unknown) =>
            error instanceof Error &&
            error.message.includes("contains an unsupported delimiter"),
        );
      } finally {
        await rm(root, { recursive: true });
      }
    }
  });
});

describe("toolchainReadGrant", () => {
  it("rejects relative, delimiter-bearing, missing, file, and symlink paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "dyfj-grants-"));
    const file = `${root}/file`;
    const link = `${root}/link`;
    try {
      await writeFile(file, "x");
      // An explicit environment, so the spawn reads none from the process.
      const linked = spawnSync("ln", ["-s", root, link], { env: {} });
      assert.ifError(linked.error);
      assert.strictEqual(linked.status, 0);
      await assert.rejects(
        () => toolchainReadGrant({ get: () => "relative" }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("absolute directory"),
      );
      for (const value of [`${root},other`, `${root}:other`]) {
        await assert.rejects(
          () => toolchainReadGrant({ get: () => value }),
          (error: unknown) =>
            error instanceof Error &&
            error.message.includes("unsupported delimiter"),
        );
      }
      for (
        const value of ["/", "///", `${root}/missing`, file, link, `${link}/`]
      ) {
        await assert.rejects(
          () => toolchainReadGrant({ get: () => value }),
          (error: unknown) =>
            error instanceof Error &&
            error.message.includes("directory is unavailable"),
        );
      }
    } finally {
      await rm(root, { recursive: true });
    }
  });
});

describe("rustupHomeReadGrant", () => {
  it("rejects relative, delimiter-bearing, missing, file, and symlink paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "dyfj-grants-"));
    const file = `${root}/file`;
    const link = `${root}/link`;
    try {
      await writeFile(file, "x");
      // An explicit environment, so the spawn reads none from the process.
      const linked = spawnSync("ln", ["-s", root, link], { env: {} });
      assert.ifError(linked.error);
      assert.strictEqual(linked.status, 0);
      await assert.rejects(
        () => rustupHomeReadGrant({ get: () => "relative" }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("absolute directory"),
      );
      for (const value of [`${root},other`, `${root}:other`]) {
        await assert.rejects(
          () => rustupHomeReadGrant({ get: () => value }),
          (error: unknown) =>
            error instanceof Error &&
            error.message.includes("unsupported delimiter"),
        );
      }
      for (
        const value of ["/", "///", `${root}/missing`, file, link, `${link}/`]
      ) {
        await assert.rejects(
          () => rustupHomeReadGrant({ get: () => value }),
          (error: unknown) =>
            error instanceof Error &&
            error.message.includes("directory is unavailable"),
        );
      }
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
