// The effective policy digest: `sha256:<hex>` over a domain prefix, a NUL and
// the canonical JSON of the policy without its own digest. Stable across
// composition order, key order and repeated runs; changed by any single
// hashed field (not by the policy's own digest or the order of a list);
// pinned by the golden vector in `testing/fixtures/effective-policy` so a Rust
// helper can match it byte for byte. The modules are loaded inside each test
// so that each test fails (and is reported) on its own until they exist.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { McpHttpServerConfig } from "./mcp-servers.ts";
import type { EffectivePolicy } from "./effective-policy.ts";

const FIXTURE = fileURLToPath(
  new URL("../../testing/fixtures/effective-policy/", import.meta.url),
);

const digestModule = () => import("./effective-policy-digest.ts");
const effectiveModule = () => import("./effective-policy.ts");

function fixtureText(name: string): string {
  return readFileSync(`${FIXTURE}${name}`, "utf8");
}

/** A fresh, mutable copy of the golden policy. */
function golden(): any {
  return JSON.parse(fixtureText("policy.json"));
}

const EXPECTED_DIGEST = fixtureText("expected-digest.txt").trim();

/** The same policy with every array reversed and every object's keys reversed. */
function shuffled(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffled).reverse();
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).reverse().map(([k, v]) => [k, shuffled(v)]),
    );
  }
  return value;
}

type Path = (string | number)[];

/** Every leaf of `value`, as the path that reaches it. */
function leafPaths(value: unknown, prefix: Path = []): Path[] {
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      leafPaths(child, [...prefix, Array.isArray(value) ? Number(key) : key])
    );
  }
  return [prefix];
}

function at(root: any, path: Path): any {
  return path.reduce((node, key) => node[key], root);
}

function changeLeaf(root: any, path: Path): void {
  const parent = at(root, path.slice(0, -1));
  const key = path[path.length - 1] as string | number;
  const current = parent[key];
  parent[key] = typeof current === "number"
    ? current + 1
    : typeof current === "boolean"
    ? !current
    : current === null
    ? "changed"
    : `${current}x`;
}

function server(url: string): McpHttpServerConfig {
  return { url } as McpHttpServerConfig;
}

const ENVELOPE = {
  identity: {
    principal: "principal-01",
    job: "job-01",
    run: "run-01",
    repositories: ["repo-a"],
    expiresAt: "2026-12-31T23:59:59.000Z",
  },
};

describe("the golden vector", () => {
  it("hashes policy.json to the pinned digest", async () => {
    const { policyDigest } = await digestModule();
    assert.match(EXPECTED_DIGEST, /^sha256:[0-9a-f]{64}$/);
    assert.strictEqual(policyDigest(golden()), EXPECTED_DIGEST);
  });

  it("writes policy.json as the pinned canonical JSON", async () => {
    const { canonicalPolicyJson } = await digestModule();
    assert.strictEqual(canonicalPolicyJson(golden()), fixtureText("canonical.json"));
  });

  it("is sha256 over the domain prefix, a NUL and the canonical JSON", async () => {
    const { canonicalPolicyJson, policyDigest } = await digestModule();
    const canonical = canonicalPolicyJson(golden());
    const expected = (prefix: string) =>
      "sha256:" +
      createHash("sha256").update(prefix + canonical, "utf8").digest("hex");
    assert.strictEqual(policyDigest(golden()), expected("dyfj-effective-policy/v1\0"));
    assert.notStrictEqual(policyDigest(golden()), expected(""));
    assert.notStrictEqual(policyDigest(golden()), expected("dyfj-effective-policy/v1"));
  });

  it("leaves the policy's own digest out of the canonical JSON", async () => {
    const { canonicalPolicyJson, policyDigest } = await digestModule();
    const policy = golden();
    assert.ok(!canonicalPolicyJson(policy).includes(policy.identity.digest));
    policy.identity.digest = "sha256:" + "f".repeat(64);
    assert.strictEqual(policyDigest(policy), EXPECTED_DIGEST);
  });

  it("verifies the digest policy.json carries", async () => {
    const { verifyDigest } = await digestModule();
    assert.strictEqual(verifyDigest(golden()), true);
  });
});

