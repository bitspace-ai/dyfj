import { describe, expect, test } from "vitest";
import {
  buildDoltPoolOptions,
  generateSpanId,
  generateTraceId,
  generateULID,
} from "./utils.ts";

test("generateULID returns a valid ULID", () => {
  const id = generateULID();
  expect(typeof id).toBe("string");
  expect(id.length).toBe(26); // ULID length
  // Basic check for ULID structure (alphanumeric, base32)
  expect(id).toMatch(/^[0-9A-Z]{26}$/);

  const anotherId = generateULID();
  expect(id).not.toBe(anotherId);
});

test("generateTraceId returns a 32-char hex string", () => {
  const id = generateTraceId();
  expect(typeof id).toBe("string");
  expect(id.length).toBe(32);
  expect(id).toMatch(/^[0-9a-f]{32}$/); // Hexadecimal characters
});

test("generateSpanId returns a 16-char hex string", () => {
  const id = generateSpanId();
  expect(typeof id).toBe("string");
  expect(id.length).toBe(16);
  expect(id).toMatch(/^[0-9a-f]{16}$/); // Hexadecimal characters
});

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
