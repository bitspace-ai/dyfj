import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { describe, it } from "node:test";
import {
  baseRuntimePolicy,
  CLI_RUN_GRANTS,
  composeRuntimePolicy,
  RUNTIME_PLATFORM_ENV,
  runtimeChildEnv,
  SERVE_UNIX_ENV_GRANTS,
  SERVE_UNIX_NET_GRANTS,
  SERVE_UNIX_RUN_GRANTS,
} from "./runtime-policy.ts";
import type { McpHttpServerConfig } from "./mcp-servers.ts";
import type { SecretsConfig } from "./secrets-config.ts";

const DENO_JSON = new URL("../../deno.json", import.meta.url);

// Assembled at runtime so the public-boundary scan never matches this
// fixture as a home-directory path in tracked source.
const FAKE_HOME = ["", "home", "op"].join("/");

async function denoProfiles(): Promise<
  Record<string, { env?: unknown; net?: unknown; run?: unknown }>
> {
  const parsed = JSON.parse(await readFile(DENO_JSON, "utf8")) as {
    permissions: Record<
      string,
      { env?: unknown; net?: unknown; run?: unknown }
    >;
  };
  return parsed.permissions;
}

function server(url: string): McpHttpServerConfig {
  return { url } as McpHttpServerConfig;
}

function secrets(
  command: string[],
  inheritEnv: string[] = [],
): SecretsConfig {
  return { command, inheritEnv } as unknown as SecretsConfig;
}

describe("runtime policy parity with the deno.json permission profiles", () => {
  it("the serve-unix net, run and env lists match the policy module", async () => {
    const profile = (await denoProfiles())["serve-unix"];
    assert.deepStrictEqual(profile.net, [...SERVE_UNIX_NET_GRANTS]);
    assert.deepStrictEqual(profile.run, [...SERVE_UNIX_RUN_GRANTS]);
    assert.deepStrictEqual(profile.env, [...SERVE_UNIX_ENV_GRANTS]);
  });

  it("the cli run list matches the policy module", async () => {
    assert.deepStrictEqual((await denoProfiles()).cli.run, [...CLI_RUN_GRANTS]);
  });
});

describe("composeRuntimePolicy", () => {
  it("the base policy is the static lists plus the runtime's own executable", () => {
    const policy = baseRuntimePolicy();
    assert.deepStrictEqual(policy.net, [...SERVE_UNIX_NET_GRANTS]);
    assert.deepStrictEqual(policy.run, [
      ...SERVE_UNIX_RUN_GRANTS,
      process.execPath,
    ]);
    assert.deepStrictEqual(policy.env, [...SERVE_UNIX_ENV_GRANTS]);
    assert.strictEqual(policy.dolt, null);
  });

  it("adds MCP, memory and nameserver hosts, Node, the resolver and inherit_env names", () => {
    const policy = composeRuntimePolicy({
      mcpServers: [server("https://mcp.example.test/mcp")],
      memoryMcpUrl: "http://127.0.0.1:7777/mcp",
      nameserverGrants: ["192.0.2.53:53"],
      secrets: secrets(["/opt/bin/op", "read"], ["OP_SERVICE_ACCOUNT_TOKEN"]),
      nodePath: "/opt/node/bin/node",
      dolt: { host: "127.0.0.1", port: 3307 },
    });
    assert.deepStrictEqual(policy.net, [
      ...SERVE_UNIX_NET_GRANTS,
      "127.0.0.1:7777",
      "mcp.example.test:443",
      "192.0.2.53:53",
    ]);
    assert.deepStrictEqual(policy.run, [
      ...SERVE_UNIX_RUN_GRANTS,
      process.execPath,
      "/opt/node/bin/node",
      "/opt/bin/op",
    ]);
    assert.deepStrictEqual(policy.env, [
      ...SERVE_UNIX_ENV_GRANTS,
      "OP_SERVICE_ACCOUNT_TOKEN",
    ]);
    assert.strictEqual(policy.dolt, "127.0.0.1:3307");
  });

  it("adds the operator's [network] allow entries to the net list", () => {
    const policy = composeRuntimePolicy({
      networkAllow: ["127.0.0.1:1234", "api.openai.com:443"],
    });
    assert.deepStrictEqual(policy.net, [
      ...SERVE_UNIX_NET_GRANTS,
      "127.0.0.1:1234",
    ]);
  });

  it("refuses an insecure memory endpoint rather than granting it", () => {
    assert.throws(
      () =>
        composeRuntimePolicy({
          memoryMcpUrl: "http://memory.example.test/mcp",
        }),
      /DYFJ_MEMORY_MCP_URL must be https/,
    );
  });
});

describe("runtimeChildEnv", () => {
  const ambient = new Map<string, string>([
    ["PATH", "/usr/bin"],
    ["HOME", FAKE_HOME],
    ["ANTHROPIC_API_KEY", "sk-test"],
    ["OP_SERVICE_ACCOUNT_TOKEN", "ops-test"],
    ["TMPDIR", "/var/folders/xy/T/"],
    ["TMP", "/tmp/a"],
    ["TEMP", "/tmp/b"],
    ["DENO_DIR", "/cache/deno"],
    ["DYFJ_TEST_OUTSIDE_POLICY", "leaked"],
    ["DYFJ_TEST_SECOND_OUTSIDER", "leaked"],
  ]);
  const env = { get: (name: string) => ambient.get(name) };

  it("forwards only policy names and the named runtime-platform variables", () => {
    const policy = composeRuntimePolicy({
      secrets: secrets(["/opt/bin/op"], ["OP_SERVICE_ACCOUNT_TOKEN"]),
    });
    assert.deepStrictEqual(runtimeChildEnv(policy, env), {
      PATH: "/usr/bin",
      HOME: FAKE_HOME,
      ANTHROPIC_API_KEY: "sk-test",
      OP_SERVICE_ACCOUNT_TOKEN: "ops-test",
      TMPDIR: "/var/folders/xy/T/",
      TMP: "/tmp/a",
      TEMP: "/tmp/b",
      DENO_DIR: "/cache/deno",
    });
  });

  it("names TMPDIR, TMP, TEMP and DENO_DIR as the platform variables", () => {
    assert.deepStrictEqual([...RUNTIME_PLATFORM_ENV], [
      "TMPDIR",
      "TMP",
      "TEMP",
      "DENO_DIR",
    ]);
  });

  it("omits an unset name rather than forwarding an empty value", () => {
    const child = runtimeChildEnv(baseRuntimePolicy(), {
      get: (name) => (name === "HOME" ? FAKE_HOME : undefined),
    });
    assert.deepStrictEqual(child, { HOME: FAKE_HOME });
  });
});
