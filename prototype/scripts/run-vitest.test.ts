import { describe, expect, it } from "vitest";
import { vitestArgs } from "./run-vitest.ts";

describe("vitestArgs", () => {
  it("runs non-interactively without broad permission grants", () => {
    const args = vitestArgs(["run"], []);
    const noPromptIndex = args.indexOf("--no-prompt");
    const vitestIndex = args.indexOf("npm:vitest@3.2.6");

    expect(noPromptIndex).toBeGreaterThan(args.indexOf("run"));
    expect(noPromptIndex).toBeLessThan(vitestIndex);
    for (
      const broadGrant of [
        "--allow-all",
        "--allow-sys",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-ffi",
        "-A",
        "-S",
        "-R",
        "-W",
      ]
    ) {
      expect(args).not.toContain(broadGrant);
    }
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
      "osRelease",
    ]);
  });
});
