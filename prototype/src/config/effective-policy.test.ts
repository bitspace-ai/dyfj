// Part A of the effective policy: `composeEffectivePolicy` is built from the
// same composition as `composeRuntimePolicy`, so projecting it back must give
// today's `{net, run, env, dolt}` exactly (parity), and the result is deeply
// frozen. The modules are loaded inside each test so that each test fails (and
// is reported) on its own until the implementation exists.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composeRuntimePolicy,
  type RuntimePolicyInputs,
} from "./runtime-policy.ts";
import type { McpHttpServerConfig } from "./mcp-servers.ts";
import type { SecretsConfig } from "./secrets-config.ts";

const effectiveModule = () => import("./effective-policy.ts");

const ENVELOPE = {
  identity: {
    principal: "principal-01",
    job: "job-01",
    run: "run-01",
    repositories: ["repo-a", "repo-b"],
    expiresAt: "2026-12-31T23:59:59.000Z",
  },
};

function server(url: string): McpHttpServerConfig {
  return { url } as McpHttpServerConfig;
}

function secrets(command: string[], inheritEnv: string[] = []): SecretsConfig {
  return { command, inheritEnv } as unknown as SecretsConfig;
}

const PARITY_CASES: readonly [string, RuntimePolicyInputs][] = [
  ["the baseline (no operator input)", {}],
  ["the runtime executable given as null", { runtimeExecutable: null }],
  [
    "an operator-extended policy",
    {
      mcpServers: [
        server("https://mcp.example.test/mcp"),
        server("http://127.0.0.1:7001/mcp"),
      ],
      memoryMcpUrl: "http://127.0.0.1:7777/mcp",
      networkAllow: ["127.0.0.1:1234", "[::1]:9000"],
      nameserverGrants: ["192.0.2.53:53"],
      secrets: secrets(["/opt/bin/op", "read"], ["OP_SERVICE_ACCOUNT_TOKEN"]),
      nodePath: "/opt/node/bin/node",
      runtimeExecutable: "/opt/runtime/bin/node",
      dolt: { host: "127.0.0.1", port: 3307 },
    },
  ],
  ["a loopback memory MCP endpoint", { memoryMcpUrl: "http://127.0.0.1:7777/mcp" }],
  ["an https memory MCP endpoint", { memoryMcpUrl: "https://memory.example.test/mcp" }],
  [
    "an MCP server on an explicit port",
    { mcpServers: [server("https://mcp.example.test:8443/mcp")] },
  ],
  [
    "[network] allow, including a static entry and an IPv6 literal",
    { networkAllow: ["127.0.0.1:1234", "api.openai.com:443", "[::1]:8080"] },
  ],
  [
    "nameserver grants, IPv4 and IPv6",
    { nameserverGrants: ["192.0.2.53:53", "[2001:db8::53]:53"] },
  ],
  ["a non-default Dolt port", { dolt: { host: "127.0.0.1", port: 3307 } }],
  ["the default Dolt endpoint (already static)", {
    dolt: { host: "127.0.0.1", port: 3306 },
  }],
  ["a remote Dolt host", { dolt: { host: "db.example.test", port: 3307 } }],
  [
    "a secrets resolver and its inherit_env names",
    { secrets: secrets(["/opt/bin/op"], ["OP_SERVICE_ACCOUNT_TOKEN"]) },
  ],
  ["a selected Node executable", { nodePath: "/opt/node/bin/node" }],
];

