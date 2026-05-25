import { describe, expect, test } from "vitest";
import { buildDoltPoolOptions } from "./dolt-config";

describe("MCP Dolt pool config", () => {
  test("reads credentials from environment", () => {
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

  test("defaults password to empty rather than the local dev password", () => {
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
