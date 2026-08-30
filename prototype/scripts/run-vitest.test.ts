import { describe, expect, it } from "vitest";
import { vitestArgs } from "./run-vitest.ts";

describe("vitestArgs", () => {
  it("runs non-interactively without broad permission grants", () => {
    const args = vitestArgs(["run"], []);

    expect(args).toContain("--no-prompt");
    expect(args).not.toContain("--allow-sys");
    expect(args).not.toContain("--allow-read");
    expect(args).not.toContain("--allow-write");
    expect(args).not.toContain("--allow-run");
    expect(args).not.toContain("--allow-ffi");
  });

  it("keeps required system grants in the named test profile", async () => {
    const config = JSON.parse(
      await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
    );

    expect(config.permissions.test.sys).toEqual([
      "cpus",
      "systemMemoryInfo",
      "networkInterfaces",
      "uid",
      "hostname",
      "homedir",
    ]);
  });
});
