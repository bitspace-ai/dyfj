import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composeRuntimePolicy,
  SERVE_UNIX_ENV_GRANTS,
} from "../../config/mod.ts";
import { buildRuntimeArgs, readLauncherNetworkAllow } from "./grants.ts";

function flag(args: string[], name: string): string[] | undefined {
  const value = args.find((arg) => arg.startsWith(`${name}=`));
  return value?.slice(name.length + 1).split(",");
}

test("the runtime's permission flags are its composed policy", () => {
  const policy = composeRuntimePolicy({
    networkAllow: ["127.0.0.1:1234"],
    nameserverGrants: ["192.0.2.53:53"],
    secrets: {
      command: ["/opt/bin/op"],
      inheritEnv: ["OP_SERVICE_ACCOUNT_TOKEN"],
    } as never,
    runtimeExecutable: null,
  });
  const args = buildRuntimeArgs(policy, "/run/wb.sock");
  assert.deepStrictEqual(flag(args, "--allow-net"), [
    ...policy.net,
    "unix:/run/wb.sock",
  ]);
  assert.ok(flag(args, "--allow-net")?.includes("127.0.0.1:1234"));
  assert.deepStrictEqual(flag(args, "--allow-run"), [...policy.run]);
  assert.deepStrictEqual(flag(args, "--allow-env"), [...policy.env]);
});

test("the profile's env grant applies when no inherit_env name is added", () => {
  const policy = composeRuntimePolicy({ runtimeExecutable: null });
  assert.strictEqual(policy.env.length, SERVE_UNIX_ENV_GRANTS.length);
  assert.strictEqual(
    flag(buildRuntimeArgs(policy, "/run/wb.sock"), "--allow-env"),
    undefined,
  );
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
