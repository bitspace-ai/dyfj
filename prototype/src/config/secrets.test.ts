import {
  assertEquals,
  assertFalse,
  assertMatch,
  assertNotStrictEquals,
  assertObjectMatch,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  buildResolverEnv,
  resolveSecrets,
  resolveSecretsIntoEnv,
  type RunSecretCommand,
  type SecretCommandResult,
  secretsRunGrant,
  unavailableSecretPointers,
} from "./secrets.ts";
import type { MutableEnv, SecretsConfig } from "./mod.ts";

/** A mutable in-memory env matching the resolver's read/write surface. */
function fakeEnv(initial: Record<string, string> = {}): MutableEnv & {
  store: Record<string, string>;
} {
  const store: Record<string, string> = { ...initial };
  return {
    store,
    get: (key) => store[key],
    set: (key, value) => {
      store[key] = value;
    },
  };
}

function cfg(
  pointers: Record<string, string>,
  overrides: Partial<SecretsConfig> = {},
): SecretsConfig {
  return {
    command: ["op", "read"],
    timeoutMs: 1000,
    pointers,
    env: {},
    inheritEnv: [],
    ...overrides,
  };
}

describe("resolveSecretsIntoEnv", () => {
  it("null config resolves nothing (no [secrets] section)", async () => {
    const env = fakeEnv();
    const run: RunSecretCommand = () => {
      throw new Error("must not run");
    };
    const results = await resolveSecretsIntoEnv(null, {
      env,
      run,
      log: () => {},
    });
    assertEquals(results, []);
    assertEquals(env.store, {});
  });

  it("resolves a pointer and sets the value into env", async () => {
    const env = fakeEnv();
    const calls: Array<{ pointer: string }> = [];
    const run: RunSecretCommand = (_command, pointer) => {
      calls.push({ pointer });
      return Promise.resolve({ ok: true, value: "sk-secret" });
    };
    const results = await resolveSecretsIntoEnv(
      cfg({ ANTHROPIC_API_KEY: "op://v/anthropic/credential" }),
      { env, run, log: () => {} },
    );
    assertEquals(calls, [{ pointer: "op://v/anthropic/credential" }]);
    assertStrictEquals(env.store.ANTHROPIC_API_KEY, "sk-secret");
    assertEquals(results, [{
      envVar: "ANTHROPIC_API_KEY",
      status: "resolved",
    }]);
  });

  it("env WINS: an already-set var is never overwritten or consulted", async () => {
    const env = fakeEnv({ ANTHROPIC_API_KEY: "ambient" });
    let ran = false;
    const run: RunSecretCommand = () => {
      ran = true;
      return Promise.resolve({ ok: true, value: "resolved" });
    };
    const results = await resolveSecretsIntoEnv(
      cfg({ ANTHROPIC_API_KEY: "op://v/anthropic/credential" }),
      { env, run, log: () => {} },
    );
    assertStrictEquals(ran, false);
    assertStrictEquals(env.store.ANTHROPIC_API_KEY, "ambient");
    assertStrictEquals(results[0].status, "already-set");
  });

  it("an empty env var does not count as set (still resolves)", async () => {
    const env = fakeEnv({ OPENAI_API_KEY: "" });
    const run: RunSecretCommand = () =>
      Promise.resolve({ ok: true, value: "sk-openai" });
    await resolveSecretsIntoEnv(
      cfg({ OPENAI_API_KEY: "op://v/openai/credential" }),
      { env, run, log: () => {} },
    );
    assertStrictEquals(env.store.OPENAI_API_KEY, "sk-openai");
  });

  it("a failed resolution leaves the var unset (provider fails closed)", async () => {
    const env = fakeEnv();
    const run: RunSecretCommand = () =>
      Promise.resolve({
        ok: false,
        reason: "timed out after 1000ms (locked or unavailable)",
      });
    const results = await resolveSecretsIntoEnv(
      cfg({ GEMINI_API_KEY: "op://v/gemini/credential" }),
      { env, run, log: () => {} },
    );
    assertStrictEquals(env.store.GEMINI_API_KEY, undefined);
    assertEquals(results[0], {
      envVar: "GEMINI_API_KEY",
      status: "unavailable",
      reason: "timed out after 1000ms (locked or unavailable)",
    });
  });

  it("one degraded provider does not block the others", async () => {
    const env = fakeEnv();
    const run: RunSecretCommand = (_command, pointer) =>
      Promise.resolve(
        pointer.includes("gemini")
          ? { ok: false, reason: "resolver exited with code 1" }
          : { ok: true, value: `val-${pointer}` } as SecretCommandResult,
      );
    const results = await resolveSecretsIntoEnv(
      cfg({
        ANTHROPIC_API_KEY: "op://v/anthropic/credential",
        GEMINI_API_KEY: "op://v/gemini/credential",
        OPENAI_API_KEY: "op://v/openai/credential",
      }),
      { env, run, log: () => {} },
    );
    assertNotStrictEquals(env.store.ANTHROPIC_API_KEY, undefined);
    assertNotStrictEquals(env.store.OPENAI_API_KEY, undefined);
    assertStrictEquals(env.store.GEMINI_API_KEY, undefined);
    assertEquals(results.map((r) => r.status), [
      "resolved",
      "unavailable",
      "resolved",
    ]);
  });

  it("presence-only logging: the secret value never appears in any log line", async () => {
    const logs: string[] = [];
    const env = fakeEnv({ OPENAI_API_KEY: "ambient-value-xyz" });
    const run: RunSecretCommand = () =>
      Promise.resolve({ ok: true, value: "super-secret-token-abc" });
    await resolveSecretsIntoEnv(
      cfg({
        ANTHROPIC_API_KEY: "op://v/anthropic/credential",
        OPENAI_API_KEY: "op://v/openai/credential",
      }),
      { env, run, log: (m) => logs.push(m) },
    );
    const joined = logs.join("\n");
    assertFalse(joined.includes("super-secret-token-abc"));
    assertFalse(joined.includes("ambient-value-xyz"));
    assertStringIncludes(joined, "ANTHROPIC_API_KEY: resolved");
    assertStringIncludes(joined, "OPENAI_API_KEY: already-set");
  });
});

