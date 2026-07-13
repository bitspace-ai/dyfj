import { describe, expect, test } from "vitest";
import {
  buildResolverEnv,
  resolveSecretsIntoEnv,
  type RunSecretCommand,
  runSecretCommand,
  type SecretCommandResult,
  type SecretsEnv,
  secretsRunGrant,
} from "./secrets";
import type { SecretsConfig } from "./config";

/** A mutable in-memory env matching the resolver's read/write surface. */
function fakeEnv(initial: Record<string, string> = {}): SecretsEnv & {
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

/** A real PATH so a `clearEnv` child can still find external binaries. */
const PATH_ENV = { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" };

describe("resolveSecretsIntoEnv", () => {
  test("null config resolves nothing (no [secrets] section)", async () => {
    const env = fakeEnv();
    const run: RunSecretCommand = () => {
      throw new Error("must not run");
    };
    const results = await resolveSecretsIntoEnv(null, {
      env,
      run,
      log: () => {},
    });
    expect(results).toEqual([]);
    expect(env.store).toEqual({});
  });

  test("resolves a pointer and sets the value into env", async () => {
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
    expect(calls).toEqual([{ pointer: "op://v/anthropic/credential" }]);
    expect(env.store.ANTHROPIC_API_KEY).toBe("sk-secret");
    expect(results).toEqual([{
      envVar: "ANTHROPIC_API_KEY",
      status: "resolved",
    }]);
  });

  test("env WINS: an already-set var is never overwritten or consulted", async () => {
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
    expect(ran).toBe(false);
    expect(env.store.ANTHROPIC_API_KEY).toBe("ambient");
    expect(results[0].status).toBe("already-set");
  });

  test("an empty env var does not count as set (still resolves)", async () => {
    const env = fakeEnv({ OPENAI_API_KEY: "" });
    const run: RunSecretCommand = () =>
      Promise.resolve({ ok: true, value: "sk-openai" });
    await resolveSecretsIntoEnv(
      cfg({ OPENAI_API_KEY: "op://v/openai/credential" }),
      { env, run, log: () => {} },
    );
    expect(env.store.OPENAI_API_KEY).toBe("sk-openai");
  });

  test("a failed resolution leaves the var unset (provider fails closed)", async () => {
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
    expect(env.store.GEMINI_API_KEY).toBeUndefined();
    expect(results[0]).toEqual({
      envVar: "GEMINI_API_KEY",
      status: "unavailable",
      reason: "timed out after 1000ms (locked or unavailable)",
    });
  });

  test("one degraded provider does not block the others", async () => {
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
    expect(env.store.ANTHROPIC_API_KEY).toBeDefined();
    expect(env.store.OPENAI_API_KEY).toBeDefined();
    expect(env.store.GEMINI_API_KEY).toBeUndefined();
    expect(results.map((r) => r.status)).toEqual([
      "resolved",
      "unavailable",
      "resolved",
    ]);
  });

  test("presence-only logging: the secret value never appears in any log line", async () => {
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
    expect(joined).not.toContain("super-secret-token-abc");
    expect(joined).not.toContain("ambient-value-xyz");
    expect(joined).toContain("ANTHROPIC_API_KEY: resolved");
    expect(joined).toContain("OPENAI_API_KEY: already-set");
  });
});

describe("secretsRunGrant", () => {
  test("null config → no run grant", () => {
    expect(secretsRunGrant(null)).toBeNull();
  });

  test("returns command[0] as the binary to grant --allow-run", () => {
    expect(secretsRunGrant(cfg({}, { command: ["op", "read"] }))).toBe("op");
    expect(
      secretsRunGrant(cfg({}, { command: ["/usr/local/bin/vault", "get"] })),
    ).toBe("/usr/local/bin/vault");
  });
});

describe("resolveSecretsIntoEnv — staging and concurrency", () => {
  test("stages writes: no resolver sees a value this pass resolved", async () => {
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
    expect(snapshotsAtRun).toEqual([0, 0]);
    // Both are applied after the pass.
    expect(env.store.ANTHROPIC_API_KEY).toBe("v-op://v/a/credential");
    expect(env.store.OPENAI_API_KEY).toBe("v-op://v/o/credential");
  });

  test("session-first: probes one pointer alone, then bursts the rest", async () => {
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
    expect(inFlightAtEachStart[0]).toBe(1);
    expect(Math.max(...inFlightAtEachStart)).toBe(2);
  });

  test("logging order follows pointer declaration order", async () => {
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
    expect(logs[0]).toContain("ANTHROPIC_API_KEY");
    expect(logs[1]).toContain("OPENAI_API_KEY");
  });
});

describe("runSecretCommand (real subprocess)", () => {
  test("a spawn failure reason leaks neither the resolver path nor the pointer", async () => {
    const privatePath = "/Users/private-user/secret-vault-tool/op";
    const pointer = "op://PrivateVault/SecretItem/credential";
    const res = await runSecretCommand([privatePath, "read"], pointer, 2000);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(
      "cannot run the resolver command (not found or not permitted)",
    );
    // The operator-private path and the pointer must not appear in the reason.
    expect(res.reason).not.toContain("private-user");
    expect(res.reason).not.toContain("secret-vault-tool");
    expect(res.reason).not.toContain("PrivateVault");
    expect(res.reason).not.toContain(pointer);
  });

  test("times out without hanging on a slow resolver", async () => {
    const res = await runSecretCommand(
      ["bash", "-c", "sleep 5; printf LEAK"],
      "op://v/x/credential",
      150,
      PATH_ENV,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/timed out/);
  });

  test("returns the trimmed stdout on a clean exit", async () => {
    const res = await runSecretCommand(
      ["bash", "-c", "printf 'resolved-value\n'"],
      "op://v/x/credential",
      2000,
      PATH_ENV,
    );
    expect(res).toEqual({ ok: true, value: "resolved-value" });
  });

  test("treats empty stdout as unavailable", async () => {
    const res = await runSecretCommand(
      ["bash", "-c", "true"],
      "op://v/x/credential",
      2000,
      PATH_ENV,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/empty/);
  });

  test("reports the exit code on a non-zero exit (no captured output)", async () => {
    const res = await runSecretCommand(
      ["bash", "-c", "printf SHOULD_NOT_LEAK >&2; exit 4"],
      "op://v/x/credential",
      2000,
      PATH_ENV,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("resolver exited with code 4");
    expect(res.reason).not.toContain("SHOULD_NOT_LEAK");
  });

  test("clearEnv isolates the child: an ambient var NOT in the passed env is absent", async () => {
    // Prove the resolver child does not inherit an ambient secret. bash echoes
    // $LEAKY_AMBIENT; the child is spawned clearEnv with only PATH, so it prints
    // the empty marker even though the parent process has the var set.
    Deno.env.set("LEAKY_AMBIENT", "super-secret");
    try {
      const res = await runSecretCommand(
        ["bash", "-c", 'printf "[%s]" "${LEAKY_AMBIENT-}"'],
        "op://v/x/credential",
        2000,
        PATH_ENV,
      );
      expect(res).toEqual({ ok: true, value: "[]" });
    } finally {
      Deno.env.delete("LEAKY_AMBIENT");
    }
  });
});

describe("resolveSecretsIntoEnv — session-first fail-fast", () => {
  test("probe TIMES OUT → remaining pointers skipped without spawning", async () => {
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
    expect(spawned).toEqual(["op://v/a/credential"]);
    expect(results.map((r) => r.status)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    // The probe reads distinctly from the skipped followers (which name it).
    expect(results[0].reason).toMatch(/session probe failed: timed out/);
    expect(results[1].reason).toMatch(
      /skipped: session probe ANTHROPIC_API_KEY did not resolve/,
    );
    expect(results[2].reason).toMatch(
      /skipped: session probe ANTHROPIC_API_KEY did not resolve/,
    );
    expect(Object.keys(env.store)).toHaveLength(0);
  });

  test("probe fails (non-timeout, e.g. bad first ref) → followers skipped, not spawned", async () => {
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
    expect(spawned).toEqual(["op://v/a/credential"]);
    expect(results.map((r) => r.status)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    // The probe names its own raw failure; followers name the probe to fix.
    expect(results[0].reason).toMatch(
      /session probe failed: resolver exited with code 1/,
    );
    expect(results[1].reason).toMatch(
      /skipped: session probe ANTHROPIC_API_KEY did not resolve/,
    );
    expect(Object.keys(env.store)).toHaveLength(0);
  });

  test("an already-set first pointer is not the probe (env wins, next pending probes)", async () => {
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
    expect(spawned).toEqual(["op://v/o/credential"]);
    expect(results.map((r) => r.status)).toEqual([
      "already-set",
      "unavailable",
      "unavailable",
    ]);
  });
});

describe("runSecretCommand — env passthrough", () => {
  test("sets the passed env vars on the spawned resolver command", async () => {
    const res = await runSecretCommand(
      ["bash", "-c", 'printf %s "$RESOLVER_MARKER"'],
      "op://v/x/credential",
      2000,
      { ...PATH_ENV, RESOLVER_MARKER: "from-secrets-env" },
    );
    expect(res).toEqual({ ok: true, value: "from-secrets-env" });
  });
});

describe("buildResolverEnv (isolated resolver environment)", () => {
  test("forwards base + inherit_env from ambient, merges [secrets.env], excludes other secrets", () => {
    const ambient = fakeEnv({
      PATH: "/bin",
      HOME: "/home/x",
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
    expect(resolverEnv).toEqual({
      PATH: "/bin",
      HOME: "/home/x",
      USER: "x",
      OP_SERVICE_ACCOUNT_TOKEN: "sa-token",
      OP_ACCOUNT: "my.1password.com",
    });
    // The runtime's other secrets are absent.
    expect(resolverEnv).not.toHaveProperty("DOLT_PASSWORD");
    expect(resolverEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  test("a base var absent from ambient is simply not set", () => {
    const resolverEnv = buildResolverEnv(cfg({}), fakeEnv({ PATH: "/bin" }));
    expect(resolverEnv).toEqual({ PATH: "/bin" });
  });
});
