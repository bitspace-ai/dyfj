import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composeRuntimePolicy,
  type DoltConnectionConfig,
  EgressRefusedError,
} from "../config/mod.ts";
import { createDoltPool } from "./dolt-pool.ts";

const configured: DoltConnectionConfig = {
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "",
  database: "dolt",
};
const policy = composeRuntimePolicy({ dolt: configured });

test("the Dolt pool refuses a host that is not the configured endpoint", () => {
  assert.throws(
    () => createDoltPool({ ...configured, host: "db.example.test" }, policy),
    (error: unknown) =>
      error instanceof EgressRefusedError &&
      /"db\.example\.test:3306"/.test(error.message) &&
      /DOLT_HOST/.test(error.message),
  );
});

test("the Dolt pool refuses a port that is not the configured endpoint", () => {
  assert.throws(
    () => createDoltPool({ ...configured, port: 3307 }, policy),
    EgressRefusedError,
  );
});

test("the Dolt pool accepts the configured endpoint without connecting", async () => {
  const pool = createDoltPool(configured, policy);
  await pool.end();
});
