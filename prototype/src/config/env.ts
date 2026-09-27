/**
 * The `Env` port: the one way runtime code reads (and, for boot-time secret
 * resolution, writes) process environment variables.
 *
 * `processEnv` is the real adapter over `Deno.env`, and this module is the only
 * runtime module that touches `Deno.env` or `process.env`; the `arch.imports`
 * lane enforces that. Code that needs a variable takes an `Env` (tests pass the
 * `MapEnv` fake from `testing/fakes/`) and defaults to `processEnv` until its
 * composition root threads one in. Every `DYFJ_*` key read through it is
 * declared in `CONFIG_SCHEMA` (`schema.ts`).
 *
 * Semantics are exactly `Deno.env`'s: an unset variable reads as `undefined`,
 * an empty one as `""`, and a read or write the process is not granted throws
 * `Deno.errors.NotCapable`.
 */

/** Read access to environment variables. */
export interface Env {
  get(name: string): string | undefined;
}

/** Read and write access, used only where the process environment is set. */
export interface MutableEnv extends Env {
  set(name: string, value: string): void;
}

/** The real adapter: the process environment. */
export const processEnv: MutableEnv = {
  get: (name) => Deno.env.get(name),
  set: (name, value) => Deno.env.set(name, value),
};
