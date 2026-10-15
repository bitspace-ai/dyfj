import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CONFIG_SCHEMA,
  declaredEnvVars,
  declaredSecretEnvVars,
} from "./schema.ts";

// The declared CONFIG_SCHEMA is the single source of truth for the engine
// permission env surface; these tests assert the deno.json allowlist against it,
// so the parity-drift class of bug (a runtime env var present in one profile and
// missing from another — the live failure that surfaced DYFJ_PRINCIPAL_ID on
// serve-unix) is caught structurally, not band-aided per-pair.
{ // "config surface ⇄ deno.json permission allowlist"
  const denoJson = JSON.parse(readFileSync("deno.json", "utf8")) as {
    permissions: Record<string, { env?: string[]; net?: string[] }>;
  };
  const profileEnv = (name: string) =>
    new Set(denoJson.permissions[name]?.env ?? []);

  // Turn-running engine profiles: each runs the SAME turn, so each must grant
  // the whole engine env surface.
  const ENGINE_PROFILES = [
    "serve-unix",
  ] as const;

  // Every engine entrypoint calls loadSecretsConfig() / resolveSecretsIntoEnv()
  // at boot, which reads HOME (configFilePath fallback when DYFJ_ROOT is unset)
  // and the resolver's minimal env base (PATH/HOME/USER/XDG_RUNTIME_DIR). An
  // ungranted read throws NotCapable and crashes the entrypoint before startup —
  // even with no [secrets] section. Assert all engine profiles grant the base.
  for (const profile of ENGINE_PROFILES) {
    test(`config surface ⇄ deno.json permission allowlist: ${profile} grants the resolver env base (so boot cannot NotCapable)`, () => {
      const granted = profileEnv(profile);
      for (const base of ["PATH", "HOME", "USER", "XDG_RUNTIME_DIR"]) {
        assert.strictEqual(granted.has(base), true);
      }
    });
  }

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

  const engineEnv = declaredEnvVars("engine");

  // Forward: no engine profile may silently lag the declared runtime surface.
  for (const profile of ENGINE_PROFILES) {
    test(`config surface ⇄ deno.json permission allowlist: ${profile} grants every declared engine env var`, () => {
      const granted = profileEnv(profile);
      const missing = engineEnv.filter((e) => !granted.has(e));
      assert.deepStrictEqual(missing, []);
    });
  }

  test("config surface ⇄ deno.json permission allowlist: verify-workbench-events grants the agent step-limit env var", () => {
    assert.strictEqual(
      profileEnv("verify-workbench-events").has("DYFJ_MAX_TOOL_STEPS"),
      true,
    );
  });

  // Test-harness and tooling keys are declared but never granted to a
  // runtime profile.
  test("config surface ⇄ deno.json permission allowlist: no runtime profile grants a test- or tooling-domain key", () => {
    const testKeys = CONFIG_SCHEMA.filter((s) =>
      s.domain === "test" || s.domain === "tooling"
    ).map((s) => s.envVar);
    assert.ok(testKeys.some((key) => key === "DYFJ_MCP_TEST_TEMP_DIR"));
    assert.ok(testKeys.some((key) => key === "DYFJ_LANE_TOKEN"));
    for (const [name, profile] of Object.entries(denoJson.permissions)) {
      if (name === "test") continue;
      const granted = new Set(profile.env ?? []);
      assert.deepStrictEqual(
        testKeys.filter((key) => granted.has(key)),
        [],
        name,
      );
    }
  });

  // Reverse: a new runtime env var can't be added to the allowlist without
  // joining the declared surface (only system env is exempt).
  for (const profile of ENGINE_PROFILES) {
    test(`config surface ⇄ deno.json permission allowlist: ${profile} grants no undeclared runtime env var`, () => {
      const declared = new Set(CONFIG_SCHEMA.map((s) => s.envVar));
      const undeclared = [...profileEnv(profile)].filter(
        (e) => !declared.has(e) && !SYSTEM_ENV.has(e),
      );
      assert.deepStrictEqual(undeclared, []);
    });
  }
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
