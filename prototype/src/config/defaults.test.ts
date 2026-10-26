import { captureThrow } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";

import { CONFIG_SCHEMA } from "./schema.ts";
import {
  BUDGET_DEFAULTS,
  resolveBudgetDefaultsFromEnv,
  resolvePrincipalId,
  resolveRuntimeEnvDefaults,
  resolveTrustWorkspaceInstructionsFromEnv,
} from "./defaults.ts";

const env = (map: Record<string, string> = {}) => new MapEnv(map);

{ // "resolveTrustWorkspaceInstructionsFromEnv"
  const envOf = (v?: string) => ({
    get: (key: string) =>
      key === "DYFJ_TRUST_WORKSPACE_INSTRUCTIONS" ? v : undefined,
  });

  test("resolveTrustWorkspaceInstructionsFromEnv: defaults off when unset or empty", () => {
    assert.strictEqual(
      resolveTrustWorkspaceInstructionsFromEnv(envOf(undefined)),
      false,
    );
    assert.strictEqual(
      resolveTrustWorkspaceInstructionsFromEnv(envOf("")),
      false,
    );
  });

  test("resolveTrustWorkspaceInstructionsFromEnv: honors an explicit true — the standalone entrypoint's binding", () => {
    assert.strictEqual(
      resolveTrustWorkspaceInstructionsFromEnv(envOf("true")),
      true,
    );
    assert.strictEqual(
      resolveTrustWorkspaceInstructionsFromEnv(envOf("false")),
      false,
    );
  });

  test("resolveTrustWorkspaceInstructionsFromEnv: rejects a malformed value loudly like every boolean binding", () => {
    assert.throws(() =>
      resolveTrustWorkspaceInstructionsFromEnv(envOf("definitely"))
    );
  });
}

{ // "resolveBudgetDefaultsFromEnv"
  test("resolveBudgetDefaultsFromEnv: returns the declared defaults when env is unset", () => {
    assert.deepStrictEqual(
      resolveBudgetDefaultsFromEnv(env()),
      BUDGET_DEFAULTS,
    );
    assert.deepStrictEqual(BUDGET_DEFAULTS, {
      sessionLimitUsd: 10.0,
      perCallLimitUsd: 0.5,
      dailyLimitUsd: 25.0,
      turnLimitUsd: 4.0,
      runawayStallUsd: 0.5,
    });
  });

  test("resolveBudgetDefaultsFromEnv: reads the declared env vars (env overrides defaults)", () => {
    assert.deepStrictEqual(
      resolveBudgetDefaultsFromEnv(
        env({
          DYFJ_BUDGET_SESSION_USD: "5",
          DYFJ_BUDGET_PER_CALL_USD: "0.25",
          DYFJ_BUDGET_DAILY_USD: "40",
        }),
      ),
      {
        sessionLimitUsd: 5,
        perCallLimitUsd: 0.25,
        dailyLimitUsd: 40,
        turnLimitUsd: 4.0,
        runawayStallUsd: 0.5,
      },
    );
  });

  test("resolveBudgetDefaultsFromEnv: rejects a non-numeric value rather than coercing to NaN", () => {
    assert.match(
      (captureThrow(() =>
        resolveBudgetDefaultsFromEnv(env({ DYFJ_BUDGET_SESSION_USD: "lots" }))
      ) as Error).message,
      /invalid USD value/,
    );
  });

  test("resolveBudgetDefaultsFromEnv: rejects a negative limit", () => {
    assert.match(
      (captureThrow(() =>
        resolveBudgetDefaultsFromEnv(env({ DYFJ_BUDGET_PER_CALL_USD: "-1" }))
      ) as Error).message,
      /invalid USD value/,
    );
  });
}

