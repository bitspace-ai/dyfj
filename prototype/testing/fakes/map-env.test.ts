import assert from "node:assert/strict";
import { MapEnv } from "./map-env.ts";

Deno.test("MapEnv reads only its own values", () => {
  const env = new MapEnv({ DYFJ_EXAMPLE: "value" });
  assert.deepStrictEqual(env.get("DYFJ_EXAMPLE"), "value");
  assert.deepStrictEqual(env.get("PATH"), undefined);
  assert.deepStrictEqual(env.has("DYFJ_EXAMPLE"), true);
  assert.deepStrictEqual(env.has("PATH"), false);
});

Deno.test("MapEnv set and delete change only the map", () => {
  const initial = { A: "1" };
  const env = new MapEnv(initial);
  env.set("B", "2");
  env.set("A", "3");
  env.delete("B");
  assert.deepStrictEqual(env.toObject(), { A: "3" });
  assert.deepStrictEqual(initial, { A: "1" });
});

Deno.test("MapEnv satisfies the Deno.env get subset", () => {
  const read = (source: { get(name: string): string | undefined }) =>
    source.get("X");
  assert.deepStrictEqual(read(new MapEnv({ X: "y" })), "y");
});
