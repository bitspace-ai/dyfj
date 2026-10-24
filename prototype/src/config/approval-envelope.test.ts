import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BEFORE_EXPIRY,
  executorPolicy,
} from "../../testing/fakes/executor-policy.ts";
import { deriveApprovalEnvelope } from "./approval-envelope.ts";
import { parseEffectivePolicy } from "./effective-policy.ts";

const INSTANCE = "ab".repeat(16);

function derive(edit?: (draft: any) => void, now = BEFORE_EXPIRY) {
  return deriveApprovalEnvelope(
    parseEffectivePolicy(executorPolicy(edit)),
    INSTANCE,
    now,
    120_000,
  );
}

describe("the approval envelope", () => {
  it("is derived from the executor policy alone", () => {
    const policy = executorPolicy();
    const derived = derive();
    assert.ok("envelope" in derived, JSON.stringify(derived));
    assert.deepStrictEqual(derived.envelope, {
      route: "linux-isolated",
      policyDigest: policy.identity.digest,
      run: policy.identity.run,
      instance: INSTANCE,
      writable: ["workspace", "scratch"],
      commandTimeoutMs: 120_000,
      expiresAt: policy.identity.expiresAt,
    });
  });

  it("never allows a deadline above the tool's default or the policy's limit", () => {
    const lower = derive((d) => (d.effects.limits.timeMs = 30_000));
    assert.ok("envelope" in lower);
    assert.strictEqual(lower.envelope.commandTimeoutMs, 30_000);
    const higher = derive((d) => (d.effects.limits.timeMs = 3_600_000));
    assert.ok("envelope" in higher);
    assert.strictEqual(higher.envelope.commandTimeoutMs, 120_000);
  });

  for (
    const [label, edit, pattern] of [
      [
        "a network entry",
        (d: any) =>
          d.network.entries.push({
            role: "provider",
            host: "api.example.test",
            port: 443,
            protocol: "tcp",
            dns: "none",
            hostnameAssurance: "tls",
          }),
        /network/,
      ],
      ["a broker operation", (d: any) => d.network.brokerOperations.push("publish"), /network/],
      ["a database", (d: any) => (d.network.dolt = "127.0.0.1:3306"), /network/],
      ["a secret", (d: any) => d.secrets.push({ name: "SYNTHETIC_TOKEN", owner: "runtime" }), /secrets/],
      [
        "a writable filesystem root",
        (d: any) =>
          d.filesystem.roots.push({ name: "all", source: "/", target: "all", rights: ["read", "write"] }),
        /whole filesystem/,
      ],
      [
        "a writable root over a forbidden path",
        (d: any) =>
          d.filesystem.roots.push({ name: "srv", source: "/srv", target: "srv", rights: ["write"] }),
        /forbidden path/,
      ],
    ] as const
  ) {
    it(`is refused for a policy with ${label}`, () => {
      const derived = derive(edit);
      assert.ok("refusal" in derived, JSON.stringify(derived));
      assert.match(derived.refusal, pattern);
    });
  }

  it("is refused when the digest does not verify", () => {
    const policy = executorPolicy();
    policy.identity.digest = `sha256:${"0".repeat(64)}`;
    const derived = deriveApprovalEnvelope(
      parseEffectivePolicy(policy),
      INSTANCE,
      BEFORE_EXPIRY,
      120_000,
    );
    assert.deepStrictEqual(derived, { refusal: "the executor policy's digest does not verify" });
  });

  it("is refused once the policy has expired", () => {
    const derived = derive(undefined, new Date("2027-01-01T00:00:00.000Z"));
    assert.deepStrictEqual(derived, { refusal: "the executor policy has expired" });
  });
});
