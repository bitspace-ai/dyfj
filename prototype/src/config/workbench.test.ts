import {
  assertEquals,
  assertFalse,
  assertMatch,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { MapEnv } from "../../testing/fakes/map-env.ts";

import {
  ANOMALY_DEFAULTS,
  BUDGET_DEFAULTS,
  resolveAnomalyDefaultsFromEnv,
} from "./defaults.ts";
import { CONFIG_DEFAULTS, loadConfig } from "./workbench.ts";

const env = (map: Record<string, string> = {}) => new MapEnv(map);

const HOME = { HOME: "/h" };
// Assembled at runtime so the public-boundary scan never matches these
// fixtures as home-directory paths in tracked source.
const FAKE_PRIVATE_HOME = ["", "Users", "private-account"].join("/");
const notFound = () => Promise.reject(new Deno.errors.NotFound());
const present = () =>
  Promise.resolve("(toml text — parsed by the injected parser)");
// Inject the parsed table directly: these test the precedence/validation
// logic, not @std/toml.
const table = (t: Record<string, unknown>) => () => t;

{ // "loadConfig"
  Deno.test("loadConfig: returns defaults when there is no file and no env", async () => {
    const cfg = await loadConfig({ env: env(HOME), readTextFile: notFound });
    assertEquals(cfg, CONFIG_DEFAULTS);
    assertStrictEquals(cfg.approvePaidDefault, false);
    // Workspace-instruction elevation defaults OFF: selecting a workspace is
    // not a trust decision; setting this posture is.
    assertStrictEquals(cfg.trustWorkspaceInstructions, false);
    assertStrictEquals(
      cfg.defaultSessionBudgetUsd,
      BUDGET_DEFAULTS.sessionLimitUsd,
    );
  });

  Deno.test("loadConfig: applies paid posture and budget defaults from the config file", async () => {
    const cfg = await loadConfig({
      env: env(HOME),
      readTextFile: present,
      parseToml: table({
        companion: { default_model: "claude-opus-4-8" },
        permissions: { level: "operator" },
        paid: { approve_paid_default: true },
        workspace: { trust_instructions: true },
        budget: { session_limit_usd: 2.5, per_call_limit_usd: 0.25 },
      }),
    });
    assertStrictEquals(cfg.defaultCompanionModel, "claude-opus-4-8");
    assertStrictEquals(cfg.permissionLevel, "operator");
    assertStrictEquals(cfg.approvePaidDefault, true);
    assertStrictEquals(cfg.trustWorkspaceInstructions, true);
    assertStrictEquals(cfg.defaultSessionBudgetUsd, 2.5);
    assertStrictEquals(cfg.defaultPerCallBudgetUsd, 0.25);
  });

  Deno.test("loadConfig: environment overrides the file (precedence)", async () => {
    const cfg = await loadConfig({
      env: env({
        ...HOME,
        DYFJ_WORKBENCH_MODEL: "env-model",
        DYFJ_PERMISSION_LEVEL: "operator",
        DYFJ_APPROVE_PAID_DEFAULT: "true",
        DYFJ_TRUST_WORKSPACE_INSTRUCTIONS: "true",
        DYFJ_BUDGET_SESSION_USD: "3",
      }),
      readTextFile: present,
      parseToml: table({
        companion: { default_model: "file-model" },
        permissions: { level: "strict" },
        paid: { approve_paid_default: false },
        workspace: { trust_instructions: false },
        budget: { session_limit_usd: 9 },
      }),
    });
    assertStrictEquals(cfg.defaultCompanionModel, "env-model");
    assertStrictEquals(cfg.permissionLevel, "operator");
    assertStrictEquals(cfg.approvePaidDefault, true);
    assertStrictEquals(cfg.trustWorkspaceInstructions, true);
    assertStrictEquals(cfg.defaultSessionBudgetUsd, 3);
  });

  Deno.test("loadConfig: rejects an invalid permission level — fail loud at startup", async () => {
    assertMatch(
      (await assertRejects(() =>
        loadConfig({
          env: env(HOME),
          readTextFile: present,
          parseToml: table({ permissions: { level: "yolo" } }),
        })
      ) as Error).message,
      /invalid permission level/,
    );
  });

  Deno.test("loadConfig: an invalid permission level error is path-free (no absolute config path)", async () => {
    assertMatch(
      (await assertRejects(() =>
        loadConfig({
          env: env({ HOME: FAKE_PRIVATE_HOME }),
          readTextFile: present,
          parseToml: table({ permissions: { level: "yolo" } }),
        })
      ) as Error).message,
      /from config\.toml/,
    );
    await loadConfig({
      env: env({ HOME: FAKE_PRIVATE_HOME }),
      readTextFile: present,
      parseToml: table({ permissions: { level: "yolo" } }),
    }).catch((e: Error) => {
      assertFalse(e.message.includes("private-account"));
    });
  });

  Deno.test("loadConfig: rejects a wrong-typed value rather than silently coercing", async () => {
    assertMatch(
      (await assertRejects(() =>
        loadConfig({
          env: env(HOME),
          readTextFile: present,
          parseToml: table({ companion: { default_model: 123 } }),
        })
      ) as Error).message,
      /must be a string/,
    );
  });

  Deno.test("loadConfig: surfaces a parse failure rather than silently mis-configuring", async () => {
    assertMatch(
      (await assertRejects(() =>
        loadConfig({
          env: env(HOME),
          readTextFile: present,
          parseToml: () => {
            throw new Error("bad toml");
          },
        })
      ) as Error).message,
      /failed to parse/,
    );
  });

  Deno.test("loadConfig: a non-NotFound read error surfaces as a config error", async () => {
    const denied = () => Promise.reject(new Error("EACCES"));
    assertMatch(
      (await assertRejects(() =>
        loadConfig({ env: env(HOME), readTextFile: denied })
      ) as Error).message,
      /cannot read/,
    );
  });
}

{ // "loadConfig daily budget env override"
  Deno.test("loadConfig daily budget env override: DYFJ_BUDGET_DAILY_USD overrides the file layer in loadConfig", async () => {
    const config = await loadConfig({
      env: {
        get: (key: string) =>
          key === "DYFJ_BUDGET_DAILY_USD" ? "40" : undefined,
      },
      readTextFile: async () => "stub",
      parseToml: () => ({ budget: { daily_limit_usd: 10.0 } }),
    });
    assertStrictEquals(config.defaultDailyBudgetUsd, 40);
  });

  Deno.test("loadConfig daily budget env override: the file layer sets the daily envelope when env is silent", async () => {
    const config = await loadConfig({
      env: { get: () => undefined },
      readTextFile: async () => "stub",
      parseToml: () => ({ budget: { daily_limit_usd: 10.0 } }),
    });
    assertStrictEquals(config.defaultDailyBudgetUsd, 10);
  });
}

{ // "anomaly multiples config surface"
  Deno.test("anomaly multiples config surface: declared defaults: turn 3×, scope 2×", async () => {
    assertStrictEquals(ANOMALY_DEFAULTS.turnMultiple, 3.0);
    assertStrictEquals(ANOMALY_DEFAULTS.scopeMultiple, 2.0);
    assertStrictEquals(CONFIG_DEFAULTS.anomalyTurnMultiple, 3.0);
    assertStrictEquals(CONFIG_DEFAULTS.anomalyScopeMultiple, 2.0);
  });

  Deno.test("anomaly multiples config surface: the [anomaly] file layer sets the multiples", async () => {
    const config = await loadConfig({
      env: { get: () => undefined },
      readTextFile: async () => "stub",
      parseToml: () => ({ anomaly: { turn_multiple: 4, scope_multiple: 1.5 } }),
    });
    assertStrictEquals(config.anomalyTurnMultiple, 4);
    assertStrictEquals(config.anomalyScopeMultiple, 1.5);
  });

  Deno.test("anomaly multiples config surface: env overrides the file layer", async () => {
    const config = await loadConfig({
      env: {
        get: (key: string) =>
          key === "DYFJ_ANOMALY_TURN_MULTIPLE" ? "5" : undefined,
      },
      readTextFile: async () => "stub",
      parseToml: () => ({ anomaly: { turn_multiple: 4 } }),
    });
    assertStrictEquals(config.anomalyTurnMultiple, 5);
  });

  Deno.test("anomaly multiples config surface: a zero or negative multiple fails loud (no degenerate hard stop)", async () => {
    assertMatch(
      (await assertRejects(() =>
        loadConfig({
          env: { get: () => undefined },
          readTextFile: async () => "stub",
          parseToml: () => ({ anomaly: { turn_multiple: 0 } }),
        })
      ) as Error).message,
      /positive/,
    );
    assertMatch(
      (await assertRejects(() =>
        loadConfig({
          env: {
            get: (key: string) =>
              key === "DYFJ_ANOMALY_SCOPE_MULTIPLE" ? "-2" : undefined,
          },
          readTextFile: async () => {
            throw new Deno.errors.NotFound();
          },
          parseToml: () => ({}),
        })
      ) as Error).message,
      /positive/,
    );
  });

  Deno.test("anomaly multiples config surface: resolveAnomalyDefaultsFromEnv: defaults → env precedence", async () => {
    assertEquals(resolveAnomalyDefaultsFromEnv({ get: () => undefined }), {
      turnMultiple: 3.0,
      scopeMultiple: 2.0,
    });
    assertStrictEquals(
      resolveAnomalyDefaultsFromEnv({
        get: (key: string) =>
          key === "DYFJ_ANOMALY_SCOPE_MULTIPLE" ? "2.5" : undefined,
      }).scopeMultiple,
      2.5,
    );
  });
}

{ // "loadConfig agent tool-step limit"
  Deno.test("loadConfig agent tool-step limit: defaults maxToolSteps to 32", async () => {
    const cfg = await loadConfig({ env: env(HOME), readTextFile: notFound });
    assertStrictEquals(cfg.maxToolSteps, 32);
  });

  Deno.test("loadConfig agent tool-step limit: TOML and environment layers override maxToolSteps with env precedence", async () => {
    const fileCfg = await loadConfig({
      env: env(HOME),
      readTextFile: present,
      parseToml: table({ agent: { max_tool_steps: 12 } }),
    });
    assertStrictEquals(fileCfg.maxToolSteps, 12);

    const envCfg = await loadConfig({
      env: env({ ...HOME, DYFJ_MAX_TOOL_STEPS: "48" }),
      readTextFile: present,
      parseToml: table({ agent: { max_tool_steps: 12 } }),
    });
    assertStrictEquals(envCfg.maxToolSteps, 48);
  });

  Deno.test("loadConfig agent tool-step limit: treats whitespace-only env max tool steps as absent", async () => {
    const cfg = await loadConfig({
      env: env({ ...HOME, DYFJ_MAX_TOOL_STEPS: " \t\n " }),
      readTextFile: present,
      parseToml: table({ agent: { max_tool_steps: 12 } }),
    });
    assertStrictEquals(cfg.maxToolSteps, 12);
  });

  for (const value of [0, -1, 1.5, 65]) {
    Deno.test(`loadConfig agent tool-step limit: rejects invalid TOML max_tool_steps ${value}`, async () => {
      assertMatch(
        (await assertRejects(() =>
          loadConfig({
            env: env(HOME),
            readTextFile: present,
            parseToml: table({ agent: { max_tool_steps: value } }),
          })
        ) as Error).message,
        /max tool steps|integer from 1 through 64/,
      );
    });
  }

  for (const value of ["0", "-1", "1.5", "many", "65"]) {
    Deno.test(`loadConfig agent tool-step limit: rejects invalid env max tool steps ${value}`, async () => {
      assertMatch(
        (await assertRejects(() =>
          loadConfig({
            env: env({ ...HOME, DYFJ_MAX_TOOL_STEPS: value }),
            readTextFile: notFound,
          })
        ) as Error).message,
        /max tool steps|integer from 1 through 64/,
      );
    });
  }
}
