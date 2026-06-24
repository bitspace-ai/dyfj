import { describe, expect, test } from "vitest";
import { CONFIG_DEFAULTS, configFilePath, loadConfig } from "./config";

function env(map: Record<string, string> = {}) {
  return { get: (k: string) => map[k] };
}
const HOME = { HOME: "/h" };
const notFound = () => Promise.reject(new Deno.errors.NotFound());
const present = () => Promise.resolve("(toml text — parsed by the injected parser)");
// Inject the parsed table directly: we test the precedence/validation logic,
// not @std/toml (which can't load under the node test runner anyway).
const table = (t: Record<string, unknown>) => () => t;

describe("loadConfig", () => {
  test("returns defaults when there is no file and no env", async () => {
    const cfg = await loadConfig({ env: env(HOME), readTextFile: notFound });
    expect(cfg).toEqual(CONFIG_DEFAULTS);
  });

  test("applies values from the config file", async () => {
    const cfg = await loadConfig({
      env: env(HOME),
      readTextFile: present,
      parseToml: table({
        companion: { default_model: "claude-opus-4-8" },
        permissions: { level: "operator" },
      }),
    });
    expect(cfg.defaultCompanionModel).toBe("claude-opus-4-8");
    expect(cfg.permissionLevel).toBe("operator");
  });

  test("environment overrides the file (precedence)", async () => {
    const cfg = await loadConfig({
      env: env({
        ...HOME,
        DYFJ_WORKBENCH_MODEL: "env-model",
        DYFJ_PERMISSION_LEVEL: "operator",
      }),
      readTextFile: present,
      parseToml: table({
        companion: { default_model: "file-model" },
        permissions: { level: "strict" },
      }),
    });
    expect(cfg.defaultCompanionModel).toBe("env-model");
    expect(cfg.permissionLevel).toBe("operator");
  });

  test("rejects an invalid permission level — fail loud at startup", async () => {
    await expect(
      loadConfig({
        env: env(HOME),
        readTextFile: present,
        parseToml: table({ permissions: { level: "yolo" } }),
      }),
    ).rejects.toThrow(/invalid permission level/);
  });

  test("rejects a wrong-typed value rather than silently coercing", async () => {
    await expect(
      loadConfig({
        env: env(HOME),
        readTextFile: present,
        parseToml: table({ companion: { default_model: 123 } }),
      }),
    ).rejects.toThrow(/must be a string/);
  });

  test("surfaces a parse failure rather than silently mis-configuring", async () => {
    await expect(
      loadConfig({
        env: env(HOME),
        readTextFile: present,
        parseToml: () => {
          throw new Error("bad toml");
        },
      }),
    ).rejects.toThrow(/failed to parse/);
  });

  test("a non-NotFound read error surfaces as a config error", async () => {
    const denied = () => Promise.reject(new Error("EACCES"));
    await expect(
      loadConfig({ env: env(HOME), readTextFile: denied }),
    ).rejects.toThrow(/cannot read/);
  });
});

describe("configFilePath", () => {
  test("uses DYFJ_ROOT when set", () => {
    expect(configFilePath(env({ DYFJ_ROOT: "/custom" }))).toBe(
      "/custom/config.toml",
    );
  });

  test("falls back to ~/.dyfj", () => {
    expect(configFilePath(env({ HOME: "/home/x" }))).toBe(
      "/home/x/.dyfj/config.toml",
    );
  });
});
