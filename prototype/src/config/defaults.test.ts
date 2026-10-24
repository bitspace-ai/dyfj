import { captureThrow } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";

import { CONFIG_SCHEMA } from "./schema.ts";
import {
  BUDGET_DEFAULTS,
  resolveAnomalyDefaultsFromEnv,
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
      sessionLimitUsd: 1.0,
      perCallLimitUsd: 0.1,
      dailyLimitUsd: 25.0,
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
      { sessionLimitUsd: 5, perCallLimitUsd: 0.25, dailyLimitUsd: 40 },
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

{ // "anomaly env parsing strictness"
  test("anomaly env parsing strictness: trailing junk fails loud instead of half-parsing ('2x' is not 2)", async () => {
    assert.match(
      (captureThrow(() =>
        resolveAnomalyDefaultsFromEnv({
          get: (key: string) =>
            key === "DYFJ_ANOMALY_TURN_MULTIPLE" ? "2x" : undefined,
        })
      ) as Error).message,
      /positive/,
    );
    assert.match(
      (captureThrow(() =>
        resolveAnomalyDefaultsFromEnv({
          get: (key: string) =>
            key === "DYFJ_ANOMALY_SCOPE_MULTIPLE" ? "1e2junk" : undefined,
        })
      ) as Error).message,
      /positive/,
    );
    // Plain and scientific forms still parse.
    assert.strictEqual(
      resolveAnomalyDefaultsFromEnv({
        get: (key: string) =>
          key === "DYFJ_ANOMALY_TURN_MULTIPLE" ? " 2.5 " : undefined,
      }).turnMultiple,
      2.5,
    );
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
      defaultSessionBudgetUsd: 1.0,
      defaultPerCallBudgetUsd: 0.1,
      defaultDailyBudgetUsd: 25.0,
      anomalyTurnMultiple: 3.0,
      anomalyScopeMultiple: 2.0,
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
        DYFJ_ANOMALY_TURN_MULTIPLE: "4",
        DYFJ_ANOMALY_SCOPE_MULTIPLE: "5",
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
        anomalyTurnMultiple: 4,
        anomalyScopeMultiple: 5,
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
