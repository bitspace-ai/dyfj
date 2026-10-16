import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRuntimeArgs, readLauncherNetworkAllow } from "./grants.ts";

test("the runtime runs its server entry as plain node", () => {
  assert.deepStrictEqual(buildRuntimeArgs(), ["src/server/main.ts"]);
  assert.ok(!buildRuntimeArgs(true).some((arg) => arg.startsWith("--permission")));
});

test("only an autostarted runtime is marked", () => {
  assert.deepStrictEqual(buildRuntimeArgs(true).slice(-2), [
    "src/server/main.ts",
    "--autostarted",
  ]);
});

test("no flag of the replaced runtime reaches the runtime", () => {
  for (const arg of buildRuntimeArgs(true)) {
    assert.ok(
      !/^(run|-P=|--allow-(run|env)=|--no-prompt)/.test(arg) &&
        !arg.includes("unix:"),
      arg,
    );
  }
});

test("the launcher reads [network] allow from the child-visible config", async () => {
  const allow = await readLauncherNetworkAllow(
    "/proto",
    (path) =>
      path === "/proto/.env"
        ? Promise.reject(Object.assign(new Error("x"), { code: "ENOENT" }))
        : Promise.resolve("toml"),
    { get: (name) => (name === "DYFJ_ROOT" ? "/cfg" : undefined) },
    () => ({ network: { allow: ["LOCALHOST:1234"] } }),
  );
  assert.deepStrictEqual(allow, ["localhost:1234"]);
});
