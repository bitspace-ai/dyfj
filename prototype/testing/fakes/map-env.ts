// Test fake for the `Env` port: an in-memory variable map.
//
// Structurally compatible with the `{ get(name) }` subset of `Deno.env` that
// runtime code accepts, so it can be passed wherever `Deno.env` is the
// default. It never reads or writes the process environment.

export class MapEnv {
  readonly #values: Map<string, string>;

  constructor(values: Readonly<Record<string, string>> = {}) {
    this.#values = new Map(Object.entries(values));
  }

  get(name: string): string | undefined {
    return this.#values.get(name);
  }

  set(name: string, value: string): void {
    this.#values.set(name, value);
  }

  delete(name: string): void {
    this.#values.delete(name);
  }

  has(name: string): boolean {
    return this.#values.has(name);
  }

  toObject(): Record<string, string> {
    return Object.fromEntries(this.#values);
  }
}
