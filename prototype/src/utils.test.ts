import { describe, expect, test } from "vitest";
import { buildDoltPoolOptions } from "./utils.ts";

describe("buildDoltPoolOptions", () => {
  test("reads Dolt connection settings from environment", () => {
    const options = buildDoltPoolOptions({
      DOLT_HOST: "localhost",
      DOLT_PORT: "3316",
      DOLT_USER: "dyfj",
      DOLT_PASSWORD: "secret",
      DOLT_DATABASE: "dyfjdb",
    });

    expect(options).toMatchObject({
      host: "localhost",
      port: 3316,
      user: "dyfj",
      password: "secret",
      database: "dyfjdb",
    });
  });

  test("does not hardcode the local Dolt password", () => {
    const options = buildDoltPoolOptions({});

    expect(options).toMatchObject({
      host: "127.0.0.1",
      port: 3306,
      user: "root",
      password: "",
      database: "dolt",
    });
  });
});