describe("the digest is stable", () => {
  it("is the same on every run", async () => {
    const { policyDigest } = await digestModule();
    const digests = new Set(Array.from({ length: 5 }, () => policyDigest(golden())));
    assert.deepStrictEqual([...digests], [EXPECTED_DIGEST]);
  });

  it("does not depend on object key order or the order of any set", async () => {
    const { canonicalPolicyJson, policyDigest } = await digestModule();
    const reordered = shuffled(golden());
    assert.notDeepEqual(Object.keys(reordered as object), Object.keys(golden()));
    assert.strictEqual(policyDigest(reordered), EXPECTED_DIGEST);
    assert.strictEqual(canonicalPolicyJson(reordered), fixtureText("canonical.json"));
  });

  it("does not depend on the order a composition lists its entries", async () => {
    const { composeEffectivePolicy } = await effectiveModule();
    const a = composeEffectivePolicy({
      networkAllow: ["127.0.0.1:1111", "127.0.0.1:2222"],
      nameserverGrants: ["192.0.2.1:53", "192.0.2.2:53"],
      mcpServers: [server("https://a.example.test/mcp"), server("https://b.example.test/mcp")],
    }, ENVELOPE);
    const b = composeEffectivePolicy({
      networkAllow: ["127.0.0.1:2222", "127.0.0.1:1111"],
      nameserverGrants: ["192.0.2.2:53", "192.0.2.1:53"],
      mcpServers: [server("https://b.example.test/mcp"), server("https://a.example.test/mcp")],
    }, ENVELOPE);
    assert.notDeepStrictEqual(a.network.entries, b.network.entries);
    assert.strictEqual(a.identity.digest, b.identity.digest);
  });

  it("is the same for two compositions of the same inputs, and verifies", async () => {
    const { composeEffectivePolicy } = await effectiveModule();
    const { verifyDigest } = await digestModule();
    const a = composeEffectivePolicy({ networkAllow: ["127.0.0.1:1234"] }, ENVELOPE);
    const b = composeEffectivePolicy({ networkAllow: ["127.0.0.1:1234"] }, ENVELOPE);
    assert.match(a.identity.digest, /^sha256:[0-9a-f]{64}$/);
    assert.strictEqual(a.identity.digest, b.identity.digest);
    assert.strictEqual(verifyDigest(a), true);
  });

  it("differs when the composed inputs differ", async () => {
    const { composeEffectivePolicy } = await effectiveModule();
    const base = composeEffectivePolicy({}, ENVELOPE).identity.digest;
    const extended = composeEffectivePolicy({ networkAllow: ["127.0.0.1:1234"] }, ENVELOPE)
      .identity.digest;
    const otherRun = composeEffectivePolicy({}, {
      identity: { ...ENVELOPE.identity, run: "run-02" },
    }).identity.digest;
    assert.strictEqual(new Set([base, extended, otherRun]).size, 3);
  });
});

describe("the digest changes with any single field", () => {
  it("changes for every leaf of the golden policy", async () => {
    const { policyDigest } = await digestModule();
    const seen = new Map<string, string>([[EXPECTED_DIGEST, "unchanged"]]);
    for (const path of leafPaths(golden())) {
      if (path.join(".") === "identity.digest") continue;
      const changed = golden();
      changeLeaf(changed, path);
      const label = path.join(".");
      const digest = policyDigest(changed);
      assert.notStrictEqual(digest, EXPECTED_DIGEST, `${label} did not change the digest`);
      assert.ok(!seen.has(digest), `${label} collides with ${seen.get(digest)}`);
      seen.set(digest, label);
    }
    assert.ok(seen.size > 40);
  });

  it("changes when a set element is added or removed", async () => {
    const { policyDigest } = await digestModule();
    const added = golden();
    added.effects.tools.push("grep_files");
    const removed = golden();
    removed.network.entries.pop();
    const emptied = golden();
    emptied.secrets = [];
    const digests = [added, removed, emptied].map(policyDigest);
    assert.ok(!digests.includes(EXPECTED_DIGEST));
    assert.strictEqual(new Set(digests).size, 3);
  });

  it("keeps null (not requested, unbounded) distinct from a value and from absence", async () => {
    const { policyDigest } = await digestModule();
    const zero = golden();
    zero.effects.limits.spendMicroUsd.daily = 0;
    const absent = golden();
    delete absent.effects.limits.spendMicroUsd.daily;
    assert.notStrictEqual(policyDigest(zero), EXPECTED_DIGEST);
    assert.notStrictEqual(policyDigest(absent), EXPECTED_DIGEST);
    assert.notStrictEqual(policyDigest(zero), policyDigest(absent));
  });

  it("changes every digest when the version is bumped", async () => {
    const { policyDigest } = await digestModule();
    const bumped = golden();
    bumped.version = 2;
    assert.notStrictEqual(policyDigest(bumped), EXPECTED_DIGEST);
  });

  it("refuses a number that is not an integer, so formatting never reaches a digest", async () => {
    const { policyDigest } = await digestModule();
    for (const bad of [0.1, 1.5, NaN, Infinity]) {
      const policy = golden();
      policy.effects.limits.spendMicroUsd.session = bad;
      assert.throws(() => policyDigest(policy), /integer/i, String(bad));
    }
  });
});

