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

/** The Dolt server's address: all the runtime policy needs. */
export type DoltEndpoint = Pick<DoltConnectionConfig, "host" | "port">;

/**
 * `DOLT_HOST` and `DOLT_PORT`, with the local sql-server defaults. Holds no
 * credential, so it can be read before secret pointers resolve.
 */
export function resolveDoltEndpoint(env: Env): DoltEndpoint {
  return {
    host: env.get("DOLT_HOST") ?? "127.0.0.1",
    port: Number(env.get("DOLT_PORT") ?? "3306"),
  };
}

/**
 * `DOLT_*` keys, with the local sql-server defaults. `DOLT_PASSWORD` may come
 * from a secret pointer, so the runtime reads this only after its pointers
 * resolve.
 */
export function resolveDoltConnection(env: Env): DoltConnectionConfig {
  return {
    ...resolveDoltEndpoint(env),
    user: env.get("DOLT_USER") ?? "root",
    password: env.get("DOLT_PASSWORD") ?? "",
    database: env.get("DOLT_DATABASE") ?? "dolt",
  };
}
