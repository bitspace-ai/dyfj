import { describe, expect, test } from "vitest";
import {
  BUDGET_DEFAULTS,
  CONFIG_DEFAULTS,
  CONFIG_SCHEMA,
  configFilePath,
  declaredEnvVars,
  declaredSecretEnvVars,
  DEFAULT_SECRET_TIMEOUT_MS,
  loadConfig,
  loadSecretsConfig,
  parseSecretsConfig,
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
    expect(cfg.approvePaidDefault).toBe(false);
    expect(cfg.defaultSessionBudgetUsd).toBe(BUDGET_DEFAULTS.sessionLimitUsd);
  });

  test("applies paid posture and budget defaults from the config file", async () => {
    const cfg = await loadConfig({
      env: env(HOME),
      readTextFile: present,
      parseToml: table({
        companion: { default_model: "claude-opus-4-8" },
        permissions: { level: "operator" },
        paid: { approve_paid_default: true },
        budget: { session_limit_usd: 2.5, per_call_limit_usd: 0.25 },
      }),
    });
    expect(cfg.defaultCompanionModel).toBe("claude-opus-4-8");
    expect(cfg.permissionLevel).toBe("operator");
    expect(cfg.approvePaidDefault).toBe(true);
    expect(cfg.defaultSessionBudgetUsd).toBe(2.5);
    expect(cfg.defaultPerCallBudgetUsd).toBe(0.25);
  });

  test("environment overrides the file (precedence)", async () => {
    const cfg = await loadConfig({
      env: env({
        ...HOME,
        DYFJ_WORKBENCH_MODEL: "env-model",
        DYFJ_PERMISSION_LEVEL: "operator",
        DYFJ_APPROVE_PAID_DEFAULT: "true",
        DYFJ_BUDGET_SESSION_USD: "3",
      }),
      readTextFile: present,
      parseToml: table({
        companion: { default_model: "file-model" },
        permissions: { level: "strict" },
        paid: { approve_paid_default: false },
        budget: { session_limit_usd: 9 },
      }),
    });
    expect(cfg.defaultCompanionModel).toBe("env-model");
    expect(cfg.permissionLevel).toBe("operator");
    expect(cfg.approvePaidDefault).toBe(true);
    expect(cfg.defaultSessionBudgetUsd).toBe(3);
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

  test("an invalid permission level error is path-free (no absolute config path)", async () => {
    await expect(
      loadConfig({
        env: env({ HOME: "/Users/private-account" }),
        readTextFile: present,
        parseToml: table({ permissions: { level: "yolo" } }),
      }),
    ).rejects.toThrow(/from config\.toml/);
    await loadConfig({
      env: env({ HOME: "/Users/private-account" }),
      readTextFile: present,
      parseToml: table({ permissions: { level: "yolo" } }),
    }).catch((e: Error) => {
      expect(e.message).not.toContain("private-account");
    });
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

  test("treats an EMPTY DYFJ_ROOT as absent (not '/'), matching the launcher", () => {
    expect(configFilePath(env({ DYFJ_ROOT: "", HOME: "/home/x" }))).toBe(
      "/home/x/.dyfj/config.toml",
    );
  });
});

describe("resolveBudgetDefaultsFromEnv", () => {
  test("returns the declared defaults when env is unset", () => {
    expect(resolveBudgetDefaultsFromEnv(env())).toEqual(BUDGET_DEFAULTS);
    expect(BUDGET_DEFAULTS).toEqual({
      sessionLimitUsd: 1.0,
      perCallLimitUsd: 0.1,
      dailyLimitUsd: 25.0,
    });
  });

  test("reads the declared env vars (env overrides defaults)", () => {
    expect(
      resolveBudgetDefaultsFromEnv(
        env({
          DYFJ_BUDGET_SESSION_USD: "5",
          DYFJ_BUDGET_PER_CALL_USD: "0.25",
          DYFJ_BUDGET_DAILY_USD: "40",
        }),
      ),
    ).toEqual({ sessionLimitUsd: 5, perCallLimitUsd: 0.25, dailyLimitUsd: 40 });
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

  // Every engine entrypoint calls loadSecretsConfig() / resolveSecretsIntoEnv()
  // at boot, which reads HOME (configFilePath fallback when DYFJ_ROOT is unset)
  // and the resolver's minimal env base (PATH/HOME/USER/XDG_RUNTIME_DIR). An
  // ungranted read throws NotCapable and crashes the entrypoint before startup —
  // even with no [secrets] section. Assert all engine profiles grant the base.
  for (const profile of ENGINE_PROFILES) {
    test(`${profile} grants the resolver env base (so boot cannot NotCapable)`, () => {
      const granted = profileEnv(profile);
      for (const base of ["PATH", "HOME", "USER", "XDG_RUNTIME_DIR"]) {
        expect(granted.has(base)).toBe(true);
      }
    });
  }

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

describe("loadConfig daily budget env override", () => {
  test("DYFJ_BUDGET_DAILY_USD overrides the file layer in loadConfig", async () => {
    const { loadConfig } = await import("./config");
    const config = await loadConfig({
      env: {
        get: (key: string) =>
          key === "DYFJ_BUDGET_DAILY_USD" ? "40" : undefined,
      },
      readTextFile: async () => "stub",
      parseToml: () => ({ budget: { daily_limit_usd: 10.0 } }),
    });
    expect(config.defaultDailyBudgetUsd).toBe(40);
  });

  test("the file layer sets the daily envelope when env is silent", async () => {
    const { loadConfig } = await import("./config");
    const config = await loadConfig({
      env: { get: () => undefined },
      readTextFile: async () => "stub",
      parseToml: () => ({ budget: { daily_limit_usd: 10.0 } }),
    });
    expect(config.defaultDailyBudgetUsd).toBe(10);
  });
});

describe("anomaly multiples config surface", () => {
  test("declared defaults: turn 3×, scope 2×", async () => {
    const { ANOMALY_DEFAULTS, CONFIG_DEFAULTS } = await import("./config");
    expect(ANOMALY_DEFAULTS.turnMultiple).toBe(3.0);
    expect(ANOMALY_DEFAULTS.scopeMultiple).toBe(2.0);
    expect(CONFIG_DEFAULTS.anomalyTurnMultiple).toBe(3.0);
    expect(CONFIG_DEFAULTS.anomalyScopeMultiple).toBe(2.0);
  });

  test("the [anomaly] file layer sets the multiples", async () => {
    const { loadConfig } = await import("./config");
    const config = await loadConfig({
      env: { get: () => undefined },
      readTextFile: async () => "stub",
      parseToml: () => ({ anomaly: { turn_multiple: 4, scope_multiple: 1.5 } }),
    });
    expect(config.anomalyTurnMultiple).toBe(4);
    expect(config.anomalyScopeMultiple).toBe(1.5);
  });

  test("env overrides the file layer", async () => {
    const { loadConfig } = await import("./config");
    const config = await loadConfig({
      env: {
        get: (key: string) =>
          key === "DYFJ_ANOMALY_TURN_MULTIPLE" ? "5" : undefined,
      },
      readTextFile: async () => "stub",
      parseToml: () => ({ anomaly: { turn_multiple: 4 } }),
    });
    expect(config.anomalyTurnMultiple).toBe(5);
  });

  test("a zero or negative multiple fails loud (no degenerate hard stop)", async () => {
    const { loadConfig } = await import("./config");
    await expect(loadConfig({
      env: { get: () => undefined },
      readTextFile: async () => "stub",
      parseToml: () => ({ anomaly: { turn_multiple: 0 } }),
    })).rejects.toThrow(/positive/);
    await expect(loadConfig({
      env: {
        get: (key: string) =>
          key === "DYFJ_ANOMALY_SCOPE_MULTIPLE" ? "-2" : undefined,
      },
      readTextFile: async () => {
        throw new Deno.errors.NotFound();
      },
      parseToml: () => ({}),
    })).rejects.toThrow(/positive/);
  });

  test("resolveAnomalyDefaultsFromEnv: defaults → env precedence", async () => {
    const { resolveAnomalyDefaultsFromEnv } = await import("./config");
    expect(resolveAnomalyDefaultsFromEnv({ get: () => undefined })).toEqual({
      turnMultiple: 3.0,
      scopeMultiple: 2.0,
    });
    expect(
      resolveAnomalyDefaultsFromEnv({
        get: (key: string) =>
          key === "DYFJ_ANOMALY_SCOPE_MULTIPLE" ? "2.5" : undefined,
      }).scopeMultiple,
    ).toBe(2.5);
  });
});

describe("anomaly env parsing strictness", () => {
  test("trailing junk fails loud instead of half-parsing ('2x' is not 2)", async () => {
    const { resolveAnomalyDefaultsFromEnv } = await import("./config");
    expect(() =>
      resolveAnomalyDefaultsFromEnv({
        get: (key: string) =>
          key === "DYFJ_ANOMALY_TURN_MULTIPLE" ? "2x" : undefined,
      })
    ).toThrow(/positive/);
    expect(() =>
      resolveAnomalyDefaultsFromEnv({
        get: (key: string) =>
          key === "DYFJ_ANOMALY_SCOPE_MULTIPLE" ? "1e2junk" : undefined,
      })
    ).toThrow(/positive/);
    // Plain and scientific forms still parse.
    expect(
      resolveAnomalyDefaultsFromEnv({
        get: (key: string) =>
          key === "DYFJ_ANOMALY_TURN_MULTIPLE" ? " 2.5 " : undefined,
      }).turnMultiple,
    ).toBe(2.5);
  });
});

describe("declaredSecretEnvVars", () => {
  test("lists exactly the engine secret-pointer env vars", () => {
    const secrets = new Set(declaredSecretEnvVars());
    // Every returned var is a declared engine secret-pointer.
    for (const envVar of secrets) {
      const spec = CONFIG_SCHEMA.find(
        (s) => s.envVar === envVar && s.domain === "engine",
      );
      expect(spec?.kind).toBe("secret-pointer");
    }
    // Spot-check the providers and the recall token the resolver must cover.
    expect(secrets.has("ANTHROPIC_API_KEY")).toBe(true);
    expect(secrets.has("OPENAI_API_KEY")).toBe(true);
    expect(secrets.has("GEMINI_API_KEY")).toBe(true);
    expect(secrets.has("DYFJ_MEMORY_MCP_TOKEN")).toBe(true);
    // A plain value key is never a secret pointer.
    expect(secrets.has("DYFJ_MEMORY_MCP_URL")).toBe(false);
  });
});

describe("parseSecretsConfig", () => {
  const PATH = "/h/.dyfj/config.toml";

  test("null table or absent [secrets] → null (no resolution)", () => {
    expect(parseSecretsConfig(null, PATH)).toBeNull();
    expect(parseSecretsConfig({ companion: {} }, PATH)).toBeNull();
  });

  test("parses command, timeout, and declared pointers", () => {
    const cfg = parseSecretsConfig(
      {
        secrets: {
          command: ["op", "read"],
          timeout_ms: 5000,
          pointers: {
            ANTHROPIC_API_KEY: "op://v/anthropic/credential",
            DYFJ_MEMORY_MCP_TOKEN: "op://v/brain/credential",
          },
        },
      },
      PATH,
    );
    expect(cfg).toEqual({
      command: ["op", "read"],
      timeoutMs: 5000,
      pointers: {
        ANTHROPIC_API_KEY: "op://v/anthropic/credential",
        DYFJ_MEMORY_MCP_TOKEN: "op://v/brain/credential",
      },
      env: {},
      inheritEnv: [],
    });
  });

  test("defaults timeout, env, and inherit_env when omitted", () => {
    const cfg = parseSecretsConfig(
      { secrets: { command: ["op", "read"] } },
      PATH,
    );
    expect(cfg?.timeoutMs).toBe(DEFAULT_SECRET_TIMEOUT_MS);
    expect(cfg?.pointers).toEqual({});
    expect(cfg?.env).toEqual({});
    expect(cfg?.inheritEnv).toEqual([]);
  });

  test("parses [secrets].inherit_env as a forward-list of ambient var names", () => {
    const cfg = parseSecretsConfig(
      {
        secrets: {
          command: ["op", "read"],
          inherit_env: ["OP_SERVICE_ACCOUNT_TOKEN", "OP_ACCOUNT"],
        },
      },
      PATH,
    );
    expect(cfg?.inheritEnv).toEqual(["OP_SERVICE_ACCOUNT_TOKEN", "OP_ACCOUNT"]);
  });

  test("inherit_env rejects denylisted and declared-secret names", () => {
    for (const name of ["PATH", "HOME", "LD_PRELOAD"]) {
      expect(() =>
        parseSecretsConfig(
          { secrets: { command: ["op", "read"], inherit_env: [name] } },
          PATH,
        )
      ).toThrow(/inherit_env may not name/);
    }
    expect(() =>
      parseSecretsConfig(
        {
          secrets: { command: ["op", "read"], inherit_env: ["ANTHROPIC_API_KEY"] },
        },
        PATH,
      )
    ).toThrow(/inherit_env may not name the declared secret/);
  });

  test("inherit_env rejects a wildcard / metacharacter name (--allow-env=* bypass)", () => {
    for (const name of ["*", "A=B", "FOO BAR", "1BAD", "A*"]) {
      expect(() =>
        parseSecretsConfig(
          { secrets: { command: ["op", "read"], inherit_env: [name] } },
          PATH,
        )
      ).toThrow(/not a valid environment variable name/);
    }
  });

  test("[secrets.env] rejects an invalid environment variable name", () => {
    expect(() =>
      parseSecretsConfig(
        { secrets: { command: ["op", "read"], env: { "*": "x" } } },
        PATH,
      )
    ).toThrow(/not a valid environment variable name/);
  });

  test("inherit_env must be an array of non-empty strings", () => {
    expect(() =>
      parseSecretsConfig(
        { secrets: { command: ["op", "read"], inherit_env: "OP_TOKEN" } },
        PATH,
      )
    ).toThrow(/must be an array/);
    expect(() =>
      parseSecretsConfig(
        { secrets: { command: ["op", "read"], inherit_env: [""] } },
        PATH,
      )
    ).toThrow(/non-empty strings/);
  });

  test("parses [secrets.env] as a non-secret string map", () => {
    const cfg = parseSecretsConfig(
      {
        secrets: {
          command: ["op", "read"],
          env: { OP_ACCOUNT: "my.1password.com", RESOLVER_FLAG: "1" },
        },
      },
      PATH,
    );
    expect(cfg?.env).toEqual({
      OP_ACCOUNT: "my.1password.com",
      RESOLVER_FLAG: "1",
    });
  });

  test("a non-string [secrets.env] value fails loud", () => {
    expect(() =>
      parseSecretsConfig(
        { secrets: { command: ["op", "read"], env: { OP_DEBUG: true } } },
        PATH,
      )
    ).toThrow(/\[secrets\.env\]\.OP_DEBUG must be a string/);
  });

  test("a security-relevant [secrets.env] name (PATH/HOME/linker) is rejected", () => {
    for (const name of ["PATH", "HOME", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD"]) {
      expect(() =>
        parseSecretsConfig(
          { secrets: { command: ["op", "read"], env: { [name]: "/evil" } } },
          PATH,
        )
      ).toThrow(/is not allowed/);
    }
  });

  test("a declared secret env var as a plaintext [secrets.env] value is rejected", () => {
    // The engine can enforce the no-plaintext-credential boundary for names it
    // knows are secret — a declared secret-pointer key must use a pointer.
    for (const name of ["ANTHROPIC_API_KEY", "DYFJ_MEMORY_MCP_TOKEN"]) {
      expect(() =>
        parseSecretsConfig(
          { secrets: { command: ["op", "read"], env: { [name]: "sk-plain" } } },
          PATH,
        )
      ).toThrow(/is a declared secret/);
    }
  });

  test("a missing command fails loud", () => {
    expect(() => parseSecretsConfig({ secrets: { timeout_ms: 1000 } }, PATH))
      .toThrow(/command is required/);
  });

  test("validation errors are path-free (no absolute config path on boot stderr)", () => {
    const privatePath = "/Users/private-account/.dyfj/config.toml";
    try {
      parseSecretsConfig({ secrets: { timeout_ms: 1000 } }, privatePath);
      throw new Error("expected a validation throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/command is required/);
      expect(msg).not.toContain("private-account");
      expect(msg).not.toContain(privatePath);
      // The stable public-safe label is fine.
      expect(msg).toContain("config.toml");
    }
  });

  test("an empty or non-string command fails loud", () => {
    expect(() => parseSecretsConfig({ secrets: { command: [] } }, PATH))
      .toThrow(/non-empty array/);
    expect(() => parseSecretsConfig({ secrets: { command: [""] } }, PATH))
      .toThrow(/non-empty array/);
    expect(() => parseSecretsConfig({ secrets: { command: "op read" } }, PATH))
      .toThrow(/non-empty array/);
  });

  test("a non-positive timeout fails loud", () => {
    expect(() =>
      parseSecretsConfig(
        { secrets: { command: ["op"], timeout_ms: 0 } },
        PATH,
      )
    ).toThrow(/positive number/);
  });

  test("a pointer for an undeclared or non-secret key fails loud", () => {
    expect(() =>
      parseSecretsConfig(
        {
          secrets: {
            command: ["op", "read"],
            pointers: { NOT_A_SECRET: "op://x" },
          },
        },
        PATH,
      )
    ).toThrow(/not a declared secret env var/);
    // A declared VALUE key (not a secret pointer) is rejected too.
    expect(() =>
      parseSecretsConfig(
        {
          secrets: {
            command: ["op", "read"],
            pointers: { DYFJ_MEMORY_MCP_URL: "op://x" },
          },
        },
        PATH,
      )
    ).toThrow(/not a declared secret env var/);
  });

  test("an empty pointer value fails loud", () => {
    expect(() =>
      parseSecretsConfig(
        {
          secrets: {
            command: ["op", "read"],
            pointers: { ANTHROPIC_API_KEY: "" },
          },
        },
        PATH,
      )
    ).toThrow(/non-empty string/);
  });
});

describe("loadSecretsConfig", () => {
  test("shares the file read; a missing file yields null", async () => {
    const cfg = await loadSecretsConfig({
      env: { get: (k) => (k === "HOME" ? "/h" : undefined) },
      readTextFile: () => Promise.reject(new Deno.errors.NotFound()),
    });
    expect(cfg).toBeNull();
  });

  test("parses the [secrets] section from the config file", async () => {
    const cfg = await loadSecretsConfig({
      env: { get: (k) => (k === "HOME" ? "/h" : undefined) },
      readTextFile: () => Promise.resolve("(toml)"),
      parseToml: () => ({
        secrets: {
          command: ["op", "read"],
          pointers: { OPENAI_API_KEY: "op://v/openai/credential" },
        },
      }),
    });
    expect(cfg?.command).toEqual(["op", "read"]);
    expect(cfg?.pointers.OPENAI_API_KEY).toBe("op://v/openai/credential");
  });
});

describe("parseSecretsConfig — strict [secrets] keys", () => {
  const PATH = "/h/.dyfj/config.toml";
  test("an unknown [secrets] key (typo) fails loud", () => {
    expect(() =>
      parseSecretsConfig(
        { secrets: { command: ["op", "read"], timeouts_ms: 5000 } },
        PATH,
      )
    ).toThrow(/not a recognized key/);
  });
});
