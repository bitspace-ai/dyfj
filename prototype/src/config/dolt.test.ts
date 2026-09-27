import { assertEquals } from "@std/assert";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { resolveDoltConnection } from "./dolt.ts";

Deno.test("resolveDoltConnection reads Dolt connection settings from the env", () => {
  assertEquals(
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

Deno.test("resolveDoltConnection defaults the password to empty, never a dev password", () => {
  assertEquals(resolveDoltConnection(new MapEnv()), {
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    password: "",
    database: "dolt",
  });
});