describe("projectRuntimePolicy(composeEffectivePolicy(x)) is composeRuntimePolicy(x)", () => {
  for (const [label, inputs] of PARITY_CASES) {
    it(`agrees for ${label}`, async () => {
      const { composeEffectivePolicy, projectRuntimePolicy } =
        await effectiveModule();
      const projected = projectRuntimePolicy(
        composeEffectivePolicy(inputs, ENVELOPE),
      );
      assert.deepStrictEqual(projected, composeRuntimePolicy(inputs));
    });
  }

  it("keeps the order of every list, as the existing seams read it", async () => {
    const { composeEffectivePolicy, projectRuntimePolicy } =
      await effectiveModule();
    const inputs: RuntimePolicyInputs = {
      networkAllow: ["127.0.0.1:2222", "127.0.0.1:1111"],
      nameserverGrants: ["192.0.2.2:53", "192.0.2.1:53"],
    };
    const projected = projectRuntimePolicy(
      composeEffectivePolicy(inputs, ENVELOPE),
    );
    assert.deepStrictEqual([...projected.net], [...composeRuntimePolicy(inputs).net]);
    assert.ok(
      projected.net.indexOf("127.0.0.1:2222") <
        projected.net.indexOf("127.0.0.1:1111"),
    );
  });

  it("refuses an insecure memory endpoint the way composeRuntimePolicy does", async () => {
    const { composeEffectivePolicy } = await effectiveModule();
    assert.throws(
      () =>
        composeEffectivePolicy({
          memoryMcpUrl: "http://memory.example.test/mcp",
        }, ENVELOPE),
      /DYFJ_MEMORY_MCP_URL must be https/,
    );
  });

  it("refuses an invalid Dolt port the way composeRuntimePolicy does", async () => {
    const { composeEffectivePolicy } = await effectiveModule();
    assert.throws(
      () =>
        composeEffectivePolicy({ dolt: { host: "127.0.0.1", port: NaN } }, ENVELOPE),
      /invalid DOLT_PORT/,
    );
  });
});

describe("the effective policy is immutable", () => {
  function everyObjectFrozen(value: unknown, path = "policy"): void {
    if (value === null || typeof value !== "object") return;
    assert.ok(Object.isFrozen(value), `${path} is not frozen`);
    for (const [key, child] of Object.entries(value)) {
      everyObjectFrozen(child, `${path}.${key}`);
    }
  }

  it("is frozen at every depth", async () => {
    const { composeEffectivePolicy } = await effectiveModule();
    everyObjectFrozen(composeEffectivePolicy({
      mcpServers: [server("https://mcp.example.test/mcp")],
      networkAllow: ["127.0.0.1:1234"],
      dolt: { host: "127.0.0.1", port: 3307 },
    }, ENVELOPE));
  });

  it("throws on assignment, deletion, push and extension", async () => {
    const { composeEffectivePolicy } = await effectiveModule();
    const policy = composeEffectivePolicy({}, ENVELOPE) as any;
    assert.throws(() => {
      policy.version = 2;
    }, TypeError);
    assert.throws(() => {
      policy.identity.principal = "someone-else";
    }, TypeError);
    assert.throws(() => {
      policy.identity.repositories.push("repo-z");
    }, TypeError);
    assert.throws(() => {
      policy.network.entries[0].port = 1;
    }, TypeError);
    assert.throws(() => {
      policy.network.entries.push({});
    }, TypeError);
    assert.throws(() => {
      policy.effects.limits.spendMicroUsd.session = 999_999_999;
    }, TypeError);
    assert.throws(() => {
      policy.effects.paidRouting = true;
    }, TypeError);
    assert.throws(() => {
      delete policy.secrets;
    }, TypeError);
    assert.throws(() => {
      policy.extra = true;
    }, TypeError);
  });

  it("is not changed by later edits to the envelope or the inputs it was built from", async () => {
    const { composeEffectivePolicy } = await effectiveModule();
    const repositories = ["repo-a"];
    const networkAllow = ["127.0.0.1:1234"];
    const policy = composeEffectivePolicy(
      { networkAllow },
      { identity: { ...ENVELOPE.identity, repositories } },
    );
    const before = JSON.stringify(policy);
    repositories.push("repo-z");
    networkAllow.push("127.0.0.1:4321");
    assert.strictEqual(JSON.stringify(policy), before);
  });

  it("does not mutate the inputs it composes", async () => {
    const { composeEffectivePolicy } = await effectiveModule();
    const inputs: RuntimePolicyInputs = {
      networkAllow: ["127.0.0.1:1234"],
      nameserverGrants: ["192.0.2.53:53"],
      mcpServers: [server("https://mcp.example.test/mcp")],
    };
    const before = JSON.stringify(inputs);
    composeEffectivePolicy(inputs, ENVELOPE);
    assert.strictEqual(JSON.stringify(inputs), before);
  });
});