describe("verifyDigest rejects tampering", () => {
  it("fails when any field changes and the digest is left as it was", async () => {
    const { verifyDigest } = await digestModule();
    for (const path of leafPaths(golden())) {
      if (path.join(".") === "identity.digest") continue;
      const tampered = golden();
      changeLeaf(tampered, path);
      assert.strictEqual(verifyDigest(tampered), false, path.join("."));
    }
  });

  it("fails for a digest of the wrong shape or the wrong value", async () => {
    const { verifyDigest } = await digestModule();
    for (const bad of ["", "sha256:abc", EXPECTED_DIGEST.toUpperCase(), "sha256:" + "0".repeat(64), EXPECTED_DIGEST.slice("sha256:".length)]) {
      const policy = golden();
      policy.identity.digest = bad;
      assert.strictEqual(verifyDigest(policy), false, bad);
    }
  });

  it("holds for a policy rewritten with a new digest", async () => {
    const { policyDigest, verifyDigest } = await digestModule();
    const policy = golden();
    policy.effects.limits.steps = 8;
    assert.strictEqual(verifyDigest(policy), false);
    policy.identity.digest = policyDigest(policy);
    assert.strictEqual(verifyDigest(policy), true);
  });
});

describe("parseEffectivePolicy", () => {
  it("accepts the golden policy and returns it frozen", async () => {
    const { parseEffectivePolicy } = await effectiveModule();
    const policy: EffectivePolicy = parseEffectivePolicy(golden());
    assert.deepStrictEqual(JSON.parse(JSON.stringify(policy)), golden());
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.network.entries));
    assert.ok(Object.isFrozen(policy.network.entries[0]));
  });

  it("rejects any version other than 1", async () => {
    const { parseEffectivePolicy } = await effectiveModule();
    for (const version of [0, 2, "1", null, undefined]) {
      const policy = golden();
      policy.version = version;
      assert.throws(() => parseEffectivePolicy(policy), /version/i, String(version));
    }
    const missing = golden();
    delete missing.version;
    assert.throws(() => parseEffectivePolicy(missing), /version/i);
  });

  it("rejects an unknown key at the top level and in every group", async () => {
    const { parseEffectivePolicy } = await effectiveModule();
    const places: Path[] = [
      [],
      ["identity"],
      ["filesystem"],
      ["filesystem", "roots", 0],
      ["network"],
      ["network", "entries", 0],
      ["processes"],
      ["processes", "executables", 0],
      ["secrets", 0],
      ["effects"],
      ["effects", "limits"],
      ["effects", "limits", "spendMicroUsd"],
    ];
    for (const place of places) {
      const policy = golden();
      at(policy, place).surprise = true;
      assert.throws(
        () => parseEffectivePolicy(policy),
        /surprise|unknown/i,
        place.join(".") || "(top level)",
      );
    }
  });

  it("rejects a missing group and a value of the wrong type", async () => {
    const { parseEffectivePolicy } = await effectiveModule();
    for (const group of ["identity", "filesystem", "network", "processes", "secrets", "effects"]) {
      const policy = golden();
      delete policy[group];
      assert.throws(() => parseEffectivePolicy(policy), new RegExp(group), group);
    }
    const floaty = golden();
    floaty.effects.limits.steps = 1.5;
    assert.throws(() => parseEffectivePolicy(floaty), /integer|steps/i);
    const wildcard = golden();
    wildcard.secrets.push({ name: "*", owner: "provider" });
    assert.throws(() => parseEffectivePolicy(wildcard), /secret|wildcard|name/i);
  });

  it("rejects text that is not an object", async () => {
    const { parseEffectivePolicy } = await effectiveModule();
    for (const bad of [null, "policy", 1, [], undefined]) {
      assert.throws(() => parseEffectivePolicy(bad), String(bad));
    }
  });
});

describe("the digest module's source", () => {
  it("opens no file and reads no clock, environment or randomness", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./effective-policy-digest.ts", import.meta.url)),
      "utf8",
    );
    assert.doesNotMatch(source, /node:fs|process\.env|Date\.now|new Date\(\)|Math\.random|randomUUID|randomBytes/);
  });
});
