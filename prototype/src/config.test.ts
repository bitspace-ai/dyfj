import { describe, expect, test } from "vitest";
import {
  BUDGET_DEFAULTS,
  CONFIG_DEFAULTS,
  CONFIG_SCHEMA,
  configFilePath,
  declaredEnvVars,
  loadConfig,
  resolveBudgetDefaultsFromEnv,
  resolvePrincipalId,
} from "./config";

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

describe("resolveBudgetDefaultsFromEnv", () => {
  test("returns the declared defaults when env is unset", () => {
    expect(resolveBudgetDefaultsFromEnv(env())).toEqual(BUDGET_DEFAULTS);
    expect(BUDGET_DEFAULTS).toEqual({ sessionLimitUsd: 1.0, perCallLimitUsd: 0.1 });
  });

  test("reads the declared env vars (env overrides defaults)", () => {
    expect(
      resolveBudgetDefaultsFromEnv(
        env({ DYFJ_BUDGET_SESSION_USD: "5", DYFJ_BUDGET_PER_CALL_USD: "0.25" }),
      ),
    ).toEqual({ sessionLimitUsd: 5, perCallLimitUsd: 0.25 });
  });

  test("rejects a non-numeric value rather than coercing to NaN", () => {
    expect(() =>
      resolveBudgetDefaultsFromEnv(env({ DYFJ_BUDGET_SESSION_USD: "lots" }))
    ).toThrow(/invalid USD value/);
  });

  test("rejects a negative limit", () => {
    expect(() =>
      resolveBudgetDefaultsFromEnv(env({ DYFJ_BUDGET_PER_CALL_USD: "-1" }))
    ).toThrow(/invalid USD value/);
  });
});

describe("resolvePrincipalId", () => {
  test("prefers DYFJ_PRINCIPAL_ID, then USER, then 'user'", () => {
    expect(resolvePrincipalId(env({ DYFJ_PRINCIPAL_ID: "p", USER: "u" }))).toBe("p");
    expect(resolvePrincipalId(env({ USER: "u" }))).toBe("u");
    expect(resolvePrincipalId(env())).toBe("user");
  });

  test("is declared as session state, not config", () => {
    const spec = CONFIG_SCHEMA.find((s) => s.key === "principalId");
    expect(spec?.sessionState).toBe(true);
    expect(spec).not.toHaveProperty("default");
  });
});

// The declared CONFIG_SCHEMA is the single source of truth for the engine
// permission env surface; these tests assert the deno.json allowlist against it,
// so the parity-drift class of bug (a runtime env var present in one profile and
// missing from another — the live failure that surfaced DYFJ_PRINCIPAL_ID on
// serve-unix) is caught structurally, not band-aided per-pair.
describe("config surface ⇄ deno.json permission allowlist", () => {
  const denoJson = JSON.parse(Deno.readTextFileSync("deno.json")) as {
    permissions: Record<string, { env?: string[]; net?: string[] }>;
  };
  const profileEnv = (name: string) =>
    new Set(denoJson.permissions[name]?.env ?? []);

  // Turn-running engine profiles: each runs the SAME turn, so each must grant
  // the whole engine env surface (minus HTTP-transport-specific vars).
  const ENGINE_PROFILES = ["workbench", "workbench-http", "serve-unix"] as const;

  // Env legitimately present only in the workbench-http profile.
  const HTTP_ONLY = new Set([
    "DYFJ_WORKBENCH_HTTP_HOST",
    "DYFJ_WORKBENCH_HTTP_PORT",
    "DYFJ_WORKBENCH_ALLOWED_HOSTS",
    "DYFJ_WORKBENCH_API_KEY",
  ]);

  // System/runtime env not part of the DYFJ config surface.
  const SYSTEM_ENV = new Set([
    "PATH",
    "USER",
    "HOME",
    "XDG_RUNTIME_DIR",
    "NODE_DEBUG_NATIVE",
    "NODE_DISABLE_COMPILE_CACHE",
    "NODE_COMPILE_CACHE_PORTABLE",
    "NODE_COMPILE_CACHE",
  ]);

  const engineEnv = declaredEnvVars("engine");

  // Forward: no engine profile may silently lag the declared runtime surface.
  for (const profile of ENGINE_PROFILES) {
    test(`${profile} grants every declared engine env var`, () => {
      const granted = profileEnv(profile);
      const missing = engineEnv.filter(
        (e) =>
          !granted.has(e) && !(profile !== "workbench-http" && HTTP_ONLY.has(e)),
      );
      expect(missing).toEqual([]);
    });
  }

  // Reverse: a new runtime env var can't be added to the allowlist without
  // joining the declared surface (only system env is exempt).
  for (const profile of ENGINE_PROFILES) {
    test(`${profile} grants no undeclared runtime env var`, () => {
      const declared = new Set(CONFIG_SCHEMA.map((s) => s.envVar));
      const undeclared = [...profileEnv(profile)].filter(
        (e) => !declared.has(e) && !SYSTEM_ENV.has(e),
      );
      expect(undeclared).toEqual([]);
    });
  }

  // Net derivation from the schema is a follow-on (the schema declares env, not
  // net hosts yet); until then, retain the serve-unix ⊇ workbench-http net
  // backstop so the UDS turn can dial everything the HTTP turn can.
  test("serve-unix net ⊇ workbench-http net (minus the HTTP server's own port)", () => {
    const http = denoJson.permissions["workbench-http"].net ?? [];
    const uds = new Set(denoJson.permissions["serve-unix"].net ?? []);
    const missing = http.filter((n) => n !== "127.0.0.1:8787" && !uds.has(n));
    expect(missing).toEqual([]);
  });
});
