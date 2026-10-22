// The provenance `composeRuntimeGrants` records, and the host helpers the
// effective policy and its compilers share. The existing `runtime-policy`
// tests pin the composed lists themselves.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeEffectivePolicy } from "./effective-policy.ts";
import {
  composeRuntimeGrants,
  composeRuntimePolicy,
  isAddressLiteral,
  isCanonicalHost,
  isLoopbackHost,
  RUNTIME_NET_GRANT_TABLE,
  RUNTIME_NET_GRANTS,
  RUNTIME_RUN_GRANT_TABLE,
  RUNTIME_RUN_GRANTS,
} from "./runtime-policy.ts";

const ENVELOPE = {
  identity: {
    principal: "principal-01",
    job: "job-01",
    run: "run-01",
    repositories: [],
    expiresAt: "2026-12-31T23:59:59.000Z",
  },
};

describe("the tagged grant tables", () => {
  it("derive the exported lists in table order", () => {
    assert.deepStrictEqual(
      [...RUNTIME_NET_GRANTS],
      RUNTIME_NET_GRANT_TABLE.map((row) => row.entry),
    );
    assert.deepStrictEqual(
      [...RUNTIME_RUN_GRANTS],
      RUNTIME_RUN_GRANT_TABLE.map((row) => row.entry),
    );
  });

  it("are frozen", () => {
    assert.ok(Object.isFrozen(RUNTIME_NET_GRANT_TABLE));
    assert.ok(Object.isFrozen(RUNTIME_NET_GRANT_TABLE[0]));
    assert.ok(Object.isFrozen(RUNTIME_RUN_GRANT_TABLE[0]));
  });
});

describe("composeRuntimeGrants", () => {
  it("lists the same entries as composeRuntimePolicy", () => {
    const inputs = {
      networkAllow: ["127.0.0.1:1234", "192.0.2.53:53"],
      nameserverGrants: ["192.0.2.53:53"],
      dolt: { host: "127.0.0.1", port: 3307 },
    };
    const grants = composeRuntimeGrants(inputs);
    const policy = composeRuntimePolicy(inputs);
    assert.deepStrictEqual(grants.net.map((g) => g.entry), [...policy.net]);
    assert.deepStrictEqual(grants.run.map((g) => g.entry), [...policy.run]);
  });

  it("keeps every source of an entry that two sources add", () => {
    const grants = composeRuntimeGrants({
      networkAllow: ["192.0.2.53:53"],
      nameserverGrants: ["192.0.2.53:53"],
    });
    const entry = grants.net.find((g) => g.entry === "192.0.2.53:53")!;
    assert.deepStrictEqual(entry.source, { kind: "network-allow" });
    assert.deepStrictEqual(entry.sources.map((s) => s.kind), [
      "network-allow",
      "nameserver",
    ]);
  });

  it("refuses a nameserver that another source also grants over TCP", () => {
    for (
      const inputs of [
        { networkAllow: ["192.0.2.53:53"], nameserverGrants: ["192.0.2.53:53"] },
        {
          mcpServers: [{ url: "http://192.0.2.53:53/mcp" } as never],
          nameserverGrants: ["192.0.2.53:53"],
        },
      ]
    ) {
      assert.throws(
        () => composeEffectivePolicy(inputs, ENVELOPE),
        /granted as a nameserver and over TCP/,
      );
      assert.doesNotThrow(() => composeRuntimePolicy(inputs));
    }
  });

  it("makes the smallest nameserver every named host's resolver", () => {
    const policy = composeEffectivePolicy({
      nameserverGrants: ["192.0.2.99:53", "192.0.2.53:53"],
    }, ENVELOPE);
    const provider = policy.network.entries.find((e) =>
      e.host === "api.anthropic.com"
    )!;
    assert.strictEqual(provider.dns, "resolver:192.0.2.53:53");
  });

  it("gives a Dolt endpoint also listed in [network] allow the database role", () => {
    const policy = composeEffectivePolicy({
      networkAllow: ["127.0.0.1:3307"],
      dolt: { host: "127.0.0.1", port: 3307 },
    }, ENVELOPE);
    const entry = policy.network.entries.find((e) => e.port === 3307)!;
    assert.strictEqual(entry.role, "dolt");
  });
});

describe("the host helpers", () => {
  it("recognize a valid address literal and nothing that only contains one", () => {
    for (const host of ["192.0.2.1", "[::1]", "[2001:db8::1]"]) {
      assert.ok(isAddressLiteral(host), host);
    }
    for (
      const host of [
        "256.1.1.1",
        "01.2.3.4",
        "[garbage]",
        "[::1]@example.test/[x]",
        "[::1]:80/[foo]",
        "example.test",
      ]
    ) {
      assert.ok(!isAddressLiteral(host), host);
    }
  });

  it("recognize loopback in its canonical spellings", () => {
    for (
      const host of [
        "localhost",
        "a.localhost",
        "127.0.0.1",
        "127.9.9.9",
        "0.0.0.0",
        "[::1]",
        "[::]",
        "[0:0:0:0:0:0:0:1]",
        "[::ffff:127.0.0.1]",
      ]
    ) {
      assert.ok(isLoopbackHost(host), host);
    }
    for (const host of ["192.0.2.1", "example.test", "[2001:db8::1]", "localhost/x"]) {
      assert.ok(!isLoopbackHost(host), host);
    }
  });

  it("accept only the one spelling a URL gives a host", () => {
    for (const host of ["example.test", "192.0.2.1", "[::1]", "localhost"]) {
      assert.ok(isCanonicalHost(host), host);
    }
    for (
      const host of [
        "127.1",
        "LOCALHOST",
        "localhost.",
        "[0:0:0:0:0:0:0:1]",
        "example.test:80",
        "user@example.test",
        "not a host",
        "",
      ]
    ) {
      assert.ok(!isCanonicalHost(host), host);
    }
  });
});
