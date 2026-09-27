import type { Env } from "./env.ts";

/**
 * Where the Dolt SQL server is. Read once, through the `Env` port, by the
 * composition root that builds the store; the store never reads the
 * environment itself.
 */
export interface DoltConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** `DOLT_*` keys, with the local sql-server defaults. */
export function resolveDoltConnection(env: Env): DoltConnectionConfig {
  return {
    host: env.get("DOLT_HOST") ?? "127.0.0.1",
    port: Number(env.get("DOLT_PORT") ?? "3306"),
    user: env.get("DOLT_USER") ?? "root",
    password: env.get("DOLT_PASSWORD") ?? "",
    database: env.get("DOLT_DATABASE") ?? "dolt",
  };
}
