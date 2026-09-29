// The launcher-grant cases that need a process grant the unit lane does not
// give: each builds a symlink fixture with `ln -s`, because `Deno.symlink`
// needs unscoped read and write. They run in the integration lane.
import { assertRejects, assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  nodeRunGrant,
  rustupHomeReadGrant,
  toolchainReadGrant,
} from "./grants.ts";

describe("nodeRunGrant", () => {
  it("carries the selected absolute executable after validating its target", async () => {
    const root = await Deno.makeTempDir({ prefix: "dyfj-grants-" });
    const target = `${root}/target`;
    const executable = `${root}/selected`;
    try {
      await Deno.writeTextFile(target, "#!/bin/sh\nexit 0\n");
      await Deno.chmod(target, 0o700);
      const linked = await new Deno.Command("ln", {
        args: ["-s", target, executable],
      }).output();
      assertStrictEquals(linked.success, true);
      assertStrictEquals(
        await nodeRunGrant({ get: () => executable }),
        executable,
      );
      await assertRejects(
        () => nodeRunGrant({ get: () => "node" }),
        Error,
        "must name an absolute executable",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("rejects delimiter-unsafe selected and canonical paths", async () => {
    for (const delimiter of [",", ":"]) {
      const root = await Deno.makeTempDir({ prefix: "dyfj-grants-" });
      const target = `${root}/node${delimiter}target`;
      const selected = `${root}/node`;
      try {
        await Deno.writeTextFile(target, "#!/bin/sh\nexit 0\n");
        await Deno.chmod(target, 0o700);
        const linked = await new Deno.Command("ln", {
          args: ["-s", target, selected],
          stdout: "null",
          stderr: "null",
        }).output();
        assertStrictEquals(linked.success, true);
        await assertRejects(
          () => nodeRunGrant({ get: () => selected }),
          Error,
          "canonical target contains an unsupported delimiter",
        );
        await assertRejects(
          () => nodeRunGrant({ get: () => target }),
          Error,
          "contains an unsupported delimiter",
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  });
});

describe("toolchainReadGrant", () => {
  it("rejects relative, delimiter-bearing, missing, file, and symlink paths", async () => {
    const root = await Deno.makeTempDir({ prefix: "dyfj-grants-" });
    const file = `${root}/file`;
    const link = `${root}/link`;
    try {
      await Deno.writeTextFile(file, "x");
      const linked = await new Deno.Command("ln", {
        args: ["-s", root, link],
      }).output();
      assertStrictEquals(linked.success, true);
      await assertRejects(
        () => toolchainReadGrant({ get: () => "relative" }),
        Error,
        "absolute directory",
      );
      for (const value of [`${root},other`, `${root}:other`]) {
        await assertRejects(
          () => toolchainReadGrant({ get: () => value }),
          Error,
          "unsupported delimiter",
        );
      }
      for (
        const value of ["/", "///", `${root}/missing`, file, link, `${link}/`]
      ) {
        await assertRejects(
          () => toolchainReadGrant({ get: () => value }),
          Error,
          "directory is unavailable",
        );
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("rustupHomeReadGrant", () => {
  it("rejects relative, delimiter-bearing, missing, file, and symlink paths", async () => {
    const root = await Deno.makeTempDir({ prefix: "dyfj-grants-" });
    const file = `${root}/file`;
    const link = `${root}/link`;
    try {
      await Deno.writeTextFile(file, "x");
      const linked = await new Deno.Command("ln", {
        args: ["-s", root, link],
      }).output();
      assertStrictEquals(linked.success, true);
      await assertRejects(
        () => rustupHomeReadGrant({ get: () => "relative" }),
        Error,
        "absolute directory",
      );
      for (const value of [`${root},other`, `${root}:other`]) {
        await assertRejects(
          () => rustupHomeReadGrant({ get: () => value }),
          Error,
          "unsupported delimiter",
        );
      }
      for (
        const value of ["/", "///", `${root}/missing`, file, link, `${link}/`]
      ) {
        await assertRejects(
          () => rustupHomeReadGrant({ get: () => value }),
          Error,
          "directory is unavailable",
        );
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
