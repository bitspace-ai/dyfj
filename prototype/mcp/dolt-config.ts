import { type Env, processEnv } from "../src/config/mod.ts";

export type SqlParam = string | number | boolean | null;

export function buildDoltPoolOptions(env: Record<string, string | undefined> = readDoltEnv(processEnv)) {
  return {
    host: env.DOLT_HOST ?? "127.0.0.1",
    port: Number(env.DOLT_PORT ?? "3306"),
    user: env.DOLT_USER ?? "root",
    password: env.DOLT_PASSWORD ?? "",
    database: env.DOLT_DATABASE ?? "dolt",
    waitForConnections: true,
    connectionLimit: 5,
  };
}

function readDoltEnv(env: Env): Record<string, string | undefined> {
  return {
    DOLT_HOST: env.get("DOLT_HOST"),
    DOLT_PORT: env.get("DOLT_PORT"),
    DOLT_USER: env.get("DOLT_USER"),
    DOLT_PASSWORD: env.get("DOLT_PASSWORD"),
    DOLT_DATABASE: env.get("DOLT_DATABASE"),
  };
}
