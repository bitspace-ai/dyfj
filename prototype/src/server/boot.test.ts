import assert from "node:assert/strict";
import { test } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import type { RunSecretCommand, SecretsConfig } from "../config/mod.ts";
import { composeBoot } from "./boot.ts";

// Fake pointers and values only; no real resolver runs.
const DOLT_POINTER = "fake://vault/dolt/password";
const POINTER_VALUE = "fake-value-from-pointer";

function secretsConfig(pointers: Record<string, string>): SecretsConfig {
  return {
    command: ["fake-resolver", "read"],
    timeoutMs: 1000,
    pointers,
    env: {},
    inheritEnv: [],
  };
}

function fakeResolver(values: Record<string, string>) {
  const asked: string[] = [];
  const run: RunSecretCommand = (_command, pointer) => {
    asked.push(pointer);
    const value = values[pointer];
    return Promise.resolve(
      value === undefined
        ? { ok: false, reason: "no such fake pointer" }
        : { ok: true, value },
    );
  };
  return { run, asked };
}

async function boot(env: MapEnv, pointers: Record<string, string>) {
  const resolver = fakeResolver({ [DOLT_POINTER]: POINTER_VALUE });
  const log: string[] = [];
  const result = await composeBoot({
    env,
    mcpServers: [],
    secrets: secretsConfig(pointers),
    networkAllow: [],
    nameserverGrants: [],
    runSecretCommand: resolver.run,
    log: (line) => log.push(line),
  });
  return { ...result, log, asked: resolver.asked };
}

test("the Dolt pool gets DOLT_PASSWORD resolved from its pointer when the env has none", async () => {
  const { doltConnection, log } = await boot(new MapEnv(), {
    DOLT_PASSWORD: DOLT_POINTER,
  });

  assert.equal(doltConnection.password, POINTER_VALUE);
  assert.ok(log.includes("secret DOLT_PASSWORD: resolved"));
  assert.ok(!log.some((line) => line.includes(POINTER_VALUE)));
});

test("a DOLT_PASSWORD already in the env wins over its pointer", async () => {
  const { doltConnection, log, asked } = await boot(
    new MapEnv({ DOLT_PASSWORD: "fake-value-from-env" }),
    { DOLT_PASSWORD: DOLT_POINTER },
  );

  assert.equal(doltConnection.password, "fake-value-from-env");
  assert.deepEqual(asked, []);
  assert.ok(
    log.includes(
      "secret DOLT_PASSWORD: already-set (env wins; pointer not consulted)",
    ),
  );
});

test("the policy allows exactly the endpoint the Dolt pool connects to", async () => {
  const { policy, doltConnection } = await boot(
    new MapEnv({ DOLT_HOST: "db.internal", DOLT_PORT: "3316" }),
    { DOLT_PASSWORD: DOLT_POINTER },
  );

  assert.equal(policy.dolt, "db.internal:3316");
  assert.equal(doltConnection.host, "db.internal");
  assert.equal(doltConnection.port, 3316);
  assert.equal(doltConnection.password, POINTER_VALUE);
});

test("the policy grants the resolver command before any pointer resolves", async () => {
  let policyAtSpawn: unknown;
  const env = new MapEnv();
  const { policy } = await composeBoot({
    env,
    mcpServers: [],
    secrets: secretsConfig({ DOLT_PASSWORD: DOLT_POINTER }),
    networkAllow: [],
    nameserverGrants: [],
    runSecretCommand: (_command, _pointer, _timeout, _env, policy) => {
      policyAtSpawn = policy;
      return Promise.resolve({ ok: true, value: POINTER_VALUE });
    },
    log: () => {},
  });

  assert.equal(policyAtSpawn, policy);
});
