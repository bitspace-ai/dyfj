import {
  assertEquals,
  assertFalse,
  assertMatch,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { MapEnv } from "../../testing/fakes/map-env.ts";

const env = (map: Record<string, string> = {}) => new MapEnv(map);
import { CONFIG_SCHEMA } from "./schema.ts";
import {
  BUDGET_DEFAULTS,
  resolveAnomalyDefaultsFromEnv,
  resolveBudgetDefaultsFromEnv,
  resolvePrincipalId,
  resolveRuntimeEnvDefaults,
  resolveTrustWorkspaceInstructionsFromEnv,
} from "./defaults.ts";

{ // "resolveTrustWorkspaceInstructionsFromEnv"
  const envOf = (v?: string) => ({
    get: (key: string) =>
      key === "DYFJ_TRUST_WORKSPACE_INSTRUCTIONS" ? v : undefined,
  });

  Deno.test("resolveTrustWorkspaceInstructionsFromEnv: defaults off when unset or empty", () => {
    assertStrictEquals(
      resolveTrustWorkspaceInstructionsFromEnv(envOf(undefined)),
      false,
    );
    assertStrictEquals(
      resolveTrustWorkspaceInstructionsFromEnv(envOf("")),
      false,
    );
  });

  Deno.test("resolveTrustWorkspaceInstructionsFromEnv: honors an explicit true — the standalone entrypoint's binding", () => {
    assertStrictEquals(
      resolveTrustWorkspaceInstructionsFromEnv(envOf("true")),
      true,
    );
    assertStrictEquals(
      resolveTrustWorkspaceInstructionsFromEnv(envOf("false")),
      false,
    );
  });

  Deno.test("resolveTrustWorkspaceInstructionsFromEnv: rejects a malformed value loudly like every boolean binding", () => {
    assertThrows(() =>
      resolveTrustWorkspaceInstructionsFromEnv(envOf("definitely"))
    );
  });
}

{ // "resolveBudgetDefaultsFromEnv"
  Deno.test("resolveBudgetDefaultsFromEnv: returns the declared defaults when env is unset", () => {
    assertEquals(resolveBudgetDefaultsFromEnv(env()), BUDGET_DEFAULTS);
    assertEquals(BUDGET_DEFAULTS, {
      sessionLimitUsd: 1.0,
      perCallLimitUsd: 0.1,
      dailyLimitUsd: 25.0,
    });
  });

  Deno.test("resolveBudgetDefaultsFromEnv: reads the declared env vars (env overrides defaults)", () => {
    assertEquals(
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

  Deno.test("resolveBudgetDefaultsFromEnv: rejects a non-numeric value rather than coercing to NaN", () => {
    assertMatch(
      (assertThrows(() =>
        resolveBudgetDefaultsFromEnv(env({ DYFJ_BUDGET_SESSION_USD: "lots" }))
      ) as Error).message,
      /invalid USD value/,
    );
  });

  Deno.test("resolveBudgetDefaultsFromEnv: rejects a negative limit", () => {
    assertMatch(
      (assertThrows(() =>
        resolveBudgetDefaultsFromEnv(env({ DYFJ_BUDGET_PER_CALL_USD: "-1" }))
      ) as Error).message,
      /invalid USD value/,
    );
  });
}

{ // "resolvePrincipalId"
  Deno.test("resolvePrincipalId: prefers DYFJ_PRINCIPAL_ID, then USER, then 'user'", () => {
    assertStrictEquals(
      resolvePrincipalId(env({ DYFJ_PRINCIPAL_ID: "p", USER: "u" })),
      "p",
    );
    assertStrictEquals(resolvePrincipalId(env({ USER: "u" })), "u");
    assertStrictEquals(resolvePrincipalId(env()), "user");
  });

  Deno.test("resolvePrincipalId: is declared as session state, not config", () => {
    const spec = CONFIG_SCHEMA.find((s) => s.key === "principalId");
    assertStrictEquals(spec?.sessionState, true);
    assertFalse(Object.hasOwn(spec as object, "default"));
  });
}

{ // "anomaly env parsing strictness"
  Deno.test("anomaly env parsing strictness: trailing junk fails loud instead of half-parsing ('2x' is not 2)", async () => {
    assertMatch(
      (assertThrows(() =>
        resolveAnomalyDefaultsFromEnv({
          get: (key: string) =>
            key === "DYFJ_ANOMALY_TURN_MULTIPLE" ? "2x" : undefined,
        })
      ) as Error).message,
      /positive/,
    );
    assertMatch(
      (assertThrows(() =>
        resolveAnomalyDefaultsFromEnv({
          get: (key: string) =>
            key === "DYFJ_ANOMALY_SCOPE_MULTIPLE" ? "1e2junk" : undefined,
        })
      ) as Error).message,
      /positive/,
    );
    // Plain and scientific forms still parse.
    assertStrictEquals(
      resolveAnomalyDefaultsFromEnv({
        get: (key: string) =>
          key === "DYFJ_ANOMALY_TURN_MULTIPLE" ? " 2.5 " : undefined,
      }).turnMultiple,
      2.5,
    );
  });
}

{ // "resolveRuntimeEnvDefaults"
  Deno.test("resolveRuntimeEnvDefaults: the standalone entrypoint resolves the standing trust posture from its env binding", () => {
    assertStrictEquals(
      resolveRuntimeEnvDefaults(env()).trustWorkspaceInstructions,
      false,
    );
    assertStrictEquals(
      resolveRuntimeEnvDefaults(
        env({ DYFJ_TRUST_WORKSPACE_INSTRUCTIONS: "true" }),
      ).trustWorkspaceInstructions,
      true,
    );
  });

  Deno.test("resolveRuntimeEnvDefaults: declared defaults when the environment is empty", () => {
    assertEquals(resolveRuntimeEnvDefaults(env()), {
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
    });
  });

  Deno.test("resolveRuntimeEnvDefaults: reads every runtime key from the injected env", () => {
    assertEquals(
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
      },
    );
  });

  Deno.test("resolveRuntimeEnvDefaults: an empty DYFJ_ROOT passes through; an unknown tally mode is paid", () => {
    const defaults = resolveRuntimeEnvDefaults(
      env({ DYFJ_ROOT: "", DYFJ_BUDGET_TALLY: "sometimes" }),
    );
    assertStrictEquals(defaults.rootOverride, "");
    assertStrictEquals(defaults.budgetTallyMode, "paid");
  });
}
