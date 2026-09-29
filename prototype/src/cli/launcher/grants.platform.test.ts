// The launcher-grant cases that need process grants the `Deno.test` unit lane
// does not give: each builds a symlink fixture with `bash -c 'ln -s ...'`,
// because `Deno.symlink` needs unscoped read and write. They stay on the
// Vitest lane until the test sweep decides where process-granted cases run.
import { describe, expect, test } from "vitest";
import {
  nodeRunGrant,
  rustupHomeReadGrant,
  toolchainReadGrant,
} from "./grants.ts";

describe("nodeRunGrant", () => {
  test("carries the selected absolute executable after validating its target", async () => {
    const root = await Deno.makeTempDir({ dir: Deno.cwd() });
    const target = `${root}/target`;
    const executable = `${root}/selected`;
    try {
      await Deno.writeTextFile(target, "#!/bin/sh\nexit 0\n");
      await Deno.chmod(target, 0o700);
      const linked = await new Deno.Command("bash", {
        args: ["-c", '/bin/ln -s "$1" "$2"', "bash", target, executable],
      }).output();
      expect(linked.success).toBe(true);
      expect(await nodeRunGrant({ get: () => executable })).toBe(executable);
      await expect(nodeRunGrant({ get: () => "node" })).rejects.toThrow(
        "must name an absolute executable",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("rejects delimiter-unsafe selected and canonical paths", async () => {
    for (const delimiter of [",", ":"]) {
      const root = await Deno.makeTempDir({ dir: Deno.cwd() });
      const target = `${root}/node${delimiter}target`;
      const selected = `${root}/node`;
      try {
        await Deno.writeTextFile(target, "#!/bin/sh\nexit 0\n");
        await Deno.chmod(target, 0o700);
        const linked = await new Deno.Command("bash", {
          args: ["-c", '/bin/ln -s "$1" "$2"', "bash", target, selected],
          stdout: "null",
          stderr: "null",
        }).output();
        expect(linked.success).toBe(true);
        await expect(nodeRunGrant({ get: () => selected })).rejects.toThrow(
          "canonical target contains an unsupported delimiter",
        );
        await expect(nodeRunGrant({ get: () => target })).rejects.toThrow(
          "contains an unsupported delimiter",
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  });
});

describe("toolchainReadGrant", () => {
  test("rejects relative, delimiter-bearing, missing, file, and symlink paths", async () => {
    const root = await Deno.makeTempDir({ dir: Deno.cwd() });
    const file = `${root}/file`;
    const link = `${root}/link`;
    await Deno.writeTextFile(file, "x");
    const linked = await new Deno.Command("bash", {
      args: ["-c", '/bin/ln -s "$1" "$2"', "bash", root, link],
    }).output();
    expect(linked.success).toBe(true);
    try {
      await expect(toolchainReadGrant({ get: () => "relative" })).rejects
        .toThrow("absolute directory");
      for (const value of [`${root},other`, `${root}:other`]) {
        await expect(toolchainReadGrant({ get: () => value })).rejects.toThrow(
          "unsupported delimiter",
        );
      }
      for (
        const value of ["/", "///", `${root}/missing`, file, link, `${link}/`]
      ) {
        await expect(toolchainReadGrant({ get: () => value })).rejects.toThrow(
          "directory is unavailable",
        );
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("rustupHomeReadGrant", () => {
  test("rejects relative, delimiter-bearing, missing, file, and symlink paths", async () => {
    const root = await Deno.makeTempDir({ dir: Deno.cwd() });
    const file = `${root}/file`;
    const link = `${root}/link`;
    await Deno.writeTextFile(file, "x");
    const linked = await new Deno.Command("bash", {
      args: ["-c", '/bin/ln -s "$1" "$2"', "bash", root, link],
    }).output();
    expect(linked.success).toBe(true);
    try {
      await expect(rustupHomeReadGrant({ get: () => "relative" })).rejects
        .toThrow("absolute directory");
      for (const value of [`${root},other`, `${root}:other`]) {
        await expect(rustupHomeReadGrant({ get: () => value })).rejects.toThrow(
          "unsupported delimiter",
        );
      }
      for (
        const value of ["/", "///", `${root}/missing`, file, link, `${link}/`]
      ) {
        await expect(rustupHomeReadGrant({ get: () => value })).rejects.toThrow(
          "directory is unavailable",
        );
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
