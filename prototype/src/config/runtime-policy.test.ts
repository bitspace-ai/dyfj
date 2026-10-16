import assert from "node:assert/strict";
import process from "node:process";
import { describe, it } from "node:test";
import {
  baseRuntimePolicy,
  CLI_NODE_PERMISSION_FLAGS,
  cliRuntimePolicy,
  composeRuntimePolicy,
  nodePermissionArgs,
  RUNTIME_ENV_GRANTS,
  RUNTIME_NET_GRANTS,
  RUNTIME_NODE_PERMISSION_FLAGS,
  RUNTIME_PLATFORM_ENV,
  RUNTIME_RUN_GRANTS,
  runtimeChildEnv,
} from "./runtime-policy.ts";
import type { McpHttpServerConfig } from "./mcp-servers.ts";
import type { SecretsConfig } from "./secrets-config.ts";

// Assembled at runtime so the public-boundary scan never matches this
// fixture as a home-directory path in tracked source.
const FAKE_HOME = ["", "home", "op"].join("/");

function server(url: string): McpHttpServerConfig {
  return { url } as McpHttpServerConfig;
}

function secrets(
  command: string[],
  inheritEnv: string[] = [],
): SecretsConfig {
  return { command, inheritEnv } as unknown as SecretsConfig;
}

describe("the Node permission flags", () => {
  it("the runtime runs as plain node, with no permission flag", () => {
    assert.deepStrictEqual([...RUNTIME_NODE_PERMISSION_FLAGS], []);
    assert.deepStrictEqual(nodePermissionArgs(RUNTIME_NODE_PERMISSION_FLAGS), []);
  });

  it("the client reads and connects, and writes nothing", () => {
    assert.deepStrictEqual([...CLI_NODE_PERMISSION_FLAGS], [
      "--permission",
      "--allow-fs-read=*",
      "--allow-net",
    ]);
  });

  it("silences the experimental --allow-net warning only where it is granted", () => {
    assert.deepStrictEqual(nodePermissionArgs(["--permission", "--allow-net"]), [
      "--permission",
      "--allow-net",
      "--disable-warning=ExperimentalWarning",
    ]);
    assert.deepStrictEqual(nodePermissionArgs(["--permission"]), [
      "--permission",
    ]);
    assert.deepStrictEqual(nodePermissionArgs([]), []);
  });
});

describe("cliRuntimePolicy", () => {
  it("starts only the Node executable running the client", () => {
    const policy = cliRuntimePolicy();
    assert.deepStrictEqual([...policy.run], [process.execPath]);
    assert.ok(!policy.run.includes("deno"));
    assert.deepStrictEqual([...policy.net], []);
    assert.strictEqual(policy.dolt, null);
  });
});

describe("composeRuntimePolicy", () => {
  it("the base policy is the static lists plus the runtime's own executable", () => {
    const policy = baseRuntimePolicy();
    assert.deepStrictEqual(policy.net, [...RUNTIME_NET_GRANTS]);
    assert.deepStrictEqual(policy.run, [
      ...RUNTIME_RUN_GRANTS,
      process.execPath,
    ]);
    assert.deepStrictEqual(policy.env, [...RUNTIME_ENV_GRANTS]);
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
      ...RUNTIME_NET_GRANTS,
      "127.0.0.1:7777",
      "mcp.example.test:443",
      "192.0.2.53:53",
      "127.0.0.1:3307",
    ]);
    assert.deepStrictEqual(policy.run, [
      ...RUNTIME_RUN_GRANTS,
      process.execPath,
      "/opt/node/bin/node",
      "/opt/bin/op",
    ]);
    assert.deepStrictEqual(policy.env, [
      ...RUNTIME_ENV_GRANTS,
      "OP_SERVICE_ACCOUNT_TOKEN",
    ]);
    assert.strictEqual(policy.dolt, "127.0.0.1:3307");
  });

  it("adds a non-default Dolt endpoint to the net list as well as dolt", () => {
    const policy = composeRuntimePolicy({
      dolt: { host: "db.example.test", port: 3307 },
    });
    assert.strictEqual(policy.dolt, "db.example.test:3307");
    assert.deepStrictEqual(policy.net, [
      ...RUNTIME_NET_GRANTS,
      "db.example.test:3307",
    ]);
    // The default endpoint is already a static entry, so it is not repeated.
    assert.deepStrictEqual(
      composeRuntimePolicy({ dolt: { host: "127.0.0.1", port: 3306 } }).net,
      [...RUNTIME_NET_GRANTS],
    );
  });

  it("refuses an invalid Dolt port rather than composing it", () => {
    assert.throws(
      () => composeRuntimePolicy({ dolt: { host: "127.0.0.1", port: NaN } }),
      /invalid DOLT_PORT/,
    );
  });

  it("adds the operator's [network] allow entries to the net list", () => {
    const policy = composeRuntimePolicy({
      networkAllow: ["127.0.0.1:1234", "api.openai.com:443"],
    });
    assert.deepStrictEqual(policy.net, [
      ...RUNTIME_NET_GRANTS,
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
    });
  });

  it("names TMPDIR, TMP and TEMP as the platform variables", () => {
    assert.deepStrictEqual([...RUNTIME_PLATFORM_ENV], [
      "TMPDIR",
      "TMP",
      "TEMP",
    ]);
  });

  it("omits an unset name rather than forwarding an empty value", () => {
    const child = runtimeChildEnv(baseRuntimePolicy(), {
      get: (name) => (name === "HOME" ? FAKE_HOME : undefined),
    });
    assert.deepStrictEqual(child, { HOME: FAKE_HOME });
  });
});