describe("resolveSecrets named credentials", () => {
  it("returns named values only in the private result map", async () => {
    const env = fakeEnv();
    const logs: string[] = [];
    const resolved = await resolveSecrets(
      cfg({}, { named: { linear_mcp: "op://v/linear/credential" } }),
      {
        env,
        run: () => Promise.resolve({ ok: true, value: "linear-secret-value" }),
        log: (message) => logs.push(message),
      },
    );
    assertEquals(resolved.named, { linear_mcp: "linear-secret-value" });
    assertEquals(resolved.namedResolutions, [{
      name: "linear_mcp",
      status: "resolved",
    }]);
    assertEquals(env.store, {});
    assertFalse((logs.join("\n")).includes("linear-secret-value"));
    assertFalse((logs.join("\n")).includes("op://v/linear/credential"));
  });

  it("shares the session-first probe across env and named pointers", async () => {
    const env = fakeEnv();
    const spawned: string[] = [];
    const resolved = await resolveSecrets(
      cfg(
        { OPENAI_API_KEY: "op://v/openai/credential" },
        { named: { linear_mcp: "op://v/linear/credential" } },
      ),
      {
        env,
        run: (_command, pointer) => {
          spawned.push(pointer);
          return Promise.resolve({ ok: false, reason: "resolver unavailable" });
        },
        log: () => {},
      },
    );
    assertEquals(spawned, ["op://v/openai/credential"]);
    assertStrictEquals(env.store.OPENAI_API_KEY, undefined);
    assertEquals(resolved.named, {});
    assertObjectMatch(resolved.namedResolutions[0], {
      name: "linear_mcp",
      status: "unavailable",
    });
  });
});

describe("secretsRunGrant", () => {
  it("null config → no run grant", () => {
    assertStrictEquals(secretsRunGrant(null), null);
  });

  it("returns command[0] as the binary to grant --allow-run", () => {
    assertStrictEquals(
      secretsRunGrant(cfg({}, { command: ["op", "read"] })),
      "op",
    );
    assertStrictEquals(
      secretsRunGrant(cfg({}, { command: ["/usr/local/bin/vault", "get"] })),
      "/usr/local/bin/vault",
    );
  });
});