{ // "resolvePrincipalId"
  test("resolvePrincipalId: prefers DYFJ_PRINCIPAL_ID, then USER, then 'user'", () => {
    assert.strictEqual(
      resolvePrincipalId(env({ DYFJ_PRINCIPAL_ID: "p", USER: "u" })),
      "p",
    );
    assert.strictEqual(resolvePrincipalId(env({ USER: "u" })), "u");
    assert.strictEqual(resolvePrincipalId(env()), "user");
  });

  test("resolvePrincipalId: is declared as session state, not config", () => {
    const spec = CONFIG_SCHEMA.find((s) => s.key === "principalId");
    assert.strictEqual(spec?.sessionState, true);
    assert.ok(!Object.hasOwn(spec as object, "default"));
  });
}

{ // "turn and runaway limits from env"
  test("turn and runaway limits from env: defaults are $4.00 and $0.50; env overrides them", () => {
    assert.strictEqual(BUDGET_DEFAULTS.turnLimitUsd, 4.0);
    assert.strictEqual(BUDGET_DEFAULTS.runawayStallUsd, 0.5);
    const resolved = resolveBudgetDefaultsFromEnv(env({
      DYFJ_BUDGET_TURN_USD: "6",
      DYFJ_BUDGET_RUNAWAY_STALL_USD: "0.75",
    }));
    assert.strictEqual(resolved.turnLimitUsd, 6);
    assert.strictEqual(resolved.runawayStallUsd, 0.75);
  });
}

{ // "resolveRuntimeEnvDefaults"
  test("resolveRuntimeEnvDefaults: the standalone entrypoint resolves the standing trust posture from its env binding", () => {
    assert.strictEqual(
      resolveRuntimeEnvDefaults(env()).trustWorkspaceInstructions,
      false,
    );
    assert.strictEqual(
      resolveRuntimeEnvDefaults(
        env({ DYFJ_TRUST_WORKSPACE_INSTRUCTIONS: "true" }),
      ).trustWorkspaceInstructions,
      true,
    );
  });

  test("resolveRuntimeEnvDefaults: declared defaults when the environment is empty", () => {
    assert.deepStrictEqual(resolveRuntimeEnvDefaults(env()), {
      principalId: "user",
      trustWorkspaceInstructions: false,
      rootOverride: undefined,
      budgetTallyMode: "paid",
      defaultSessionBudgetUsd: 10.0,
      defaultPerCallBudgetUsd: 0.5,
      defaultDailyBudgetUsd: 25.0,
      defaultTurnBudgetUsd: 4.0,
      defaultRunawayStallUsd: 0.5,
      maxToolSteps: 32,
      maxToolStepsCeiling: 64,
    });
  });

  test("resolveRuntimeEnvDefaults: reads every runtime key from the injected env", () => {
    assert.deepStrictEqual(
      resolveRuntimeEnvDefaults(env({
        DYFJ_PRINCIPAL_ID: "p",
        DYFJ_ROOT: "/root",
        DYFJ_BUDGET_TALLY: "on",
        DYFJ_BUDGET_SESSION_USD: "2",
        DYFJ_BUDGET_PER_CALL_USD: "0.2",
        DYFJ_BUDGET_DAILY_USD: "30",
        DYFJ_BUDGET_TURN_USD: "4.5",
        DYFJ_BUDGET_RUNAWAY_STALL_USD: "0.6",
        DYFJ_MAX_TOOL_STEPS: "8",
        DYFJ_MAX_TOOL_STEPS_CEILING: "12",
      })),
      {
        principalId: "p",
        trustWorkspaceInstructions: false,
        rootOverride: "/root",
        budgetTallyMode: "on",
        defaultSessionBudgetUsd: 2,
        defaultPerCallBudgetUsd: 0.2,
        defaultDailyBudgetUsd: 30,
        defaultTurnBudgetUsd: 4.5,
        defaultRunawayStallUsd: 0.6,
        maxToolSteps: 8,
        maxToolStepsCeiling: 12,
      },
    );
  });

  test("resolveRuntimeEnvDefaults: an empty DYFJ_ROOT passes through; an unknown tally mode is paid", () => {
    const defaults = resolveRuntimeEnvDefaults(
      env({ DYFJ_ROOT: "", DYFJ_BUDGET_TALLY: "sometimes" }),
    );
    assert.strictEqual(defaults.rootOverride, "");
    assert.strictEqual(defaults.budgetTallyMode, "paid");
  });
}
