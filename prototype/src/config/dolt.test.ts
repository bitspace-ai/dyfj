import assert from "node:assert/strict";
import { test } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { resolveDoltConnection } from "./dolt.ts";

test("resolveDoltConnection reads Dolt connection settings from the env", () => {
  assert.deepStrictEqual(
    resolveDoltConnection(
      new MapEnv({
        DOLT_HOST: "localhost",
        DOLT_PORT: "3316",
        DOLT_USER: "dyfj",
        DOLT_PASSWORD: "secret",
        DOLT_DATABASE: "dyfjdb",
      }),
    ),
    {
      host: "localhost",
      port: 3316,
      user: "dyfj",
      password: "secret",
      database: "dyfjdb",
    },
  );
});

test("resolveDoltConnection defaults the password to empty, never a dev password", () => {
  assert.deepStrictEqual(resolveDoltConnection(new MapEnv()), {
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    password: "",
    database: "dolt",
  });
});