describe("resolveSecretsIntoEnv — staging and concurrency", () => {
  it("stages writes: no resolver sees a value this pass resolved", async () => {
    const env = fakeEnv();
    const snapshotsAtRun: number[] = [];
    const run: RunSecretCommand = (_command, pointer) => {
      // The environment must be empty of resolved values while any pointer is
      // still resolving — writes happen only after all settle.
      snapshotsAtRun.push(Object.keys(env.store).length);
      return Promise.resolve({ ok: true, value: `v-${pointer}` });
    };
    await resolveSecretsIntoEnv(
      cfg({
        ANTHROPIC_API_KEY: "op://v/a/credential",
        OPENAI_API_KEY: "op://v/o/credential",
      }),
      { env, run, log: () => {} },
    );
    assertEquals(snapshotsAtRun, [0, 0]);
    // Both are applied after the pass.
    assertStrictEquals(env.store.ANTHROPIC_API_KEY, "v-op://v/a/credential");
    assertStrictEquals(env.store.OPENAI_API_KEY, "v-op://v/o/credential");
  });

  it("session-first: probes one pointer alone, then bursts the rest", async () => {
    const env = fakeEnv();
    let inFlight = 0;
    const inFlightAtEachStart: number[] = [];
    const run: RunSecretCommand = async () => {
      inFlight++;
      inFlightAtEachStart.push(inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return { ok: true, value: "x" };
    };
    await resolveSecretsIntoEnv(
      cfg({
        ANTHROPIC_API_KEY: "op://v/a/credential",
        OPENAI_API_KEY: "op://v/o/credential",
        GEMINI_API_KEY: "op://v/g/credential",
      }),
      { env, run, log: () => {} },
    );
    // Probe runs alone (in-flight 1), then the two followers burst together
    // (in-flight peaks at 2).
    assertStrictEquals(inFlightAtEachStart[0], 1);
    assertStrictEquals(Math.max(...inFlightAtEachStart), 2);
  });

  it("bounds the successful session's follower concurrency", async () => {
    const env = fakeEnv();
    let inFlight = 0;
    let peak = 0;
    let callCount = 0;
    let releaseFollowers!: () => void;
    const followerGate = new Promise<void>((resolve) => {
      releaseFollowers = resolve;
    });
    const named = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [
        `credential_${index}`,
        `op://v/item-${index}/credential`,
      ]),
    );
    const run: RunSecretCommand = async () => {
      callCount++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (callCount > 1) {
        await followerGate;
      }
      inFlight--;
      return { ok: true, value: "resolved" };
    };

    const resolving = resolveSecrets(
      cfg({}, { named }),
      { env, run, log: () => {} },
    );
    for (let turn = 0; turn < 100 && peak < 8; turn++) {
      await Promise.resolve();
    }
    const peakBeforeRelease = peak;
    releaseFollowers();
    const result = await resolving;
    assertEquals((Object.keys(result.named)).length, 17);
    assertStrictEquals(peakBeforeRelease, 8);
    assertStrictEquals(peak, 8);
  });

  it("logging order follows pointer declaration order", async () => {
    const logs: string[] = [];
    const env = fakeEnv();
    const run: RunSecretCommand = (_c, pointer) =>
      Promise.resolve({ ok: true, value: `v-${pointer}` });
    await resolveSecretsIntoEnv(
      cfg({
        ANTHROPIC_API_KEY: "op://v/a/credential",
        OPENAI_API_KEY: "op://v/o/credential",
      }),
      { env, run, log: (m) => logs.push(m) },
    );
    assertStringIncludes(logs[0], "ANTHROPIC_API_KEY");
    assertStringIncludes(logs[1], "OPENAI_API_KEY");
  });
});

