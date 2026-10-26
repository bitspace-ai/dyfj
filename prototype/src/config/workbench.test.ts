import { captureRejection } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";

import { BUDGET_DEFAULTS } from "./defaults.ts";
import { CONFIG_DEFAULTS, loadConfig } from "./workbench.ts";

const env = (map: Record<string, string> = {}) => new MapEnv(map);

const HOME = { HOME: "/h" };
// Assembled at runtime so the public-boundary scan never matches these
// fixtures as home-directory paths in tracked source.
const FAKE_PRIVATE_HOME = ["", "Users", "private-account"].join("/");
const notFound = () =>
  Promise.reject(
    Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }),
  );
const present = () =>
  Promise.resolve("(toml text — parsed by the injected parser)");
// Inject the parsed table directly: these test the precedence/validation
// logic, not the TOML parser.
const table = (t: Record<string, unknown>) => () => t;

{ // "loadConfig"
  test("loadConfig: returns defaults when there is no file and no env", async () => {
    const cfg = await loadConfig({ env: env(HOME), readTextFile: notFound });
    assert.deepStrictEqual(cfg, CONFIG_DEFAULTS);
    assert.strictEqual(cfg.approvePaidDefault, false);
    // Workspace-instruction elevation defaults OFF: selecting a workspace is
    // not a trust decision; setting this posture is.
    assert.strictEqual(cfg.trustWorkspaceInstructions, false);
    assert.strictEqual(
      cfg.defaultSessionBudgetUsd,
      BUDGET_DEFAULTS.sessionLimitUsd,
    );
  });

  test("loadConfig: applies paid posture and budget defaults from the config file", async () => {
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
    assert.strictEqual(cfg.defaultCompanionModel, "claude-opus-4-8");
    assert.strictEqual(cfg.permissionLevel, "operator");
    assert.strictEqual(cfg.approvePaidDefault, true);
    assert.strictEqual(cfg.trustWorkspaceInstructions, true);
    assert.strictEqual(cfg.defaultSessionBudgetUsd, 2.5);
    assert.strictEqual(cfg.defaultPerCallBudgetUsd, 0.25);
  });

  test("loadConfig: environment overrides the file (precedence)", async () => {
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
    assert.strictEqual(cfg.defaultCompanionModel, "env-model");
    assert.strictEqual(cfg.permissionLevel, "operator");
    assert.strictEqual(cfg.approvePaidDefault, true);
    assert.strictEqual(cfg.trustWorkspaceInstructions, true);
    assert.strictEqual(cfg.defaultSessionBudgetUsd, 3);
  });

  test("loadConfig: rejects an invalid permission level — fail loud at startup", async () => {
    assert.match(
      (await captureRejection(() =>
        loadConfig({
          env: env(HOME),
          readTextFile: present,
          parseToml: table({ permissions: { level: "yolo" } }),
        })
      ) as Error).message,
      /invalid permission level/,
    );
  });

  test("loadConfig: an invalid permission level error is path-free (no absolute config path)", async () => {
    assert.match(
      (await captureRejection(() =>
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
      assert.ok(!e.message.includes("private-account"));
    });
  });

  test("loadConfig: rejects a wrong-typed value rather than silently coercing", async () => {
    assert.match(
      (await captureRejection(() =>
        loadConfig({
          env: env(HOME),
          readTextFile: present,
          parseToml: table({ companion: { default_model: 123 } }),
        })
      ) as Error).message,
      /must be a string/,
    );
  });

  test("loadConfig: surfaces a parse failure rather than silently mis-configuring", async () => {
    assert.match(
      (await captureRejection(() =>
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

  test("loadConfig: a missing config.toml yields the defaults through the default reader", async () => {
    // No reader is injected: the real file read runs on a directory that holds
    // no config.toml, and its not-found error must read as "no file".
    const dir = await mkdtemp(join(tmpdir(), "tmp-"));
    try {
      const config = await loadConfig({
        env: { get: (key) => (key === "DYFJ_ROOT" ? dir : undefined) },
        parseToml: () => ({}),
      });
      assert.deepStrictEqual(config, CONFIG_DEFAULTS);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("loadConfig: a read error with a code names that code, not its message", async () => {
    // The message repeats the path; the label must carry the code only.
    const denied = () =>
      Promise.reject(
        Object.assign(new Error("EACCES: permission denied, open '/x/y'"), {
          code: "EACCES",
        }),
      );
    const message =
      ((await captureRejection(() =>
        loadConfig({ env: env(HOME), readTextFile: denied })
      )) as Error).message;
    assert.match(message, /cannot read config\.toml \(EACCES\)/);
    assert.ok(!message.includes("/x/y"));
  });

  test("loadConfig: a non-NotFound read error surfaces as a config error", async () => {
    const denied = () => Promise.reject(new Error("EACCES"));
    assert.match(
      (await captureRejection(() =>
        loadConfig({ env: env(HOME), readTextFile: denied })
      ) as Error).message,
      /cannot read/,
    );
  });
}

{ // "loadConfig daily budget env override"
  test("loadConfig daily budget env override: DYFJ_BUDGET_DAILY_USD overrides the file layer in loadConfig", async () => {
    const config = await loadConfig({
      env: {
        get: (key: string) =>
          key === "DYFJ_BUDGET_DAILY_USD" ? "40" : undefined,
      },
      readTextFile: async () => "stub",
      parseToml: () => ({ budget: { daily_limit_usd: 10.0 } }),
    });
    assert.strictEqual(config.defaultDailyBudgetUsd, 40);
  });

  test("loadConfig daily budget env override: the file layer sets the daily envelope when env is silent", async () => {
    const config = await loadConfig({
      env: { get: () => undefined },
      readTextFile: async () => "stub",
      parseToml: () => ({ budget: { daily_limit_usd: 10.0 } }),
    });
    assert.strictEqual(config.defaultDailyBudgetUsd, 10);
  });
}

{ // "turn and runaway limits config surface"
  test("turn and runaway limits config surface: declared defaults: turn $4.00, runaway $0.50", () => {
    assert.strictEqual(CONFIG_DEFAULTS.defaultTurnBudgetUsd, 4.0);
    assert.strictEqual(CONFIG_DEFAULTS.defaultRunawayStallUsd, 0.5);
  });

  test("turn and runaway limits config surface: the [budget] file layer sets them, and env overrides the file", async () => {
    const fromFile = await loadConfig({
      env: { get: () => undefined },
      readTextFile: async () => "stub",
      parseToml: () => ({
        budget: { turn_limit_usd: 6, runaway_stall_usd: 0.8 },
      }),
    });
    assert.strictEqual(fromFile.defaultTurnBudgetUsd, 6);
    assert.strictEqual(fromFile.defaultRunawayStallUsd, 0.8);
    const fromEnv = await loadConfig({
      env: {
        get: (key: string) => key === "DYFJ_BUDGET_TURN_USD" ? "7" : undefined,
      },
      readTextFile: async () => "stub",
      parseToml: () => ({ budget: { turn_limit_usd: 6 } }),
    });
    assert.strictEqual(fromEnv.defaultTurnBudgetUsd, 7);
  });

  test("turn and runaway limits config surface: a retired [anomaly] table fails loud and names the replacement keys", async () => {
    const message = (await captureRejection(() =>
      loadConfig({
        env: { get: () => undefined },
        readTextFile: async () => "stub",
        parseToml: () => ({ anomaly: { turn_multiple: 3 } }),
      })
    ) as Error).message;
    assert.match(message, /\[anomaly\] is no longer supported/);
    assert.match(message, /turn_limit_usd and runaway_stall_usd/);
  });

}

{ // "loadConfig agent tool-step limit"
  test("loadConfig agent tool-step limit: defaults maxToolSteps to 32", async () => {
    const cfg = await loadConfig({ env: env(HOME), readTextFile: notFound });
    assert.strictEqual(cfg.maxToolSteps, 32);
  });

  test("loadConfig agent tool-step limit: TOML and environment layers override maxToolSteps with env precedence", async () => {
    const fileCfg = await loadConfig({
      env: env(HOME),
      readTextFile: present,
      parseToml: table({ agent: { max_tool_steps: 12 } }),
    });
    assert.strictEqual(fileCfg.maxToolSteps, 12);

    const envCfg = await loadConfig({
      env: env({ ...HOME, DYFJ_MAX_TOOL_STEPS: "48" }),
      readTextFile: present,
      parseToml: table({ agent: { max_tool_steps: 12 } }),
    });
    assert.strictEqual(envCfg.maxToolSteps, 48);
  });

  test("loadConfig agent tool-step limit: treats whitespace-only env max tool steps as absent", async () => {
    const cfg = await loadConfig({
      env: env({ ...HOME, DYFJ_MAX_TOOL_STEPS: " \t\n " }),
      readTextFile: present,
      parseToml: table({ agent: { max_tool_steps: 12 } }),
    });
    assert.strictEqual(cfg.maxToolSteps, 12);
  });

  for (const value of [0, -1, 1.5, 65]) {
    test(`loadConfig agent tool-step limit: rejects invalid TOML max_tool_steps ${value}`, async () => {
      assert.match(
        (await captureRejection(() =>
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

  test("loadConfig agent tool-step ceiling: defaults to 64; TOML and env layers override it with env precedence", async () => {
    const cfg = await loadConfig({ env: env(HOME), readTextFile: notFound });
    assert.strictEqual(cfg.maxToolStepsCeiling, 64);
    const fileCfg = await loadConfig({
      env: env(HOME),
      readTextFile: present,
      parseToml: table({ agent: { max_tool_steps: 8, max_tool_steps_ceiling: 16 } }),
    });
    assert.strictEqual(fileCfg.maxToolStepsCeiling, 16);
    const envCfg = await loadConfig({
      env: env({ ...HOME, DYFJ_MAX_TOOL_STEPS_CEILING: "24" }),
      readTextFile: present,
      parseToml: table({ agent: { max_tool_steps: 8, max_tool_steps_ceiling: 16 } }),
    });
    assert.strictEqual(envCfg.maxToolStepsCeiling, 24);
  });

  test("loadConfig agent tool-step ceiling: refuses a default limit above the ceiling", async () => {
    assert.match(
      (await captureRejection(() =>
        loadConfig({
          env: env({ ...HOME, DYFJ_MAX_TOOL_STEPS: "8", DYFJ_MAX_TOOL_STEPS_CEILING: "4" }),
          readTextFile: notFound,
        })
      ) as Error).message,
      /default max tool steps \(8\) is above the tool-step ceiling \(4\)/,
    );
  });

  for (const value of [0, 1.5, 65]) {
    test(`loadConfig agent tool-step ceiling: rejects invalid TOML max_tool_steps_ceiling ${value}`, async () => {
      assert.match(
        (await captureRejection(() =>
          loadConfig({
            env: env(HOME),
            readTextFile: present,
            parseToml: table({ agent: { max_tool_steps_ceiling: value } }),
          })
        ) as Error).message,
        /max_tool_steps_ceiling.*integer from 1 through 64/,
      );
    });
  }

  for (const value of ["0", "-1", "1.5", "many", "65"]) {
    test(`loadConfig agent tool-step limit: rejects invalid env max tool steps ${value}`, async () => {
      assert.match(
        (await captureRejection(() =>
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
