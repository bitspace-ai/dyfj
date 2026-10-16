import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONFIG_SCHEMA,
  declaredEnvVars,
  declaredSecretEnvVars,
} from "./schema.ts";
import { RUNTIME_ENV_GRANTS } from "./runtime-policy.ts";

// The declared CONFIG_SCHEMA is the single source of truth for the engine env
// surface; these tests assert the runtime policy's env list against it, so the
// parity-drift class of bug (a runtime env var declared but not forwarded to
// the runtime, the live failure that once surfaced DYFJ_PRINCIPAL_ID) is caught
// structurally, not band-aided per-pair.
{ // "config surface ⇄ runtime env allowlist"
  const granted = new Set(RUNTIME_ENV_GRANTS);

  // Every engine entrypoint calls loadSecretsConfig() / resolveSecretsIntoEnv()
  // at boot, which reads HOME (configFilePath fallback when DYFJ_ROOT is unset)
  // and the resolver's minimal env base (PATH/HOME/USER/XDG_RUNTIME_DIR). The
  // runtime sees only the names its policy forwards, so each must be there.
  test("config surface ⇄ runtime env allowlist: the runtime gets the resolver env base", () => {
    for (const base of ["PATH", "HOME", "USER", "XDG_RUNTIME_DIR"]) {
      assert.strictEqual(granted.has(base), true, base);
    }
  });

  // System/runtime env not part of the DYFJ config surface.
  const SYSTEM_ENV = new Set([
    "PATH",
    "USER",
    "HOME",
    "XDG_RUNTIME_DIR",
    "NODE_DEBUG_NATIVE",
    "NODE_V8_COVERAGE",
    "NODE_DISABLE_COMPILE_CACHE",
    "NODE_COMPILE_CACHE_PORTABLE",
    "NODE_COMPILE_CACHE",
  ]);

  // Forward: the runtime allowlist may not silently lag the declared surface.
  test("config surface ⇄ runtime env allowlist: the runtime gets every declared engine env var", () => {
    const missing = declaredEnvVars("engine").filter((e) => !granted.has(e));
    assert.deepStrictEqual(missing, []);
  });

  // Test-harness and tooling keys are declared but never forwarded to the
  // runtime.
  test("config surface ⇄ runtime env allowlist: the runtime gets no test- or tooling-domain key", () => {
    const testKeys = CONFIG_SCHEMA.filter((s) =>
      s.domain === "test" || s.domain === "tooling"
    ).map((s) => s.envVar);
    assert.ok(testKeys.some((key) => key === "DYFJ_MCP_TEST_TEMP_DIR"));
    assert.ok(testKeys.some((key) => key === "DYFJ_LANE_TOKEN"));
    assert.deepStrictEqual(testKeys.filter((key) => granted.has(key)), []);
  });

  // Reverse: a new runtime env var can't be added to the allowlist without
  // joining the declared surface (only system env is exempt).
  test("config surface ⇄ runtime env allowlist: the runtime gets no undeclared env var", () => {
    const declared = new Set(CONFIG_SCHEMA.map((s) => s.envVar));
    const undeclared = [...granted].filter(
      (e) => !declared.has(e) && !SYSTEM_ENV.has(e),
    );
    assert.deepStrictEqual(undeclared, []);
  });
}

{ // "declaredSecretEnvVars"
  test("declaredSecretEnvVars: lists exactly the engine secret-pointer env vars", () => {
    const secrets = new Set(declaredSecretEnvVars());
    // Every returned var is a declared engine secret-pointer.
    for (const envVar of secrets) {
      const spec = CONFIG_SCHEMA.find(
        (s) => s.envVar === envVar && s.domain === "engine",
      );
      assert.strictEqual(spec?.kind, "secret-pointer");
    }
    // Spot-check the providers and the recall token the resolver must cover.
    assert.strictEqual(secrets.has("ANTHROPIC_API_KEY"), true);
    assert.strictEqual(secrets.has("OPENAI_API_KEY"), true);
    assert.strictEqual(secrets.has("OPENROUTER_API_KEY"), true);
    assert.strictEqual(secrets.has("GEMINI_API_KEY"), true);
    assert.strictEqual(secrets.has("DYFJ_MEMORY_MCP_TOKEN"), true);
    // A plain value key is never a secret pointer.
    assert.strictEqual(secrets.has("DYFJ_MEMORY_MCP_URL"), false);
  });
}