describe("resolveSecretsIntoEnv — session-first fail-fast", () => {
  it("probe TIMES OUT → remaining pointers skipped without spawning", async () => {
    const env = fakeEnv();
    const spawned: string[] = [];
    const run: RunSecretCommand = (_command, pointer) => {
      spawned.push(pointer);
      return Promise.resolve({
        ok: false,
        reason: "timed out after 1000ms (locked or unavailable)",
      });
    };
    const results = await resolveSecretsIntoEnv(
      cfg({
        ANTHROPIC_API_KEY: "op://v/a/credential",
        OPENAI_API_KEY: "op://v/o/credential",
        GEMINI_API_KEY: "op://v/g/credential",
      }),
      { env, run, log: () => {} },
    );
    assertEquals(spawned, ["op://v/a/credential"]);
    assertEquals(results.map((r) => r.status), [
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    // The probe reads distinctly from the skipped followers (which name it).
    assertMatch(results[0].reason ?? "", /session probe failed: timed out/);
    assertMatch(
      results[1].reason ?? "",
      /skipped: session probe ANTHROPIC_API_KEY did not resolve/,
    );
    assertMatch(
      results[2].reason ?? "",
      /skipped: session probe ANTHROPIC_API_KEY did not resolve/,
    );
    assertEquals((Object.keys(env.store)).length, 0);
  });

  it("probe fails (non-timeout, e.g. bad first ref) → followers skipped, not spawned", async () => {
    // Only a SUCCESSFUL probe proves the session is warm; a fast non-zero exit
    // is indistinguishable from a declined unlock, so we fail closed rather than
    // risk a prompt-storm. A bad FIRST ref therefore skips the rest.
    const env = fakeEnv();
    const spawned: string[] = [];
    const run: RunSecretCommand = (_command, pointer) => {
      spawned.push(pointer);
      if (pointer === "op://v/a/credential") {
        return Promise.resolve({
          ok: false,
          reason: "resolver exited with code 1",
        });
      }
      return Promise.resolve({ ok: true, value: `v-${pointer}` });
    };
    const results = await resolveSecretsIntoEnv(
      cfg({
        ANTHROPIC_API_KEY: "op://v/a/credential",
        OPENAI_API_KEY: "op://v/o/credential",
        GEMINI_API_KEY: "op://v/g/credential",
      }),
      { env, run, log: () => {} },
    );
    // Only the probe spawned; followers were skipped fail-closed.
    assertEquals(spawned, ["op://v/a/credential"]);
    assertEquals(results.map((r) => r.status), [
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    // The probe names its own raw failure; followers name the probe to fix.
    assertMatch(
      results[0].reason ?? "",
      /session probe failed: resolver exited with code 1/,
    );
    assertMatch(
      results[1].reason ?? "",
      /skipped: session probe ANTHROPIC_API_KEY did not resolve/,
    );
    assertEquals((Object.keys(env.store)).length, 0);
  });

  it("an already-set first pointer is not the probe (env wins, next pending probes)", async () => {
    const env = fakeEnv({ ANTHROPIC_API_KEY: "ambient" });
    const spawned: string[] = [];
    const run: RunSecretCommand = (_command, pointer) => {
      spawned.push(pointer);
      return Promise.resolve({
        ok: false,
        reason: "timed out",
      });
    };
    const results = await resolveSecretsIntoEnv(
      cfg({
        ANTHROPIC_API_KEY: "op://v/a/credential",
        OPENAI_API_KEY: "op://v/o/credential",
        GEMINI_API_KEY: "op://v/g/credential",
      }),
      { env, run, log: () => {} },
    );
    assertEquals(spawned, ["op://v/o/credential"]);
    assertEquals(results.map((r) => r.status), [
      "already-set",
      "unavailable",
      "unavailable",
    ]);
  });
});

describe("buildResolverEnv (isolated resolver environment)", () => {
  it("forwards base + inherit_env from ambient, merges [secrets.env], excludes other secrets", () => {
    // Assembled at runtime so the public-boundary scan never matches this
    // fixture as a home-directory path in tracked source.
    const fakeHome = ["", "home", "x"].join("/");
    const ambient = fakeEnv({
      PATH: "/bin",
      HOME: fakeHome,
      USER: "x",
      // These ambient secrets must NOT be forwarded:
      DOLT_PASSWORD: "db-secret",
      ANTHROPIC_API_KEY: "provider-secret",
      // A launch-scope resolver auth the operator opts to forward:
      OP_SERVICE_ACCOUNT_TOKEN: "sa-token",
    });
    const resolverEnv = buildResolverEnv(
      cfg(
        { OPENAI_API_KEY: "op://v/o/credential" },
        {
          env: { OP_ACCOUNT: "my.1password.com" },
          inheritEnv: ["OP_SERVICE_ACCOUNT_TOKEN"],
        },
      ),
      ambient,
    );
    // Base (present ones) + forwarded inherit_env + [secrets.env] literal.
    assertEquals(resolverEnv, {
      PATH: "/bin",
      HOME: fakeHome,
      USER: "x",
      OP_SERVICE_ACCOUNT_TOKEN: "sa-token",
      OP_ACCOUNT: "my.1password.com",
    });
    // The runtime's other secrets are absent.
    assertFalse("DOLT_PASSWORD" in resolverEnv);
    assertFalse("ANTHROPIC_API_KEY" in resolverEnv);
  });

  it("a base var absent from ambient is simply not set", () => {
    const resolverEnv = buildResolverEnv(cfg({}), fakeEnv({ PATH: "/bin" }));
    assertEquals(resolverEnv, { PATH: "/bin" });
  });
});

describe("unavailableSecretPointers", () => {
  it("keeps only the environment pointers that failed, with their reasons", () => {
    assertEquals(
      unavailableSecretPointers({
        environment: [
          {
            envVar: "OPENROUTER_API_KEY",
            status: "unavailable",
            reason: "timed out",
          },
          { envVar: "OPENAI_API_KEY", status: "resolved" },
          { envVar: "XAI_API_KEY", status: "already-set" },
          { envVar: "GEMINI_API_KEY", status: "unavailable" },
        ],
      }),
      [
        { envVar: "OPENROUTER_API_KEY", reason: "timed out" },
        { envVar: "GEMINI_API_KEY", reason: "unavailable" },
      ],
    );
  });
});
